# Project 2: NotifyHub — Real-Time Multi-Channel Notification System

## Context

You are building the notification backend for a production SaaS product. Think GitHub's notification system: a code review is requested, and within milliseconds the reviewer sees a red badge in their browser tab, receives a webhook to their CI bot, and gets batched into an hourly email digest if they have not opened the app. Think Slack alert pipelines: a monitoring system fires an event, and every team member watching that channel — across five browser tabs, a mobile app, and two webhook integrations — receives it simultaneously.

Notification systems are deceptively hard. A naive implementation (write to DB, poll on frontend) breaks at scale: polling is expensive, delivery is not guaranteed, fan-out to multiple devices is not atomic, and users who want email but not webhooks need per-channel preference management. You will build this correctly from the start, using Redis as the backbone for real-time delivery, queuing, and state management.

This project is the practical capstone of your Redis knowledge. Every major Redis data structure — Strings, Lists, Sets, Sorted Sets, Hashes, Pub/Sub, and Streams — will be used for a real, justified purpose.

---

## What You Are Building

**NotifyHub** is a notification delivery service with the following delivery channels:

1. **In-app (WebSocket)** — real-time push to all connected browser/mobile clients for a user
2. **Email digest** — hourly batched email summarizing unread notifications
3. **Webhook** — HTTP POST to a user-configured endpoint, with retry on failure

The system must handle fan-out (one notification event → delivered to N devices), delivery guarantees (at-least-once), user preferences (opt out of email, throttle webhooks), and rate limiting.

---

## Features

### Core Notification Operations

- **Send notification**: An event source (your own API or an internal service) POSTs a notification for a user. The notification has a type, title, body, optional action URL, and metadata.
- **Fan-out to devices**: When a notification arrives for `userId`, all servers holding active WebSocket connections for that user receive it and forward it immediately. A user may have multiple browser tabs open across multiple server instances.
- **Inbox**: Users can fetch their last 100 notifications (paginated), ordered newest-first.
- **Read receipts**: A client marks a notification as read. The unread count decrements. A `read` event is published so other open tabs reflect the change instantly.
- **Unread count**: Each user has a live unread count. Fetching `/notifications/unread-count` is O(1). Marking all as read resets it atomically.

### Email Digest

- A BullMQ repeatable job runs every hour.
- It fetches all users who have unread, undigested notifications.
- It batches all their unread notifications into a single email (not one email per notification).
- After sending, it marks those notifications as digested so they are not included in the next digest.
- Users who have opted out of email receive no digest.

### Webhook Delivery

- Users can register a webhook URL. When they receive a notification, a BullMQ job is enqueued to POST to their webhook endpoint.
- If the endpoint returns a non-2xx response or times out, the job retries with exponential backoff (1s, 2s, 4s, 8s, up to 5 retries).
- Each delivery attempt is logged: timestamp, HTTP status, latency.
- An idempotency key (`notificationId:webhookId`) prevents duplicate delivery on job retry.
- Users can throttle webhooks: minimum interval between webhook deliveries (e.g., no more than 1 webhook per minute).

### User Preferences

- Per-user, per-channel opt-in/opt-out: `{ email: true, webhook: false, inApp: true }`
- Default preferences applied if user has no stored preference.
- Preferences are stored in Redis and hot-reloaded (no server restart needed).
- Notification types can be muted per-user (e.g., mute `comment` notifications but not `mention`).

### Rate Limiting

- Per-user, per-channel rate limiting using a sliding window algorithm.
- Example: a user cannot receive more than 50 in-app notifications per minute.
- Prevents a buggy event source from flooding a user's inbox.
- Returns a structured error to the sender when rate limit is exceeded.

---

## Technical Constraints

- **Language**: TypeScript, Node.js
- **Redis**: Use `ioredis`. All real-time and state operations go through Redis.
- **Queue**: BullMQ for email digest and webhook jobs (BullMQ uses Redis internally — no separate queue broker).
- **WebSocket**: `ws` library. Each server process maintains its own connection map.
- **Real-time fan-out**: Must use Redis Pub/Sub. Do not poll. Do not use a single-process workaround.
- **Unread count**: Must use Redis atomic operations (INCR/DECR). Do not compute from scanning the inbox.
- **Event log**: All notification events (sent, read, digested, webhook-delivered) must be written to a Redis Stream for auditability.
- **Delivery guarantee**: At-least-once. A notification must not be silently dropped. Prefer duplicate delivery over loss.
- **No relational database**: Redis is the only persistence layer in this project. You are learning Redis data modeling, not Postgres.

---

## Acceptance Criteria

1. **Fan-out latency**: A notification sent via `POST /notifications` is received by all connected WebSocket clients for that user within **100ms** under normal load. Measure with two browser tabs open.

2. **Multi-server fan-out**: Start two server instances on different ports. Connect a WebSocket client to each. Send a notification. Both clients receive it. (This proves Pub/Sub fan-out across processes works.)

3. **Webhook retry**: Configure a webhook URL that returns 500. Observe that BullMQ retries with backoff and logs each attempt. After 5 failures, the job moves to the failed queue.

4. **Email digest batching**: Send 5 notifications to a user. Trigger the digest job manually. Observe that exactly one email is sent containing all 5. Send 3 more notifications. Trigger again. Observe that only the 3 new ones are included.

5. **Read receipt fan-out**: Open two tabs. Mark a notification as read in one tab. The unread count in the other tab updates within 100ms.

6. **Rate limiting**: Send 51 in-app notifications in rapid succession for the same user. The 51st returns a 429 with a `retryAfter` field.

7. **Preference opt-out**: Set `email: false` for a user. Send them 10 notifications. Trigger the digest job. No email is sent for that user.

8. **Unread count accuracy**: After sending N notifications and reading M of them, `GET /notifications/unread-count` returns exactly `N - M`.

---

## Redis Concepts This Project Exercises

| Concept | Where Used |
|---|---|
| **Redis Pub/Sub** | Fan-out to WebSocket connections across server processes |
| **Redis Lists** | Notification inbox (LPUSH + LTRIM for capped list, LRANGE for pagination) |
| **Redis Strings (INCR/DECR)** | Atomic unread count per user |
| **Redis Hashes** | User preferences, webhook delivery log, notification metadata |
| **Redis Sets** | Active connection IDs per user (presence tracking) |
| **Redis Sorted Sets** | Rate limiting (sliding window: ZADD + ZCOUNT + ZREMRANGEBYSCORE) |
| **Redis Streams** | Audit event log (XADD, consumer groups for processing) |
| **BullMQ (Redis-backed)** | Email digest scheduling, webhook delivery with retry |
| **Atomic operations** | GETSET for bulk-read-reset, HSETNX for idempotency keys |
| **Key expiry (TTL)** | Rate limit windows expire automatically |
| **Lua scripting** | Atomic check-and-set for rate limiter (EVAL) |
