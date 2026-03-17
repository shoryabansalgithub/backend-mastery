# Lesson 3: Job Queues with BullMQ

## Why BullMQ

Before we get into code, it's worth understanding why BullMQ exists and
what problem it solves at an architectural level.

BullMQ is a Node.js job queue library backed by Redis. It sits between
your application code (which creates jobs) and your worker code (which
processes them). The critical insight is that Redis is the source of
truth for job state — not your application's memory. This means:

- Multiple producer processes can enqueue jobs concurrently
- Multiple worker processes can process jobs concurrently
- If a worker crashes mid-job, the job is not lost
- You can inspect, retry, and remove jobs without touching your application

The alternative — in-memory queues, or simple setTimeout-based deferral —
falls apart the moment you have more than one process, or the moment your
process crashes. BullMQ's durability guarantee is the reason to use it.

---

## Architecture: The Three Core Entities

BullMQ has three primary classes that you'll work with constantly. Understanding
what each one does, and what it does NOT do, is essential.

### Queue

A `Queue` is the interface for adding jobs. It represents the logical queue
and knows how to communicate with Redis. You use `Queue` in your API handlers,
in your cron schedulers, anywhere you want to enqueue work.

The `Queue` object does not process jobs. It only adds them. This separation
means your API server can enqueue thousands of jobs without any of the
complexity of job processing.

### Worker

A `Worker` connects to the same Redis queue and processes jobs. It polls
Redis for available jobs, runs your processor function for each one, and
handles acknowledgment and error tracking. You can run multiple `Worker`
instances — in the same process or different processes — and they will
each grab different jobs from the queue.

### QueueEvents

`QueueEvents` is an event emitter that lets you listen to queue-wide events:
when jobs complete, fail, stall, or progress. It uses Redis's pub/sub
mechanism. Use it for monitoring, dashboards, and cross-cutting concerns
like logging job lifecycle events.

---

## How BullMQ Uses Redis

Understanding the data structures BullMQ creates in Redis gives you insight
into how the system works and helps you debug issues.

BullMQ uses Redis **sorted sets** and **hashes** as its primary data
structures (and some lists for specific operations). For a queue named
`emails`, BullMQ creates keys like:

```
bull:emails:id            — counter for generating unique job IDs
bull:emails:wait          — sorted set: jobs waiting to be picked up
bull:emails:active        — sorted set: jobs currently being processed
bull:emails:completed     — sorted set: jobs that finished successfully
bull:emails:failed        — sorted set: jobs that exceeded max attempts
bull:emails:delayed       — sorted set: jobs scheduled for future execution
bull:emails:prioritized   — sorted set: jobs with priority > 0
bull:emails:{id}          — hash: full job data for job with this ID
bull:emails:events        — Redis stream: job lifecycle events
```

When a worker picks up a job, it atomically moves the job from `wait`
to `active` (using a Redis transaction). When the processor function
returns successfully, it moves the job to `completed`. If the processor
throws, it moves the job to either `wait` (for retry) or `failed` (if
max attempts exceeded). This atomic movement is the core of BullMQ's
reliability guarantee.

The sorted sets use scores (typically timestamps) to order jobs. Delayed
jobs have a score equal to their scheduled run time — the worker checks
if any delayed jobs have scores in the past and moves them to `wait`.

---

## Job Lifecycle

Every job in BullMQ passes through a defined set of states:

```
                    ┌──────────────────────────────────┐
                    │                                  │
  add()    ┌─────┐  │  ┌────────┐     ┌───────────┐   │
 ─────────►│wait │──┘  │ active │────►│ completed │   │
           └─────┘     │        │     └───────────┘   │
               │       └────────┘                     │
               │           │                          │
               │           │ (failed attempt)         │
               │           ▼                          │
               │       ┌────────┐                     │
               │       │  wait  │◄────────────────────┘
               │       │(retry) │      (delay between retries)
               │       └────────┘
               │           │
               │           │ (max attempts exceeded)
               │           ▼
               │       ┌────────┐
               │       │ failed │
               │       └────────┘
               │
               │ (delay option set)
               ▼
           ┌─────────┐
           │ delayed │
           └─────────┘
```

**waiting:** The job has been added and is queued for processing.
No worker has picked it up yet.

**active:** A worker has picked up the job and is running the processor.
The job has a lock associated with it. If the worker crashes and stops
renewing the lock, the job becomes "stalled" and BullMQ returns it to
the waiting state.

**completed:** The processor function returned without throwing. The job
is done.

**failed:** The processor threw an exception and all retry attempts have
been exhausted. The job sits in `failed` state until a human (or an
automated process) inspects and retries or discards it.

**delayed:** The job was added with a `delay` option, or it failed and
has a retry delay configured. It will move to `waiting` when the delay
expires.

---

## Installation and Setup

```bash
npm install bullmq ioredis
```

BullMQ requires Redis 6.2 or higher. It uses Redis modules/features that
older versions don't support.

```typescript
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';

// Shared Redis connection configuration
const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,  // Required for BullMQ
});
```

The `maxRetriesPerRequest: null` setting is important. BullMQ's blocking
commands need to wait indefinitely, and the default retry behavior of
ioredis will interfere with that.

---

## Defining Jobs: Types and Payloads

Before writing queue code, define your job types. Type safety here pays
off enormously when you're debugging production issues and can't remember
what fields a particular job carries.

```typescript
// types/jobs.ts

export interface WelcomeEmailPayload {
  userId: string;
  email: string;
  name: string;
}

export interface PasswordResetPayload {
  userId: string;
  email: string;
  resetToken: string;
  expiresAt: string;  // ISO date string
}

export interface WeeklyDigestPayload {
  userId: string;
  email: string;
  weekStartDate: string;  // ISO date string
}

export interface InvoiceGeneratedPayload {
  invoiceId: string;
  userId: string;
  email: string;
  amount: number;
  currency: string;
}

// Union type for all job payloads
export type EmailJobPayload =
  | ({ type: 'welcome_email' } & WelcomeEmailPayload)
  | ({ type: 'password_reset' } & PasswordResetPayload)
  | ({ type: 'weekly_digest' } & WeeklyDigestPayload)
  | ({ type: 'invoice_generated' } & InvoiceGeneratedPayload);
```

---

## Creating a Queue and Adding Jobs

```typescript
import { Queue } from 'bullmq';
import { connection } from './redis';
import type { EmailJobPayload } from './types/jobs';

export const emailQueue = new Queue<EmailJobPayload>('emails', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,  // Start with 1 second, then 2s, then 4s
    },
    removeOnComplete: { count: 1000 },  // Keep last 1000 completed jobs
    removeOnFail: { count: 5000 },      // Keep last 5000 failed jobs
  },
});

// Add a job
await emailQueue.add('welcome_email', {
  type: 'welcome_email',
  userId: 'user-123',
  email: 'alice@example.com',
  name: 'Alice',
});

// Add a job with options that override the defaults
await emailQueue.add(
  'password_reset',
  {
    type: 'password_reset',
    userId: 'user-456',
    email: 'bob@example.com',
    resetToken: 'tok_abc123',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  {
    priority: 10,        // Higher priority = processed sooner
    attempts: 5,         // Override the default 3 attempts
    delay: 0,            // Start immediately (no delay)
  }
);

// Add a delayed job (runs in 30 minutes)
await emailQueue.add(
  'invoice_generated',
  { type: 'invoice_generated', invoiceId: 'inv-789', userId: 'user-789',
    email: 'charlie@example.com', amount: 9900, currency: 'usd' },
  { delay: 30 * 60 * 1000 }
);
```

### Job Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `attempts` | `number` | Max attempts before marking as failed |
| `backoff` | `BackoffOptions` | Delay strategy between retries |
| `delay` | `number` | Delay in ms before job becomes active |
| `priority` | `number` | Higher = processed first (default: 0) |
| `lifo` | `boolean` | Last-in-first-out (default: false) |
| `removeOnComplete` | `boolean \| RemoveOptions` | Auto-remove completed jobs |
| `removeOnFail` | `boolean \| RemoveOptions` | Auto-remove failed jobs |
| `jobId` | `string` | Custom ID — if job with ID exists, skip |
| `repeat` | `RepeatOptions` | Schedule repeating job |

---

## Writing a Worker

```typescript
import { Worker, Job } from 'bullmq';
import { connection } from './redis';
import type { EmailJobPayload } from './types/jobs';

// Simulate email sending with a realistic delay
async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const delay = 200 + Math.random() * 800;  // 200-1000ms
  await new Promise(resolve => setTimeout(resolve, delay));

  // In production, call your email provider here (SendGrid, Postmark, etc.)
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`);
  console.log(`[EMAIL] Body: ${body.slice(0, 80)}...`);
}

// The processor function
async function processEmailJob(job: Job<EmailJobPayload>): Promise<void> {
  const { data } = job;

  console.log(`Processing job ${job.id} (${data.type}), attempt ${job.attemptsMade + 1}`);

  switch (data.type) {
    case 'welcome_email':
      await job.updateProgress(10);
      await sendEmail(
        data.email,
        'Welcome to the platform!',
        `Hi ${data.name}, thanks for joining us!`
      );
      await job.updateProgress(100);
      break;

    case 'password_reset':
      await sendEmail(
        data.email,
        'Reset your password',
        `Click this link to reset your password: https://app.example.com/reset/${data.resetToken}`
      );
      break;

    case 'weekly_digest':
      await job.updateProgress(0);
      const articles = await fetchWeeklyArticles(data.weekStartDate);
      await job.updateProgress(50);
      await sendEmail(
        data.email,
        'Your weekly digest',
        formatDigest(articles)
      );
      await job.updateProgress(100);
      break;

    case 'invoice_generated':
      const pdfPath = await generateInvoicePdf(data.invoiceId);
      await sendEmail(
        data.email,
        `Invoice #${data.invoiceId} — $${(data.amount / 100).toFixed(2)}`,
        `Your invoice is attached. Amount: ${data.currency.toUpperCase()} ${data.amount / 100}`
      );
      break;

    default:
      // TypeScript will catch this if you've covered all cases,
      // but defensive runtime check is good practice
      throw new Error(`Unknown job type: ${(data as any).type}`);
  }
}

// Create the worker
export const emailWorker = new Worker<EmailJobPayload>(
  'emails',
  processEmailJob,
  {
    connection,
    concurrency: 5,    // Process up to 5 jobs simultaneously
    limiter: {
      max: 100,         // Max 100 jobs per duration
      duration: 60_000, // Per minute
    },
  }
);

// Worker event handlers
emailWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed in ${Date.now() - job.timestamp}ms`);
});

emailWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed: ${err.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    console.error(`Job ${job.id} exceeded max attempts, moving to dead letter`);
    // Handle dead letter — covered in Lesson 4
  }
});

emailWorker.on('stalled', (jobId) => {
  console.warn(`Job ${jobId} stalled — worker may have crashed`);
});

emailWorker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});
```

### Worker Concurrency

The `concurrency` option controls how many jobs a single worker instance
processes simultaneously. With `concurrency: 5`, your worker runs 5 jobs
at once in the same Node.js event loop.

This is appropriate for I/O-bound work (email sending, API calls) because
waiting for an HTTP response releases the event loop to run other jobs.
For CPU-bound work (PDF generation, image processing), concurrency > 1
provides little benefit and can hurt performance by causing event loop
starvation.

For CPU-bound work, use BullMQ's sandboxed processors (separate child
processes, covered below) instead of high concurrency.

---

## Rate Limiting Workers

BullMQ can rate-limit job processing to respect external API limits:

```typescript
const emailWorker = new Worker('emails', processEmailJob, {
  connection,
  concurrency: 5,
  limiter: {
    max: 100,           // Maximum 100 jobs
    duration: 60_000,   // In 60 seconds
    // This translates to ~1.67 jobs/second, respecting SendGrid's limits
  },
});
```

When a worker is rate-limited, it pauses and waits for the rate limit
window to reset before picking up new jobs. Existing active jobs continue
running. This is purely a throughput throttle — it does not affect
already-active jobs.

---

## Job Events with QueueEvents

For monitoring and cross-service notification, `QueueEvents` lets you
listen to events from any process:

```typescript
import { QueueEvents } from 'bullmq';
import { connection } from './redis';

const queueEvents = new QueueEvents('emails', { connection });

queueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`[MONITOR] Job ${jobId} completed:`, returnvalue);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[MONITOR] Job ${jobId} failed: ${failedReason}`);
  // Send alert to Slack, PagerDuty, etc.
});

queueEvents.on('stalled', ({ jobId }) => {
  console.warn(`[MONITOR] Job ${jobId} stalled`);
});

queueEvents.on('progress', ({ jobId, data }) => {
  // data is whatever you passed to job.updateProgress()
  console.log(`[MONITOR] Job ${jobId} progress:`, data);
});
```

`QueueEvents` uses a dedicated Redis connection and subscribes to the
queue's event stream. It works across processes — you can run a separate
monitoring service that listens to events from all your queues.

---

## Progress Reporting

For long-running jobs, progress reporting lets you surface status to users
in real-time (via websockets, polling, etc.):

```typescript
async function generateReport(job: Job) {
  const { userId, dateRange } = job.data;

  await job.updateProgress({ stage: 'fetching_data', percent: 0 });

  const rawData = await fetchAnalyticsData(userId, dateRange);
  await job.updateProgress({ stage: 'processing', percent: 40 });

  const processed = await processData(rawData);
  await job.updateProgress({ stage: 'generating_pdf', percent: 70 });

  const pdfPath = await generatePdf(processed);
  await job.updateProgress({ stage: 'uploading', percent: 90 });

  await uploadToS3(pdfPath);
  await job.updateProgress({ stage: 'complete', percent: 100 });

  return { pdfUrl: `https://cdn.example.com/reports/${userId}-${dateRange}.pdf` };
}
```

In your API, you can expose a `/jobs/:id/status` endpoint:

```typescript
app.get('/jobs/:id/status', async (req, res) => {
  const job = await Job.fromId(emailQueue, req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const state = await job.getState();
  const progress = job.progress;

  res.json({
    id: job.id,
    state,
    progress,
    data: job.data,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  });
});
```

---

## Repeat Jobs: Cron via BullMQ

BullMQ handles scheduled/recurring jobs natively. This is the recommended
way to do cron in applications that already have BullMQ:

```typescript
import { Queue } from 'bullmq';
import { connection } from './redis';

const emailQueue = new Queue('emails', { connection });

// Schedule a weekly digest job — runs every Monday at 9am UTC
await emailQueue.add(
  'weekly-digest-scheduler',
  { type: 'weekly_digest' },
  {
    repeat: {
      pattern: '0 9 * * 1',   // Standard cron syntax
      tz: 'UTC',
    },
    // Using a stable jobId prevents duplicate schedules on restart
    jobId: 'repeat:weekly-digest',
  }
);

// You can also use a millisecond interval for high-frequency jobs
await emailQueue.add(
  'health-check',
  { type: 'health_check' },
  {
    repeat: {
      every: 30_000,   // Every 30 seconds
    },
    jobId: 'repeat:health-check',
  }
);
```

When BullMQ processes a repeat job, it automatically adds the next
occurrence to the `delayed` set before completing. The repeat schedule
persists in Redis even if your application restarts.

**Important:** Register repeat jobs carefully. Call `queue.add` with the
same `jobId` on every startup — BullMQ is smart enough not to create
a duplicate if the schedule already exists.

---

## Sandboxed Processors

For CPU-intensive work, BullMQ can run your processor in a separate
child process using the `processor` file path:

```typescript
// worker.ts (main file)
import { Worker } from 'bullmq';
import { connection } from './redis';

const worker = new Worker('pdf-generation', './processors/pdf-processor.js', {
  connection,
  concurrency: 2,  // 2 child processes
});
```

```typescript
// processors/pdf-processor.ts (separate file, loaded in child process)
import { SandboxedJob } from 'bullmq';

export default async function(job: SandboxedJob): Promise<string> {
  // This runs in a child process — CPU work won't block your main event loop
  const pdfBuffer = await generateHeavyPdf(job.data);
  return savePdf(pdfBuffer);
}
```

The child process is spawned when the worker starts and is reused for
multiple jobs. If the child process crashes, BullMQ starts a new one.
The main process is never affected.

---

## Full Working Example: Email Notification System

Let's tie everything together into a complete, runnable example:

```typescript
// src/queues/email-queue.ts
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({ maxRetriesPerRequest: null });

// ─── Types ────────────────────────────────────────────────────────────────────

type EmailJob =
  | { type: 'welcome_email'; userId: string; email: string; name: string }
  | { type: 'password_reset'; email: string; resetToken: string }
  | { type: 'weekly_digest'; email: string; weekOf: string }
  | { type: 'invoice_generated'; email: string; invoiceId: string; amount: number };

// ─── Queue ────────────────────────────────────────────────────────────────────

export const emailQueue = new Queue<EmailJob>('emails', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: false,  // Keep all failed jobs for inspection
  },
});

// ─── Producer Helpers ─────────────────────────────────────────────────────────

export async function enqueueWelcomeEmail(
  userId: string,
  email: string,
  name: string
): Promise<string> {
  const job = await emailQueue.add(
    'welcome_email',
    { type: 'welcome_email', userId, email, name },
    { jobId: `welcome:${userId}` }  // Deduplicate by user
  );
  return job.id!;
}

export async function enqueuePasswordReset(
  email: string,
  resetToken: string
): Promise<string> {
  const job = await emailQueue.add(
    'password_reset',
    { type: 'password_reset', email, resetToken },
    { priority: 10 }  // High priority — user is actively waiting
  );
  return job.id!;
}

// ─── Processor ────────────────────────────────────────────────────────────────

async function mockSendEmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  // Simulate network latency
  await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

  // Simulate occasional failures for testing retry logic
  if (Math.random() < 0.05) {
    throw new Error('Email provider temporarily unavailable (simulated)');
  }

  console.log('─'.repeat(60));
  console.log(`📧 EMAIL SENT`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Body:    ${body}`);
  console.log('─'.repeat(60));
}

async function processEmail(job: Job<EmailJob>): Promise<{ sent: boolean }> {
  const { data } = job;

  switch (data.type) {
    case 'welcome_email':
      await mockSendEmail(
        data.email,
        `Welcome, ${data.name}!`,
        `Hi ${data.name}, your account is ready. Get started at https://app.example.com`
      );
      return { sent: true };

    case 'password_reset':
      await mockSendEmail(
        data.email,
        'Reset your password',
        `Use this link (expires in 1 hour): https://app.example.com/reset/${data.resetToken}`
      );
      return { sent: true };

    case 'weekly_digest':
      await job.updateProgress(25);
      // In production: fetch user-specific content
      await job.updateProgress(75);
      await mockSendEmail(
        data.email,
        `Your weekly digest — week of ${data.weekOf}`,
        `Here's what happened this week: [digest content here]`
      );
      await job.updateProgress(100);
      return { sent: true };

    case 'invoice_generated':
      await mockSendEmail(
        data.email,
        `Invoice #${data.invoiceId} — $${(data.amount / 100).toFixed(2)}`,
        `Your invoice has been generated. Amount due: $${(data.amount / 100).toFixed(2)}`
      );
      return { sent: true };

    default:
      throw new Error(`Unknown email type: ${(data as any).type}`);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export const emailWorker = new Worker<EmailJob>('emails', processEmail, {
  connection: new IORedis({ maxRetriesPerRequest: null }),
  concurrency: 5,
  limiter: { max: 50, duration: 60_000 },
});

emailWorker.on('completed', (job, result) => {
  console.log(`✓ Job ${job.id} (${job.data.type}) completed`, result);
});

emailWorker.on('failed', (job, err) => {
  console.error(`✗ Job ${job?.id} (${job?.data.type}) failed: ${err.message}`);
});

// ─── Queue Events (Monitoring) ────────────────────────────────────────────────

const queueEvents = new QueueEvents('emails', {
  connection: new IORedis({ maxRetriesPerRequest: null }),
});

queueEvents.on('waiting', ({ jobId }) => {
  console.log(`[QUEUE] Job ${jobId} waiting`);
});

queueEvents.on('active', ({ jobId }) => {
  console.log(`[QUEUE] Job ${jobId} active`);
});

// ─── Register Repeat Jobs ─────────────────────────────────────────────────────

export async function registerScheduledJobs(): Promise<void> {
  // Weekly digest — runs every Monday at 9am UTC
  await emailQueue.add(
    'weekly-digest',
    { type: 'weekly_digest', email: '', weekOf: '' },  // Populated at runtime
    {
      repeat: { pattern: '0 9 * * 1', tz: 'UTC' },
      jobId: 'repeat:weekly-digest',
    }
  );

  console.log('Scheduled jobs registered');
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function demo(): Promise<void> {
  console.log('Starting email queue demo...\n');

  // Queue a variety of jobs
  await enqueueWelcomeEmail('user-1', 'alice@example.com', 'Alice');
  await enqueueWelcomeEmail('user-2', 'bob@example.com', 'Bob');
  await enqueuePasswordReset('charlie@example.com', 'reset-tok-abc123');

  await emailQueue.add('invoice_generated', {
    type: 'invoice_generated',
    email: 'diana@example.com',
    invoiceId: 'inv-0042',
    amount: 4999,
  });

  // Wait for all jobs to process
  await new Promise(r => setTimeout(r, 5000));

  // Show queue stats
  const counts = await emailQueue.getJobCounts(
    'waiting', 'active', 'completed', 'failed'
  );
  console.log('\nQueue stats:', counts);

  // Graceful shutdown
  await emailWorker.close();
  await emailQueue.close();
  await queueEvents.close();
  await connection.quit();
}

demo().catch(console.error);
```

---

## Exercises

### Exercise 1: Job Options Exploration

Add jobs to a queue with each of the following option combinations and
observe the behavior:

1. A job with `delay: 10000` — where does it appear in Redis? When does
   it move to `waiting`?
2. A job with `priority: 100` — add it after 5 other regular-priority jobs
   are already waiting. Which processes first?
3. A job with `jobId: 'unique-id'` — try to add the same jobId twice.
   What happens?
4. A job with `attempts: 5` and a processor that always throws. Watch
   it move through retry states. What does `job.attemptsMade` show at
   each attempt?

### Exercise 2: Progress Tracking API

Build a simple Express API that:
1. Accepts `POST /jobs/report` to enqueue a "report generation" job
2. Returns the job ID immediately with status 202
3. Exposes `GET /jobs/:id` that returns the job's current state and progress
4. The job processor simulates 5 stages of work, updating progress at each stage

The client should be able to poll `GET /jobs/:id` to watch the report
being "generated."

### Exercise 3: Worker Concurrency Experiment

Create a queue with 20 jobs, each simulating 1 second of async work
(using `setTimeout`). Run a worker with `concurrency: 1` and measure
total processing time. Then run the same 20 jobs with `concurrency: 5`
and `concurrency: 20`. Record the wall-clock times and explain the
relationship between concurrency and throughput for I/O-bound work.

### Exercise 4: Rate Limited Worker

You're sending emails through a provider that allows a maximum of 10
emails per second. Set up a worker with a rate limiter that enforces
this limit. Then enqueue 50 jobs and verify (by measuring timestamps
on completion events) that no more than 10 jobs complete per second.

### Exercise 5: Scheduled Repeat Job

Create a repeat job that fires every 30 seconds (for demo purposes).
The processor should:
1. Log the current time and which occurrence it is (1st, 2nd, 3rd, etc.)
2. Store state in Redis (using `ioredis` directly) to track how many
   times it has run
3. Cancel itself after 5 runs

Write the complete code and explain how BullMQ's repeat job mechanism
differs from running a `setInterval` in the same process.
