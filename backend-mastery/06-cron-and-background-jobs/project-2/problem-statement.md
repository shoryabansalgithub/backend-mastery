# Project: CronForge — Distributed Task Scheduler API

## Context

You're building a general-purpose job scheduling service. Think of it as the infrastructure layer that other services use to schedule work: "send this email in 5 minutes", "run this report every Monday at 9am", "process this payment, and if it fails, retry 3 times with exponential backoff."

This is what BullMQ powers under the hood — but you're building the HTTP API and management layer on top of it. Companies like Vercel, Render, and Railway all have a version of this service internally.

---

## What You're Building

**CronForge** is a job scheduling API with:

### Job Types
1. **Immediate** — Run as soon as a worker is available
2. **Delayed** — Run after a specified delay (e.g., `delayMs: 300000` = 5 minutes from now)
3. **Recurring** — Run on a cron schedule (e.g., `cron: "0 9 * * MON"`)
4. **Dependent** — Run only after a specified parent job completes successfully (DAG execution)

### Core Features
- **Priority queues** — Jobs are assigned a priority level: `critical`, `high`, `normal`, `low`. Critical jobs preempt others.
- **Retry with exponential backoff** — Each priority level has a different max retry count. Failed jobs wait 2^attempt seconds before retry.
- **Idempotency keys** — A job submitted with a previously-used idempotency key is silently ignored (not re-queued). Prevents duplicate work when callers retry HTTP requests.
- **Dead letter queue** — Jobs that exhaust all retries move to a DLQ. They stay there until manually retried or deleted.
- **Job result storage** — Completed jobs store their result payload for 24 hours. Callers can poll for completion.

### Admin API
- List all jobs (by status, priority, type)
- Get a specific job's details, status, progress, result, and retry history
- Cancel a pending/waiting job
- Retry a job from the DLQ
- Delete a job from the DLQ
- Queue stats: depth per priority, active worker count, failure rate
- Metrics endpoint for monitoring

---

## The Worker Architecture

```
HTTP API → BullMQ Queue → Workers → Job Processor
                     ↓
               Dead Letter Queue ← exhausted retries
```

Workers are separate processes (or the same process for simplicity). They pull jobs from BullMQ queues and execute them. For this project, the "job work" is a configurable HTTP webhook call — the CronForge service calls a URL you specify with the job payload. This is the exact pattern that Zapier, n8n, and GitHub Actions webhooks use.

---

## Constraints

1. **BullMQ + ioredis** — Use BullMQ for all queue operations. No in-memory simulation.
2. **Four named queues** — One per priority level: `jobs:critical`, `jobs:high`, `jobs:normal`, `jobs:low`. Workers pull from all four, but critical takes precedence.
3. **Idempotency via Redis** — Use `SET NX EX` (atomic set-if-not-exists with TTL). The check-and-enqueue must be atomic enough to prevent races.
4. **Graceful shutdown** — Workers must catch `SIGTERM`, finish the current job (if one is in progress), then exit. Must not kill in-flight jobs.
5. **DAG validation** — When creating a dependent job, validate that the parent job exists and is not already in a terminal state (completed, failed, dlq). Return `400` if the dependency doesn't exist.

---

## Deliverables

### REST Endpoints

```
POST   /jobs                 → Schedule a job
GET    /jobs                 → List jobs (filter by status, priority, type)
GET    /jobs/:id             → Get job details + history
DELETE /jobs/:id             → Cancel a job (only if not yet started)

GET    /dlq                  → List dead-letter jobs
POST   /dlq/:id/retry        → Move DLQ job back to its original queue
DELETE /dlq/:id              → Delete a DLQ job permanently

GET    /queues/stats         → Per-queue depths: waiting, active, completed, failed
GET    /metrics              → Prometheus-style text metrics
GET    /health               → Service health + Redis connectivity
```

### Job Schema (POST /jobs body)
```typescript
{
  type:           'immediate' | 'delayed' | 'recurring' | 'dependent',
  name:           string,           // human-readable name
  priority:       'critical' | 'high' | 'normal' | 'low',
  payload:        object,           // arbitrary data passed to the processor
  webhookUrl:     string,           // the URL the worker calls with the payload
  idempotencyKey: string | null,    // optional; prevents duplicates
  // For delayed:
  delayMs?:       number,
  // For recurring:
  cron?:          string,           // valid cron expression
  // For dependent:
  dependsOnJobId?: string,          // run after this job completes
  // Retry config (optional, defaults applied per priority):
  maxRetries?:    number,
  backoffType?:   'exponential' | 'fixed',
}
```

---

## Acceptance Criteria

- [ ] Submitting two jobs with the same `idempotencyKey` only enqueues one job
- [ ] A job with `maxRetries: 3` that always fails ends up in the DLQ after 3 attempts
- [ ] `POST /dlq/:id/retry` re-enqueues the job and removes it from the DLQ
- [ ] A `recurring` job with `cron: "* * * * *"` fires every minute (verify via `GET /jobs/:id` progress log)
- [ ] A `dependent` job does NOT run while its parent is still pending
- [ ] `DELETE /jobs/:id` returns `409` if the job is already running
- [ ] On SIGTERM, the worker completes the current job before shutting down (verify by sending SIGTERM mid-job)
- [ ] `GET /queues/stats` shows accurate job counts that match BullMQ queue state

---

## Concepts Exercised

| Concept | Where |
|---------|-------|
| BullMQ Queue + Worker setup | Core infrastructure |
| Multiple named queues | Four priority queues |
| Repeatable jobs (cron) | `recurring` job type |
| Delayed jobs | `delayed` job type |
| BullMQ Flows (parent/child) | `dependent` job type |
| Retry + exponential backoff | Retry configuration |
| Dead letter queue | Failed job handling |
| Idempotency (Redis SET NX EX) | Duplicate prevention |
| Job progress reporting | Worker progress updates |
| Graceful shutdown (SIGTERM) | Worker shutdown handler |
| Queue metrics | `/queues/stats` + `/metrics` |

---

## Difficulty

**Advanced.** The DAG dependency tracking via BullMQ Flows, and the idempotency race condition handling, are the hardest parts. The graceful shutdown pattern under real load is also tricky to get right.

## Estimated Time

12–18 hours.
