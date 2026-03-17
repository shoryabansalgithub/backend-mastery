# Lesson 2: Cron Scheduling

## What Cron Actually Is

Cron is a Unix job scheduler that has been around since 1975. The name
comes from the Greek word "chronos" (time). The idea is simple: express
when you want a command to run using a compact syntax, and the scheduler
fires it at the right moments.

The cron syntax was designed for a world where you edited a text file
(`crontab`) and the system daemon read it. In modern Node applications,
libraries like `node-cron` bring the same scheduler logic into your
process. But before we touch any library, you need to understand the
syntax cold — it's one of those things where a single character can mean
the difference between "every minute" and "once a year."

---

## Cron Syntax from First Principles

A cron expression has five fields, separated by spaces:

```
┌───────────── minute        (0–59)
│ ┌─────────── hour          (0–23)
│ │ ┌───────── day of month  (1–31)
│ │ │ ┌─────── month         (1–12)
│ │ │ │ ┌───── day of week   (0–7, both 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Read it as: "At [minute] past [hour], on day [dom] of [month], if it is
[dow]." Each field has specific allowed values and a set of special
characters that modify their meaning.

### The Special Characters

**`*` (asterisk) — "every"**

The asterisk means "match every value in this field." `* * * * *` means
"every minute of every hour of every day." Think of it as the wildcard
that says "I don't care about this dimension."

**`/` (slash) — "every N"**

The slash is a step value. `*/15` in the minute field means "every 15
minutes." `*/2` in the hour field means "every 2 hours." More precisely,
it means "starting from the lowest value, step by N."

`*/15` in minutes → 0, 15, 30, 45
`2/15` in minutes → 2, 17, 32, 47 (start at 2, step by 15)

**`-` (hyphen) — "range"**

The hyphen defines a range. `9-17` in the hour field means "every hour
from 9am to 5pm, inclusive." `1-5` in day-of-week means Monday through
Friday.

**`,` (comma) — "list"**

The comma separates a list of discrete values. `0,15,30,45` in the minute
field means "at minute 0, 15, 30, and 45." `1,3,5` in day-of-week means
Monday, Wednesday, Friday.

### Named Values

For months and days of week, you can use names instead of numbers:

- Months: JAN, FEB, MAR, APR, MAY, JUN, JUL, AUG, SEP, OCT, NOV, DEC
- Days: SUN, MON, TUE, WED, THU, FRI, SAT

`0 9 * * MON` is equivalent to `0 9 * * 1`.

### Reading Cron Expressions

The most reliable way to read a cron expression is to say aloud:
"At [minute field] past [hour field], on [dom field] of [month field],
when it is [dow field]."

Let's work through examples:

```
# At minute 0 past every hour — "run hourly at the top of the hour"
0 * * * *

# At minute 0 past hour 9, every day — "run daily at 9:00am"
0 9 * * *

# At minute 0 past hour 9, every Monday — "run weekly on Monday at 9am"
0 9 * * 1

# At minute 0 past hour 9, on the 1st of every month — "run monthly"
0 9 1 * *

# At minute 0 past hours 9 and 17, every weekday — "9am and 5pm Mon-Fri"
0 9,17 * * 1-5

# Every 15 minutes — "run every quarter hour"
*/15 * * * *

# Every 15 minutes during business hours on weekdays
*/15 9-17 * * 1-5

# At midnight every Sunday — "weekly maintenance window"
0 0 * * 0

# At 2:30am on the 1st and 15th of every month
30 2 1,15 * *

# Every minute (for development/testing)
* * * * *
```

### Common Patterns Table

| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 0 * * *` | Daily at midnight |
| `0 9 * * *` | Daily at 9am |
| `0 9 * * 1` | Weekly, Monday 9am |
| `0 9 1 * *` | Monthly, 1st at 9am |
| `*/5 * * * *` | Every 5 minutes |
| `*/15 9-17 * * 1-5` | Every 15 min, business hours |
| `0 2 * * 0` | Weekly cleanup, Sunday 2am |
| `0 0 1 1 *` | Yearly, Jan 1st midnight |

---

## Crontab Pitfalls You Will Hit in Production

### Pitfall 1: Timezone Confusion

Cron expressions run in the timezone of the machine running them. If your
server is in UTC and your users are in New York (UTC-5), a job scheduled
for `0 9 * * 1` runs at 9am UTC, which is 4am in New York. Your "morning
digest" arrives at 4am.

This is one of the most common production bugs with cron. The fix:

1. Decide your canonical timezone for cron expressions and document it
2. Use a library that supports explicit timezone configuration
3. Keep your servers in UTC and offset your cron expressions:
   `0 14 * * 1` = 2pm UTC = 9am EST = 10am EDT (with the DST caveat below)

**The DST trap:** If your target timezone observes daylight saving time,
your job will shift by an hour twice a year. A job at "9am Eastern" will
fire at 8am or 10am UTC depending on the season. The safest solution is
to run all cron times in UTC internally and do any user-facing
time-of-day reasoning in your job logic.

### Pitfall 2: Overlapping Runs

If a cron job fires every 5 minutes and occasionally takes 6 minutes to
complete, two instances will run simultaneously. Depending on what the
job does, this can be:
- Harmless (read-only report generation)
- Problematic (two workers updating the same records)
- Catastrophic (double-charging, double-sending)

This is why every scheduled job needs a lock. The pattern is: before
doing any work, acquire a lock. If the lock is already held, exit
immediately. After completing, release the lock.

### Pitfall 3: The Missed Midnight Job

A job scheduled for `0 0 * * *` (midnight) will not run if your server
is down at midnight. Unlike message queues, cron has no built-in
persistence or replay. If the trigger fires and nobody is home, the
job simply doesn't run.

For critical nightly jobs, you need to either:
- Ensure high availability so the server is never down at midnight
- Add a startup check: "did yesterday's job run? If not, run it now."
- Use a queue-based approach for scheduled jobs (we'll cover this with
  BullMQ's repeat jobs in Lesson 3)

### Pitfall 4: Silent Failures

Traditional cron emails output to the system's local mail. In a Docker
container or cloud VM, that mail goes nowhere. Your job can fail completely
and you'll never know.

Always wrap cron jobs in error handling that logs to your observability
stack and alerts on repeated failures.

---

## node-cron: Cron Scheduling in Node.js

`node-cron` is the most straightforward library for adding cron scheduling
to a Node application. It runs cron schedules in-process.

```
npm install node-cron
npm install -D @types/node-cron
```

Basic usage:

```typescript
import cron from 'node-cron';

// Schedule a task
const task = cron.schedule('0 9 * * 1', async () => {
  console.log('Running Monday 9am job:', new Date().toISOString());
  await sendWeeklyDigest();
}, {
  timezone: 'America/New_York',
});

// The task starts automatically. You can also control it manually:
task.stop();   // Pause scheduling
task.start();  // Resume scheduling
```

`node-cron` supports a 6-field syntax with an optional seconds field
prepended:

```
┌──────────── second (optional, 0–59)
│ ┌────────── minute (0–59)
│ │ ┌──────── hour (0–23)
│ │ │ ┌────── day of month (1–31)
│ │ │ │ ┌──── month (1–12)
│ │ │ │ │ ┌── day of week (0–7)
│ │ │ │ │ │
* * * * * *
```

With seconds: `*/30 * * * * *` fires every 30 seconds.

---

## The Distributed Cron Problem

Here is the situation in every production deployment of any meaningful
scale: you run more than one instance of your application. Maybe you have
3 pods in Kubernetes, or 2 EC2 instances behind a load balancer.

If you've added cron jobs to your application process using `node-cron`,
every instance has the scheduler. At 9am Monday, all three instances fire
the `sendWeeklyDigest` job simultaneously. Your users get three copies
of the weekly digest email.

This is not a hypothetical. It is an extremely common production bug.

### Solution 1: Separate Scheduler Process

Run the scheduler as a separate, single-instance service. Only one pod
runs the scheduler container; the others are pure API servers. The scheduler
enqueues jobs into a queue; workers process them.

This works well but creates operational complexity: now you must ensure
the scheduler process is always running, and you have a new single point
of failure.

### Solution 2: Database-Based Distributed Locking

Each instance tries to acquire a lock in a shared database before running
the job. The first one to acquire the lock wins and does the work. The
others see the lock is held and skip.

This is elegant because you already have a database. No new infrastructure.

### Solution 3: Dedicated Job Scheduler

BullMQ's repeat jobs (covered in Lesson 3) let you define scheduled jobs
in the queue itself. Only one instance needs to register the schedule.
The job is created by the queue system and processed by a single worker.

For production applications, Solution 3 is the right answer. But
understanding Solution 2 is important because you'll need it for
database-backed applications and for cases where a full queue system
is unavailable.

---

## Database-Based Locking: The Claim-Before-Run Pattern

The pattern is straightforward: before doing any job work, write a lock
record to the database. If the write succeeds (because the lock didn't
exist), you own the job. If it fails (the lock already exists), another
instance is running it — bail out.

```typescript
import cron from 'node-cron';
import { db } from './database';

interface CronLock {
  jobName: string;
  lockedAt: Date;
  lockedBy: string;
  expiresAt: Date;
}

const INSTANCE_ID = `${process.env.HOSTNAME ?? 'local'}-${process.pid}`;

async function acquireLock(
  jobName: string,
  ttlMs: number
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    // Try to insert a lock record
    // If one already exists and hasn't expired, this will fail
    // due to the unique constraint on jobName
    await db.query(
      `INSERT INTO cron_locks (job_name, locked_at, locked_by, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_name) DO UPDATE
         SET locked_at = $2, locked_by = $3, expires_at = $4
         WHERE cron_locks.expires_at < NOW()`,
      [jobName, now, INSTANCE_ID, expiresAt]
    );
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(jobName: string): Promise<void> {
  await db.query(
    `DELETE FROM cron_locks WHERE job_name = $1 AND locked_by = $2`,
    [jobName, INSTANCE_ID]
  );
}

async function withDistributedLock<T>(
  jobName: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T | null> {
  const acquired = await acquireLock(jobName, ttlMs);

  if (!acquired) {
    console.log(`[${jobName}] Lock held by another instance, skipping`);
    return null;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(jobName);
  }
}
```

The key detail in the lock query: the `ON CONFLICT DO UPDATE ... WHERE
cron_locks.expires_at < NOW()` clause means "update (and thus re-acquire)
the lock only if the existing lock has expired." This handles the case
where a previous instance crashed without releasing its lock — after the
TTL passes, the lock is stealable.

The migration to create the lock table:

```sql
CREATE TABLE cron_locks (
  job_name   TEXT PRIMARY KEY,
  locked_at  TIMESTAMPTZ NOT NULL,
  locked_by  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_cron_locks_expires_at ON cron_locks(expires_at);
```

### Putting It All Together

Here is a complete, production-grade cron setup using `node-cron` with
distributed locking, error handling, and proper lifecycle management:

```typescript
import cron from 'node-cron';
import { db } from './database';
import { sendWeeklyDigest } from './jobs/weekly-digest';
import { cleanupExpiredSessions } from './jobs/cleanup';
import { logger } from './logger';

const INSTANCE_ID = `${process.env.HOSTNAME ?? 'unknown'}-${process.pid}`;

// ─── Lock Utilities ──────────────────────────────────────────────────────────

async function acquireLock(jobName: string, ttlMs: number): Promise<boolean> {
  try {
    const result = await db.query(
      `INSERT INTO cron_locks (job_name, locked_at, locked_by, expires_at)
       VALUES ($1, NOW(), $2, NOW() + $3 * INTERVAL '1 millisecond'
       ON CONFLICT (job_name) DO UPDATE
         SET locked_at = NOW(), locked_by = $2,
             expires_at = NOW() + $3 * INTERVAL '1 millisecond'
         WHERE cron_locks.expires_at < NOW()
       RETURNING job_name`,
      [jobName, INSTANCE_ID, ttlMs]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.error({ err, jobName }, 'Failed to acquire cron lock');
    return false;
  }
}

async function releaseLock(jobName: string): Promise<void> {
  await db.query(
    `DELETE FROM cron_locks WHERE job_name = $1 AND locked_by = $2`,
    [jobName, INSTANCE_ID]
  );
}

// ─── Job Runner ───────────────────────────────────────────────────────────────

async function runWithLock(
  jobName: string,
  ttlMs: number,
  fn: () => Promise<void>
): Promise<void> {
  const acquired = await acquireLock(jobName, ttlMs);
  if (!acquired) {
    logger.debug({ jobName }, 'Skipping — lock held by another instance');
    return;
  }

  const startTime = Date.now();
  logger.info({ jobName, instanceId: INSTANCE_ID }, 'Cron job started');

  try {
    await fn();
    const duration = Date.now() - startTime;
    logger.info({ jobName, duration }, 'Cron job completed');
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error({ err, jobName, duration }, 'Cron job failed');
    // In production: alert via PagerDuty/OpsGenie here
  } finally {
    await releaseLock(jobName);
  }
}

// ─── Job Definitions ─────────────────────────────────────────────────────────

const tasks: cron.ScheduledTask[] = [];

function scheduleCron(
  expression: string,
  jobName: string,
  ttlMs: number,
  fn: () => Promise<void>,
  timezone = 'UTC'
): void {
  if (!cron.validate(expression)) {
    throw new Error(`Invalid cron expression for job "${jobName}": ${expression}`);
  }

  const task = cron.schedule(expression, () => {
    // Note: we don't await here because node-cron's callback isn't async-aware.
    // The lock and error handling are inside runWithLock.
    runWithLock(jobName, ttlMs, fn).catch((err) => {
      logger.error({ err, jobName }, 'Unexpected error in cron runner');
    });
  }, { timezone });

  tasks.push(task);
  logger.info({ jobName, expression, timezone }, 'Cron job registered');
}

// ─── Register Jobs ────────────────────────────────────────────────────────────

export function startCronJobs(): void {
  // Weekly digest: every Monday at 9am UTC
  // TTL of 30 minutes — if it takes longer than that, something is wrong
  scheduleCron(
    '0 9 * * 1',
    'weekly-digest',
    30 * 60 * 1000,
    sendWeeklyDigest,
    'UTC'
  );

  // Session cleanup: every night at 3am UTC
  // TTL of 10 minutes
  scheduleCron(
    '0 3 * * *',
    'session-cleanup',
    10 * 60 * 1000,
    cleanupExpiredSessions,
    'UTC'
  );

  logger.info(`Cron scheduler started on instance ${INSTANCE_ID}`);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

export function stopCronJobs(): void {
  tasks.forEach(task => task.stop());
  logger.info('Cron jobs stopped');
}
```

In your main application entry point:

```typescript
import { startCronJobs, stopCronJobs } from './cron';

startCronJobs();

process.on('SIGTERM', async () => {
  stopCronJobs();
  // Allow any in-flight jobs to finish before exiting
  await new Promise(resolve => setTimeout(resolve, 5000));
  process.exit(0);
});
```

---

## The Alternative: Use a Proper Job Scheduler

The locking approach above works but has a fundamental limitation: it
requires every instance of your application to know about every cron job,
and to participate in the lock race on every tick. It's poll-based — every
instance wakes up at the scheduled time and fights over a lock.

A better architecture for applications that are already using a job queue:

1. Register scheduled jobs in the queue (BullMQ's `repeat` option)
2. The queue manages scheduling, not your application code
3. Workers process scheduled jobs exactly like triggered jobs
4. No distributed locking needed — the queue ensures one job is created

```typescript
// With BullMQ — no locking needed
const emailQueue = new Queue('emails', { connection: redis });

// Register the repeat job once, on startup
await emailQueue.add(
  'weekly-digest',
  { type: 'weekly_digest' },
  {
    repeat: { pattern: '0 9 * * 1', tz: 'UTC' },
    jobId: 'weekly-digest-repeat',  // Stable ID prevents duplicates
  }
);
```

BullMQ uses Redis sorted sets to track upcoming repeat jobs. One instance
creates the schedule; the queue system ensures the job fires once and is
processed by exactly one worker. This is covered in depth in Lesson 3.

The rule: if you have a job queue (you should), use it for scheduling too.
Reserve direct cron usage for lightweight scripts and situations where
adding a full queue system is not justified.

---

## When Cron Isn't Enough

Cron is a trigger mechanism. It says "run this at this time." It does
not handle:

- **Retries.** If the job fails, cron fires again at the next scheduled
  time. It will not retry in 30 seconds, or 5 minutes, or with exponential
  backoff. You get one shot per schedule tick.

- **Concurrency control.** Unless you implement it yourself (like above),
  multiple instances fire simultaneously.

- **Job history.** Cron has no built-in way to see "which jobs ran, which
  failed, and what was the error."

- **Dynamic scheduling.** If you want to schedule a one-off job to run
  in 47 minutes, cron can't express that. You'd need a `* * * * *` job
  that checks a database table for pending one-off jobs — which is
  basically reinventing a queue.

- **Long-running jobs.** If a nightly job takes 2 hours and you've scheduled
  it for midnight, you'd better not have another instance try to fire at
  1am. Without locking, you will.

These limitations are features, not bugs, of cron. Cron is a simple,
time-based scheduler. For anything more complex, use a job queue with
scheduling capabilities.

---

## Exercises

### Exercise 1: Cron Expression Translation

Translate each of these requirements into a valid cron expression. Verify
your answer using a cron expression visualizer (crontab.guru is excellent).

1. Every day at 6:30am
2. Every weekday (Mon-Fri) at noon
3. Every 10 minutes between 8am and 6pm, on weekdays only
4. The first Monday of every month at 8am (Hint: this is a known cron
   limitation — think about what approximation is possible)
5. Midnight on December 31st (New Year's Eve)
6. Every 5 minutes, but only on odd hours (1am, 3am, 5am, etc.)
7. 15 minutes past midnight, every Sunday
8. Twice a day, at 9am and 6pm, on the 1st and 15th of each month

### Exercise 2: Implement the Lock Table

Write the SQL migration to create the `cron_locks` table. Then write
a test (using a test database or in-memory SQLite) that:

1. Confirms that two concurrent calls to `acquireLock` with the same
   job name result in only one returning `true`
2. Confirms that after the lock expires, a new call to `acquireLock`
   returns `true`
3. Confirms that `releaseLock` with the wrong `locked_by` value does
   not release the lock

### Exercise 3: Timezone Bug Hunt

You have this cron job deployed on a server running UTC:

```typescript
cron.schedule('0 9 * * 1', sendWeeklyDigest);
```

Your users are in New York (EST, UTC-5 in winter / EDT, UTC-4 in summer).
You want the digest to arrive at 9am New York time.

1. What time does the job currently fire in New York during winter?
2. What time does it fire during summer?
3. Fix the cron expression to always fire at 9am New York time
   (acknowledging the DST limitation)
4. What is the "correct" long-term solution?

### Exercise 4: Missed Job Detection

Implement a startup check that detects whether a daily job failed to run.
The job should record its completion in a `job_runs` table. On application
startup, check if the daily cleanup job ran in the last 25 hours. If not,
run it immediately.

```typescript
interface JobRun {
  jobName: string;
  startedAt: Date;
  completedAt: Date | null;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

async function checkAndRecoverMissedJobs(): Promise<void> {
  // Your implementation
}
```

### Exercise 5: Cron vs Queue Decision

For each of the following requirements, decide whether to use a cron
job, a queue-triggered job, or both. Explain the interaction pattern
between them:

1. "Every night, generate a report for each of our 5,000 enterprise customers"
2. "Every 5 minutes, check for pending webhook deliveries that haven't been
   acknowledged and retry them"
3. "When a user uploads a video, transcode it to 3 different resolutions"
4. "Every Monday morning, create a 'weekly-digest' job for each user
   who has opted in to email newsletters"
5. "Every hour, sync the product catalog with our supplier's API"

For requirement 4, write the complete code showing how the scheduler
creates individual email jobs in the queue.
