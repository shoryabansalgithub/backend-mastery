# Lesson 3: Redis Streams in Depth

## What Makes Streams Different

When we covered Redis Pub/Sub in the last lesson, the central limitation
was clear: if no subscriber is connected, the message disappears. Pub/Sub
is live radio — you have to be listening when it broadcasts. Redis Streams
are more like a recording. Messages are appended to a persistent log.
Consumers can read from any position: from the beginning, from the current
end, from a specific offset. If a consumer disconnects and reconnects, it
resumes from where it left off.

This single property — persistence with position tracking — is what
separates Redis Streams from Pub/Sub, and what makes Streams suitable
for reliable messaging, event sourcing, and audit logs.

Redis Streams are internally represented as a radix tree of macro-nodes,
where each macro-node contains a compressed list of entries. This gives
O(log n) entry lookup and O(1) append. For practical purposes, appending
to a stream is fast and reads are sequential.

---

## Stream Entry IDs

Every entry in a Redis Stream has a unique ID. The default ID format is:

```
<millisecondsTimestamp>-<sequenceNumber>
```

For example: `1699900000000-0` means "the first entry added at Unix timestamp
1699900000000 milliseconds."

If two entries are added in the same millisecond, the sequence number
increments: `1699900000000-0`, `1699900000000-1`, etc.

This design provides:
1. Natural ordering — IDs increase monotonically
2. Time-based queries — "give me all entries after timestamp T"
3. Uniqueness without a central ID allocator

You can also specify custom IDs, but auto-generated IDs are correct 99%
of the time. The special ID `*` tells Redis to auto-generate.

---

## XADD: Adding Entries

```typescript
import IORedis from 'ioredis';
const redis = new IORedis();

// XADD stream-name * field1 value1 field2 value2 ...
// Returns the generated entry ID

const entryId = await redis.xadd(
  'orders',          // stream name
  '*',               // auto-generate ID
  'orderId', 'ord-42',
  'userId', 'usr-123',
  'total', '9900',
  'currency', 'usd',
  'status', 'placed'
);

console.log(entryId);
// e.g., '1699900000000-0'

// XADD with MAXLEN — trim stream to at most N entries (approximate)
const entryId2 = await redis.xadd(
  'orders',
  'MAXLEN', '~', '10000',  // ~ means approximate (faster)
  '*',
  'orderId', 'ord-43',
  'total', '5000'
);
```

The `MAXLEN ~` option tells Redis to trim the stream to approximately
10,000 entries. The `~` means "at least 10,000" — Redis may keep more
for efficiency, but guarantees the stream won't grow unboundedly.

---

## XREAD: Simple Reading

`XREAD` is the basic read command. It reads entries from one or more
streams, starting from a given ID.

```typescript
// Read up to 10 entries from the beginning of 'orders'
const entries = await redis.xread(
  'COUNT', 10,
  'STREAMS',
  'orders',
  '0'         // Start from the very beginning
);

// Format: [[streamName, [[id, [field, value, ...]], ...]]]
if (entries) {
  const [streamName, messages] = entries[0];
  for (const [id, fields] of messages) {
    // fields is ['field1', 'value1', 'field2', 'value2', ...]
    const obj = fieldsToObject(fields);
    console.log(id, obj);
  }
}

// Helper to convert flat array to object
function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

// Read new entries since last read ($ = entries added after this point)
const newEntries = await redis.xread(
  'BLOCK', 5000,   // Wait up to 5 seconds for new entries
  'COUNT', 100,
  'STREAMS',
  'orders',
  '$'              // Only entries added after XREAD call
);
```

`BLOCK 0` waits indefinitely. `BLOCK 5000` waits up to 5000ms and returns
null if no entries arrive. The blocking form is how you implement efficient
polling without spin-looping.

---

## Consumer Groups: The Core of Reliable Streaming

A consumer group is a named bookmark into a stream. Multiple consumers
within the group each process different entries — entries are distributed
among group members. The group tracks which entries have been acknowledged.
Unacknowledged entries remain in the Pending Entries List (PEL).

The key operations for consumer groups:

### XGROUP CREATE: Initialize a Group

```typescript
// Create a consumer group on the 'orders' stream
// '$' means: start processing new entries (ignore existing)
// '0' means: start from the very beginning
await redis.xgroup('CREATE', 'orders', 'inventory-service', '$', 'MKSTREAM');

// MKSTREAM creates the stream if it doesn't exist yet
// Use '0' to process existing entries from the beginning:
await redis.xgroup('CREATE', 'orders', 'payments-service', '0');
```

**Important design decision:** Should your consumer group start at `$` (now)
or `0` (beginning)?

- `$` — for new deployments where you don't want to reprocess historical events
- `0` — for catching up with backlog, or for a new service that needs all history

Create consumer groups before starting producers, or use `MKSTREAM` and
start groups at `$`. Never create a group in the middle of processing —
you'll skip entries.

### XREADGROUP: Read as a Consumer

```typescript
// Read entries as a specific consumer within a group
const entries = await redis.xreadgroup(
  'GROUP',
  'inventory-service',    // Group name
  'worker-1',             // Consumer name (can be hostname/pod name)
  'COUNT', 10,
  'BLOCK', 5000,          // Wait up to 5s for new entries
  'STREAMS',
  'orders',
  '>'                     // '>' means: entries not yet delivered to any consumer
);

if (entries) {
  const [streamName, messages] = entries[0];
  for (const [id, fields] of messages) {
    const entry = fieldsToObject(fields);
    console.log(`Processing entry ${id}:`, entry);

    try {
      await processOrder(entry);

      // Acknowledge successful processing
      await redis.xack('orders', 'inventory-service', id);
      console.log(`Acknowledged ${id}`);
    } catch (err) {
      console.error(`Failed to process ${id}:`, err.message);
      // Do NOT acknowledge — entry stays in PEL for retry
    }
  }
}
```

The `>` ID is special: it means "deliver entries that no consumer in this
group has received yet." After delivery, entries enter the Pending Entries
List (PEL) for the consumer that received them, until acknowledged.

### What "Acknowledging" Means

Acknowledgment (`XACK`) signals to the group that a specific entry has
been successfully processed. Once acknowledged:
- The entry is removed from the PEL (but remains in the stream)
- Other consumers in the group won't receive it
- The group's "last delivered ID" may advance

Without acknowledgment, the entry stays in the PEL. If the consumer
crashes, the entry can be claimed by another consumer after a timeout.
This is the at-least-once delivery guarantee.

---

## The Pending Entries List (PEL)

The PEL is per-consumer, per-group. It lists all entries delivered to
a consumer but not yet acknowledged. You can inspect it with `XPENDING`:

```typescript
// Get a summary of pending entries for the group
const summary = await redis.xpending(
  'orders',
  'inventory-service'
);
// Returns: [total, minId, maxId, [[consumerName, count], ...]]

// Get detailed info about specific pending entries
const pendingDetails = await redis.xpending(
  'orders',
  'inventory-service',
  '-',      // From (min ID)
  '+',      // To (max ID)
  10        // Count
);
// Returns: [[id, consumerName, idleTimeMs, deliveryCount], ...]
```

The `idleTimeMs` field tells you how long the entry has been in the PEL
without acknowledgment. The `deliveryCount` tells you how many times the
entry has been delivered (1 for fresh, >1 for re-delivered after a claim).

---

## XCLAIM: Recovering Stuck Messages

When a consumer crashes mid-processing, its PEL entries are stuck. They
won't be automatically re-delivered. You must claim them using `XCLAIM`.

```typescript
// Claim entries that have been idle for more than 30 seconds
// (i.e., the consumer that received them hasn't acked in 30s)

async function claimStalePendingEntries(
  stream: string,
  group: string,
  newConsumer: string,
  minIdleTimeMs: number
): Promise<void> {
  // First, find pending entries
  const pending = await redis.xpending(
    stream, group, '-', '+', 100
  ) as Array<[string, string, number, number]>;

  for (const [id, originalConsumer, idleTime, deliveryCount] of pending) {
    if (idleTime < minIdleTimeMs) continue;

    // Check if this entry has been attempted too many times
    if (deliveryCount > 5) {
      console.error(`Entry ${id} has been delivered ${deliveryCount} times — possible poison message`);
      // Move to a dead letter stream or acknowledge and discard
      await redis.xadd(
        `${stream}:dead`,
        '*',
        'originalId', id,
        'originalConsumer', originalConsumer,
        'deliveryCount', String(deliveryCount),
        'claimedBy', newConsumer
      );
      await redis.xack(stream, group, id);
      continue;
    }

    // Claim the entry — takes ownership from originalConsumer
    const claimed = await redis.xclaim(
      stream,
      group,
      newConsumer,
      minIdleTimeMs,
      id
    );

    if (claimed && claimed.length > 0) {
      console.log(`Claimed entry ${id} from ${originalConsumer}`);
      // Process it
      const entry = fieldsToObject(claimed[0][1] as string[]);
      try {
        await processOrder(entry);
        await redis.xack(stream, group, id);
      } catch (err) {
        console.error(`Failed to process claimed entry ${id}`);
      }
    }
  }
}

// Run this periodically in a separate "monitor" process
setInterval(
  () => claimStalePendingEntries('orders', 'inventory-service', 'monitor-1', 30_000),
  10_000
);
```

`XAUTOCLAIM` (Redis 6.2+) combines `XPENDING` + `XCLAIM` into a single
command, more efficiently:

```typescript
// Auto-claim entries idle for more than 30 seconds, take up to 10
const [nextId, claimed] = await redis.xautoclaim(
  'orders',
  'inventory-service',
  'monitor-1',
  30_000,    // minIdleTime in ms
  '0-0',     // Start scanning from the beginning of PEL
  'COUNT', 10
) as [string, Array<[string, string[]]>];

for (const [id, fields] of claimed) {
  await processAndAck(id, fieldsToObject(fields));
}
```

---

## Stream Trimming

Without trimming, a Redis stream grows indefinitely. Use `MAXLEN` to keep
the stream size bounded. There are two strategies:

**Length-based trimming:** Keep the last N entries.

```typescript
// Trim to approximately 100,000 entries during XADD
await redis.xadd('orders', 'MAXLEN', '~', '100000', '*', 'field', 'value');

// Or explicitly trim an existing stream
await redis.xtrim('orders', 'MAXLEN', '~', '100000');
```

**Time-based trimming:** Keep entries newer than a given ID (since IDs
encode timestamps, you can compute a cutoff ID):

```typescript
// Keep only entries from the last 7 days
const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
const cutoffId = `${sevenDaysAgo}-0`;
await redis.xtrim('orders', 'MINID', '~', cutoffId);
```

**The ~ (tilde) is critical.** Without it, Redis trims exactly to N entries
on every XADD, which requires examining the stream length on every write.
With `~`, Redis only trims when a radix tree node is full, making it much
more efficient. Use `~` always unless you have strict size requirements.

---

## Full Example: Order Processing Pipeline

Let's build a complete order processing system with three independent
consumer groups: inventory, payments, and notifications.

```typescript
// src/streams/order-pipeline.ts
import IORedis from 'ioredis';

const redis = new IORedis();

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderEntry {
  orderId: string;
  userId: string;
  total: string;        // cents as string (Redis values are strings)
  currency: string;
  status: string;
  createdAt: string;
}

function parseEntry(fields: string[]): OrderEntry {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj as OrderEntry;
}

// ─── Producer: Add Order to Stream ────────────────────────────────────────────

export async function publishOrder(order: Omit<OrderEntry, 'status' | 'createdAt'>): Promise<string> {
  const id = await redis.xadd(
    'orders',
    'MAXLEN', '~', '100000',
    '*',
    'orderId', order.orderId,
    'userId', order.userId,
    'total', order.total,
    'currency', order.currency,
    'status', 'placed',
    'createdAt', new Date().toISOString()
  );

  console.log(`[Producer] Published order ${order.orderId} as entry ${id}`);
  return id;
}

// ─── Consumer Group Setup ─────────────────────────────────────────────────────

export async function initializeConsumerGroups(): Promise<void> {
  const groups = [
    'inventory-service',
    'payments-service',
    'notifications-service',
  ];

  for (const group of groups) {
    try {
      await redis.xgroup('CREATE', 'orders', group, '$', 'MKSTREAM');
      console.log(`Created consumer group: ${group}`);
    } catch (err: any) {
      if (err.message.includes('BUSYGROUP')) {
        console.log(`Consumer group already exists: ${group}`);
      } else {
        throw err;
      }
    }
  }
}

// ─── Generic Consumer Loop ────────────────────────────────────────────────────

async function runConsumer(
  group: string,
  consumer: string,
  processor: (entry: OrderEntry, id: string) => Promise<void>
): Promise<void> {
  console.log(`[${group}/${consumer}] Starting consumer loop`);

  while (true) {
    try {
      const result = await redis.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', 10,
        'BLOCK', 5000,
        'STREAMS', 'orders', '>'
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!result) continue;  // Timeout, no new entries

      const [, messages] = result[0];

      for (const [id, fields] of messages) {
        const entry = parseEntry(fields);

        try {
          await processor(entry, id);
          await redis.xack('orders', group, id);
          console.log(`[${group}/${consumer}] Acknowledged ${id}`);
        } catch (err: any) {
          console.error(`[${group}/${consumer}] Failed to process ${id}: ${err.message}`);
          // Don't ack — will be in PEL for claiming
        }
      }
    } catch (err: any) {
      if (err.message === 'Connection is closed.') break;
      console.error(`[${group}/${consumer}] Consumer error:`, err.message);
      await new Promise(r => setTimeout(r, 1000));  // Brief pause before retry
    }
  }
}

// ─── Inventory Consumer ───────────────────────────────────────────────────────

async function checkInventory(entry: OrderEntry, entryId: string): Promise<void> {
  // Idempotency check: has this order already been processed by inventory?
  const processed = await redis.get(`inventory:processed:${entry.orderId}`);
  if (processed) {
    console.log(`[Inventory] Order ${entry.orderId} already processed, skipping`);
    return;
  }

  // Simulate inventory check (300-700ms)
  await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

  const inStock = Math.random() > 0.1;  // 90% chance in stock

  if (!inStock) {
    // Publish an inventory.failed event
    await redis.xadd(
      'inventory-events',
      '*',
      'orderId', entry.orderId,
      'event', 'inventory_failed',
      'reason', 'out_of_stock'
    );
    throw new Error(`Inventory unavailable for order ${entry.orderId}`);
  }

  // Mark as reserved
  await redis.set(`inventory:processed:${entry.orderId}`, '1', 'EX', 86400);
  console.log(`[Inventory] Reserved inventory for order ${entry.orderId}`);
}

// ─── Payment Consumer ─────────────────────────────────────────────────────────

async function processPayment(entry: OrderEntry, entryId: string): Promise<void> {
  const processed = await redis.get(`payments:processed:${entry.orderId}`);
  if (processed) {
    console.log(`[Payments] Order ${entry.orderId} already charged, skipping`);
    return;
  }

  // Simulate payment processing (500-1500ms)
  await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

  const paymentSucceeded = Math.random() > 0.05;  // 95% success

  if (!paymentSucceeded) {
    await redis.xadd(
      'payment-events',
      '*',
      'orderId', entry.orderId,
      'event', 'payment_failed',
      'reason', 'card_declined'
    );
    throw new Error(`Payment failed for order ${entry.orderId}`);
  }

  const chargeId = `ch_${Math.random().toString(36).slice(2, 10)}`;
  await redis.set(`payments:processed:${entry.orderId}`, chargeId, 'EX', 86400);
  console.log(`[Payments] Charged ${entry.total} ${entry.currency} for order ${entry.orderId}`);
}

// ─── Notification Consumer ────────────────────────────────────────────────────

async function sendNotification(entry: OrderEntry, entryId: string): Promise<void> {
  const processed = await redis.get(`notifications:processed:${entry.orderId}`);
  if (processed) {
    console.log(`[Notifications] Confirmation already sent for ${entry.orderId}`);
    return;
  }

  // Simulate email sending (200-600ms)
  await new Promise(r => setTimeout(r, 200 + Math.random() * 400));

  await redis.set(`notifications:processed:${entry.orderId}`, '1', 'EX', 86400);
  console.log(`[Notifications] Sent confirmation for order ${entry.orderId} to user ${entry.userId}`);
}

// ─── Start All Consumers ──────────────────────────────────────────────────────

export async function startConsumers(): Promise<void> {
  await initializeConsumerGroups();

  // Each consumer uses its own Redis connection
  const inventoryRedis = new IORedis();
  const paymentsRedis = new IORedis();
  const notificationsRedis = new IORedis();

  // Run concurrently — each consumer loop is independent
  await Promise.all([
    runConsumer('inventory-service', 'worker-1', checkInventory),
    runConsumer('payments-service', 'worker-1', processPayment),
    runConsumer('notifications-service', 'worker-1', sendNotification),
  ]);
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function demo(): Promise<void> {
  await initializeConsumerGroups();

  // Start consumers in the background
  startConsumers().catch(console.error);

  // Publish some orders
  for (let i = 1; i <= 5; i++) {
    await publishOrder({
      orderId: `order-${i.toString().padStart(4, '0')}`,
      userId: `user-${(Math.floor(Math.random() * 100) + 1).toString().padStart(3, '0')}`,
      total: String(Math.floor(Math.random() * 10000) + 1000),
      currency: 'usd',
    });
    await new Promise(r => setTimeout(r, 200));
  }

  // Let consumers process
  await new Promise(r => setTimeout(r, 10_000));

  // Show stream info
  const length = await redis.xlen('orders');
  console.log(`\nStream 'orders' contains ${length} entries`);

  // Show pending entries per group
  for (const group of ['inventory-service', 'payments-service', 'notifications-service']) {
    const pending = await redis.xpending('orders', group) as [number, string, string, any[]];
    console.log(`Group '${group}': ${pending[0]} pending entries`);
  }

  process.exit(0);
}

demo().catch(console.error);
```

---

## Fan-out with Multiple Consumer Groups

The power of consumer groups is that you can add new groups at any time,
and each group gets all messages independently. This is true fan-out.

```typescript
// Add a new analytics consumer group — reads from the beginning
try {
  await redis.xgroup('CREATE', 'orders', 'analytics-service', '0');
} catch (err: any) {
  if (!err.message.includes('BUSYGROUP')) throw err;
}

// This group will now process all historical entries, not just new ones
// The other groups (inventory, payments, notifications) are unaffected
```

Compare this to a traditional queue: adding a new "consumer" to a queue
gives it only new messages. Existing messages have already been consumed.
With Streams, a new consumer group can replay the entire history from `0`.

---

## Redis Streams vs Kafka: An Honest Comparison

| Property | Redis Streams | Kafka |
|----------|--------------|-------|
| Throughput | ~100k-500k msg/s | >1M msg/s |
| Latency | Sub-millisecond | Low millisecond |
| Persistence | Memory-first (RDB/AOF optional) | Disk-first, durable by default |
| Partitioning | None (single log per stream) | Native, key-based |
| Retention | Configurable MAXLEN | Configurable time/size |
| Replay | Yes (within MAXLEN window) | Yes (full retention period) |
| Consumer groups | Yes, with PEL | Yes, with offsets |
| Operational complexity | Low (already have Redis) | High (Kafka + ZooKeeper/KRaft) |
| Schema registry | No | Via Confluent/community |
| Streams per cluster | Many | Many partitions |
| Max entry size | 512MB (Redis string limit) | Configurable, default 1MB |

**Choose Redis Streams when:**
- You already use Redis (BullMQ, caching, sessions)
- Moderate throughput (< 100k msg/s per stream)
- Small team with low operational overhead constraint
- You want replay capability but not Kafka's operational burden

**Choose Kafka when:**
- Very high throughput requirements (millions of events/second)
- Events must be retained for days/weeks for compliance or replay
- Multiple teams consuming the same event streams (Kafka's consumer group
  model is more operationally mature at scale)
- You need partitioned ordering with horizontal producer scaling

**The honest truth:** Most applications never need Kafka. The operational
cost of running Kafka (cluster management, ZooKeeper or KRaft, topic
configuration, monitoring, backup, upgrades) is substantial. Redis Streams
covers 80% of real-world use cases with 10% of the operational burden.

---

## Exercises

### Exercise 1: Stream Command Reference

Write a script that demonstrates each of the following Redis Streams
commands with real data. Use ioredis. For each command, log the full
return value and write a comment explaining what each field means:

- `XADD` with auto-ID and with `MAXLEN ~`
- `XLEN`
- `XRANGE` — read a range of entries
- `XREVRANGE` — read in reverse order
- `XREAD` with `BLOCK 0` in a separate async function (non-blocking read first)
- `XINFO STREAM` — stream metadata
- `XINFO GROUPS` — consumer group info
- `XPENDING` — summary and detailed form

### Exercise 2: Consumer Group Failover

Build a demonstration of consumer group resilience:

1. Start consumer A in group "workers" reading from stream "tasks"
2. Publish 20 tasks
3. Consumer A processes 10 of them, then "crash" (exit the loop without acking)
4. The 10 unacked tasks should be in the PEL
5. Start a "recovery" consumer that uses `XPENDING` to find stuck entries
6. Claim them with `XCLAIM` and process them
7. Verify all 20 tasks are eventually acknowledged

Log the entry IDs and consumer names at each stage to show ownership transfer.

### Exercise 3: Dead Letter Stream

Extend the order processing pipeline to implement a dead letter stream:

1. If an entry in the PEL has `deliveryCount > 3`, move it to `orders:dead`
2. The `orders:dead` stream entry should include: original entry ID, original
   consumer, delivery count, and the original entry fields
3. Build an admin function `listDeadLetterEntries()` that reads all entries
   from `orders:dead` and returns them formatted
4. Build a `replayDeadLetterEntry(deadEntryId)` that reads the entry from
   `orders:dead`, re-adds it to `orders`, and removes it from `orders:dead`

### Exercise 4: Stream as an Audit Log

Implement an audit log for user actions using Redis Streams:

```typescript
// Log any user action
async function logAction(
  userId: string,
  action: string,
  details: Record<string, string>
): Promise<string>

// Query actions for a user (last 50)
async function getUserAuditLog(
  userId: string,
  limit?: number
): Promise<AuditEntry[]>

// Query actions in a time range
async function getAuditLogByTimeRange(
  from: Date,
  to: Date
): Promise<AuditEntry[]>
```

For the time range query, use `XRANGE` with ID-based timestamps.
Demonstrate that the time range query works correctly by adding entries
at known times and querying for a specific window.

### Exercise 5: Throughput Benchmark

Write a benchmark that compares the throughput of:

1. Redis Streams (`XADD`)
2. Redis List (`RPUSH`)
3. BullMQ queue add (for comparison)

For each:
- Publish 10,000 messages as fast as possible
- Measure total time and messages-per-second
- Use pipelining for the direct Redis commands

Then add a consumer to each and measure end-to-end throughput
(producer + consumer together). Report your findings and explain
the tradeoffs you observe.
