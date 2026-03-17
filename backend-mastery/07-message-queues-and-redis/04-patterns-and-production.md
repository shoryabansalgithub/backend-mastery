# Lesson 4: Patterns and Production

## The Hardest Problem in Distributed Systems

Distributed systems fail in partial ways. A database write can succeed
while the subsequent message publish fails. A message can be received
and processed while the acknowledgment is lost in transit. A service can
crash after completing half of a multi-step operation.

Synchronous systems fail cleanly: either the request completes or it
returns an error. Asynchronous, distributed systems fail messily: you
often don't know what succeeded and what didn't, and the system may be
left in an inconsistent state.

The patterns in this lesson address the fundamental question: how do you
maintain consistency across services that communicate through messages,
when any step can fail at any time?

---

## The Outbox Pattern

### The Fundamental Problem

Consider a simple operation: a user places an order. You need to:
1. Write the order to your database
2. Publish an `order.placed` event to your message stream

These are two separate operations. What if step 1 succeeds but step 2
fails? Your database has an order that the rest of the system doesn't
know about. Inventory was never reserved. Payment was never collected.

You might think: do both in a transaction. But your database (Postgres)
and your message stream (Redis) are different systems. There's no way
to make a write to both atomic.

You might think: do step 2 first. But if step 2 succeeds and step 1
fails, you've published an event for an order that doesn't exist.

This is the dual-write problem, and it's why "just write to the DB and
publish to the queue" is subtly broken in ways that won't show up in
testing but will cause real production incidents.

### The Solution: Outbox Table

The outbox pattern solves this by making the message publish part of
the database transaction. Instead of publishing directly to the queue,
you write a record to an `outbox` table in the same database transaction
as your business data. A separate process reads from the outbox and
publishes to the real message stream.

```
User Request
     │
     ▼
  BEGIN TRANSACTION
  ├── INSERT INTO orders (...)
  └── INSERT INTO outbox (event_type, payload, ...)
  COMMIT
     │
     │  (atomically — either both happen or neither)
     │
     ▼
Outbox Processor (separate process)
  ├── SELECT * FROM outbox WHERE published = false LIMIT 100
  ├── Publish to Redis Stream / RabbitMQ / Kafka
  └── UPDATE outbox SET published = true WHERE id = ...
```

```typescript
// src/outbox/outbox-table.sql
/*
CREATE TABLE outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published   BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_unpublished ON outbox(created_at)
  WHERE published = FALSE;
*/

// src/outbox/place-order.ts
import { db } from './database';

export async function placeOrder(orderData: OrderData): Promise<Order> {
  return db.transaction(async (trx) => {
    // Step 1: Create the order
    const order = await trx('orders').insert(orderData).returning('*');

    // Step 2: Write to outbox IN THE SAME TRANSACTION
    await trx('outbox').insert({
      event_type: 'order.placed',
      payload: JSON.stringify({
        orderId: order[0].id,
        userId: order[0].userId,
        total: order[0].total,
        currency: order[0].currency,
      }),
    });

    return order[0];
  });
}

// src/outbox/outbox-processor.ts
import { redis } from './redis';
import { db } from './database';

async function processOutbox(): Promise<void> {
  const unpublished = await db('outbox')
    .where('published', false)
    .orderBy('created_at', 'asc')
    .limit(100);

  for (const record of unpublished) {
    try {
      // Publish to Redis Stream
      await redis.xadd(
        record.event_type.replace('.', '-'),  // 'order-placed'
        'MAXLEN', '~', '100000',
        '*',
        'outboxId', record.id,
        'eventType', record.event_type,
        'payload', record.payload
      );

      // Mark as published
      await db('outbox')
        .where('id', record.id)
        .update({ published: true, published_at: new Date() });

    } catch (err) {
      await db('outbox')
        .where('id', record.id)
        .increment('attempts', 1);

      console.error(`Failed to publish outbox record ${record.id}:`, err);
    }
  }
}

// Run every second
setInterval(processOutbox, 1000);
```

The outbox processor publishes at-least-once. The consumer must be
idempotent — it might receive the same event twice if the outbox processor
published successfully but crashed before marking it as published.

### CDC as an Alternative to Outbox Polling

Instead of polling the outbox table, you can use Change Data Capture (CDC)
to stream database changes directly. Tools like Debezium watch the Postgres
WAL (Write-Ahead Log) and emit change events. This eliminates the polling
delay and the outbox table overhead.

CDC is the right choice at scale. For most teams, the polling-based outbox
is simpler to operate and sufficient.

---

## Saga Pattern: Distributed Transactions

A saga is a sequence of local transactions, each in a different service,
coordinated through events. If any step fails, compensating transactions
undo the previous steps.

The term comes from a 1987 paper on long-running database transactions.
In microservices, it's the standard answer to "how do I implement a
transaction that spans multiple services."

### Choreography vs Orchestration

There are two ways to coordinate a saga:

**Choreography:** Each service publishes events and reacts to events.
There is no central coordinator. The workflow emerges from the interactions.

```
Order Service ──publishes──► order.placed
                                  │
                    Inventory Service reacts
                              │  ──publishes──► inventory.reserved
                                                     │
                                       Payment Service reacts
                                                 │  ──publishes──► payment.captured
                                                                        │
                                                        Fulfillment Service reacts
```

Pros: Loose coupling. Each service only knows about its events.
Cons: Hard to see the "big picture" of a saga. Debugging is difficult.
Cyclic dependencies can emerge.

**Orchestration:** A central coordinator (the "saga orchestrator") tells
each service what to do and tracks the saga's state.

```
Saga Orchestrator
  │
  ├── 1. Reserve inventory (call Inventory Service)
  │         └── inventory.reserved
  ├── 2. Charge payment (call Payment Service)
  │         └── payment.captured
  │         └── On failure: release inventory (compensating transaction)
  └── 3. Notify fulfillment (call Fulfillment Service)
```

Pros: Centralized state. Easy to see saga progress. Easier to implement
compensating transactions.
Cons: Orchestrator is a single point of failure. More coupling.

### Implementing a Simple Choreography Saga

```typescript
// Order Service: publishes order.placed
async function placeOrder(orderData: OrderData): Promise<void> {
  const order = await db.orders.create(orderData);
  await redis.xadd('order-events', '*',
    'eventType', 'order.placed',
    'orderId', order.id,
    'userId', order.userId,
    'total', String(order.total)
  );
}

// Inventory Service: reacts to order.placed, publishes inventory.reserved or inventory.failed
async function handleOrderPlaced(event: OrderPlacedEvent): Promise<void> {
  const reserved = await reserveInventory(event.orderId, event.items);
  if (reserved) {
    await redis.xadd('inventory-events', '*',
      'eventType', 'inventory.reserved',
      'orderId', event.orderId
    );
  } else {
    await redis.xadd('inventory-events', '*',
      'eventType', 'inventory.failed',
      'orderId', event.orderId,
      'reason', 'out_of_stock'
    );
  }
}

// Payment Service: reacts to inventory.reserved
// If payment fails, publishes payment.failed → Inventory Service must release
async function handleInventoryReserved(event: InventoryReservedEvent): Promise<void> {
  const charged = await chargeCustomer(event.orderId);
  if (charged) {
    await redis.xadd('payment-events', '*',
      'eventType', 'payment.captured',
      'orderId', event.orderId,
      'chargeId', charged.id
    );
  } else {
    await redis.xadd('payment-events', '*',
      'eventType', 'payment.failed',
      'orderId', event.orderId,
      'reason', 'card_declined'
    );
    // Inventory service must listen to payment.failed and release the reservation
  }
}
```

Notice the compensating transaction: when payment fails, inventory must
release the reservation. Each service is responsible for implementing
its own compensation. This requires careful design to ensure all failure
paths have corresponding compensation paths.

---

## Event Sourcing Basics

Traditional data modeling stores the current state: the `orders` table
has a row for each order, showing its current status. When the status
changes, you update the row. The history of changes is gone.

Event sourcing inverts this model. Instead of storing current state, you
store a sequence of events that led to the current state. The current
state is derived by replaying the events.

```typescript
// Traditional model:
// orders: { id, status: 'shipped', updatedAt: '...' }

// Event sourced model:
// order-events stream:
//   { eventType: 'order.placed', orderId: '42', ... }
//   { eventType: 'payment.captured', orderId: '42', ... }
//   { eventType: 'order.fulfilled', orderId: '42', ... }
//   { eventType: 'order.shipped', orderId: '42', trackingId: '...', ... }

async function getOrderState(orderId: string): Promise<Order> {
  const events = await redis.xrange(
    `order:${orderId}:events`,
    '-', '+'
  );

  let order: Partial<Order> = {};
  for (const [id, fields] of events) {
    const event = parseEntry(fields);
    order = applyEvent(order, event);  // Pure function: (state, event) => state
  }
  return order as Order;
}

function applyEvent(state: Partial<Order>, event: AnyEvent): Partial<Order> {
  switch (event.eventType) {
    case 'order.placed':
      return { ...state, id: event.orderId, status: 'placed', total: event.total };
    case 'payment.captured':
      return { ...state, status: 'paid', chargeId: event.chargeId };
    case 'order.shipped':
      return { ...state, status: 'shipped', trackingId: event.trackingId };
    default:
      return state;
  }
}
```

Event sourcing has powerful benefits: full audit log, ability to replay
history, temporal queries ("what was the state at 2pm yesterday?"), and
easy integration with multiple consumers. It also has real costs: more
complex read models, need for "snapshots" for high-event-count aggregates,
and harder to query across multiple aggregates.

Redis Streams are a natural fit for event sourcing at moderate scale.
At large scale, Kafka is preferred because of its superior retention
and query capabilities.

---

## Idempotency Keys

An idempotency key is a client-generated identifier that uniquely
identifies a specific operation. If you retry the same operation with
the same idempotency key, the server returns the original result instead
of performing the operation again.

This is the practical mechanism for achieving exactly-once semantics
at the application level, even over at-least-once transport.

```typescript
// Client sends idempotency key with each request
// If the request is retried, same key → same result

// Server implementation:
app.post('/orders', async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }

  // Check if we've already processed this request
  const cacheKey = `idempotency:orders:${idempotencyKey}`;
  const existing = await redis.get(cacheKey);

  if (existing) {
    // Return the original result — no side effects
    console.log(`Returning cached result for idempotency key ${idempotencyKey}`);
    return res.status(200).json(JSON.parse(existing));
  }

  // Mark as in-flight to prevent concurrent duplicate processing
  const acquired = await redis.set(cacheKey, '__in_flight__', 'NX', 'EX', 30);
  if (!acquired) {
    return res.status(409).json({ error: 'Request with this idempotency key is already being processed' });
  }

  try {
    // Process the request
    const order = await createOrder(req.body);
    const result = { orderId: order.id, status: 'created' };

    // Store the result with a 24-hour TTL
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);

    return res.status(201).json(result);
  } catch (err) {
    // On failure, remove the in-flight marker so retries can proceed
    await redis.del(cacheKey);
    throw err;
  }
});
```

Stripe's API uses idempotency keys exactly this way. The client generates
a random key (UUID) for each logical operation. Retries use the same key.
The server guarantees that the operation's side effects happen at most once.

---

## Redis Cluster: Sharding at Scale

A single Redis instance is limited by the RAM of one machine and the
throughput of one CPU. Redis Cluster provides horizontal scaling by
sharding data across multiple nodes.

### How Sharding Works

Redis Cluster uses consistent hashing with 16,384 "slots." Each key maps
to a slot based on its hash. Slots are distributed among master nodes
(each master owns a range of slots). Slave nodes replicate their master
for failover.

```
Cluster of 3 masters:
  Node A: slots 0–5460      (keys like 'user:1', 'user:2'...)
  Node B: slots 5461–10922  (keys like 'order:5', 'session:abc'...)
  Node C: slots 10923–16383 (keys like 'product:x', 'rate:xyz'...)
```

The client computes `CRC16(key) % 16384` to determine which node to
contact. The `ioredis` cluster client does this automatically.

### Hash Tags: Keeping Related Keys on the Same Node

If you need to run multi-key commands (`MGET`, pipelines, transactions)
across keys that must be on the same node, use hash tags. The part of
the key inside `{}` is used for slot assignment:

```typescript
// Without hash tags: may be on different nodes
await redis.mget('user:123', 'user:456');  // Might fail in cluster mode

// With hash tags: same slot because same {}
await redis.mget('{user:123}:profile', '{user:123}:settings');
// Both keys hash to the slot for 'user:123'
```

### Using Redis Cluster with ioredis

```typescript
import { Cluster } from 'ioredis';

const cluster = new Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 },
], {
  redisOptions: {
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  },
});

// Regular commands work transparently — client routes to correct node
await cluster.set('user:123:name', 'Alice');
const name = await cluster.get('user:123:name');
```

**Cluster limitations:**
- Lua scripts are limited to keys that all map to the same slot
- Multi-key commands require all keys to be in the same slot
- BullMQ requires cluster mode setup with key prefixes to ensure queue
  keys land on the same slot

---

## Redis Sentinel: Automatic Failover

For deployments that don't need horizontal scaling (data fits in one
machine's RAM) but do need high availability, Redis Sentinel provides
automatic failover without the complexity of Cluster.

Sentinel monitors master and replica nodes. When a master fails, Sentinel
promotes a replica to master and updates clients automatically.

```typescript
import IORedis from 'ioredis';

const redis = new IORedis({
  sentinels: [
    { host: 'sentinel-1', port: 26379 },
    { host: 'sentinel-2', port: 26379 },
    { host: 'sentinel-3', port: 26379 },
  ],
  name: 'mymaster',   // The name of the master in Sentinel config
  password: process.env.REDIS_PASSWORD,
});
```

The client connects to Sentinel nodes to discover the current master's
address. If the master changes (failover), the client reconnects to the
new master.

**Sentinel vs Cluster:**
- Sentinel: single master, automatic failover. Good for HA on one machine's worth of data.
- Cluster: multiple masters, horizontal scaling. Required when data exceeds one machine.

---

## Monitoring Redis in Production

### Memory Monitoring

Memory is Redis's most critical resource. Track `used_memory_human` and
compare it to `maxmemory`. At 80%, investigate growth. At 95%, data loss
(eviction) is imminent.

```typescript
const info = await redis.info('memory');
// Parse the INFO output:
const lines = info.split('\r\n');
const memInfo: Record<string, string> = {};
for (const line of lines) {
  if (line.includes(':')) {
    const [key, value] = line.split(':');
    memInfo[key] = value;
  }
}

console.log({
  usedMemory: memInfo['used_memory_human'],
  maxMemory: memInfo['maxmemory_human'],
  evictedKeys: memInfo['evicted_keys'],
  hitRate: Number(memInfo['keyspace_hits']) /
           (Number(memInfo['keyspace_hits']) + Number(memInfo['keyspace_misses'])),
});
```

### Latency Monitoring

Redis should be fast. If P99 latency exceeds 1-2ms for your local
network, something is wrong (big keyspace scans, Lua scripts running too long,
memory pressure causing swap).

```typescript
// Slowlog: commands that took longer than slowlog-log-slower-than microseconds
const slowlog = await redis.slowlog('GET', 10);
// Returns [[id, timestamp, duration_us, command_args], ...]
```

### Hit Rate

For caches, the hit rate (cache hits / (cache hits + misses)) should be
above 90% for a healthy cache. A low hit rate means you're not caching
the right things, or your TTLs are too short.

```typescript
async function getCacheHitRate(): Promise<number> {
  const info = await redis.info('stats');
  const hits = Number(/keyspace_hits:(\d+)/.exec(info)?.[1] ?? 0);
  const misses = Number(/keyspace_misses:(\d+)/.exec(info)?.[1] ?? 0);
  const total = hits + misses;
  return total === 0 ? 0 : hits / total;
}
```

---

## Common Redis Antipatterns

These are the mistakes that show up in production postmortems.

### The KEYS Command in Production

`KEYS pattern` scans all keys in the keyspace matching a pattern. It's
O(n) where n is the total number of keys. On a production Redis with
millions of keys, this blocks the entire server for hundreds of milliseconds.
That means every other client's commands are delayed.

```typescript
// NEVER do this in production:
const allSessions = await redis.keys('session:*');

// Use SCAN instead — iterates in batches, non-blocking:
async function* scanKeys(pattern: string): AsyncGenerator<string> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) yield key;
  } while (cursor !== '0');
}

// Usage:
for await (const key of scanKeys('session:*')) {
  // Process one key at a time — non-blocking
}
```

### Huge Values

Storing large objects in Redis (JSON blobs > 1MB, large lists, huge sorted
sets) creates latency spikes. Redis is single-threaded — serializing and
transferring a 10MB value blocks all other commands during that transfer.

The rule: Redis values should be small (< 100KB for most use cases). If
you need to store large objects, store them in S3 or your database and
keep a reference (URL, ID) in Redis.

### No TTL on Cache Keys

Cache keys without TTL grow indefinitely. Your Redis instance fills up
and you get evictions — or worse, if `maxmemory-policy` is `noeviction`,
write errors.

Every cache key must have a TTL. The only exception: data that you
explicitly manage the lifecycle of (like BullMQ job data — BullMQ sets
its own retention).

```typescript
// BAD: no TTL
await redis.set(`profile:${userId}`, JSON.stringify(profile));

// GOOD: always set TTL
await redis.set(`profile:${userId}`, JSON.stringify(profile), 'EX', 3600);
```

### Storing Passwords or Secrets

Redis is an in-memory store often shared across many application components.
It's not appropriate for storing secrets or passwords. If an attacker gets
access to your Redis instance (which is more common than you'd think —
many Redis deployments are accidentally exposed), they get all your secrets.

Store secrets in a dedicated secrets manager (AWS Secrets Manager, HashiCorp
Vault, etc.) or at minimum in your database (encrypted at rest). Never in Redis.

### Using Redis as a Primary Database

Redis's persistence model has inherent limits. AOF provides good durability,
but Redis is not a relational database. It has no JOIN, no constraints, no
ACID transactions across multiple keys. Using Redis to store user data,
financial records, or any authoritative state that requires referential
integrity is a recipe for data corruption.

Redis is a complement to your database, not a replacement.

---

## Exercises

### Exercise 1: Outbox Pattern Implementation

Implement the outbox pattern for a `createUser` operation:

1. Create the `users` and `outbox` tables in SQLite (using better-sqlite3)
2. Write `createUser(data)` that inserts the user and an `outbox` record
   in one transaction
3. Write an `OutboxProcessor` class that:
   - Polls every 500ms for unpublished records
   - Publishes them to a Redis Stream (`user-events`)
   - Marks them as published
   - Increments `attempts` on failure (max 5 attempts before giving up)
4. Write a consumer that reads from `user-events` and logs the events

Verify: kill the Redis connection before the outbox processor runs and
confirm the user record exists in SQLite but the event is not published.
Then restore Redis and confirm the event is eventually published.

### Exercise 2: Idempotency Middleware

Build a reusable Express middleware `idempotent(ttlSeconds)` that:
- Reads the `Idempotency-Key` header
- Returns 400 if the header is missing
- Returns the cached response if the key has been seen before (within TTL)
- Processes the request if it's new
- Stores the response (status code + body) in Redis with the given TTL

Test it with a route that creates an order. Verify that sending the same
idempotency key twice:
- Only creates one order in the database
- Returns the same order ID both times
- Logs a "cache hit" message on the second call

### Exercise 3: Simple Saga

Implement a three-step choreography saga for an e-commerce order:

Events:
1. `order.placed` → triggers `inventory.reserve`
2. `inventory.reserved` → triggers `payment.charge`
3. `payment.failed` → triggers `inventory.release` (compensating transaction)
4. `payment.captured` → triggers `fulfillment.notify`

Each step should:
- Be implemented as a consumer group on the relevant stream
- Log what it's doing
- Have a 20% chance of failure (for testing compensation)
- Be idempotent

Run the saga 5 times and observe: how often does the full happy path
complete? How often does compensation run? Verify no orders are left
in an inconsistent state.

### Exercise 4: Redis Monitoring Dashboard

Build a simple monitoring script that runs every 10 seconds and prints:

```
Redis Health Check — 2024-01-15T09:00:00Z
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Memory: 45.2MB / 256MB (17.6%)
Evictions: 0 keys
Cache hit rate: 94.2%
Connected clients: 12
Commands/sec: 2,847
P99 latency: 0.3ms
Keyspace: 45,231 keys

Slowlog (last 5):
  [1234ms] XRANGE orders - + COUNT 10000
  [892ms]  KEYS session:*    ← ANTIPATTERN DETECTED
  [45ms]   HGETALL user:bigprofile
```

The script should:
- Parse `INFO all` output
- Detect slowlog entries > 100ms and flag them as warnings
- Detect if `KEYS` appears in the slowlog (antipattern alert)
- Exit with status code 1 if any critical threshold is exceeded

### Exercise 5: Cluster Simulation with Slots

Without a real Redis Cluster, implement a toy "consistent hashing" layer
over multiple Redis instances (use different databases on the same instance
with `redis.select()` to simulate separate nodes):

1. Implement `CRC16(key)` and `slot = CRC16(key) % 16384`
2. Map slots to 3 "nodes" (databases 0, 1, 2)
3. Write `clusterGet(key)` and `clusterSet(key, value)` that route to
   the correct node
4. Verify that all operations for `user:123` go to the same node
5. Test that multi-key operations across different slots raise an error
   (or implement a workaround using hash tags)
