# NotifyHub — Implementation Plan

This is a complete implementation blueprint. Every section specifies exact Redis commands, TypeScript types, and architectural decisions. You should be able to build the project solely from this document.

---

## 1. Redis Data Structure Design — Key Schemas

Every key follows the pattern `{entity}:{identifier}` or `{entity}:{identifier}:{subtype}`. All keys that belong to a user are prefixed with the userId so they can be inspected and deleted together.

### 1.1 Notification Inbox

```
Key:   notifications:{userId}
Type:  Redis List
Usage: LPUSH to prepend new notifications; LTRIM to cap at 100; LRANGE for pagination
TTL:   None (explicit eviction via LTRIM on each write)
```

Each list element is a JSON-serialized `Notification` object:

```typescript
interface Notification {
  id: string;           // nanoid(), e.g. "nfy_abc123"
  userId: string;
  type: string;         // "mention" | "comment" | "review_request" | ...
  title: string;
  body: string;
  actionUrl?: string;
  metadata: Record<string, unknown>;
  createdAt: number;    // Unix ms timestamp
  readAt?: number;      // Unix ms timestamp, undefined = unread
  digestedAt?: number;  // Unix ms timestamp, undefined = not yet digested
}
```

Redis operations:
```
LPUSH notifications:{userId} <JSON string>
LTRIM notifications:{userId} 0 99          // keep only the 100 most recent
LRANGE notifications:{userId} 0 19         // fetch first page (20 items)
```

### 1.2 Unread Count

```
Key:   unread:{userId}
Type:  Redis String (integer counter)
Usage: INCR on send, DECR on read, SET 0 on mark-all-read
TTL:   None
```

```
INCR unread:{userId}                        // returns new count
DECR unread:{userId}                        // returns new count (floor at 0 via Lua)
GET  unread:{userId}                        // returns count as string, parse to int
GETSET unread:{userId} 0                    // atomically read old count and reset to 0
```

Important: DECR can go negative if called erroneously. Use a Lua script to ensure floor at 0:

```lua
-- KEYS[1] = unread:{userId}
local val = tonumber(redis.call('GET', KEYS[1])) or 0
if val > 0 then
  return redis.call('DECR', KEYS[1])
else
  return 0
end
```

### 1.3 Presence (Active Connection IDs)

```
Key:   presence:{userId}
Type:  Redis Set
Usage: SADD on WebSocket connect, SREM on disconnect, SMEMBERS for fan-out decision
TTL:   None (manually managed; also set a 5-minute keepalive TTL on the key via EXPIRE and reset on each heartbeat)
```

Each member is a `connectionId` string (nanoid). The connectionId maps to a WebSocket instance in the local process's in-memory registry. The Set across all server instances shows global presence.

```
SADD presence:{userId} {connectionId}
SREM presence:{userId} {connectionId}
SCARD presence:{userId}                     // 0 = offline
SMEMBERS presence:{userId}                  // all active connectionIds
EXPIRE presence:{userId} 300                // 5-minute TTL, reset on heartbeat
```

### 1.4 User Preferences

```
Key:   prefs:{userId}
Type:  Redis Hash
Usage: HSET to update individual fields, HGETALL to load full prefs, HSETNX for defaults
TTL:   None
```

Hash fields:
```
email          "1" | "0"      // email digest enabled
webhook        "1" | "0"      // webhook delivery enabled
inApp          "1" | "0"      // in-app delivery enabled (almost always 1)
webhookUrl     "https://..."  // registered webhook endpoint
webhookSecret  "sha256=..."   // HMAC secret for payload signing
emailAddress   "user@..."     // override email (defaults to account email)
mutedTypes     "comment,star" // comma-separated notification types to mute
webhookThrottle "60"          // minimum seconds between webhook deliveries
```

```typescript
interface UserPrefs {
  email: boolean;
  webhook: boolean;
  inApp: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  emailAddress?: string;
  mutedTypes: string[];
  webhookThrottleSeconds: number;
}

const DEFAULT_PREFS: UserPrefs = {
  email: true,
  webhook: false,
  inApp: true,
  mutedTypes: [],
  webhookThrottleSeconds: 0,
};
```

Redis operations:
```
HSET prefs:{userId} email 1 inApp 1 webhook 0
HGETALL prefs:{userId}                      // returns object: {email: "1", inApp: "1", ...}
HSET prefs:{userId} email 0                 // update single field, hot-reload
```

### 1.5 Events Stream (Audit Log)

```
Key:   events:notifications
Type:  Redis Stream
Usage: XADD for all notification lifecycle events; consumer group for async processing
TTL:   None (or set maxlen to cap stream size)
```

Stream entry fields:
```
type        "sent" | "read" | "digested" | "webhook_delivered" | "webhook_failed"
notifId     "nfy_abc123"
userId      "usr_xyz"
channel     "inApp" | "email" | "webhook"
ts          "1710000000000"   // Unix ms
extra       JSON string of additional context
```

```
XADD events:notifications * type sent notifId nfy_abc123 userId usr_xyz channel inApp ts 1710000000000
XADD events:notifications MAXLEN ~ 100000 * type read ...  // cap stream at ~100k entries

// Consumer group for processing (e.g., analytics worker)
XGROUP CREATE events:notifications analytics-group $ MKSTREAM
XREADGROUP GROUP analytics-group worker1 COUNT 100 BLOCK 5000 STREAMS events:notifications >
XACK events:notifications analytics-group {entryId}
```

### 1.6 Webhook Delivery Log

```
Key:   webhook:log:{notifId}:{webhookId}
Type:  Redis Hash
Usage: Record each delivery attempt
TTL:   7 days (EX 604800)
```

Hash fields:
```
attempts      "3"
lastAttemptAt "1710000000000"
lastStatus    "500"
lastLatencyMs "234"
deliveredAt   "1710001000000"   // only set on success
```

### 1.7 Rate Limiter Window

```
Key:   ratelimit:{userId}:{channel}
Type:  Redis Sorted Set
Usage: Sliding window — score = timestamp, member = unique request ID
TTL:   Automatic via ZREMRANGEBYSCORE cleanup
```

See section 7 for the full Lua implementation.

### 1.8 Webhook Last-Sent Timestamp (Throttle)

```
Key:   webhook:lastsent:{userId}
Type:  Redis String (timestamp)
Usage: SET with no TTL; compare against webhookThrottleSeconds before enqueueing
```

---

## 2. Fan-Out Architecture

### Problem

A user may have 3 browser tabs open, each connected to WebSocket. Those 3 connections may land on 3 different server processes (or all on one). When a notification arrives, all 3 must receive it immediately.

### Solution: Redis Pub/Sub

Each server process subscribes to a Redis Pub/Sub channel for every user that has an active connection on that process. When a notification is sent, the API handler publishes to `user:{userId}`. Every subscribed server process receives the message and forwards it to the local WebSocket connections for that user.

```
Publisher:   PUBLISH user:{userId}  <JSON notification payload>
Subscriber:  SUBSCRIBE user:{userId}   (each server process that has connections for this user)
```

### Architecture

```
POST /notifications
       │
       ▼
  notificationService.send(userId, notif)
       │
       ├─► LPUSH notifications:{userId}  (write inbox)
       ├─► INCR  unread:{userId}          (increment counter)
       ├─► XADD  events:notifications    (audit log)
       ├─► PUBLISH user:{userId} <JSON>  (fan-out to all servers)
       ├─► enqueue webhookJob            (if webhook enabled)
       └─► (email digest picks this up on next hourly run)

Every server process:
  redis.subscribe("user:{userId}") when first WS connection for userId connects
  redis.unsubscribe("user:{userId}") when last WS connection for userId disconnects

On message received from Redis Pub/Sub:
  connectionRegistry.getConnections(userId).forEach(ws => ws.send(payload))
```

### Connection Registry (in-memory, per process)

```typescript
// src/ws/connectionRegistry.ts

type ConnectionId = string;

interface ConnectionEntry {
  ws: WebSocket;
  userId: string;
  connectionId: ConnectionId;
  connectedAt: number;
}

class ConnectionRegistry {
  // userId → Set of connectionIds
  private userConnections = new Map<string, Set<ConnectionId>>();
  // connectionId → entry
  private connections = new Map<ConnectionId, ConnectionEntry>();

  add(entry: ConnectionEntry): void {
    this.connections.set(entry.connectionId, entry);
    if (!this.userConnections.has(entry.userId)) {
      this.userConnections.set(entry.userId, new Set());
    }
    this.userConnections.get(entry.userId)!.add(entry.connectionId);
  }

  remove(connectionId: ConnectionId): ConnectionEntry | undefined {
    const entry = this.connections.get(connectionId);
    if (!entry) return undefined;
    this.connections.delete(connectionId);
    const userSet = this.userConnections.get(entry.userId);
    if (userSet) {
      userSet.delete(connectionId);
      if (userSet.size === 0) this.userConnections.delete(entry.userId);
    }
    return entry;
  }

  getConnections(userId: string): WebSocket[] {
    const ids = this.userConnections.get(userId);
    if (!ids) return [];
    return [...ids]
      .map(id => this.connections.get(id)?.ws)
      .filter((ws): ws is WebSocket => ws !== undefined);
  }

  hasUser(userId: string): boolean {
    return (this.userConnections.get(userId)?.size ?? 0) > 0;
  }
}

export const registry = new ConnectionRegistry();
```

### Pub/Sub Subscription Manager

```typescript
// src/ws/subscriptionManager.ts
// Uses a SEPARATE Redis client for subscriptions (ioredis subscriber mode is exclusive)

import Redis from 'ioredis';
import { registry } from './connectionRegistry';

const subscriber = new Redis(process.env.REDIS_URL!);

const subscribedUsers = new Set<string>();

export async function subscribeUser(userId: string): Promise<void> {
  if (subscribedUsers.has(userId)) return;
  await subscriber.subscribe(`user:${userId}`);
  subscribedUsers.add(userId);
}

export async function unsubscribeUser(userId: string): Promise<void> {
  if (!subscribedUsers.has(userId)) return;
  await subscriber.unsubscribe(`user:${userId}`);
  subscribedUsers.delete(userId);
}

subscriber.on('message', (channel: string, message: string) => {
  const userId = channel.replace('user:', '');
  const connections = registry.getConnections(userId);
  connections.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(message);
  });
});
```

---

## 3. Email Digest Batching

### BullMQ Repeatable Job Setup

```typescript
// src/queues/emailDigestQueue.ts
import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!);

export const digestQueue = new Queue('email-digest', { connection });

// Register the repeatable job on server startup (idempotent — BullMQ deduplicates by key)
await digestQueue.add(
  'hourly-digest',
  {},
  {
    repeat: { every: 60 * 60 * 1000 }, // every hour in ms
    jobId: 'hourly-digest-singleton',
  }
);
```

### Worker Logic

```typescript
// src/workers/emailDigestWorker.ts
import { Worker } from 'bullmq';
import { redis } from '../redis';
import { getUsersWithUndigestedNotifications } from '../services/notificationService';
import { sendDigestEmail } from '../services/emailService';

const worker = new Worker('email-digest', async (job: Job) => {
  // 1. Find all users with undigested unread notifications
  // Strategy: maintain a Redis Set "digest:pending" — SADD userId whenever a notification
  // is sent to a user with email prefs enabled. SPOP all members in the worker.

  const pendingUsers = await redis.smembers('digest:pending');
  if (pendingUsers.length === 0) return;

  // Process each user
  for (const userId of pendingUsers) {
    const prefs = await getUserPrefs(userId);
    if (!prefs.email) {
      await redis.srem('digest:pending', userId);
      continue;
    }

    // Fetch all notifications from inbox
    const rawItems = await redis.lrange(`notifications:${userId}`, 0, 99);
    const notifications: Notification[] = rawItems.map(r => JSON.parse(r));

    // Filter: unread AND not yet digested
    const toDigest = notifications.filter(n => !n.readAt && !n.digestedAt);
    if (toDigest.length === 0) {
      await redis.srem('digest:pending', userId);
      continue;
    }

    // Send the batched email
    await sendDigestEmail(prefs.emailAddress ?? userId, toDigest);

    // Mark as digested: update each notification in the list
    // Since Redis Lists store values (not references), we must rewrite them
    // Strategy: use a Lua script to update matching items in-place
    const now = Date.now();
    const digestedIds = new Set(toDigest.map(n => n.id));

    const updatedItems = notifications.map(n => {
      if (digestedIds.has(n.id)) {
        return JSON.stringify({ ...n, digestedAt: now });
      }
      return JSON.stringify(n);
    });

    // Atomically replace the list
    const pipeline = redis.pipeline();
    pipeline.del(`notifications:${userId}`);
    // RPUSH to maintain order (newest-first was from LPUSH, so reverse for RPUSH)
    updatedItems.reverse().forEach(item => pipeline.rpush(`notifications:${userId}`, item));
    await pipeline.exec();

    // Log to stream
    await redis.xadd('events:notifications', '*',
      'type', 'digested',
      'userId', userId,
      'count', String(toDigest.length),
      'ts', String(now)
    );

    await redis.srem('digest:pending', userId);
  }
}, { connection });
```

---

## 4. Webhook Delivery

### Job Schema

```typescript
interface WebhookJobData {
  notifId: string;
  userId: string;
  webhookUrl: string;
  webhookSecret: string;
  payload: Notification;
  idempotencyKey: string; // `${notifId}:${userId}`
}
```

### Queue Setup

```typescript
// src/queues/webhookQueue.ts
import { Queue } from 'bullmq';

export const webhookQueue = new Queue('webhook-delivery', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000, // 1s, 2s, 4s, 8s, 16s
    },
    removeOnComplete: { age: 86400 },     // keep completed for 24h
    removeOnFail: { age: 7 * 86400 },     // keep failed for 7d
  },
});
```

### Worker Logic

```typescript
// src/workers/webhookWorker.ts
const worker = new Worker('webhook-delivery', async (job: Job<WebhookJobData>) => {
  const { notifId, userId, webhookUrl, webhookSecret, payload, idempotencyKey } = job.data;
  const logKey = `webhook:log:${notifId}:${userId}`;

  // Idempotency check: if already delivered, skip
  const deliveredAt = await redis.hget(logKey, 'deliveredAt');
  if (deliveredAt) {
    return { skipped: true, reason: 'already_delivered' };
  }

  // Throttle check
  const prefs = await getUserPrefs(userId);
  if (prefs.webhookThrottleSeconds > 0) {
    const lastSent = await redis.get(`webhook:lastsent:${userId}`);
    if (lastSent) {
      const elapsed = (Date.now() - parseInt(lastSent)) / 1000;
      if (elapsed < prefs.webhookThrottleSeconds) {
        // Delay the job rather than failing it
        throw new Error(`THROTTLED: retry after ${prefs.webhookThrottleSeconds - elapsed}s`);
      }
    }
  }

  // Build signed payload
  const bodyStr = JSON.stringify(payload);
  const sig = computeHmacSignature(bodyStr, webhookSecret);
  const startMs = Date.now();

  // Deliver
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NotifyHub-Signature': sig,
      'X-NotifyHub-IdempotencyKey': idempotencyKey,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(10_000), // 10 second timeout
  });

  const latencyMs = Date.now() - startMs;
  const attemptCount = (job.attemptsMade ?? 0) + 1;

  // Update delivery log
  const pipeline = redis.pipeline();
  pipeline.hset(logKey,
    'attempts', String(attemptCount),
    'lastAttemptAt', String(Date.now()),
    'lastStatus', String(response.status),
    'lastLatencyMs', String(latencyMs),
  );
  pipeline.expire(logKey, 7 * 86400);

  if (response.ok) {
    pipeline.hset(logKey, 'deliveredAt', String(Date.now()));
    pipeline.set(`webhook:lastsent:${userId}`, String(Date.now()));
    pipeline.xadd('events:notifications', '*',
      'type', 'webhook_delivered',
      'notifId', notifId,
      'userId', userId,
      'status', String(response.status),
      'latencyMs', String(latencyMs),
      'ts', String(Date.now())
    );
  }

  await pipeline.exec();

  if (!response.ok) {
    throw new Error(`Webhook failed: HTTP ${response.status}`);
  }
}, { connection });

worker.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= job.opts.attempts!) {
    await redis.xadd('events:notifications', '*',
      'type', 'webhook_failed',
      'notifId', job.data.notifId,
      'userId', job.data.userId,
      'error', err.message,
      'ts', String(Date.now())
    );
  }
});
```

---

## 5. Read Receipts

### Flow

1. Client sends `POST /notifications/:notifId/read`
2. Server finds the notification in the list, updates `readAt`
3. Decrements `unread:{userId}` with floor-at-0 Lua script
4. Publishes a `read` event to `user:{userId}` so other tabs update their unread badge
5. Writes to events stream

### Implementation Note

Redis Lists do not support in-place updates by ID. Strategy: LRANGE all 100, find the item by `id` field in JSON, rebuild the list with the updated item. This is acceptable at 100 items; it is a known trade-off.

```typescript
async function markRead(userId: string, notifId: string): Promise<void> {
  const listKey = `notifications:${userId}`;
  const items = await redis.lrange(listKey, 0, -1);

  let found = false;
  const updated = items.map(raw => {
    const n: Notification = JSON.parse(raw);
    if (n.id === notifId && !n.readAt) {
      found = true;
      return JSON.stringify({ ...n, readAt: Date.now() });
    }
    return raw;
  });

  if (!found) return; // Already read or not found

  // Atomically replace list
  const pipeline = redis.pipeline();
  pipeline.del(listKey);
  updated.reverse().forEach(item => pipeline.rpush(listKey, item));
  // Decrement unread with floor-at-0 Lua
  pipeline.eval(DECR_FLOOR_ZERO_SCRIPT, 1, `unread:${userId}`);
  await pipeline.exec();

  // Publish read event for real-time badge update in other tabs
  await redis.publish(`user:${userId}`, JSON.stringify({
    event: 'notification_read',
    notifId,
    userId,
  }));

  await redis.xadd('events:notifications', '*',
    'type', 'read',
    'notifId', notifId,
    'userId', userId,
    'ts', String(Date.now())
  );
}
```

---

## 6. Unread Count

```typescript
// On notification send:
await redis.incr(`unread:${userId}`);

// On single read:
await redis.eval(DECR_FLOOR_ZERO_SCRIPT, 1, `unread:${userId}`);

// On mark-all-read:
const previousCount = await redis.getset(`unread:${userId}`, '0');
// Use previousCount to know how many were cleared

// GET:
const raw = await redis.get(`unread:${userId}`);
const count = raw ? parseInt(raw, 10) : 0;
```

The Lua script for floor-at-zero decrement:
```lua
-- src/scripts/decrFloorZero.lua
local val = tonumber(redis.call('GET', KEYS[1])) or 0
if val > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
```

Load and cache the script SHA at startup using `SCRIPT LOAD` for efficient `EVALSHA` usage.

---

## 7. Rate Limiting

Uses a sliding window algorithm with Redis Sorted Sets. The score is the Unix timestamp in milliseconds; the member is a unique request ID. On each request, we:
1. Remove all members older than the window
2. Count remaining members
3. If under limit, add the new member and allow
4. If at or over limit, deny

This is implemented as a Lua script to make it atomic:

```lua
-- src/scripts/rateLimiter.lua
-- KEYS[1] = ratelimit:{userId}:{channel}
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = window size (ms), e.g. 60000
-- ARGV[3] = limit (max requests per window)
-- ARGV[4] = unique request ID

local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local reqId = ARGV[4]
local windowStart = now - window

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', windowStart)

-- Count current entries
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  -- Allow: add this request
  redis.call('ZADD', KEYS[1], now, reqId)
  -- Set TTL to auto-clean the key
  redis.call('PEXPIRE', KEYS[1], window)
  return { 1, limit - count - 1 }  -- { allowed, remaining }
else
  -- Get oldest entry to compute retryAfter
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retryAfterMs = tonumber(oldest[2]) + window - now
  return { 0, retryAfterMs }  -- { denied, retryAfterMs }
end
```

```typescript
// src/middleware/rateLimiter.ts
import { Request, Response, NextFunction } from 'express';
import { redis } from '../redis';
import { nanoid } from 'nanoid';

const RATE_LIMIT_SCRIPT = fs.readFileSync('./src/scripts/rateLimiter.lua', 'utf8');
let scriptSha: string;

async function loadScript() {
  scriptSha = await redis.script('LOAD', RATE_LIMIT_SCRIPT) as string;
}

export function rateLimiter(channel: string, limit: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId) return next();

    const key = `ratelimit:${userId}:${channel}`;
    const result = await redis.evalsha(scriptSha, 1, key,
      String(Date.now()), String(windowMs), String(limit), nanoid()
    ) as [number, number];

    const [allowed, value] = result;
    if (allowed === 1) {
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(value));
      return next();
    } else {
      res.setHeader('Retry-After', String(Math.ceil(value / 1000)));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        retryAfterMs: value,
        channel,
      });
    }
  };
}
```

---

## 8. Preference Management

```typescript
// src/services/prefService.ts
import { redis } from '../redis';

const DEFAULT_PREFS: UserPrefs = {
  email: true,
  webhook: false,
  inApp: true,
  mutedTypes: [],
  webhookThrottleSeconds: 0,
};

export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const raw = await redis.hgetall(`prefs:${userId}`);

  if (Object.keys(raw).length === 0) {
    return { ...DEFAULT_PREFS };
  }

  return {
    email: raw.email !== '0',
    webhook: raw.webhook === '1',
    inApp: raw.inApp !== '0',
    webhookUrl: raw.webhookUrl || undefined,
    webhookSecret: raw.webhookSecret || undefined,
    emailAddress: raw.emailAddress || undefined,
    mutedTypes: raw.mutedTypes ? raw.mutedTypes.split(',').filter(Boolean) : [],
    webhookThrottleSeconds: raw.webhookThrottle ? parseInt(raw.webhookThrottle, 10) : 0,
  };
}

export async function updateUserPrefs(userId: string, updates: Partial<UserPrefs>): Promise<void> {
  const fields: string[] = [];

  if (updates.email !== undefined) fields.push('email', updates.email ? '1' : '0');
  if (updates.webhook !== undefined) fields.push('webhook', updates.webhook ? '1' : '0');
  if (updates.inApp !== undefined) fields.push('inApp', updates.inApp ? '1' : '0');
  if (updates.webhookUrl !== undefined) fields.push('webhookUrl', updates.webhookUrl);
  if (updates.webhookSecret !== undefined) fields.push('webhookSecret', updates.webhookSecret);
  if (updates.emailAddress !== undefined) fields.push('emailAddress', updates.emailAddress);
  if (updates.mutedTypes !== undefined) fields.push('mutedTypes', updates.mutedTypes.join(','));
  if (updates.webhookThrottleSeconds !== undefined) {
    fields.push('webhookThrottle', String(updates.webhookThrottleSeconds));
  }

  if (fields.length > 0) {
    await redis.hset(`prefs:${userId}`, ...fields);
  }

  // Preferences are read fresh on each request — no cache invalidation needed.
  // This is the "hot-reload without restart" property.
}
```

---

## 9. API Routes

### Route Table

| Method | Path | Description |
|---|---|---|
| POST | `/notifications` | Send a notification to a user |
| GET | `/notifications` | Fetch paginated inbox for authenticated user |
| GET | `/notifications/unread-count` | Get unread count |
| POST | `/notifications/:id/read` | Mark one notification as read |
| POST | `/notifications/read-all` | Mark all as read, reset unread count |
| GET | `/notifications/:id` | Get single notification by ID |
| GET | `/prefs` | Get current user's preferences |
| PATCH | `/prefs` | Update preferences |
| GET | `/webhook/log/:notifId` | Get delivery log for a notification |
| GET | `/health` | Service health + Redis ping |

### Request/Response Shapes

```typescript
// POST /notifications
// Request body:
interface SendNotificationRequest {
  userId: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}
// Response 201:
interface SendNotificationResponse {
  notifId: string;
  deliveredTo: {
    inApp: boolean;
    webhookEnqueued: boolean;
    emailWillDigest: boolean;
  };
}

// GET /notifications?page=0&limit=20
// Response 200:
interface GetNotificationsResponse {
  notifications: Notification[];
  total: number;           // total in inbox (max 100)
  unreadCount: number;
  page: number;
  limit: number;
}

// GET /notifications/unread-count
// Response 200:
interface UnreadCountResponse {
  count: number;
}

// POST /notifications/:id/read
// Response 200:
interface MarkReadResponse {
  ok: boolean;
  unreadCount: number;     // new count after decrement
}

// PATCH /prefs
// Request body: Partial<UserPrefs>
// Response 200: { ok: true, prefs: UserPrefs }

// GET /webhook/log/:notifId
// Response 200:
interface WebhookLogResponse {
  notifId: string;
  attempts: number;
  lastAttemptAt: number;
  lastStatus: number;
  lastLatencyMs: number;
  deliveredAt?: number;
}
```

### Route Implementation Example

```typescript
// src/routes/notifications.ts
import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimiter } from '../middleware/rateLimiter';
import * as notifService from '../services/notificationService';

const router = Router();

router.post('/',
  authenticate,
  rateLimiter('inApp', 50, 60_000), // 50 per minute
  async (req, res) => {
    const { userId, type, title, body, actionUrl, metadata } = req.body;
    const notif = await notifService.send({ userId, type, title, body, actionUrl, metadata });
    res.status(201).json(notif);
  }
);

router.get('/',
  authenticate,
  async (req, res) => {
    const page = parseInt(req.query.page as string ?? '0', 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? '20', 10), 50);
    const result = await notifService.getInbox(req.user!.id, page, limit);
    res.json(result);
  }
);

export default router;
```

---

## 10. WebSocket Connection Registry

```typescript
// src/ws/server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { nanoid } from 'nanoid';
import { registry } from './connectionRegistry';
import { subscribeUser, unsubscribeUser } from './subscriptionManager';
import { redis } from '../redis';

export function attachWebSocketServer(server: import('http').Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    // Extract userId from token in query string: /ws?token=...
    const userId = await authenticateWsRequest(req);
    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const connectionId = nanoid();

    // Register local connection
    registry.add({ ws, userId, connectionId, connectedAt: Date.now() });

    // Register in Redis presence Set
    await redis.sadd(`presence:${userId}`, connectionId);
    await redis.expire(`presence:${userId}`, 300);

    // Subscribe to user's Redis Pub/Sub channel (idempotent)
    await subscribeUser(userId);

    // Send initial state
    const unreadCount = parseInt(await redis.get(`unread:${userId}`) ?? '0', 10);
    ws.send(JSON.stringify({ event: 'connected', connectionId, unreadCount }));

    // Heartbeat: refresh presence TTL every 60s
    const heartbeatInterval = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        await redis.expire(`presence:${userId}`, 300);
      }
    }, 60_000);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'mark_read') {
          await notifService.markRead(userId, msg.notifId);
        }
      } catch {}
    });

    ws.on('close', async () => {
      clearInterval(heartbeatInterval);
      registry.remove(connectionId);
      await redis.srem(`presence:${userId}`, connectionId);
      // If no more connections for this user on this process, unsubscribe
      if (!registry.hasUser(userId)) {
        await unsubscribeUser(userId);
      }
    });
  });
}
```

---

## 11. File and Folder Structure

```
src/
  index.ts                     // Express app init, WebSocket attach, worker startup
  redis.ts                     // ioredis client singleton (publisher client)

  routes/
    notifications.ts           // POST/GET /notifications, read, unread-count
    prefs.ts                   // GET/PATCH /prefs
    webhooks.ts                // GET /webhook/log/:notifId
    health.ts                  // GET /health

  services/
    notificationService.ts     // send(), getInbox(), markRead(), markAllRead()
    prefService.ts             // getUserPrefs(), updateUserPrefs()
    emailService.ts            // sendDigestEmail() — integrates with Resend/SendGrid

  queues/
    emailDigestQueue.ts        // Queue setup + repeatable job registration
    webhookQueue.ts            // Queue setup + default job options

  workers/
    emailDigestWorker.ts       // Hourly digest processor
    webhookWorker.ts           // Webhook delivery with retry

  ws/
    server.ts                  // WebSocketServer setup, connection lifecycle
    connectionRegistry.ts      // In-memory userId → WebSocket map
    subscriptionManager.ts     // Redis Pub/Sub subscription management

  middleware/
    auth.ts                    // JWT authentication middleware
    rateLimiter.ts             // Redis sliding window rate limiter

  scripts/
    rateLimiter.lua            // Atomic Lua rate limit script
    decrFloorZero.lua          // Lua: DECR with floor at 0

  types/
    notification.ts            // Notification, UserPrefs, WebhookLog interfaces

.env
package.json
tsconfig.json
docker-compose.yml             // Redis + optional mail catcher (Mailhog)
```

---

## 12. Environment Variables

```bash
# .env
PORT=3000
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your-jwt-secret-here

# Email (use Resend, SendGrid, or Nodemailer with SMTP)
EMAIL_PROVIDER=resend                 # "resend" | "smtp"
RESEND_API_KEY=re_...
EMAIL_FROM=notifications@yourapp.com

# Optional: webhook HMAC signing algorithm
WEBHOOK_HMAC_ALGO=sha256

# Optional: rate limit config (override defaults)
RATE_LIMIT_INAPP_PER_MINUTE=50
RATE_LIMIT_WEBHOOK_PER_HOUR=100

# Optional: digest schedule (cron expression, overrides default hourly)
DIGEST_CRON=0 * * * *
```

---

## TypeScript Type Reference

```typescript
// src/types/notification.ts

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  readAt?: number;
  digestedAt?: number;
}

export interface UserPrefs {
  email: boolean;
  webhook: boolean;
  inApp: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  emailAddress?: string;
  mutedTypes: string[];
  webhookThrottleSeconds: number;
}

export interface WebhookLog {
  notifId: string;
  userId: string;
  attempts: number;
  lastAttemptAt: number;
  lastStatus: number;
  lastLatencyMs: number;
  deliveredAt?: number;
}

export interface StreamEvent {
  id: string;
  type: 'sent' | 'read' | 'digested' | 'webhook_delivered' | 'webhook_failed';
  notifId: string;
  userId: string;
  channel?: 'inApp' | 'email' | 'webhook';
  ts: number;
  extra?: Record<string, unknown>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}
```

---

## Build and Run

```bash
# Install dependencies
npm install ioredis bullmq ws express nanoid @types/ws @types/express typescript ts-node

# Start Redis
docker compose up -d redis

# Run in development
npx ts-node src/index.ts

# Or with hot reload
npx tsx watch src/index.ts
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --save 60 1 --loglevel warning

  mailhog:
    image: mailhog/mailhog
    ports:
      - "1025:1025"   # SMTP
      - "8025:8025"   # Web UI

volumes:
  redis-data:
```
