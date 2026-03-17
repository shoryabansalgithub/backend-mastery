# Project: Mailer — Production-Ready Email Notification System

## Overview

Mailer is a background job system for sending transactional emails. It
demonstrates production-grade job queue patterns: durability, retry logic,
deduplication, dead letter handling, progress tracking, and observability.

You are building the backend job infrastructure, not an email UI. The
"email sending" is simulated with `console.log` and a realistic delay.
What matters is the correctness and reliability of the queue mechanics.

By the end of this project, you will have built a system that:
- Accepts job requests via HTTP
- Queues them in BullMQ backed by Redis
- Processes them with a typed worker
- Retries transient failures with exponential backoff
- Moves permanently failed jobs to a dead letter queue
- Runs a scheduled weekly digest every Monday at 9am
- Prevents duplicate welcome emails for the same user
- Tracks progress for batch operations
- Exposes an admin HTTP API for monitoring and recovery

---

## System Architecture

```
HTTP Client
    │
    ▼
Express API Server (src/api.ts)
    │  enqueue()
    ▼
BullMQ Queue (Redis)
    │
    ├── emails queue
    │       │
    │       ▼
    │   Email Worker (src/workers/email-worker.ts)
    │       │ on permanent failure
    │       ▼
    │   emails:dead queue
    │
    └── Cron Scheduler (src/scheduler.ts)
            │ every Monday 9am
            └── enqueues weekly_digest jobs
```

---

## Job Definitions

Every job has a `type` discriminator field plus a payload. All payloads
are TypeScript interfaces. No `any` types permitted.

```typescript
// src/types/jobs.ts

export interface WelcomeEmailPayload {
  type: 'welcome_email';
  userId: string;       // Used for deduplication
  email: string;
  name: string;
}

export interface PasswordResetPayload {
  type: 'password_reset';
  userId: string;
  email: string;
  resetToken: string;  // Opaque token — included in email link
  expiresAt: string;   // ISO 8601 — show expiry in email body
}

export interface WeeklyDigestPayload {
  type: 'weekly_digest';
  userId: string;
  email: string;
  weekStartDate: string;  // ISO 8601, always a Monday
  // Optional: populated by scheduler, empty string means "current week"
}

export interface InvoiceGeneratedPayload {
  type: 'invoice_generated';
  invoiceId: string;
  userId: string;
  email: string;
  amount: number;      // In cents (e.g., 9900 = $99.00)
  currency: string;    // ISO 4217 (e.g., 'usd', 'eur')
  lineItems: Array<{
    description: string;
    amount: number;
  }>;
}

export type EmailJobPayload =
  | WelcomeEmailPayload
  | PasswordResetPayload
  | WeeklyDigestPayload
  | InvoiceGeneratedPayload;
```

---

## Job Behavior Specifications

### welcome_email
- **Deduplication:** Cannot queue more than one welcome email for the same
  `userId`. Use BullMQ's `jobId: 'welcome:{userId}'` option.
- **Priority:** Low (0)
- **Attempts:** 3
- **Backoff:** Exponential, starting at 2 seconds
- **On permanent failure:** Move to dead letter queue

### password_reset
- **Deduplication:** None — user may request multiple resets
- **Priority:** High (10) — user is actively waiting
- **Attempts:** 5 — password resets are critical
- **Backoff:** Exponential, starting at 1 second
- **On permanent failure:** Move to dead letter queue AND log a critical alert

### weekly_digest
- **Schedule:** Every Monday at 9:00am UTC (via BullMQ repeat job)
- **Deduplication:** By `userId` + `weekStartDate` using `jobId`
- **Priority:** Low (0)
- **Attempts:** 2 — missing a digest is not critical
- **Backoff:** Fixed delay of 30 seconds
- **Progress:** Report progress at 0%, 50% (content fetched), 100% (sent)

### invoice_generated
- **Deduplication:** By `invoiceId` using `jobId: 'invoice:{invoiceId}'`
- **Priority:** Medium (5) — user expects this within seconds of purchase
- **Attempts:** 3
- **Backoff:** Exponential, starting at 3 seconds
- **On permanent failure:** Move to dead letter queue AND create an alert
  record in the database

---

## Mock Email Service

Do not use a real email provider. Implement a `MockEmailService` class:

```typescript
// src/services/mock-email-service.ts

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; content: string }>;
}

export class MockEmailService {
  // Simulates 300-800ms network latency
  // Has a configurable failure rate (default 5%) for testing retries
  async send(message: EmailMessage): Promise<{ messageId: string }> { ... }
}
```

The `MockEmailService.send()` method should:
1. Wait for a random delay between 300ms and 800ms
2. With 5% probability, throw `new Error('SMTP connection refused')`
3. Otherwise, log the email to the console in a clearly formatted block
4. Return a mock `messageId` like `mock-${randomUUID()}`

The 5% failure rate will naturally trigger retry logic for testing.
You should be able to set `MOCK_FAILURE_RATE=0` in `.env` for demos.

---

## API Endpoints

All endpoints are prefixed with `/api/v1`.

### Enqueue Endpoints

```
POST /api/v1/jobs/welcome-email
Body: { userId, email, name }
Response 202: { jobId, status: 'queued' }
Response 409: { error: 'duplicate', message: 'Welcome email already queued for this user' }

POST /api/v1/jobs/password-reset
Body: { userId, email, resetToken, expiresAt }
Response 202: { jobId, status: 'queued' }

POST /api/v1/jobs/invoice
Body: { invoiceId, userId, email, amount, currency, lineItems }
Response 202: { jobId, status: 'queued' }
Response 409: { error: 'duplicate', message: 'Email already queued for invoice {id}' }
```

### Job Status

```
GET /api/v1/jobs/:id
Response 200: {
  id, name, state, progress, data,
  returnvalue, failedReason,
  attempts: { made, max },
  timestamps: { created, started, finished }
}
Response 404: { error: 'not found' }
```

### Admin Endpoints

```
GET /api/v1/jobs/stats
Response 200: {
  queues: {
    emails: { waiting, active, delayed, completed, failed, paused },
    'emails:dead': { waiting, active, delayed, completed, failed }
  },
  throughput: {
    completedLastHour: number,
    failedLastHour: number
  }
}

GET /api/v1/jobs/failed
Query params: ?page=0&limit=20
Response 200: {
  jobs: [{ id, name, data, failedReason, attempts, createdAt, failedAt }],
  total: number,
  page: number
}

GET /api/v1/jobs/dead-letter
Query params: ?page=0&limit=20
Response 200: { jobs: [...], total, page }

POST /api/v1/jobs/retry/:id
Response 200: { retried: true, newJobId }
Response 404: { error: 'not found' }

DELETE /api/v1/jobs/:id
Removes a job from the queue (any state)
Response 200: { removed: true }
Response 404: { error: 'not found' }
```

---

## Project Structure

```
src/
├── api.ts                          # Express server, route definitions
├── scheduler.ts                    # Cron/repeat job registration
├── redis.ts                        # Shared IORedis connection factory
├── queues/
│   ├── email-queue.ts              # Queue instance + add helpers
│   └── dead-letter-queue.ts        # DLQ instance + admin helpers
├── workers/
│   └── email-worker.ts             # Worker instance + processor
├── services/
│   └── mock-email-service.ts       # MockEmailService class
├── types/
│   └── jobs.ts                     # All job payload interfaces
└── demo.ts                         # Full working demo script
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Redis 7+ running on localhost:6379 (or set `REDIS_URL` in `.env`)

### Environment Variables

```bash
# .env
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
MOCK_FAILURE_RATE=0.05    # 0 to 1, chance each send() fails
LOG_LEVEL=info
```

### Install and Run

```bash
npm install
npm run build         # TypeScript compilation
npm run worker        # Start the email worker (separate terminal)
npm run start         # Start the API server (separate terminal)
npm run demo          # Run the full demo script
```

The demo script (`src/demo.ts`) should, in order:
1. Start the worker
2. Enqueue one of each job type
3. Attempt to enqueue a duplicate welcome_email (should get 409)
4. Wait for all jobs to process, logging progress
5. Print final queue stats
6. Enqueue a job that will permanently fail (set failure rate to 100% temporarily)
7. Verify it appears in the dead letter queue
8. Retry it via the admin API
9. Print final stats and exit cleanly

---

## Grading Criteria

### Core Requirements (70 points)

| Requirement | Points |
|-------------|--------|
| All 4 job types queue and process successfully | 15 |
| Retry logic works: 3 attempts with exponential backoff | 10 |
| Dead letter queue receives permanently failed jobs | 10 |
| welcome_email deduplication (jobId strategy) | 10 |
| weekly_digest runs on a cron schedule | 10 |
| All admin API endpoints return correct data | 15 |

### Quality Requirements (20 points)

| Requirement | Points |
|-------------|--------|
| TypeScript — no `any` types, all payloads typed | 10 |
| Graceful shutdown: worker finishes active jobs | 5 |
| Error handling: all errors logged, not swallowed | 5 |

### Stretch Goals (10 points bonus)

| Requirement | Points |
|-------------|--------|
| Bull Board dashboard mounted at `/admin/queues` | 3 |
| Progress reporting for weekly_digest with SSE endpoint | 4 |
| Rate limiting: max 50 emails per minute via worker limiter | 3 |

---

## Stretch Goals — Detail

### Bull Board Dashboard

Mount Bull Board at `/admin/queues`. It should show both the `emails`
queue and the `emails:dead` queue. Accessible at
`http://localhost:3000/admin/queues` without authentication (this is
an internal admin tool).

### Progress Reporting via SSE

Add a `GET /api/v1/jobs/:id/progress` endpoint that sends
Server-Sent Events (SSE). The client receives updates as the job
progresses through stages. When the job completes, send a final
`event: complete` and close the connection.

### Rate Limiting

Configure the email worker with a rate limiter of 50 jobs per minute.
Add a `/api/v1/jobs/rate-limit` endpoint that returns the current rate
limiter state (jobs processed in the current window, limit, reset time).
