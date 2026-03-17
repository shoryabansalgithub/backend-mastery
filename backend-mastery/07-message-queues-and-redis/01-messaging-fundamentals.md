# Lesson 1: Messaging Fundamentals

## Why Asynchronous Messaging Exists

Every distributed system has the same underlying problem: components need
to communicate, but they cannot all be available and fast at the same time.
Synchronous communication — one service calling another's HTTP endpoint
and waiting for a response — forces the caller to care about the callee's
availability, speed, and failures.

Asynchronous messaging breaks that dependency. The producer sends a message
and moves on. The consumer receives the message when it's ready to process
it. If the consumer is slow, messages queue up and are processed in order.
If the consumer is down, messages wait. Neither participant needs to know
about the other's state.

This gives you three things that synchronous communication cannot provide:

**Decoupling.** The order service doesn't need to know that the notification
service, the inventory service, and the analytics service all need to know
about new orders. It publishes an `order.created` event. Each interested
consumer subscribes independently. You can add a new consumer (say, a
fraud detection service) without modifying the order service at all.

**Buffering.** Black Friday arrives and order volume spikes 50x. With
synchronous calls, your notification service would be flooded and start
returning 503s, causing the order service to fail. With a message queue,
the spike is absorbed: orders pile up in the queue, and the notification
service works through them at its sustainable pace. Orders don't fail;
notifications are just delayed.

**Fan-out.** A single event can be consumed by multiple independent systems,
each at their own pace, each maintaining their own cursor into the event
stream. An `order.paid` event might simultaneously drive: fulfillment,
accounting, customer notification, and analytics — all from one published
message, each consumer independent.

---

## Message Broker vs Message Queue

These terms are often used interchangeably, but they describe different
things. Understanding the distinction matters for system design.

A **message queue** is a simple buffer. One producer puts messages in.
One consumer takes messages out. Each message is processed by exactly one
consumer and then removed. The queue provides durability and ordering.
Classic examples: a work queue for background jobs. A task scheduler.
BullMQ's underlying model is essentially a message queue.

A **message broker** is a routing layer. Producers publish messages to
the broker. The broker routes messages to one or more queues based on
routing rules, topics, or exchange configurations. Consumers subscribe
to queues. The broker decouples producers from consumers entirely.
Classic example: RabbitMQ.

In practice, the distinction is blurry. Redis Streams and Kafka sit in
a third category — **event streaming platforms** — where messages are
retained in an ordered log, and consumers can read from any point in
history at any time. This is fundamentally different from a queue, where
messages are consumed and removed.

| Property | Queue | Broker | Event Stream |
|----------|-------|--------|--------------|
| Message retention | Until consumed | Until consumed | Configurable (persistent log) |
| Multiple consumers | No (one consumer gets each message) | Via exchanges/routing | Yes (consumer groups each get all messages) |
| Replay old messages | No | No | Yes |
| Primary use case | Work distribution | Complex routing | Audit log, event sourcing |
| Examples | BullMQ, SQS | RabbitMQ | Kafka, Redis Streams |

---

## Communication Patterns

### Point-to-Point

One producer sends a message. One consumer receives it. The queue ensures
that even if multiple consumers are running, each message is processed by
exactly one of them. This is the work-queue pattern from Module 6.

```
Producer ──► [Queue] ──► Consumer A (gets message)
                    ──► Consumer B (does NOT get same message)
```

Use this for: background jobs, task queues, anything where you want
one worker to handle each piece of work.

### Pub/Sub (Publish-Subscribe)

One producer publishes a message to a topic. Every subscriber to that
topic receives a copy. No queue — messages are pushed to active subscribers
and forgotten. If a subscriber is offline when the message is published,
it misses it forever.

```
Publisher ──► [Topic]
                ├──► Subscriber A (gets a copy)
                ├──► Subscriber B (gets a copy)
                └──► Subscriber C (gets a copy)
```

Redis has a built-in pub/sub system. Use it for: real-time broadcasting
(chat, live scores, presence updates). Not for: durable, reliable message
delivery.

### Event Streaming

The producer appends events to a durable, ordered log. Multiple consumer
groups each maintain their own position in the log. Each consumer group
gets every event. Adding a new consumer group allows it to replay the
entire history.

```
Producer ──► [Stream: ─────────────────────► ]
                        ▲         ▲
             Group A ───┘         │
             Group B (reads independently) ─┘
```

Use this for: event sourcing, audit logs, multi-system fan-out where
replay matters, change data capture.

---

## Delivery Guarantees

Delivery guarantees describe what a messaging system promises about
whether and how many times a consumer will receive each message. They
represent a fundamental tradeoff between performance and correctness.

### At-Most-Once

The system makes one delivery attempt. If it fails — network error,
consumer crash — the message is lost. The consumer receives the message
zero or one times.

This is the behavior of Redis Pub/Sub. Fire and forget. Maximum throughput,
zero durability. Acceptable only when message loss is explicitly acceptable.

### At-Least-Once

The system retries delivery until the consumer acknowledges receipt. The
consumer may receive the same message multiple times (once normally, plus
additional times if the acknowledgment is lost or the consumer crashes
mid-processing).

This is the default for most serious queue systems including BullMQ,
RabbitMQ, SQS, and Kafka. The tradeoff: you must write idempotent consumers.

### Exactly-Once

The system guarantees each message is delivered and processed exactly once.
True exactly-once in a distributed system is the CAP theorem's hardest
consequence: it requires distributed transactions, which are slow and complex.

Kafka claims exactly-once semantics for producers within a cluster using
idempotent producers and transactions. But exactly-once end-to-end (including
the consumer's side effects) still requires idempotent consumers.

In practice: design for at-least-once delivery and write idempotent consumers.
The observable behavior is equivalent to exactly-once, with much simpler
infrastructure.

| Guarantee | Message loss | Duplicates | Use case |
|-----------|-------------|------------|----------|
| At-most-once | Possible | Never | Metrics, non-critical events |
| At-least-once | Never | Possible | Orders, emails, payments |
| Exactly-once | Never | Never | Theoretical ideal |

---

## Ordering Guarantees

Can consumers rely on receiving messages in the order they were produced?
The answer depends on the system and the configuration.

**Total ordering:** Every consumer sees every message in the same global
order. Simple, but impossible to scale horizontally without sacrificing
throughput. Redis Streams within a single stream provide total ordering.

**Per-partition ordering:** Messages within a partition are ordered.
Messages across partitions may arrive in any order. Kafka partitions by
key. If all messages for a given order ID go to the same partition, they
arrive in order for that order ID. This allows horizontal scaling while
preserving meaningful ordering.

**No ordering guarantee:** Messages may arrive in any order. SQS standard
queues provide this. Acceptable for work queues where each job is
independent.

The practical rule: if you need ordering, use a single partition/stream
and accept the throughput constraint. If you need throughput, partition
your data and live with per-partition ordering.

---

## Consumer Groups

A consumer group is a named set of consumers that collectively process
messages from a stream or queue. The semantics differ between systems,
but the core idea is consistent: the group tracks how far it has read,
and each message is processed by exactly one member of the group.

```
Stream: [msg1, msg2, msg3, msg4, msg5, msg6]

Consumer Group "inventory" (3 consumers):
  Consumer A processes: msg1, msg4
  Consumer B processes: msg2, msg5
  Consumer C processes: msg3, msg6

Consumer Group "payments" (2 consumers):
  Consumer X processes: msg1, msg2, msg3
  Consumer Y processes: msg4, msg5, msg6
```

Both groups get all messages. Within each group, messages are distributed
among members. This is how you achieve fan-out with parallel processing:
multiple groups for fan-out, multiple members per group for throughput.

Redis Streams implements this with `XREADGROUP`. Kafka implements it
natively. We'll explore Redis Streams consumer groups in depth in Lesson 3.

---

## Backpressure

Backpressure is the mechanism by which a slow consumer signals to a fast
producer to slow down. Without backpressure, a producer that generates
messages faster than consumers can process them will eventually exhaust
memory (if buffering in-memory) or disk (if persisting to disk).

In a message queue system, backpressure is implicit: the queue fills up
and the producer can observe queue depth as a signal to slow down or stop
producing. In Redis, the `MAXLEN` option on streams trims old entries.

Explicit backpressure: some systems allow consumers to push back on
producers via flow control signals. Node.js streams have a built-in
backpressure mechanism — `writable.write()` returns `false` when the
internal buffer is full, signaling the readable stream to pause.

For most application-level queuing, you don't implement backpressure
manually. Instead, you:
1. Monitor queue depth
2. Alert when it grows beyond a threshold
3. Scale consumers horizontally when depth is persistently high

---

## Message Schemas and Versioning

A message schema is the contract between producers and consumers. When
a producer changes what it sends, consumers must be updated. In a
synchronous API, this is manageable — you version the API and deploy
everything together. In an async system, producers and consumers are
deployed independently. Old messages may sit in the queue for hours.
Old consumers may be running while the producer has already updated.

This makes schema evolution a first-class concern.

### Backward Compatibility

Adding new optional fields to a message is backward compatible. Existing
consumers ignore unknown fields. New consumers use the new fields.

Removing required fields or changing field types is breaking. Old consumers
expecting those fields will fail.

### Schema Registry

For production systems with many event types and many consumers, a schema
registry (like Confluent's) centralizes schema definitions and validates
that all messages conform to their registered schema. Producers and consumers
register schemas; the registry enforces compatibility rules.

For most teams, this is overkill. Instead:
- Define schemas in TypeScript interfaces, shared via a package or monorepo
- Use versioned event types: `order.v1.created`, `order.v2.created`
- Maintain backward compatibility when possible; use new event types for breaking changes

```typescript
// Versioned event type with envelope
interface EventEnvelope<T> {
  id: string;         // Unique event ID (for idempotency)
  type: string;       // 'order.v2.created'
  version: number;    // 2
  timestamp: string;  // ISO 8601
  data: T;
}
```

---

## Comparing Redis Streams, RabbitMQ, and Kafka

These are the three systems you'll encounter most often in production.
Understanding their design principles helps you choose correctly.

### Redis Streams

Redis Streams is a persistent, ordered log built into Redis 5.0+. It's
backed by a radix tree. Entries are appended with `XADD` and read with
`XREAD` or `XREADGROUP`. Consumer groups track read position per group.

**Strengths:**
- Already in your stack (if you use Redis for caching or BullMQ)
- Simple operational model — one thing to deploy and monitor
- Low latency (sub-millisecond with local Redis)
- Good for small-to-medium event volumes

**Weaknesses:**
- Limited throughput compared to Kafka (single-node bottleneck)
- No built-in partitioning
- Persistence is optional (Redis can lose data without AOF/RDB)
- No native message schemas or serialization

**When to use:** Your team already uses Redis. You need simple fan-out
or event streaming with moderate throughput. You want to avoid operational
complexity.

### RabbitMQ

RabbitMQ is a traditional message broker built on AMQP. It uses exchanges
and queues with flexible routing (direct, topic, fanout, headers). The
model is push-based: the broker pushes messages to consumers.

**Strengths:**
- Rich routing capabilities (topic exchanges, header matching)
- Mature, well-understood semantics
- Strong at-least-once delivery guarantees
- Good built-in UI (RabbitMQ management plugin)
- Supports multiple protocols (AMQP, MQTT, STOMP)

**Weaknesses:**
- No message replay — consumed messages are gone
- Performance degrades under very high throughput
- More complex operational model than Redis
- Not designed for event sourcing or audit logs

**When to use:** You need complex routing rules. You have heterogeneous
consumers (different languages/protocols). You need a battle-tested broker
without the complexity of Kafka.

### Kafka

Kafka is a distributed event streaming platform. Messages are persisted
in partitioned, replicated logs. Consumers maintain their own offsets.
Messages can be replayed. Kafka scales to millions of events per second.

**Strengths:**
- Extreme throughput (millions of messages/second)
- Durable persistence — messages retained as long as you configure
- Replay — new consumers can read from the beginning
- Horizontal scalability via partitioning
- Perfect for event sourcing, CDC, audit logs

**Weaknesses:**
- Operationally complex (ZooKeeper or KRaft, broker coordination)
- Higher latency than Redis for small volumes (batching adds latency)
- Steep learning curve
- Overkill for most applications

**When to use:** Very high throughput requirements. Need replay/event
sourcing. Large engineering team with Kafka expertise. You're building
data pipelines or have strict audit log requirements.

### Decision Matrix

| Factor | Redis Streams | RabbitMQ | Kafka |
|--------|--------------|----------|-------|
| Throughput needed | < 100k/s | < 100k/s | > 100k/s |
| Message replay | Yes (with MAXLEN care) | No | Yes |
| Operational complexity | Low | Medium | High |
| Already in stack | Usually | Sometimes | Rarely |
| Complex routing | No | Yes | Via Kafka Streams |
| Event sourcing | Limited | No | Yes |
| Team expertise required | Low | Medium | High |

For most teams building their first event-driven features: start with
Redis Streams. You likely already have Redis, the operational burden is
minimal, and you can move to Kafka later if you genuinely hit the limits.

---

## Exercises

### Exercise 1: Communication Pattern Identification

For each of the following system requirements, identify the appropriate
communication pattern (point-to-point queue, pub/sub, or event streaming)
and justify your choice:

1. When a user uploads an avatar, resize it to 3 different dimensions
2. When a post is published, notify all followers via push notification
3. Track every price change for 10,000 products for auditing purposes
4. Distribute image transcoding tasks across 20 worker machines
5. Real-time delivery of chat messages to all connected users in a channel
6. Allow the data warehouse team to replay the last 30 days of user activity events

### Exercise 2: Delivery Guarantee Classification

You are designing the event-driven backbone of an e-commerce platform.
For each event type, choose a delivery guarantee and explain your reasoning.
Also describe what "failure" looks like for each and how you'd handle it.

1. `product.view` — user views a product page
2. `cart.item_added` — user adds item to cart
3. `order.placed` — user completes checkout
4. `payment.captured` — payment processor confirms charge
5. `inventory.reserved` — inventory management reserves stock
6. `notification.email_requested` — system requests email to be sent

### Exercise 3: Schema Evolution

You have this existing event schema in production, with 15 consumers:

```typescript
interface OrderCreatedV1 {
  orderId: string;
  userId: string;
  total: number;
  items: Array<{ productId: string; quantity: number }>;
}
```

You need to make the following changes:
1. Add a `currency` field (required — orders can now be in multiple currencies)
2. Rename `total` to `totalAmount`
3. Remove the `items` array (a separate `order.items.fetched` event will carry this)
4. Add a `shippingAddress` field

Which changes are backward-compatible? Which are breaking? For each
breaking change, describe a migration strategy that allows old and new
consumers to coexist during a rolling deployment.

### Exercise 4: Backpressure Simulation

Write a Node.js simulation:
- A producer that generates 1,000 messages as fast as possible
- A consumer that takes 10ms to process each message
- An in-memory queue (simple array) between them

Without backpressure, how many messages accumulate in the queue?
What is the peak memory usage if each message is 1KB?

Now add a simple backpressure mechanism: if the queue length exceeds 100,
the producer pauses until it drops below 50. Measure the difference in
peak queue depth and total processing time.

### Exercise 5: Technology Selection

You work at a Series A startup with 3 backend engineers. Your current
architecture is a Node.js monolith with PostgreSQL and Redis (for caching
and BullMQ). You're planning to add event-driven communication for these
use cases:

1. Notify users when their reports are ready (triggered by background jobs)
2. Fan-out `user.registered` events to: email service, CRM sync, and analytics
3. Stream all database changes to a data warehouse for analytics

For each use case, recommend a technology and justify your choice based
on your team's constraints (small team, Redis already in stack, no Kafka
expertise). Also describe what problems each choice will hit at 100x
current scale, and what you'd migrate to.
