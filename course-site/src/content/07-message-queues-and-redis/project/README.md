# Project: StreamLine — Order Processing Pipeline

## Overview

StreamLine is a Redis Streams-based order processing pipeline. Instead of
direct service calls, services communicate through Redis Streams with
consumer groups. Each service is an independent consumer, reading from the
`orders` stream at its own pace, processing entries, and publishing results
to its own event stream.

This project demonstrates:
- Redis Streams as a durable event bus
- Multiple independent consumer groups reading from the same stream
- At-least-once delivery with acknowledgment
- Pending Entry List (PEL) recovery for crashed consumers
- Dead letter handling for poison messages
- Event-driven saga choreography across services
- Admin API for stream inspection and consumer group management

You are building the full pipeline in a single Node.js process with
separate consumer loops (simulating separate services). Each consumer is
a separate file with its own Redis connection.

---

## System Overview

```
POST /orders
     │
     ▼
[Order Producer] ──XADD──► [orders stream]
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
            [inventory      [payments    [notifications
            consumer]       consumer]     consumer]
                 │               │              │
                 ▼               ▼              ▼
         [inventory-events] [payment-events] [notification-events]
                                 │
                        payment.failed?
                                 │
                                 ▼
                         [inventory consumer]
                         reads payment-events
                         releases reservation
```

---

## Stream Definitions

### `orders` — Main event stream

Produced by the Order API. Consumed by all three consumer groups.

```
Entry fields:
  orderId     string    e.g., 'ord-0042'
  userId      string    e.g., 'usr-123'
  items       string    JSON: [{ productId, quantity, price }]
  totalAmount string    Total in cents (e.g., '9900' = $99.00)
  currency    string    ISO 4217 (e.g., 'usd')
  status      string    Always 'placed' when first added
  createdAt   string    ISO 8601
```

### `inventory-events` — Produced by inventory consumer

```
Entry fields:
  orderId     string
  eventType   string    'inventory.reserved' | 'inventory.failed'
  reason      string    (only when failed) e.g., 'out_of_stock'
  reservedAt  string    ISO 8601 (only when reserved)
```

### `payment-events` — Produced by payment consumer

```
Entry fields:
  orderId     string
  eventType   string    'payment.captured' | 'payment.failed'
  chargeId    string    (only when captured) e.g., 'ch_abc123'
  reason      string    (only when failed) e.g., 'card_declined'
  processedAt string    ISO 8601
```

### `notification-events` — Produced by notification consumer

```
Entry fields:
  orderId     string
  eventType   string    'notification.sent' | 'notification.failed'
  messageId   string    (only when sent)
  sentAt      string    ISO 8601
```

### `orders:dead` — Dead letter stream

Entries that exceeded `MAX_DELIVERY_COUNT` (3) in any consumer group.

```
Entry fields:
  originalEntryId   string    The entry ID in 'orders'
  originalGroup     string    Which group's PEL it came from
  originalConsumer  string    Which consumer was holding it
  deliveryCount     string    How many times it was delivered
  failureReason     string    Last error message
  movedAt           string    ISO 8601
  payload           string    JSON copy of the original entry fields
```

---

## Consumer Group Definitions

| Group Name | Stream | Start Position | Purpose |
|------------|--------|----------------|---------|
| `inventory-service` | `orders` | `$` (new entries only) | Reserve inventory |
| `payments-service` | `orders` | `$` | Process payment |
| `notifications-service` | `orders` | `$` | Send confirmation email |
| `inventory-release` | `payment-events` | `$` | Release inventory on payment failure |

---

## Message Schemas (TypeScript)

```typescript
// src/types/streams.ts

export interface OrderEntry {
  orderId: string;
  userId: string;
  items: string;          // JSON string
  totalAmount: string;    // Cents as string
  currency: string;
  status: string;
  createdAt: string;
}

export interface ParsedOrderEntry extends Omit<OrderEntry, 'items'> {
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
}

export interface InventoryEvent {
  orderId: string;
  eventType: 'inventory.reserved' | 'inventory.failed';
  reason?: string;
  reservedAt?: string;
}

export interface PaymentEvent {
  orderId: string;
  eventType: 'payment.captured' | 'payment.failed';
  chargeId?: string;
  reason?: string;
  processedAt: string;
}

export interface NotificationEvent {
  orderId: string;
  eventType: 'notification.sent' | 'notification.failed';
  messageId?: string;
  sentAt: string;
}

export interface DeadLetterEntry {
  originalEntryId: string;
  originalGroup: string;
  originalConsumer: string;
  deliveryCount: string;
  failureReason: string;
  movedAt: string;
  payload: string;
}
```

---

## API Endpoints

### Order Placement

```
POST /api/v1/orders
Content-Type: application/json
Body: {
  userId: string,
  items: [{ productId: string, quantity: number, price: number }],
  currency?: string   (default: 'usd')
}
Response 201: {
  orderId: string,
  entryId: string,      // Redis Stream entry ID
  status: 'placed',
  totalAmount: number   // In cents
}
Response 400: { error: 'validation_failed', details: [...] }
```

### Order Status

```
GET /api/v1/orders/:orderId
Response 200: {
  orderId: string,
  status: string,     // derived from event streams
  events: [
    { stream: string, eventType: string, timestamp: string, ... }
  ]
}
Response 404: { error: 'not_found' }
```

The status is computed by reading the order's events from all streams and
determining the latest known state.

### Admin: Stream Statistics

```
GET /api/v1/admin/streams
Response 200: {
  streams: {
    orders: {
      length: number,
      firstEntryId: string,
      lastEntryId: string,
      groups: [
        {
          name: string,
          pending: number,
          lastDeliveredId: string,
          consumers: [{ name: string, pending: number, idle: number }]
        }
      ]
    },
    'inventory-events': { length, ... },
    'payment-events': { length, ... },
    'notification-events': { length, ... },
    'orders:dead': { length, ... }
  }
}
```

### Admin: Consumer Group Lag

```
GET /api/v1/admin/lag
Response 200: {
  lag: [
    {
      stream: string,
      group: string,
      lag: number,       // How many entries behind the consumer group is
      pending: number    // How many entries in PEL (delivered but not acked)
    }
  ]
}
```

"Lag" = total stream length minus entries processed by the group. A high
lag means the consumer group is falling behind and may need more consumers.

### Admin: Replay from Offset

```
POST /api/v1/admin/replay
Body: {
  stream: string,
  group: string,
  fromEntryId: string   // Replay from this ID ('0' for beginning, or specific ID)
}
Response 200: { replayed: true, fromId: string }
```

This resets the consumer group's `last-delivered-id` to the specified offset,
causing it to re-process entries from that point. Use with caution — all
consumers in the group will re-process entries, so they must be idempotent.

Implementation: use `XGROUP SETID stream group entryId` to reset the position.

### Admin: Dead Letter Entries

```
GET /api/v1/admin/dead-letter
Query: ?stream=orders (optional, filter by original stream)
Response 200: { entries: [...], total: number }

POST /api/v1/admin/dead-letter/:entryId/replay
Body: { targetStream?: string }  // Defaults to original stream
Response 200: { replayed: true, newEntryId: string }

DELETE /api/v1/admin/dead-letter/:entryId
Response 200: { deleted: true }
```

---

## Project Structure

```
src/
├── api.ts                         # Express server + route definitions
├── redis.ts                       # Redis connection factory
├── streams/
│   ├── stream-names.ts            # Stream name constants
│   ├── group-init.ts              # Consumer group initialization
│   └── helpers.ts                 # fieldsToObject, objectToFields, parseOrder
├── producers/
│   └── order-producer.ts          # XADD to orders stream
├── consumers/
│   ├── base-consumer.ts           # Generic consumer loop with PEL recovery
│   ├── inventory-consumer.ts      # Processes orders stream
│   ├── payment-consumer.ts        # Processes orders stream (separate group)
│   ├── notification-consumer.ts   # Processes orders stream
│   └── inventory-release-consumer.ts  # Processes payment-events
├── recovery/
│   └── stale-entry-recovery.ts    # Claims and handles PEL entries
├── types/
│   └── streams.ts                 # All TypeScript interfaces
└── demo.ts                        # Full demo script
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Redis 7+ on localhost:6379

### Install and Run

```bash
npm install
npm run build

# Terminal 1: Start consumers
npm run consumers

# Terminal 2: Start API server
npm run start

# Terminal 3: Run the demo
npm run demo
```

### Environment Variables

```bash
# .env
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
MAX_DELIVERY_COUNT=3           # How many times to attempt before dead letter
RECOVERY_INTERVAL_MS=15000     # How often to check for stale PEL entries
STALE_ENTRY_THRESHOLD_MS=30000 # An entry is "stale" if in PEL for this long
MOCK_INVENTORY_FAILURE_RATE=0.1   # 10% inventory failures
MOCK_PAYMENT_FAILURE_RATE=0.05    # 5% payment failures
```

---

## Demo Script Behavior

`npm run demo` should execute the following steps with clear console output:

1. **Initialize:** Create all consumer groups (idempotent)
2. **Publish 10 orders:** Log each entry ID as it's added to the stream
3. **Start consumers:** All four consumer loops begin processing
4. **Watch processing:** As entries are processed, log each step
   (inventory reserved, payment captured, notification sent)
5. **Simulate a consumer crash:** Stop the payment consumer mid-processing,
   leave 2 entries in the PEL
6. **Run recovery:** Trigger stale entry recovery, which claims and processes
   the stuck entries
7. **Show lag:** Call `GET /api/v1/admin/lag` and display results
8. **Show a dead letter entry:** Set `MOCK_PAYMENT_FAILURE_RATE=1.0`,
   queue one order, wait for it to hit dead letter
9. **Replay dead letter entry:** Use the replay endpoint
10. **Print final stream stats** and exit

---

## Grading Criteria

### Core Requirements (70 points)

| Requirement | Points |
|-------------|--------|
| POST /orders adds to stream, returns entryId | 10 |
| All 3 consumer groups process entries from `orders` stream | 15 |
| inventory-release consumer handles payment.failed events | 10 |
| Entries not acked stay in PEL; recovery claims and processes them | 10 |
| Dead letter stream receives entries exceeding MAX_DELIVERY_COUNT | 10 |
| Admin stream stats endpoint returns accurate data | 10 |
| Replay endpoint resets consumer group position | 5 |

### Quality Requirements (20 points)

| Requirement | Points |
|-------------|--------|
| All consumers are idempotent (safe to run twice) | 10 |
| TypeScript — all stream entry types defined, no `any` | 5 |
| Graceful shutdown: all consumers acknowledge final messages | 5 |

### Stretch Goals (10 points bonus)

| Requirement | Points |
|-------------|--------|
| Consumer group lag monitoring (alert if lag > threshold) | 3 |
| GET /api/v1/orders/:orderId derives status from all event streams | 4 |
| Outbox pattern: order service writes to Postgres outbox, separate process publishes to stream | 3 |

---

## Stretch Goal Detail

### Order Status Derivation

`GET /api/v1/orders/:orderId` should:
1. Read all event streams (`inventory-events`, `payment-events`, `notification-events`)
   for entries matching `orderId`
2. Determine the current status based on the most recent events:
   - No events yet → `placed`
   - inventory.reserved → `inventory_reserved`
   - inventory.failed → `cancelled`
   - payment.captured → `paid`
   - payment.failed → `payment_failed`
   - notification.sent → `confirmed`
3. Return the full event history

Implementation note: Use `XRANGE streamName - + COUNT 1000` and filter
by `orderId`. This is a full scan — not efficient at scale, but correct
for this project.

### Outbox Pattern

Replace direct `XADD` in the order producer with a two-step process:
1. Write order to a SQLite `orders` table + outbox record in one transaction
2. `OutboxPublisher` reads unpublished records every 500ms and does `XADD`
3. Mark as published

This ensures no order is lost even if Redis is temporarily unavailable.
