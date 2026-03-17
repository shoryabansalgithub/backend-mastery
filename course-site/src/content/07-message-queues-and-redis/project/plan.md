# StreamLine — Implementation Plan

## Overview

Five phases, each building on the last. Every phase ends with working,
demonstrable code. Do not skip ahead.

Estimated total time: 8-12 hours depending on Redis familiarity.

---

## Phase 1: Redis Setup and Stream Definitions

**Goal:** Redis connection established, all stream constants defined,
consumer groups initialized.

### Steps

1. Install dependencies:
   ```bash
   npm install ioredis express
   npm install -D typescript @types/node @types/express tsx
   ```

2. Create `src/redis.ts`:
   ```typescript
   import IORedis from 'ioredis';

   export function createRedisConnection(label = 'default'): IORedis {
     const redis = new IORedis({
       host: process.env.REDIS_HOST ?? 'localhost',
       port: Number(process.env.REDIS_PORT ?? 6379),
       maxRetriesPerRequest: null,
     });
     redis.on('connect', () => console.log(`[Redis:${label}] Connected`));
     redis.on('error', (err) => console.error(`[Redis:${label}] Error:`, err.message));
     return redis;
   }
   ```

3. Create `src/streams/stream-names.ts`:
   ```typescript
   export const STREAMS = {
     ORDERS: 'orders',
     INVENTORY_EVENTS: 'inventory-events',
     PAYMENT_EVENTS: 'payment-events',
     NOTIFICATION_EVENTS: 'notification-events',
     DEAD_LETTER: 'orders:dead',
   } as const;

   export const GROUPS = {
     INVENTORY: 'inventory-service',
     PAYMENTS: 'payments-service',
     NOTIFICATIONS: 'notifications-service',
     INVENTORY_RELEASE: 'inventory-release',
   } as const;
   ```

4. Create `src/streams/group-init.ts`:
   - Export `initializeConsumerGroups()` function
   - For each (stream, group) pair, call `XGROUP CREATE ... MKSTREAM`
   - Catch `BUSYGROUP` errors (group already exists — not an error)
   - Log which groups were created vs already existed

5. Create `src/streams/helpers.ts`:
   - `fieldsToObject(fields: string[]): Record<string, string>`
   - `objectToFields(obj: Record<string, string>): string[]`
   - `parseOrderEntry(fields: string[]): ParsedOrderEntry`
   - `generateOrderId(): string` — returns `ord-${nanoid(8)}`

6. Create `src/types/streams.ts` with all interfaces from the README.

7. Write a sanity check script `src/check-streams.ts`:
   - Initialize groups
   - XADD a test entry to `orders`
   - XREAD it back
   - XACK it from one group
   - Print the XPENDING summary for all groups
   - Clean up

**Definition of done:** `npx tsx src/check-streams.ts` runs, creates
consumer groups, adds and reads an entry, and prints pending counts.

---

## Phase 2: Order Producer (HTTP API)

**Goal:** `POST /api/v1/orders` adds an entry to the `orders` stream
and returns the entry ID.

### Steps

1. Create `src/producers/order-producer.ts`:
   ```typescript
   export async function publishOrder(
     redis: IORedis,
     order: CreateOrderInput
   ): Promise<PublishedOrder>
   ```
   - Validate required fields (userId, items array, each item has productId/quantity/price)
   - Compute `totalAmount = sum of (item.quantity * item.price)`
   - Generate `orderId` using `generateOrderId()`
   - `XADD orders MAXLEN ~ 100000 * field value ...`
   - Return `{ orderId, entryId, totalAmount, status: 'placed' }`

2. Create `src/api.ts` with Express setup:
   - `POST /api/v1/orders` — calls `publishOrder`, returns 201
   - Basic validation middleware
   - Error handling middleware

3. Test with curl:
   ```bash
   curl -X POST http://localhost:3000/api/v1/orders \
     -H 'Content-Type: application/json' \
     -d '{"userId":"usr-1","items":[{"productId":"prod-1","quantity":2,"price":1999}]}'
   ```

4. Verify in Redis:
   ```bash
   redis-cli XLEN orders
   redis-cli XRANGE orders - + COUNT 1
   ```

**Definition of done:** POST endpoint works, entries appear in Redis,
`XLEN orders` reflects the correct count.

---

## Phase 3: Consumer Implementations

**Goal:** All four consumers correctly process entries, acknowledge on
success, and leave entries in the PEL on failure.

### Steps

1. Create `src/consumers/base-consumer.ts`:
   A generic consumer loop function that other consumers call:
   ```typescript
   export async function runConsumerLoop(
     redis: IORedis,
     stream: string,
     group: string,
     consumer: string,
     processor: (entry: Record<string, string>, entryId: string) => Promise<void>,
     options?: { blockMs?: number; batchSize?: number }
   ): Promise<void>
   ```
   - Loop: `XREADGROUP GROUP {group} {consumer} COUNT {batchSize} BLOCK {blockMs} STREAMS {stream} >`
   - For each entry: call `processor(entry, id)`
   - On success: `XACK stream group id`
   - On failure: log the error (do NOT ack — stays in PEL)
   - Handle connection errors with a 1s pause and retry

2. Create `src/consumers/inventory-consumer.ts`:
   - Reads from `orders` stream, group `inventory-service`
   - Idempotency: check `redis.exists('inventory:processed:{orderId}')`
   - Simulate inventory check (400-800ms delay)
   - 10% chance of `out_of_stock` failure (configurable via env)
   - On success: XADD to `inventory-events`, set idempotency key with 24h TTL
   - On failure: XADD `inventory.failed` event, throw error (stays in PEL)

3. Create `src/consumers/payment-consumer.ts`:
   - Reads from `orders` stream, group `payments-service`
   - Idempotency: check `redis.exists('payment:processed:{orderId}')`
   - Simulate payment processing (600-1200ms)
   - 5% chance of `card_declined` failure
   - On success: XADD to `payment-events`, set idempotency key
   - On failure: XADD `payment.failed` event, throw error

4. Create `src/consumers/notification-consumer.ts`:
   - Reads from `orders` stream, group `notifications-service`
   - Waits for payment to be captured before sending notification
     (check `redis.exists('payment:processed:{orderId}')`)
   - If payment not yet captured, NACK by not acking — the entry
     stays in PEL and recovery will retry it later
   - On success: XADD to `notification-events`, set idempotency key

5. Create `src/consumers/inventory-release-consumer.ts`:
   - Reads from `payment-events` stream, group `inventory-release`
   - Filters for entries where `eventType = 'payment.failed'`
   - Releases the inventory reservation:
     `redis.del('inventory:processed:{orderId}')`
   - Logs the release with orderId

**The notification consumer challenge:** The notification consumer reads
from the `orders` stream but needs to know if payment has succeeded before
sending. Two approaches:

Option A: Check the `payment:processed:*` key — simple but creates an
implicit dependency between consumers.

Option B: Notification consumer reads from `payment-events` stream instead
(separate consumer group). This is architecturally cleaner.

Choose Option B for the implementation. Document your choice.

**Definition of done:** Start all consumers, POST several orders, observe
each step logged as it processes. At the end, `XPENDING orders
inventory-service - + 10` should show 0 pending entries for successful orders.

---

## Phase 4: PEL Recovery and Dead Letter Handling

**Goal:** Stuck entries are automatically recovered. Entries that fail
too many times go to the dead letter stream.

### Steps

1. Create `src/recovery/stale-entry-recovery.ts`:
   ```typescript
   export async function recoverStalePendingEntries(
     redis: IORedis,
     stream: string,
     group: string,
     claimerConsumer: string
   ): Promise<number>  // Returns number of entries recovered
   ```
   - Use `XPENDING stream group - + 100` to find pending entries
   - For each entry where `idleTime > STALE_ENTRY_THRESHOLD_MS`:
     - Check `deliveryCount`
     - If `deliveryCount > MAX_DELIVERY_COUNT`:
       - XADD to `orders:dead` stream with metadata
       - XACK the entry from the main stream (remove from PEL)
       - Log a dead letter event
     - Otherwise:
       - XCLAIM it to `claimerConsumer`
       - Re-process it (call the same processor as the original consumer)
       - XACK on success

2. Create a `RecoveryScheduler` that runs `recoverStalePendingEntries`
   every `RECOVERY_INTERVAL_MS` (default 15s) for each (stream, group) pair.

3. Write a test for dead letter promotion:
   - Set `MAX_DELIVERY_COUNT=2`
   - Add an entry that will always fail to the stream
   - Let it fail twice
   - Wait for recovery to run
   - Verify the entry appears in `XRANGE orders:dead - +`

4. Add dead letter admin endpoints to `src/api.ts`:
   - `GET /api/v1/admin/dead-letter` — XRANGE on `orders:dead`
   - `POST /api/v1/admin/dead-letter/:entryId/replay` — re-add to orders stream
   - `DELETE /api/v1/admin/dead-letter/:entryId` — XDEL from dead letter stream

**Note on XAUTOCLAIM vs XPENDING + XCLAIM:**
Redis 6.2+ supports `XAUTOCLAIM` which combines pending detection and claiming
in one command. Use `XAUTOCLAIM` if your Redis version supports it. Fall back
to `XPENDING + XCLAIM` for older versions. Check version at startup:
```typescript
const info = await redis.info('server');
const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '0';
const useXAutoClaim = version >= '6.2.0';
```

**Definition of done:** A consumer that fails 3 times results in an entry
in `orders:dead`. The dead letter endpoint returns it. The replay endpoint
successfully re-queues it.

---

## Phase 5: Admin API

**Goal:** All admin endpoints return correct, real-time data.

### Steps

1. Implement `GET /api/v1/admin/streams`:
   - For each stream: `XINFO STREAM streamName` for length/IDs
   - For each stream: `XINFO GROUPS streamName` for group info
   - Parse the XINFO responses (they return flat arrays — convert to objects)

2. Implement `GET /api/v1/admin/lag`:
   - For each (stream, group): call `XINFO GROUPS` and find the group
   - Lag = `XLEN stream` - (number of entries with ID ≤ last-delivered-id)
   - In practice: use `pending` count from XINFO GROUPS as an approximation

3. Implement `POST /api/v1/admin/replay`:
   - Validate stream and group exist
   - `XGROUP SETID stream group fromEntryId`
   - Log the reset and return confirmation

4. Write the final `src/demo.ts` script that exercises the entire system
   end-to-end following the sequence described in the README.

5. Test the full API:
   ```bash
   # Get stream stats
   curl http://localhost:3000/api/v1/admin/streams | jq .

   # Check lag
   curl http://localhost:3000/api/v1/admin/lag | jq .

   # List dead letter entries
   curl http://localhost:3000/api/v1/admin/dead-letter | jq .
   ```

**Definition of done:** All endpoints return correct JSON. The demo script
runs end-to-end without manual intervention and produces clear output
showing each stage of the pipeline.

---

## Key Architectural Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Communication pattern | Redis Streams consumer groups | Fan-out, persistence, replay |
| Consumer coordination | Separate Redis connections per consumer | BullMQ pattern, avoids connection state confusion |
| Idempotency mechanism | `SET key value NX EX ttl` per orderId | Simple, fast, no extra table |
| Notification trigger | Reads from `payment-events` (separate group) | Decoupled, correct ordering |
| PEL recovery | Scheduled check every 15s | Simple, no distributed coordination needed |
| Dead letter | Separate stream `orders:dead` | Inspectable, replayable, isolated |
| Stream trimming | `MAXLEN ~ 100000` on every XADD | Bounded memory, approximate for performance |

---

## Testing Approach

### Unit Tests

- `fieldsToObject` / `objectToFields` round-trip
- `parseOrderEntry` with various input shapes
- Total amount calculation for order items

### Integration Tests

Use a real Redis connection (not mocked):

```typescript
// test/consumer-integration.test.ts
// 1. Initialize consumer groups
// 2. XADD a test order
// 3. Run inventory consumer for one iteration
// 4. Check XPENDING is 0 (acknowledged)
// 5. Check inventory-events stream has the result entry
// 6. Clean up streams
```

### Manual Testing Checklist

- [ ] POST /orders returns 201 with entryId
- [ ] All consumers log processing activity
- [ ] Idempotency: processing same entry twice produces one event in each output stream
- [ ] PEL shows 0 pending for all groups after successful processing
- [ ] Simulated failure leaves entry in PEL
- [ ] Recovery claims stale entries and processes them
- [ ] Dead letter promotion works for entries with deliveryCount > MAX
- [ ] GET /admin/streams shows correct lengths and group info
- [ ] GET /admin/lag shows correct lag values
- [ ] POST /admin/replay resets group position
- [ ] Demo script runs end-to-end without errors
