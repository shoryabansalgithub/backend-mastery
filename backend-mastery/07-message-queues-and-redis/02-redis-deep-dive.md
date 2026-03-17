# Lesson 2: Redis Deep Dive

## What Redis Actually Is

Redis is not a cache. Or rather, it's not only a cache. Redis is an
in-memory data structure server. The key distinction is "data structure"
— Redis doesn't just store values, it stores typed values with operations
specific to each type. You don't just get and set strings; you push and
pop from lists, add and score members in sorted sets, and publish to
channels that other clients subscribe to.

Redis is also not a full replacement for a relational database. It lacks
transactions that span multiple keys atomically (Redis's `MULTI`/`EXEC`
blocks are closer to batches than ACID transactions), it lacks joins, and
its query model is key-based rather than declarative.

Redis's place in a backend stack: it's the fastest layer. Because all
data lives in memory and the server is single-threaded with an event loop,
Redis can serve hundreds of thousands of operations per second with
consistent sub-millisecond latency. You use it for the things where that
speed matters: caching, session storage, rate limiting counters, queues,
pub/sub, and leaderboards.

---

## The Single-Threaded Event Loop

Redis processes commands using a single-threaded event loop, similar to
Node.js. This is not a limitation — it's a deliberate design choice that
simplifies the data model enormously.

Because all operations are single-threaded, Redis never has race conditions
between commands from different clients (with one exception: Lua scripts,
which we'll cover below). An `INCR` command is atomic. A sorted set
operation is atomic. You never need to worry about two clients seeing
an inconsistent view of a data structure mid-operation.

The practical consequence: Redis operations are individually atomic without
any locking. This makes Redis extremely useful as a coordination layer —
you can use a single Redis command to implement distributed locks, rate
limiters, and deduplication checks.

**Why single-threaded is fast enough:** Redis's bottleneck is almost never
the CPU. It's the network. A single core can handle hundreds of thousands
of Redis operations per second because most of the work is pointer
manipulation and memory reads, not computation. Redis 6.0+ uses threading
for network I/O while keeping the command execution single-threaded.

---

## Data Structures from First Principles

Understanding Redis's data structures is the foundation for using Redis
correctly. Each structure has specific time and space complexities that
determine when to use it.

### String

The simplest type. Stores a sequence of bytes. Despite the name, it can
hold anything: text, serialized JSON, a binary blob, or a number (Redis
can atomically increment numeric strings).

```typescript
import IORedis from 'ioredis';
const redis = new IORedis();

// Basic get/set
await redis.set('user:123:name', 'Alice');
const name = await redis.get('user:123:name');
console.log(name);  // 'Alice'

// With expiry (TTL in seconds)
await redis.set('session:abc123', JSON.stringify({ userId: '123' }), 'EX', 3600);

// Atomic increment — safe even with concurrent clients
await redis.set('counter:pageviews', '0');
await redis.incr('counter:pageviews');  // Atomic: returns 1
await redis.incrby('counter:pageviews', 5);  // Atomic: returns 6

// Conditional set — only set if key does not exist
const set = await redis.set('lock:resource-1', 'owner-1', 'NX', 'EX', 30);
// Returns 'OK' if set, null if key existed
```

**Complexity:** GET/SET O(1). INCR O(1).

**When to use:** Single values, counters, serialized objects, session
data, distributed locks.

### Hash

A hash is a map of string fields to string values, stored under a single
key. Think of it as a flat object. Unlike storing a JSON-encoded string,
a hash lets you update individual fields without reading and rewriting the
entire object.

```typescript
// Store user profile as a hash
await redis.hset('user:123', {
  name: 'Alice',
  email: 'alice@example.com',
  role: 'admin',
  loginCount: '0',
});

// Get a single field
const email = await redis.hget('user:123', 'email');
console.log(email);  // 'alice@example.com'

// Get all fields
const user = await redis.hgetall('user:123');
console.log(user);  // { name: 'Alice', email: '...', role: 'admin', loginCount: '0' }

// Update a single field atomically (no need to read-modify-write)
await redis.hincrby('user:123', 'loginCount', 1);

// Check field existence
const exists = await redis.hexists('user:123', 'email');  // 1 (truthy)
```

**Complexity:** HGET/HSET O(1). HGETALL O(n) where n is the number of fields.

**When to use:** Storing objects where you need to update individual
fields, avoiding serialization/deserialization overhead for partial updates.

### List

A doubly-linked list of strings. Supports O(1) push and pop from both
ends. The canonical use case is a queue or stack.

```typescript
// Push to the right (tail) — standard queue behavior
await redis.rpush('notifications:user:123', 'msg1', 'msg2', 'msg3');

// Pop from the left (head) — FIFO dequeue
const msg = await redis.lpop('notifications:user:123');
console.log(msg);  // 'msg1'

// Blocking pop — wait up to 30 seconds for an item
const item = await redis.blpop('task-queue', 30);
// Returns [key, value] or null on timeout

// Get a range (0 = first, -1 = last)
const allItems = await redis.lrange('notifications:user:123', 0, -1);

// Get the length
const length = await redis.llen('notifications:user:123');
```

**Complexity:** LPUSH/RPUSH/LPOP/RPOP O(1). LRANGE O(S+N) where S is
offset from start and N is number of elements requested.

**When to use:** Queues (RPUSH/LPOP), stacks (RPUSH/RPOP), recent activity
logs (LPUSH + LTRIM to keep last N items).

**Not for:** Queues with multiple consumers (all consumers race for the
same items). Use Streams for that.

### Set

An unordered collection of unique strings. Membership testing is O(1).
The key operations are add, remove, test membership, and set operations
(union, intersection, difference).

```typescript
// Add members
await redis.sadd('user:123:following', 'user:456', 'user:789', 'user:101');

// Test membership
const isFollowing = await redis.sismember('user:123:following', 'user:456');
console.log(isFollowing);  // 1 (truthy)

// Get all members
const following = await redis.smembers('user:123:following');

// Set operations
await redis.sadd('user:456:following', 'user:789', 'user:202');

// Who do both users follow? (intersection)
const mutualFollowing = await redis.sinter(
  'user:123:following',
  'user:456:following'
);
console.log(mutualFollowing);  // ['user:789']

// Remove a member
await redis.srem('user:123:following', 'user:789');

// Random member (for random selection)
const randomMember = await redis.srandmember('user:123:following');
```

**Complexity:** SADD/SREM/SISMEMBER O(1). SMEMBERS O(n).
SINTER O(n*m) where n is the smallest set size.

**When to use:** Unique collections, social graphs (followers/following),
tags, feature flags (which users have feature X enabled).

### Sorted Set

Like a Set but each member has a score (a floating-point number). Members
are stored in sorted order by score. You can query by score range, get
the rank of a member, or iterate in order. This is one of Redis's most
powerful and unique data structures.

```typescript
// Add members with scores (score = timestamp or any numeric value)
await redis.zadd('leaderboard:game-1', [
  100, 'user:alice',
  85, 'user:bob',
  120, 'user:charlie',
  85, 'user:diana',
]);

// Get top 3 (highest score first: 'ZREVRANGEBYSCORE')
const top3 = await redis.zrange('leaderboard:game-1', 0, 2, 'REV');
console.log(top3);  // ['user:charlie', 'user:alice', 'user:bob' or 'user:diana']

// Get rank (0-indexed, lowest score = rank 0)
const rank = await redis.zrank('leaderboard:game-1', 'user:alice');
const revRank = await redis.zrevrank('leaderboard:game-1', 'user:alice');

// Get score
const score = await redis.zscore('leaderboard:game-1', 'user:alice');
console.log(score);  // '100'

// Get members with scores in a range
const midScorers = await redis.zrangebyscore(
  'leaderboard:game-1',
  80, 110,
  'WITHSCORES'
);

// Increment score atomically
await redis.zincrby('leaderboard:game-1', 5, 'user:bob');
```

**Complexity:** ZADD O(log n). ZRANGE O(log n + k) where k is elements
returned. ZRANK O(log n).

**When to use:** Leaderboards, priority queues, time-series with range
queries (score = timestamp), rate limiting windows (score = timestamp,
members = request IDs).

### Stream

The newest and most complex Redis data structure. A Redis Stream is an
append-only log of entries, where each entry has an auto-generated
time-based ID and a set of field-value pairs. Consumer groups allow
multiple independent consumers to track their position in the stream.

We cover Streams in full depth in Lesson 3.

---

## Persistence: Durability Tradeoffs

Redis stores all data in memory. If the process restarts without any
persistence configured, all data is lost. Redis offers three approaches
to durability, each with different performance and safety tradeoffs.

### No Persistence

All data is ephemeral. If Redis restarts, everything is gone. This is
appropriate for pure caches where the source of truth is elsewhere.
It gives maximum performance because Redis never writes to disk.

```
Restart → all data lost
Write throughput: maximum (no disk I/O)
Recovery time: instant (nothing to load)
```

### RDB (Redis Database) Snapshots

Redis forks the process and dumps a point-in-time snapshot to disk.
The snapshot is a compact binary file. On restart, Redis loads the
snapshot and reconstructs the in-memory state.

```
# redis.conf
save 900 1       # Save if at least 1 change in 900 seconds
save 300 10      # Save if at least 10 changes in 300 seconds
save 60 10000    # Save if at least 10000 changes in 60 seconds
```

**Pros:** Compact file, fast restart, no performance impact during
normal operation (fork is fast, background process writes to disk).

**Cons:** You can lose up to `save interval` worth of data on crash.
If you've configured `save 60 10000`, you can lose up to 60 seconds
of writes. The fork operation uses copy-on-write memory, but with very
large datasets, the fork itself can cause a brief pause.

### AOF (Append-Only File)

Every write command is logged to a file. On restart, Redis replays the
log to reconstruct state. Depending on the `appendfsync` setting, this
can be configured for different durability levels:

```
# redis.conf
appendonly yes
appendfsync everysec    # Flush to disk every second (default, recommended)
# appendfsync always   # Flush after every command (safest, slowest)
# appendfsync no       # Let OS decide (fastest, least safe)
```

With `everysec`, you can lose at most 1 second of writes on crash.
With `always`, you lose nothing but pay a significant throughput penalty.

AOF files grow over time. Redis periodically rewrites the AOF, compacting
it into a minimal set of commands that produce the current state.

**Pros:** More durable than RDB (especially with `everysec`).

**Cons:** Larger files than RDB. Restart is slower (must replay the log).
Slightly lower throughput than RDB or no-persistence.

### RDB + AOF Combined

You can enable both. On restart, Redis prefers the AOF (more recent data)
and falls back to RDB if AOF is missing or corrupted. This is the
recommended production configuration when durability matters.

### The Decision

| Use case | Recommendation |
|----------|----------------|
| Pure cache (Redis backed by DB) | No persistence |
| Session storage (can tolerate some loss) | RDB |
| Job queue (BullMQ) | RDB + AOF |
| Event log (Streams) | AOF with `everysec` |
| Financial data | AOF with `always` |

---

## Expiry and Eviction Policies

### Key Expiry (TTL)

You can attach a TTL (time-to-live) to any key. Redis removes it when
the TTL expires. This is fundamental for caching.

```typescript
// Set with TTL in seconds
await redis.set('session:abc', data, 'EX', 3600);      // 1 hour

// Set with TTL in milliseconds
await redis.set('rate:user:123', '0', 'PX', 60_000);   // 1 minute

// Set TTL on an existing key
await redis.expire('some:key', 300);

// Get remaining TTL
const ttl = await redis.ttl('session:abc');     // seconds, -1 = no expiry, -2 = gone
const pttl = await redis.pttl('session:abc');   // milliseconds
```

### Eviction Policies

When Redis's memory limit (`maxmemory`) is reached, it needs to decide
what to delete to make room. The `maxmemory-policy` configuration controls
this behavior.

```
# redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
```

| Policy | Description | When to use |
|--------|-------------|-------------|
| `noeviction` | Return error on write when full | Queues — never lose data |
| `allkeys-lru` | Evict least recently used keys | General cache |
| `allkeys-lfu` | Evict least frequently used keys | Cache with hot/cold data |
| `volatile-lru` | Evict LRU keys that have a TTL | Mixed cache/persistent data |
| `volatile-ttl` | Evict keys with shortest TTL | When TTL reflects importance |
| `allkeys-random` | Evict random keys | Never use this |

**LRU vs LFU:** LRU (Least Recently Used) evicts keys that haven't been
accessed recently. It works well for temporal locality — recently used
data is likely to be used again. LFU (Least Frequently Used) evicts keys
that are accessed rarely. It works better when some keys are always hot
(many accesses over their lifetime) and others are rarely accessed.

For BullMQ: use `noeviction`. Evicting queue data would silently lose jobs.

For caches: use `allkeys-lru` or `allkeys-lfu` depending on your access
patterns.

---

## Pub/Sub: Fire-and-Forget Broadcasting

Redis Pub/Sub is the simplest form of messaging in Redis. Clients
subscribe to channels; publishers send messages to channels; subscribed
clients receive them.

```typescript
import IORedis from 'ioredis';

// Subscriber — uses its own connection (blocked in subscribe mode)
const subscriber = new IORedis();
await subscriber.subscribe('notifications:user:123', 'system:alerts');

subscriber.on('message', (channel, message) => {
  console.log(`[${channel}] ${message}`);
});

// Publisher — uses a separate connection
const publisher = new IORedis();
await publisher.publish('notifications:user:123', JSON.stringify({
  type: 'friend_request',
  from: 'user:456',
}));
```

**The critical limitation:** Pub/Sub in Redis has zero durability. If
a subscriber is not connected when the message is published, it misses
it permanently. There is no buffering, no queue, no replay.

Use Redis Pub/Sub for: live notifications (user is currently online),
real-time updates (live dashboard metrics), cache invalidation signals
across multiple servers.

Do NOT use Redis Pub/Sub for: anything where message delivery must be
guaranteed. Use Streams instead.

---

## Redis Streams: Brief Introduction

Redis Streams (XADD/XREAD/XREADGROUP) are the durable, consumer-group-aware
evolution of Pub/Sub. We cover them in full depth in Lesson 3. For now,
the key difference:

- Pub/Sub: push-based, no persistence, no consumer groups, fire-and-forget
- Streams: append-only log, persistence, consumer groups with acknowledgment,
  position tracking

---

## Redis as a Cache: Patterns

### Cache-Aside (Lazy Loading)

The most common pattern. Application code manages the cache explicitly.

```typescript
async function getUser(userId: string): Promise<User> {
  const cacheKey = `user:${userId}`;

  // 1. Try the cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as User;
  }

  // 2. Cache miss — fetch from the database
  const user = await db.users.findByPk(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  // 3. Store in cache for next time
  await redis.set(cacheKey, JSON.stringify(user), 'EX', 3600);

  return user;
}

// Invalidate when data changes
async function updateUser(userId: string, updates: Partial<User>): Promise<User> {
  const user = await db.users.update(userId, updates);

  // Invalidate the cache — don't update it (stale update patterns are tricky)
  await redis.del(`user:${userId}`);

  return user;
}
```

**The tradeoff:** Cache-aside is simple and the data is only cached when
it's actually requested. The downside is the cache is cold on startup —
the first request for any key goes to the database.

### Read-Through Cache

The cache layer fetches from the database automatically on a miss. The
application always reads from cache and never directly from the database.
This simplifies application code at the cost of a more complex cache layer.

### Write-Behind (Write-Back)

Writes go to the cache first and are asynchronously written to the
database. Very high write performance, but risk of data loss if the
cache crashes before the async write completes. Rarely appropriate for
primary data.

### Write-Through

Writes go to the cache and the database simultaneously. The cache is always
in sync. Slower writes than write-behind, but no data loss risk. Reads
are fast because the cache is always warm.

### Cache vs Database: The Philosophical Difference

A cache is expendable. You can delete all cache data at any time and
the system remains correct — it just gets slower until the cache warms up.
A database is the source of truth. You cannot delete it.

If you find yourself thinking "I need to make sure the cache is always
consistent with the database," you've crossed the line from cache to
secondary database. This is a red flag. Caches are okay with occasional
staleness. Embrace it or use a database.

---

## Lua Scripting: Atomic Multi-Command Operations

Redis executes Lua scripts atomically. The entire script runs as a single
command — no other client can execute commands between your script's
commands. This is how you implement operations that require reading a value
and conditionally updating it without a race condition.

The classic example: atomic rate limiting.

```typescript
// Rate limiter: allow N requests per time window
// Returns { allowed: true/false, remaining, resetAt }

const rateLimitScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Get current count
local count = tonumber(redis.call('GET', key) or '0')

if count >= limit then
  -- Rate limit exceeded — get TTL to report reset time
  local ttl = redis.call('PTTL', key)
  return {0, 0, now + ttl}  -- {allowed, remaining, resetAt}
end

-- Increment the counter
local newCount = redis.call('INCR', key)

-- Set expiry on first request
if newCount == 1 then
  redis.call('PEXPIRE', key, windowMs)
end

local ttl = redis.call('PTTL', key)
return {1, limit - newCount, now + ttl}  -- {allowed, remaining, resetAt}
`;

async function checkRateLimit(
  userId: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const key = `ratelimit:${userId}`;
  const now = Date.now();

  const result = await redis.eval(
    rateLimitScript,
    1,           // number of keys
    key,         // KEYS[1]
    String(limit),
    String(windowMs),
    String(now)
  ) as [number, number, number];

  return {
    allowed: result[0] === 1,
    remaining: result[1],
    resetAt: result[2],
  };
}
```

Without the Lua script, the `GET + INCR + EXPIRE` sequence would have
race conditions. Between the `GET` (checking the count) and the `INCR`
(incrementing), another client could have incremented the counter, causing
you to exceed the limit. The Lua script makes all three operations atomic.

### When to Use Lua

- Atomic read-modify-write operations
- Operations that must fail completely or succeed completely
- Optimistic locking patterns
- Complex conditional updates

### When NOT to Use Lua

- Operations that only use a single Redis command (already atomic)
- Long-running computations (blocks the entire Redis server)
- Operations that could be expressed as a Redis transaction (`MULTI`/`EXEC`)

---

## Working with ioredis

ioredis is the standard Node.js Redis client. It supports pipelining,
cluster mode, Sentinel, and Lua scripting.

```typescript
import IORedis from 'ioredis';

const redis = new IORedis({
  host: 'localhost',
  port: 6379,
  // For production Redis with auth:
  // password: process.env.REDIS_PASSWORD,
  // tls: {},
  // For Sentinel:
  // sentinels: [{ host: 'sentinel-1', port: 26379 }],
  // name: 'mymaster',
});

// Pipeline: batch multiple commands, one round trip
const pipeline = redis.pipeline();
pipeline.set('key1', 'value1');
pipeline.set('key2', 'value2');
pipeline.get('key1');
pipeline.get('key2');
const results = await pipeline.exec();
// results: [[null, 'OK'], [null, 'OK'], [null, 'value1'], [null, 'value2']]

// Transaction: all or nothing
const txResult = await redis
  .multi()
  .incr('counter')
  .expire('counter', 3600)
  .exec();
// Both commands execute atomically, or neither does
```

---

## Exercises

### Exercise 1: Data Structure Selection

For each use case, identify the correct Redis data structure and write
the key ioredis operations you would use. Include key naming conventions:

1. Track which users are currently online (add/remove on connect/disconnect)
2. Store a user's profile (name, email, bio, avatar_url) with partial updates
3. Implement a "most recently viewed products" feature showing the last 10 items
4. Build a trending hashtags leaderboard ordered by usage count
5. Implement a job queue where each task should only be processed once
6. Store a mapping from session tokens to user IDs with 2-hour expiry

### Exercise 2: Cache-Aside Implementation

Implement a full cache-aside pattern for a `Product` object:

```typescript
interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  updatedAt: string;
}
```

Implement three functions:
1. `getProduct(id)` — cache-aside read with 1-hour TTL
2. `updateProduct(id, updates)` — update DB and invalidate cache
3. `getProducts(ids: string[])` — bulk read using pipeline to check
   cache for all IDs in one round trip, then fetch missing ones from DB

For the bulk read: use `MGET` or pipeline to check all keys at once.
Fetch only the missing ones from the database. Write them all back to
cache. This is called a "multi-key cache-aside" pattern.

### Exercise 3: Lua Rate Limiter

Using the Lua script from this lesson, build a rate limiter middleware
for Express:

```typescript
function rateLimiter(options: {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
}): RequestHandler
```

- Use IP address as the rate limit key by default
- Return `429 Too Many Requests` with a `Retry-After` header when limited
- Return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
  headers on all responses
- Test that concurrent requests from the same IP are correctly counted

### Exercise 4: Pub/Sub Real-Time Notifications

Build a simple live notification system using Redis Pub/Sub and
Server-Sent Events (SSE):

1. `GET /notifications/stream` — opens an SSE connection, subscribes to
   `notifications:user:{userId}` channel, forwards messages as SSE events
2. `POST /notifications/send` — body `{ userId, message }` — publishes
   to the user's channel

What happens if the user closes and reopens their browser? What messages
do they miss? How would you fix this using Redis Streams instead?

### Exercise 5: Eviction Policy Analysis

You are using Redis as a cache for a social media platform. You have
the following key types:

- `session:{token}` — user sessions, always need when user is active
- `profile:{userId}` — user profiles, frequently read
- `feed:{userId}` — precomputed feed, expensive to regenerate
- `trending:hashtags` — sorted set, regenerated every 5 minutes
- `post:{postId}` — individual posts, read on demand

Your Redis instance is at 80% memory capacity. You need to set a
`maxmemory-policy`. Which policy do you choose? Write your justification
for each key type, explaining which ones you can afford to lose and
which you cannot. Also describe what happens to each key type under
your chosen policy.
