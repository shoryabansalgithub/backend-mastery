# Mailer — Implementation Plan

## Overview

This plan breaks implementation into six phases. Each phase produces
working, testable code before you move to the next. Never move to the
next phase with broken code in the current phase.

Estimated total time: 6-10 hours depending on familiarity with Redis.

---

## Phase 1: Redis and BullMQ Setup

**Goal:** Establish the Redis connection and confirm BullMQ can create queues.

### Steps

1. Initialize the project: `npm init -y`, install dependencies:
   ```bash
   npm install bullmq ioredis express
   npm install -D typescript @types/node @types/express tsx
   ```

2. Create `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "Node16",
       "moduleResolution": "Node16",
       "outDir": "dist",
       "strict": true,
       "esModuleInterop": true
     },
     "include": ["src"]
   }
   ```

3. Create `src/redis.ts` — export a factory function `getRedis()` that
   returns a shared IORedis instance. Do not create multiple connections
   unnecessarily. Remember: BullMQ requires separate connection instances
   for Queue, Worker, and QueueEvents.

4. Create `src/queues/email-queue.ts` — create the BullMQ `Queue` instance.
   Do not add jobs yet.

5. Create `src/queues/dead-letter-queue.ts` — create the DLQ `Queue` instance.

6. Write a sanity check script `src/check-redis.ts` that:
   - Connects to Redis
   - Adds a test job to the email queue
   - Reads it back with `queue.getJob(id)`
   - Logs success and exits

**Definition of done:** `npx tsx src/check-redis.ts` runs without errors
and prints the job data.

### Key Decision: Connection Management

BullMQ requires each Queue, Worker, and QueueEvents to have its own
connection because they use different Redis features internally. The
correct pattern is a factory function:

```typescript
// src/redis.ts
import IORedis from 'ioredis';

export function createRedisConnection(): IORedis {
  return new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,  // Required for BullMQ
  });
}
```

Pass a fresh `createRedisConnection()` call to each Queue/Worker/QueueEvents
constructor.

---

## Phase 2: Job Definitions and Payload Types

**Goal:** Define all TypeScript interfaces and the complete type union.

### Steps

1. Create `src/types/jobs.ts` with interfaces for all four job types:
   - `WelcomeEmailPayload`
   - `PasswordResetPayload`
   - `WeeklyDigestPayload`
   - `InvoiceGeneratedPayload`
   - `EmailJobPayload` (union type)

2. Add `JobResult` type for what processors return:
   ```typescript
   export interface JobResult {
     sent: boolean;
     messageId?: string;
     skipped?: boolean;
     skipReason?: string;
   }
   ```

3. Create `src/services/mock-email-service.ts`:
   - `MockEmailService` class with a `send(message: EmailMessage)` method
   - Reads `MOCK_FAILURE_RATE` from environment (default 0.05)
   - Waits random 300-800ms
   - Randomly throws with the configured probability
   - Logs a formatted email block to stdout on success
   - Returns `{ messageId: string }`

4. Write a unit test for `MockEmailService`:
   - Call `send()` 100 times with `MOCK_FAILURE_RATE=0` — none should throw
   - Call `send()` 100 times with `MOCK_FAILURE_RATE=1` — all should throw

**Definition of done:** TypeScript compiles with zero errors. Mock email
service passes its unit tests.

---

## Phase 3: Worker Implementation

**Goal:** A working worker that processes all four job types correctly.

### Steps

1. Create `src/workers/email-worker.ts`:
   - Import `Worker`, `Job`, `UnrecoverableError` from `bullmq`
   - Write the `processEmailJob(job: Job<EmailJobPayload>)` function
   - Use a `switch` on `job.data.type` with full TypeScript narrowing
   - Each case should call `MockEmailService.send()` with appropriate content
   - The `weekly_digest` case must call `job.updateProgress()` at 0%, 50%, 100%
   - Add a `default` case that throws `UnrecoverableError`

2. Add worker event handlers in `email-worker.ts`:
   - `completed`: log success with job ID and duration
   - `failed`: log error with job ID, type, reason, and attempt number
   - `stalled`: log a warning

3. Configure worker options:
   - `concurrency: 5`
   - `limiter: { max: 50, duration: 60_000 }`

4. Implement dead letter handling in the `failed` handler:
   - Check if `job.attemptsMade >= job.opts.attempts`
   - If yes, add the job to the DLQ with metadata (see Lesson 4 for the pattern)

5. Test the worker end-to-end:
   - Start the worker with `npx tsx src/workers/email-worker.ts`
   - Manually add jobs using the check script from Phase 1
   - Verify all four types process correctly
   - Verify that a job with `MOCK_FAILURE_RATE=1` retries and eventually
     lands in the DLQ

**Definition of done:** All four job types process. Failed jobs appear
in the dead letter queue after exhausting attempts. Worker logs are clear.

### Key Decision: Processor Error Handling

Distinguish transient from permanent errors in the processor:

```typescript
import { UnrecoverableError } from 'bullmq';

async function processEmailJob(job: Job<EmailJobPayload>): Promise<JobResult> {
  const { data } = job;

  // Validate required fields — bad data is never transient
  if (!data.email || !data.email.includes('@')) {
    throw new UnrecoverableError(`Invalid email address: "${data.email}"`);
  }

  try {
    // Transient failures (SMTP errors) will be retried automatically
    const result = await mockEmailService.send({ ... });
    return { sent: true, messageId: result.messageId };
  } catch (err) {
    // All errors from MockEmailService are transient
    // Re-throw to trigger BullMQ's retry logic
    throw err;
  }
}
```

---

## Phase 4: Scheduled Jobs

**Goal:** Weekly digest fires automatically every Monday at 9am UTC.

### Steps

1. Create `src/scheduler.ts`:
   - Export an async `registerScheduledJobs()` function
   - Add the weekly digest repeat job to the queue
   - Use `jobId: 'repeat:weekly-digest'` to prevent duplicates on restart

2. The weekly digest repeat job processor needs to do something when
   triggered by the scheduler. The payload stored in the repeat job is
   a template — the actual `userId` and `email` fields are not populated.

   Handle this in the worker: if `weekStartDate` is empty, compute the
   current Monday's date. For the demo, the processor should simply log
   that it would send digests to all opted-in users.

   For the stretch goal, the repeat job triggers a "fan-out" that creates
   individual `weekly_digest` jobs per user.

3. Call `registerScheduledJobs()` from your main entry point (or from
   `api.ts` startup).

4. Verify scheduling works:
   - Start the application
   - Check Redis for the scheduled job: `KEYS bull:emails:*`
   - You should see a `bull:emails:repeat` key

**Definition of done:** `KEYS bull:emails:repeat*` shows the schedule in
Redis. After changing the schedule to `* * * * *` (every minute) and
waiting, the job fires and the processor runs.

### Key Decision: One-Time Registration

Call `registerScheduledJobs()` once on startup. BullMQ checks for an
existing repeat job with the same `jobId` and skips creation if found.
This is safe to call on every startup:

```typescript
// Safe to call multiple times — idempotent
await emailQueue.add('weekly-digest', templatePayload, {
  repeat: { pattern: '0 9 * * 1', tz: 'UTC' },
  jobId: 'repeat:weekly-digest',
});
```

---

## Phase 5: Admin API

**Goal:** Express HTTP API with all required endpoints.

### Steps

1. Create `src/api.ts` with Express app setup.

2. Implement queue helpers in a separate file `src/queues/stats.ts`:
   - `getQueueStats()`: returns counts for both queues
   - `getFailedJobs(page, limit)`: paginated failed jobs from main queue
   - `getDeadLetterJobs(page, limit)`: paginated jobs from DLQ
   - `retryJob(jobId)`: moves a job back to main queue
   - `removeJob(jobId)`: removes a job from whichever queue holds it

3. Implement all enqueue endpoints with proper validation:
   - Validate required fields before enqueueing
   - Return 400 with field errors if validation fails
   - Return 409 if `jobId` already exists in the queue (check first with
     `await queue.getJob(jobId)` before adding)

4. Implement all admin endpoints.

5. Add global error handling middleware.

**Definition of done:** All endpoints return the correct shape. Manual
testing with curl or Postman covers all happy paths and error cases.

### Key Decision: Duplicate Detection

BullMQ's `jobId` option silently deduplicates — if the job exists, the
add call succeeds but no new job is created. For proper 409 responses,
check manually:

```typescript
async function enqueueWelcomeEmail(payload: WelcomeEmailPayload) {
  const jobId = `welcome:${payload.userId}`;
  const existingJob = await emailQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();
    // Only deduplicate if the job is still pending — not if it completed
    if (state !== 'completed' && state !== 'failed') {
      return { duplicate: true, jobId: existingJob.id };
    }
  }

  const job = await emailQueue.add('welcome_email', payload, { jobId });
  return { duplicate: false, jobId: job.id };
}
```

---

## Phase 6: Dead Letter Handling

**Goal:** Full DLQ workflow — inspect, retry, discard.

### Steps

1. Ensure the DLQ is populated by Phase 3's dead letter logic.

2. Implement admin endpoints for the DLQ:
   - `GET /api/v1/jobs/dead-letter` — list all DLQ jobs with failure metadata
   - `POST /api/v1/jobs/retry/:id` — move a DLQ job back to the main queue
   - `DELETE /api/v1/jobs/:id` — remove a job (check both queues)

3. Write the `demo.ts` script that exercises the full flow:
   - Enqueue all job types
   - Trigger a permanent failure (temporarily set failure rate to 1.0)
   - Verify the job appears in the DLQ
   - Use the retry endpoint to move it back
   - Set failure rate to 0 and verify it processes successfully
   - Print a summary of queue stats

4. Test error recovery scenarios:
   - Job that fails 3 times → appears in failed, DLQ
   - Retry from DLQ → re-queued, processes on next attempt
   - Invalid payload → UnrecoverableError → immediately to failed/DLQ

**Definition of done:** Full demo script runs end-to-end without manual
intervention. All queue states are reachable and recoverable.

---

## Testing Approach

### Unit Tests

- `MockEmailService`: failure rate configuration, delay range
- Job payload validation (individual type guards)
- Retry delay calculation for each backoff strategy

### Integration Tests

Use `testcontainers` or a local Redis instance:

```typescript
// test/email-worker.test.ts
// 1. Create a test queue connected to real Redis
// 2. Add a job with known payload
// 3. Start a worker for that queue
// 4. Assert on the completed event
// 5. Check final queue state
```

### Manual Testing Checklist

Before submitting:
- [ ] All 4 job types enqueue and process
- [ ] Duplicate welcome_email returns 409
- [ ] Setting `MOCK_FAILURE_RATE=1` causes permanent failure
- [ ] Failed job appears in `/api/v1/jobs/dead-letter`
- [ ] Retrying from dead letter re-queues successfully
- [ ] Worker handles SIGTERM gracefully (no mid-job corruption)
- [ ] `GET /api/v1/jobs/stats` returns accurate counts
- [ ] Repeat job is registered in Redis and shows as delayed

---

## Key Architectural Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Queue library | BullMQ | Best-maintained, full-featured, TypeScript-native |
| Redis client | ioredis | Required by BullMQ |
| DLQ implementation | Separate BullMQ queue | Clear separation, easy admin |
| Deduplication | BullMQ jobId + manual check for 409 | Clean, no extra locking |
| Scheduling | BullMQ repeat jobs | Integrates with worker system, no separate cron |
| Failure classification | UnrecoverableError for permanent, re-throw for transient | BullMQ's built-in mechanism |
| Progress reporting | `job.updateProgress()` | Native BullMQ, works with Bull Board |
