# Lesson 4: Reliability and Patterns

## What Reliability Means in a Job Queue

A job queue is only as valuable as its reliability guarantees. An unreliable
queue is worse than no queue at all — it gives you the illusion of durable
background processing while silently dropping or duplicating work.

Reliability in a job queue system has four dimensions:

1. **Durability:** Jobs are not lost when workers crash or when Redis restarts
2. **Delivery:** Jobs are processed at least once (at-least-once delivery)
3. **Recovery:** Failed jobs are surfaced and retrievable, not silently dropped
4. **Observability:** You know what's happening at all times

The patterns in this lesson address all four. They are not optional
optimizations — they are the minimum necessary for a production system.

---

## Retry Strategies

When a job fails, you have a choice: give up immediately, or try again.
For transient failures (network timeouts, rate limits, database contention),
retrying is almost always the right answer. The question is how to retry.

### Immediate Retry

Retry immediately with no delay. This is almost never the right choice.

If a job failed because an external API returned a 503, retrying immediately
will fail again immediately for the same reason. You've burned through your
retry budget in milliseconds and accomplished nothing. Worse, you've added
load to an already-struggling system.

```typescript
// Bad: immediate retry
{ attempts: 3, backoff: { type: 'fixed', delay: 0 } }
```

The only scenario where immediate retry is appropriate: purely local
transient errors like database deadlocks, where a millisecond of wait is
sufficient.

### Fixed Delay

Wait a fixed number of milliseconds between every retry. Better than
immediate, but still problematic under load.

If 1,000 jobs all fail at the same time (say, during a downstream outage),
they all retry after exactly 30 seconds. You get a thundering herd — a
massive spike of traffic hitting the already-recovering downstream system
exactly 30 seconds after the outage.

```typescript
{ attempts: 5, backoff: { type: 'fixed', delay: 30_000 } }
// Retry at: T+30s, T+60s, T+90s, T+120s — synchronized stampede
```

### Exponential Backoff

Each retry waits exponentially longer than the last. The first retry might
wait 1 second, the second 2 seconds, the third 4 seconds, and so on.

This naturally spreads out retries over time and gives downstream systems
room to recover without being immediately bombarded again.

```typescript
{ attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
// Retry at: T+1s, T+2s, T+4s, T+8s
// delay formula: delay * 2^(attemptsMade - 1)
```

This is BullMQ's built-in `exponential` backoff type. The delay doubles
with each attempt.

### Exponential Backoff with Jitter

The canonical approach. Exponential backoff spreads retries out over time,
but when you have thousands of jobs, all those exponential delays still
align at the same moments. Jitter randomizes the wait to break that
synchronization.

BullMQ doesn't support jitter natively, so you implement it by throwing
a custom `WaitingChildrenError` or by computing the delay manually in
a custom backoff strategy:

```typescript
import { Worker, Job, UnrecoverableError } from 'bullmq';

async function processWithJitter(job: Job): Promise<void> {
  try {
    await doWork(job.data);
  } catch (err) {
    if (isTransientError(err)) {
      // Compute jittered backoff manually
      const baseDelay = 1000;
      const maxDelay = 32_000;
      const exponential = baseDelay * Math.pow(2, job.attemptsMade);
      const jitter = Math.random() * 1000;  // 0-1 second of random jitter
      const delay = Math.min(exponential + jitter, maxDelay);

      // BullMQ will use the backoff option, but you can also
      // signal a specific delay by storing it in job metadata
      throw err;  // Re-throw so BullMQ applies the backoff
    } else {
      // Non-transient error: don't retry
      throw new UnrecoverableError(err.message);
    }
  }
}

// Custom backoff strategy in worker options
const worker = new Worker('jobs', processWithJitter, {
  connection,
  settings: {
    backoffStrategy: (attemptsMade, type, err, job) => {
      if (type === 'custom') {
        const baseDelay = 1000;
        const exponential = baseDelay * Math.pow(2, attemptsMade - 1);
        const jitter = Math.floor(Math.random() * 1000);
        return Math.min(exponential + jitter, 32_000);
      }
      return -1;  // Use default strategy
    },
  },
});
```

Use `type: 'custom'` in your job options to invoke the `backoffStrategy`:

```typescript
await queue.add('task', data, {
  attempts: 6,
  backoff: { type: 'custom' },
});
```

### The `UnrecoverableError` Escape Hatch

Some errors should not be retried at all. If a job has bad data — a
malformed email address, an invalid user ID — retrying it 5 times is
pointless. It will fail identically every time.

BullMQ's `UnrecoverableError` marks a job as permanently failed immediately,
bypassing all remaining retry attempts:

```typescript
import { UnrecoverableError } from 'bullmq';

async function processJob(job: Job): Promise<void> {
  const user = await db.users.findByPk(job.data.userId);

  if (!user) {
    // This user doesn't exist. Retrying won't make them appear.
    throw new UnrecoverableError(`User ${job.data.userId} not found`);
  }

  // ...rest of processing
}
```

When `UnrecoverableError` is thrown, BullMQ immediately moves the job
to `failed` state regardless of remaining attempts.

### Retry Strategy Comparison

| Strategy | Retry timing | Thundering herd | Best for |
|----------|-------------|-----------------|----------|
| Immediate | Instant | Severe | Local deadlocks only |
| Fixed delay | Uniform | Moderate | Simple cases |
| Exponential | Doubling | Low | External API failures |
| Exponential + jitter | Randomized doubling | Minimal | High-volume, production |

---

## Dead Letter Queues

A dead letter queue (DLQ) is where jobs go when they've exhausted all retry
attempts. The term comes from postal services: a "dead letter" is mail that
can't be delivered and can't be returned to sender.

In BullMQ, jobs that reach their `attempts` limit automatically move to
the `failed` state in the same queue. This serves as BullMQ's implicit
dead letter store. However, it's worth setting up a dedicated dead letter
queue for explicit handling.

### Why You Need a DLQ

Without a DLQ, failed jobs accumulate silently in the `failed` state.
They might be cleaned up automatically (if you have `removeOnFail` set).
Nobody is alerted. Nobody investigates.

A DLQ makes failure explicit and observable. It separates "this failed
and will be retried" from "this has permanently failed and needs human
attention." It gives you a single place to look at all permanently failed
jobs across your system.

### Implementing a Dead Letter Queue in BullMQ

BullMQ doesn't have a first-class DLQ concept, but implementing one is
straightforward using worker event handlers:

```typescript
import { Queue, Worker, Job } from 'bullmq';
import { connection } from './redis';

// Main work queue
const emailQueue = new Queue('emails', { connection });

// Dead letter queue — separate queue, same Redis
const deadLetterQueue = new Queue('emails:dead', {
  connection,
  defaultJobOptions: {
    // DLQ jobs are never retried automatically
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  },
});

const emailWorker = new Worker('emails', processEmail, {
  connection,
  concurrency: 5,
});

// When a job has failed all its attempts, move it to the DLQ
emailWorker.on('failed', async (job: Job | undefined, err: Error) => {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  const hasExhaustedAttempts = job.attemptsMade >= maxAttempts;

  if (hasExhaustedAttempts) {
    console.error(`Moving job ${job.id} to dead letter queue`);

    await deadLetterQueue.add(
      job.name,
      {
        ...job.data,
        // Attach failure metadata for debugging
        _deadLetter: {
          originalJobId: job.id,
          originalQueue: 'emails',
          failedAt: new Date().toISOString(),
          failedReason: err.message,
          attemptsMade: job.attemptsMade,
          stackTrace: err.stack,
        },
      }
    );
  }
});
```

### Working with the DLQ

You need an admin API to inspect and act on dead letter jobs:

```typescript
import express from 'express';
import { Job } from 'bullmq';

const app = express();

// List all dead letter jobs
app.get('/admin/dead-letter', async (req, res) => {
  const jobs = await deadLetterQueue.getFailed(0, 99);
  res.json({
    count: jobs.length,
    jobs: jobs.map(job => ({
      id: job.id,
      name: job.name,
      data: job.data,
      deadLetterMeta: job.data._deadLetter,
      failedReason: job.failedReason,
      createdAt: new Date(job.timestamp).toISOString(),
    })),
  });
});

// Retry a specific dead letter job (move back to main queue)
app.post('/admin/dead-letter/:id/retry', async (req, res) => {
  const job = await Job.fromId(deadLetterQueue, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Extract original data, remove DLQ metadata
  const { _deadLetter, ...originalData } = job.data;

  // Re-queue in the main queue
  const newJob = await emailQueue.add(job.name, originalData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });

  // Remove from DLQ
  await job.remove();

  res.json({ requeued: true, newJobId: newJob.id });
});

// Discard a dead letter job permanently
app.delete('/admin/dead-letter/:id', async (req, res) => {
  const job = await Job.fromId(deadLetterQueue, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  await job.remove();
  res.json({ removed: true });
});
```

---

## Poison Messages

A poison message is a job that will always fail, no matter how many times
you retry it. Examples:

- A job that calls an API endpoint that no longer exists
- A job with malformed data that causes a parsing error
- A job that tries to access a database record that was deleted

Poison messages are dangerous in naive queue setups because they can
exhaust all your workers if they keep being retried rapidly. A single
poison message cycling between active and waiting state in a tight loop
can starve other jobs of worker capacity.

### Detecting Poison Messages

The signature of a poison message: it fails on every attempt, with the
same error, regardless of when you retry it.

Detection approach:

```typescript
async function processJob(job: Job): Promise<void> {
  // Detect poison by checking if this job has failed too many times
  // in a short window — this suggests it's systematically broken
  if (job.attemptsMade > 0) {
    const timeSinceCreation = Date.now() - job.timestamp;
    const failureRate = job.attemptsMade / (timeSinceCreation / 60_000);

    if (failureRate > 5) {
      // More than 5 failures per minute — likely a poison message
      throw new UnrecoverableError(
        `Poison message detected: ${job.attemptsMade} failures in ${Math.round(timeSinceCreation / 1000)}s`
      );
    }
  }

  await doWork(job.data);
}
```

The `UnrecoverableError` immediately moves it to `failed`, preventing
further retry cycles.

---

## Circuit Breaker Pattern

The circuit breaker pattern comes from electrical engineering. In software,
it prevents a failing downstream dependency from causing cascading failures
across your system.

Imagine your email worker calls an external email provider. The provider
goes down. Without a circuit breaker, every email job fails, retries,
fails again, and burns through retry attempts. Your queue fills with
failed jobs, your workers are constantly busy failing, and legitimate
work (password resets!) is delayed indefinitely.

A circuit breaker tracks the failure rate for a dependency. When failures
exceed a threshold, the circuit "trips" and subsequent calls fail fast
(without even trying the external service). After a timeout, the circuit
enters a "half-open" state where it allows one test request. If that
succeeds, the circuit closes and normal operation resumes.

```typescript
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOptions {
  failureThreshold: number;   // How many failures to open the circuit
  successThreshold: number;   // How many successes to close from half-open
  timeout: number;             // How long to wait before trying half-open (ms)
}

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private readonly options: CircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions) {
    this.options = options;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.lastFailureTime ?? 0);
      if (elapsed > this.options.timeout) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new Error('Circuit is open — dependency is unavailable');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.state = 'closed';
        console.log('Circuit breaker: closed (dependency recovered)');
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.options.failureThreshold) {
      this.state = 'open';
      console.error('Circuit breaker: opened (dependency failing)');
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// Usage in a job processor
const emailProviderBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60_000,  // Wait 1 minute before trying again
});

async function processEmailJob(job: Job): Promise<void> {
  await emailProviderBreaker.execute(async () => {
    await emailProvider.send(job.data);
  });
}
```

When the circuit is open, the job fails immediately (without waiting
for a network timeout). BullMQ applies backoff and retries later. By
the time the circuit is ready to half-open, the dependency may have
recovered.

---

## Job Deduplication

Deduplication prevents the same logical job from being queued twice.
This is different from idempotency — idempotency ensures correct behavior
if a job runs twice, while deduplication prevents it from running twice
in the first place.

BullMQ's `jobId` option is the primary deduplication mechanism. If you
add a job with a `jobId` that already exists in the queue (in any
non-completed, non-failed state), BullMQ silently discards the duplicate:

```typescript
// Deduplicate welcome emails by userId
// If this user's welcome email is already queued or running, skip it
await emailQueue.add(
  'welcome_email',
  { userId: 'user-123', email: 'alice@example.com', name: 'Alice' },
  { jobId: `welcome:user-123` }
);

// Calling this again with the same jobId is safe — no duplicate queued
await emailQueue.add(
  'welcome_email',
  { userId: 'user-123', email: 'alice@example.com', name: 'Alice' },
  { jobId: `welcome:user-123` }
);
```

**Important caveat:** Once a job with a given `jobId` completes or fails
and is removed from the queue, that `jobId` is available again. If you
want permanent deduplication (e.g., "never send a welcome email to this
user even if we delete and re-add them"), you need a separate idempotency
record in your database.

### Time-Windowed Deduplication

For cases where you want to allow re-runs after a time window:

```typescript
async function enqueueDeduped(
  queue: Queue,
  name: string,
  data: object,
  dedupeKey: string,
  windowMs: number
): Promise<string | null> {
  const lockKey = `dedupe:${queue.name}:${dedupeKey}`;

  // Try to set a flag in Redis that expires after the window
  const redis = queue.client;
  const set = await redis.set(lockKey, '1', 'PX', windowMs, 'NX');

  if (!set) {
    console.log(`Deduped: ${dedupeKey} already queued within ${windowMs}ms`);
    return null;
  }

  const job = await queue.add(name, data);
  return job.id ?? null;
}

// Usage: don't send more than one digest per user per week
await enqueueDeduped(
  emailQueue,
  'weekly_digest',
  { userId: 'user-123', email: 'alice@example.com' },
  `digest:user-123`,
  7 * 24 * 60 * 60 * 1000  // 7 days
);
```

---

## Workflow Orchestration: Chains and Fan-out

Real business processes often require multiple jobs to run in sequence
or parallel. BullMQ supports this with **job flows** (using `FlowProducer`).

### Job Chains

A chain runs jobs in sequence. Job B starts only after Job A completes.
Classic use case: generate PDF → upload to S3 → send email with link.

```typescript
import { FlowProducer } from 'bullmq';

const flowProducer = new FlowProducer({ connection });

// Create a chain: step 1 → step 2 → step 3
await flowProducer.add({
  name: 'send-invoice-email',
  queueName: 'notifications',
  data: { invoiceId: 'inv-123' },
  children: [
    {
      name: 'upload-to-s3',
      queueName: 'storage',
      data: { invoiceId: 'inv-123' },
      children: [
        {
          name: 'generate-pdf',
          queueName: 'pdf-generation',
          data: { invoiceId: 'inv-123' },
        },
      ],
    },
  ],
});
```

BullMQ processes children first. `generate-pdf` runs first, `upload-to-s3`
runs when it completes, `send-invoice-email` runs when that completes.

### Fan-out (Parallel Jobs)

Fan-out creates multiple jobs that run in parallel, then waits for all to
complete before proceeding. Classic use case: send notifications to 1,000
users simultaneously, then record that the broadcast completed.

```typescript
// Fan-out to multiple workers simultaneously
const userIds = await db.users.getAllActiveUserIds();

// Create a job for each user (fan-out)
const emailJobs = userIds.map(userId => ({
  name: 'weekly-digest',
  data: { userId },
  queueName: 'emails',
}));

// Add all jobs at once — they'll be processed concurrently
const jobs = await emailQueue.addBulk(emailJobs);
console.log(`Queued ${jobs.length} weekly digest emails`);

// For fan-in (waiting for all to complete), use QueueEvents
// or track completion via a counter in Redis
```

For true fan-in (run code after all fan-out jobs complete), you need to
track completions:

```typescript
async function fanOutWithCompletion(
  userIds: string[],
  batchId: string
): Promise<void> {
  const redis = await getRedis();

  // Store expected count
  await redis.set(`batch:${batchId}:total`, userIds.length);
  await redis.set(`batch:${batchId}:completed`, 0);

  // Queue all jobs with batchId in the data
  await emailQueue.addBulk(
    userIds.map(userId => ({
      name: 'weekly-digest',
      data: { userId, batchId },
    }))
  );
}

// In the worker, after each job completes:
async function processDigest(job: Job): Promise<void> {
  const { userId, batchId } = job.data;
  await sendDigestEmail(userId);

  if (batchId) {
    const completed = await redis.incr(`batch:${batchId}:completed`);
    const total = Number(await redis.get(`batch:${batchId}:total`));

    if (completed >= total) {
      // All jobs in the batch are done — trigger completion action
      await notifyBatchComplete(batchId);
    }
  }
}
```

---

## Monitoring Jobs

Observability is non-negotiable in production. You need to know:
- How many jobs are waiting, active, completed, and failed?
- What is the job processing throughput?
- Are there jobs sitting in `failed` that need attention?
- How long are jobs taking to process?

### Queue Metrics

```typescript
async function getQueueStats(queue: Queue) {
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
    'paused'
  );

  const waiting = await queue.getWaiting(0, 9);
  const failed = await queue.getFailed(0, 9);

  return {
    counts,
    recentWaiting: waiting.map(j => ({
      id: j.id,
      name: j.name,
      waitingSince: new Date(j.timestamp).toISOString(),
    })),
    recentFailed: failed.map(j => ({
      id: j.id,
      name: j.name,
      failedReason: j.failedReason,
      failedAt: new Date(j.finishedOn ?? j.timestamp).toISOString(),
    })),
  };
}
```

### BullMQ Dashboard

For a visual interface, Bull Board is the standard choice:

```bash
npm install @bull-board/express @bull-board/api
```

```typescript
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(emailQueue),
    new BullMQAdapter(deadLetterQueue),
  ],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());
```

Navigate to `/admin/queues` to see job counts, inspect individual jobs,
retry failed jobs, and clean up the queue — all from a browser UI.

---

## Graceful Shutdown

Graceful shutdown ensures your workers finish their current jobs before
exiting. Without it, you'll have jobs interrupted mid-flight — data
partially written, emails half-sent, state corrupted.

```typescript
import { Worker, Queue } from 'bullmq';

const worker = new Worker('emails', processEmail, { connection });
const queue = new Queue('emails', { connection });

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, initiating graceful shutdown...`);

  // Stop accepting new jobs
  await worker.pause();
  console.log('Worker paused — no new jobs will be picked up');

  // Wait for active jobs to complete (with a timeout)
  const shutdownTimeout = 30_000;  // 30 seconds
  const shutdownDeadline = Date.now() + shutdownTimeout;

  while (Date.now() < shutdownDeadline) {
    const activeCount = (await queue.getActiveCount());
    if (activeCount === 0) {
      console.log('All active jobs completed');
      break;
    }
    console.log(`Waiting for ${activeCount} active jobs...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Close connections
  await worker.close();
  await queue.close();
  await connection.quit();

  console.log('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

The `worker.close()` call waits for all active jobs to finish before
closing the worker. The explicit loop above adds visibility and a timeout.

In Kubernetes, `SIGTERM` is sent when a pod is being terminated. You
have `terminationGracePeriodSeconds` (default 30s) before a `SIGKILL`
is sent. Make sure your `shutdownTimeout` is less than that, or your
jobs may be killed mid-flight.

---

## Exercises

### Exercise 1: Retry Strategy Analysis

You have a job that calls a third-party weather API. The API has three
types of failures:

1. `429 Too Many Requests` — you're over the rate limit
2. `503 Service Unavailable` — the API is temporarily down
3. `400 Bad Request` — your request is malformed (the job data is bad)
4. `404 Not Found` — the location you're querying doesn't exist

For each error type, specify:
- Should you retry? If yes, how many times?
- What backoff strategy is appropriate?
- Should you use `UnrecoverableError`?
- How should you log the error?

Write a `processWeatherJob` function that handles all four cases correctly.

### Exercise 2: Dead Letter Queue Inspector

Build a CLI tool (not an Express server — a runnable script) that:
1. Connects to the dead letter queue
2. Lists all failed jobs with their failure reasons and timestamps
3. Accepts user input: retry job by ID, discard job by ID, or discard all
4. Re-queues the job to the main queue when retrying

Use `readline` from Node's standard library for the interactive menu.

### Exercise 3: Circuit Breaker Integration Test

Write an integration test (using a real or mocked worker) that:
1. Simulates 5 consecutive failures from a downstream service
2. Verifies the circuit breaker opens after the 5th failure
3. Verifies that subsequent calls fail fast (without actually hitting the service)
4. Advances time past the timeout
5. Verifies the circuit enters half-open state
6. Simulates 2 successful calls
7. Verifies the circuit closes

### Exercise 4: Fan-out Batch Processing

Implement a complete fan-out system for sending weekly digests:

1. A "batch starter" job is triggered by a cron schedule
2. It queries the database for all users who want digests
3. It creates individual `weekly_digest` jobs for each user (fan-out)
4. It stores a counter in Redis: `batch:{id}:total` = user count
5. Each individual digest job, upon completion, increments `batch:{id}:completed`
6. When completed equals total, fire a `batch_completed` job that records
   the batch run in the database

Include error handling: what happens if a batch_completed job itself fails?

### Exercise 5: Graceful Shutdown Test

Write a test that:
1. Starts a worker with `concurrency: 3`
2. Queues 10 jobs, each taking 3 seconds
3. After 2 seconds, sends SIGTERM to the process
4. Verifies that all 3 in-progress jobs complete
5. Verifies that the remaining 7 queued jobs are still in `waiting` state
6. Verifies no data is corrupted (each job that started, completed cleanly)
