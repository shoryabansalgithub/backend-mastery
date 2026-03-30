# CronForge — Exhaustive Implementation Plan

## 1. Project Structure

```
cronforge/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                    # Express app + worker startup
│   ├── queues/
│   │   ├── index.ts                # Queue definitions (4 named queues + DLQ)
│   │   └── scheduler.ts            # QueueScheduler for delayed/repeatable jobs
│   ├── workers/
│   │   ├── index.ts                # Worker startup + SIGTERM handler
│   │   └── processor.ts            # Job execution logic (webhook call)
│   ├── routes/
│   │   ├── jobs.ts                 # /jobs CRUD
│   │   ├── dlq.ts                  # /dlq management
│   │   ├── queues.ts               # /queues/stats
│   │   └── metrics.ts              # /metrics (Prometheus text)
│   ├── services/
│   │   ├── scheduler.ts            # Business logic for job scheduling
│   │   ├── idempotency.ts          # Redis SET NX EX idempotency
│   │   └── dag.ts                  # Dependency validation + BullMQ Flows
│   ├── middleware/
│   │   └── errorHandler.ts
│   └── types.ts
```

---

## 2. Queue Setup (`src/queues/index.ts`)

```typescript
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

export const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,  // required by BullMQ
});

// Priority-based named queues
// BullMQ doesn't have global cross-queue priority, so we use separate queues
// and workers that poll high-priority queues first
export const queues = {
  critical: new Queue('jobs:critical', { connection }),
  high:     new Queue('jobs:high',     { connection }),
  normal:   new Queue('jobs:normal',   { connection }),
  low:      new Queue('jobs:low',      { connection }),
  dlq:      new Queue('jobs:dlq',      { connection }),  // dead letter
} as const;

export type Priority = keyof typeof queues;

// QueueEvents lets us listen for job completion/failure from outside the worker
export const queueEvents: Record<string, QueueEvents> = {};
for (const [name, queue] of Object.entries(queues)) {
  queueEvents[name] = new QueueEvents(queue.name, { connection });
}
```

---

## 3. Job Types (`src/types.ts`)

```typescript
export type Priority = 'critical' | 'high' | 'normal' | 'low';
export type JobType  = 'immediate' | 'delayed' | 'recurring' | 'dependent';
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'dlq' | 'cancelled';

export interface CreateJobDto {
  type:            JobType;
  name:            string;
  priority:        Priority;
  payload:         Record<string, unknown>;
  webhookUrl:      string;
  idempotencyKey?: string;
  delayMs?:        number;          // for 'delayed'
  cron?:           string;          // for 'recurring'
  dependsOnJobId?: string;          // for 'dependent'
  maxRetries?:     number;
  backoffType?:    'exponential' | 'fixed';
}

export interface JobDetails {
  id:           string;
  name:         string;
  type:         JobType;
  priority:     Priority;
  status:       JobStatus;
  payload:      Record<string, unknown>;
  webhookUrl:   string;
  progress:     number;
  attempts:     number;
  maxAttempts:  number;
  result?:      unknown;
  failReason?:  string;
  logs:         Array<{ at: string; message: string }>;
  createdAt:    string;
  startedAt?:   string;
  completedAt?: string;
}
```

---

## 4. Idempotency Service (`src/services/idempotency.ts`)

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);
const TTL_SECONDS = 60 * 60 * 24;  // 24 hours

// Returns false if key already exists (duplicate), true if successfully set
export async function claimIdempotencyKey(key: string, jobId: string): Promise<boolean> {
  // SET NX EX is atomic: only sets if key doesn't exist
  // Returns 'OK' on success, null if key already exists
  const result = await redis.set(
    `idempotency:${key}`,
    jobId,
    'EX', TTL_SECONDS,
    'NX'
  );
  return result === 'OK';
}

export async function getIdempotencyJobId(key: string): Promise<string | null> {
  return redis.get(`idempotency:${key}`);
}
```

### Race condition analysis
The `SET NX EX` operation is **atomic at the Redis level**. Even if two requests arrive simultaneously with the same key, only one will receive `'OK'`. The other receives `null` and can return the existing job ID.

Note: there's still a tiny window between the idempotency check and the BullMQ enqueue. To handle this:
1. Claim the idempotency key first
2. Enqueue the job
3. If BullMQ enqueue fails, release the key (DELETE it)
This way, the failure path cleans up correctly.

---

## 5. Job Scheduler Service (`src/services/scheduler.ts`)

```typescript
import { JobsOptions } from 'bullmq';
import { queues } from '../queues';
import * as idempotency from './idempotency';
import * as dag from './dag';
import { CreateJobDto, Priority } from '../types';
import { v4 as uuidv4 } from 'uuid';

// Default retry config per priority
const DEFAULT_RETRIES: Record<Priority, number> = {
  critical: 5,
  high:     3,
  normal:   2,
  low:      1,
};

export async function scheduleJob(dto: CreateJobDto): Promise<{ jobId: string; duplicate: boolean }> {
  // 1. Idempotency check
  if (dto.idempotencyKey) {
    const existing = await idempotency.getIdempotencyJobId(dto.idempotencyKey);
    if (existing) return { jobId: existing, duplicate: true };
  }

  const jobId = uuidv4();

  // 2. Claim idempotency key before enqueue
  if (dto.idempotencyKey) {
    const claimed = await idempotency.claimIdempotencyKey(dto.idempotencyKey, jobId);
    if (!claimed) {
      // Race: another request claimed it between our check and claim
      const existing = await idempotency.getIdempotencyJobId(dto.idempotencyKey)!;
      return { jobId: existing!, duplicate: true };
    }
  }

  // 3. Validate dependencies for dependent jobs
  if (dto.type === 'dependent' && dto.dependsOnJobId) {
    await dag.validateDependency(dto.dependsOnJobId);  // throws 400 if invalid
  }

  // 4. Build BullMQ options
  const maxAttempts = (dto.maxRetries ?? DEFAULT_RETRIES[dto.priority]) + 1;
  const opts: JobsOptions = {
    jobId,
    attempts: maxAttempts,
    backoff: dto.backoffType === 'fixed'
      ? { type: 'fixed', delay: 5000 }
      : { type: 'exponential', delay: 1000 },  // 1s, 2s, 4s, 8s...
    removeOnComplete: { age: 24 * 3600 },  // keep for 24h
    removeOnFail:     false,               // we move to DLQ manually
  };

  if (dto.type === 'delayed' && dto.delayMs) {
    opts.delay = dto.delayMs;
  }

  if (dto.type === 'recurring' && dto.cron) {
    opts.repeat = { pattern: dto.cron };
  }

  const queue = queues[dto.priority];

  try {
    if (dto.type === 'dependent' && dto.dependsOnJobId) {
      await dag.enqueueDependent(jobId, dto, opts);
    } else {
      await queue.add(dto.name, {
        webhookUrl: dto.webhookUrl,
        payload:    dto.payload,
        jobType:    dto.type,
      }, opts);
    }
  } catch (err) {
    // Rollback idempotency key on failure
    if (dto.idempotencyKey) {
      await idempotency.releaseKey(dto.idempotencyKey);
    }
    throw err;
  }

  return { jobId, duplicate: false };
}
```

---

## 6. DAG Service (`src/services/dag.ts`)

```typescript
import { FlowProducer } from 'bullmq';
import { queues, connection } from '../queues';
import { CreateJobDto } from '../types';
import { JobsOptions } from 'bullmq';

const flowProducer = new FlowProducer({ connection });

export async function validateDependency(parentJobId: string): Promise<void> {
  // Search all queues for the parent job
  for (const queue of Object.values(queues)) {
    const job = await queue.getJob(parentJobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        throw Object.assign(new Error(`Parent job is in terminal state: ${state}`), { statusCode: 400 });
      }
      return;  // found and valid
    }
  }
  throw Object.assign(new Error(`Parent job not found: ${parentJobId}`), { statusCode: 400 });
}

// BullMQ Flows: child jobs wait for parent to complete before being processed
export async function enqueueDependent(
  jobId:    string,
  dto:      CreateJobDto,
  opts:     JobsOptions
): Promise<void> {
  await flowProducer.add({
    name:  dto.name,
    queueName: `jobs:${dto.priority}`,
    data: { webhookUrl: dto.webhookUrl, payload: dto.payload },
    opts: { ...opts, parent: { id: dto.dependsOnJobId!, queue: `bull:jobs:${dto.priority}` } },
  });
}
```

---

## 7. Worker & Processor (`src/workers/processor.ts`)

```typescript
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { connection, queues } from '../queues';
import got from 'got';  // or node-fetch

interface JobData {
  webhookUrl: string;
  payload:    Record<string, unknown>;
  jobType:    string;
}

async function processJob(job: Job<JobData>): Promise<unknown> {
  await job.updateProgress(10);

  // Call the webhook URL with the payload
  let response: unknown;
  try {
    const { body } = await got.post(job.data.webhookUrl, {
      json: { jobId: job.id, name: job.name, payload: job.data.payload },
      timeout: { request: 30_000 },  // 30s timeout
      retry: { limit: 0 },           // BullMQ handles retries, not got
    });
    response = body;
  } catch (err: any) {
    if (err.response?.statusCode === 422) {
      // 422 Unprocessable Entity = permanent failure, don't retry
      throw new UnrecoverableError(`Webhook rejected: ${err.response.statusCode}`);
    }
    throw err;  // rethrow → BullMQ will retry per backoff config
  }

  await job.updateProgress(100);
  return response;
}

// Workers pull from all queues; process() is called for each
export function startWorkers(): Worker[] {
  return Object.entries(queues)
    .filter(([name]) => name !== 'dlq')  // don't process DLQ automatically
    .map(([name, queue]) =>
      new Worker(queue.name, processJob, {
        connection,
        concurrency: name === 'critical' ? 10 : name === 'high' ? 5 : 3,
      })
    );
}
```

---

## 8. DLQ Handling

```typescript
// In worker event handler — move failed jobs to DLQ after exhausting retries
worker.on('failed', async (job, err) => {
  if (!job) return;
  const isExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isExhausted) {
    // Move to DLQ
    await queues.dlq.add(job.name, {
      ...job.data,
      _dlqMeta: {
        originalQueue:  job.queueName,
        originalJobId:  job.id,
        failedAt:       new Date().toISOString(),
        failReason:     err.message,
        attemptsMade:   job.attemptsMade,
      },
    });
  }
});
```

### Retry from DLQ
```typescript
// POST /dlq/:id/retry
const dlqJob = await queues.dlq.getJob(jobId);
const { _dlqMeta, ...originalData } = dlqJob.data;

const originalQueue = queues[_dlqMeta.originalQueue.replace('jobs:', '') as Priority];
await originalQueue.add(dlqJob.name, originalData, { attempts: 3 });
await dlqJob.remove();
```

---

## 9. Graceful Shutdown (`src/workers/index.ts`)

```typescript
let activeWorkers: Worker[] = [];

export async function gracefulShutdown(): Promise<void> {
  console.log('Shutting down workers...');

  // Worker.close() waits for the current job to finish before closing
  // Default timeout: 5000ms. Use a longer timeout for slow jobs.
  await Promise.all(activeWorkers.map(w => w.close()));

  console.log('All workers closed cleanly.');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT',  gracefulShutdown);

activeWorkers = startWorkers();
```

---

## 10. Queue Stats Endpoint

```typescript
// GET /queues/stats
async function getQueueStats() {
  const stats: Record<string, object> = {};
  for (const [name, queue] of Object.entries(queues)) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    stats[name] = { waiting, active, completed, failed, delayed };
  }
  return stats;
}
```

---

## 11. Metrics (Prometheus text format)

```
# HELP cronforge_jobs_waiting Jobs currently waiting in queue
# TYPE cronforge_jobs_waiting gauge
cronforge_jobs_waiting{queue="jobs:critical"} 0
cronforge_jobs_waiting{queue="jobs:high"} 3
cronforge_jobs_waiting{queue="jobs:normal"} 17
cronforge_jobs_waiting{queue="jobs:low"} 42

# HELP cronforge_jobs_active Jobs currently being processed
# TYPE cronforge_jobs_active gauge
cronforge_jobs_active{queue="jobs:critical"} 2

# HELP cronforge_jobs_failed_total Total jobs that exhausted retries
# TYPE cronforge_jobs_failed_total counter
cronforge_jobs_failed_total{queue="jobs:normal"} 14
```

---

## 12. Default Retry Config

| Priority | Max Retries | Backoff Pattern |
|----------|-------------|-----------------|
| critical | 5 | exponential: 1s, 2s, 4s, 8s, 16s |
| high     | 3 | exponential: 1s, 2s, 4s |
| normal   | 2 | exponential: 1s, 2s |
| low      | 1 | fixed: 5s |

---

## 13. Environment Variables

```env
REDIS_URL=redis://localhost:6379
PORT=3000
WORKER_CONCURRENCY_CRITICAL=10
WORKER_CONCURRENCY_HIGH=5
WORKER_CONCURRENCY_NORMAL=3
WORKER_CONCURRENCY_LOW=3
WEBHOOK_TIMEOUT_MS=30000
NODE_ENV=development
```
