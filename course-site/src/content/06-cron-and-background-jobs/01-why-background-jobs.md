# Lesson 1: Why Background Jobs Exist

## The Fundamental Tension in Web Servers

Every HTTP request follows the same contract: a client sends a request,
your server does some work, and the server sends back a response. The
client is waiting the entire time. It holds a connection open, a thread
or event loop slot occupied, a user staring at a spinner.

This contract works beautifully for most things. Reading a record from the
database? Milliseconds. Formatting a response? Microseconds. But the
moment your request handler needs to do something that takes more than a
few hundred milliseconds — send an email, generate a PDF, call a slow
third-party API, process an uploaded image — you have a problem.

The synchronous request model has three failure modes that will bite you
in production:

**User-facing latency.** If generating a PDF takes 8 seconds, the user
waits 8 seconds. That is catastrophically bad UX. Users abandon requests
that take more than 2-3 seconds. You've done all that work for nothing.

**Timeouts.** HTTP clients, reverse proxies, and load balancers all have
timeout configurations. A typical Nginx proxy_read_timeout is 60 seconds.
AWS ALB hard-caps requests at 4000 seconds, but your Lambda function
might cut off at 29 seconds. If your long-running work outlasts any of
these timeouts, the client gets a 504 and the work is simply abandoned
mid-flight — often leaving partial state in your database.

**Duplicated work on retry.** When a request times out, clients retry.
If your request was doing non-idempotent work — charging a credit card,
sending an email, creating a database record — you may do it twice. Or
three times. This is where production bugs that cost real money come from.

The solution is to decouple the *acknowledgment* of work from the
*execution* of work. Receive the request, put the work in a queue,
return a 202 Accepted immediately. Let something else do the work
asynchronously. The user doesn't wait. The work doesn't block. Retries
become safe.

---

## What Belongs in a Background Job

Not everything should be a background job. There's overhead in queuing,
there's latency in processing, and there's complexity in monitoring. The
rule of thumb: if the user does not need the result right now, or if the
work is expensive and can be deferred, it belongs in a background job.

Here are the clearest examples:

**Email and notification sending.** The user submits a registration form.
They need to see a "check your email" confirmation page immediately. They
do not need the email to be delivered before you respond. Queue the email
job, respond to the user, send the email in the background. If the email
server is down, retry later — the user doesn't need to know.

**PDF and document generation.** Generating a 100-page PDF report with
charts might take 10-30 seconds. No user will tolerate that wait. Queue
the generation job, show the user a "your report is being generated"
message, and notify them (via email, websocket, or polling) when it's ready.

**Report generation and data aggregation.** Queries that join millions
of rows, run complex analytics, or hit multiple data sources don't belong
in request handlers. Run them on a schedule or trigger them as background
jobs. Store the result. Serve the stored result to users instantly.

**Data sync and ETL.** Syncing data with third-party systems (CRMs,
accounting software, data warehouses) is slow and failure-prone. These
operations should be queued jobs with retry logic, not synchronous API calls.

**Webhook delivery.** When you receive an event that should trigger
notifications to multiple subscribers, queue a delivery job for each
subscriber. If one subscriber's endpoint is slow or down, the others aren't
affected and you can retry the failed delivery independently.

**Image and video processing.** Resizing uploaded images, generating
thumbnails, transcoding video — these are CPU-intensive and can take
seconds to minutes. Always background jobs.

**Cleanup and maintenance.** Deleting expired sessions, archiving old
records, vacuuming soft-deleted rows, invalidating stale caches — none
of this belongs in a request handler. Schedule it.

What does NOT belong in a background job: anything that the user needs
immediately in order to proceed. If the user needs to know whether their
username is available, that must be synchronous. If you need to validate
a payment method before confirming an order, do it synchronously. The
test is simple: can the user do anything useful while they wait for this
result? If yes, background it. If no, keep it synchronous.

---

## The Spectrum of Background Processing

"Background job" is not a single technology. It describes a pattern that
can be implemented at many levels of sophistication.

### Level 0: setTimeout / setImmediate

The simplest thing that works. You defer work to after the current
event loop tick:

```typescript
app.post('/register', async (req, res) => {
  const user = await db.users.create(req.body);

  // Don't await this — fire and forget
  setImmediate(async () => {
    await sendWelcomeEmail(user.email);
  });

  res.status(201).json({ user });
});
```

This works. The email sends in the background. But it has serious problems:
- If the process crashes, the email is never sent. No retry.
- If the email server is down, the error is swallowed. No retry.
- You have no visibility into what's pending or failed.
- Under high load, you can accumulate thousands of in-memory pending
  operations, none of which are durable.

Use this for truly unimportant work where loss is acceptable. Cache
warming, logging, metrics — maybe. User-facing email? Never.

### Level 1: Scheduled Tasks (Cron)

Cron is for work that needs to happen on a schedule, not triggered by
user action. Send a weekly digest every Monday at 9am. Clean up expired
sessions every night at 3am. Sync with an external API every 15 minutes.

Node's `node-cron` library lets you write cron jobs inline with your
application. Dedicated schedulers like Kubernetes CronJobs run your code
on a schedule in a controlled environment.

We'll cover cron in depth in the next lesson.

### Level 2: In-Process Job Queue

Libraries like Agenda (MongoDB-backed) or simple database-backed queues
let you persist jobs and process them within your application process.
More durable than fire-and-forget, but still tied to your application
process. If you're running two instances, you need locking to prevent
both from processing the same job.

### Level 3: Dedicated Queue with External Broker

BullMQ + Redis. RabbitMQ. AWS SQS. This is production-grade. Jobs are
persisted in an external system. Workers are separate processes. Multiple
workers can run concurrently. Failed jobs are retried automatically.
Everything is observable. This is what you build when correctness matters.

The tradeoff is operational complexity — you need Redis or a message
broker running and healthy. For applications that need background jobs
to be reliable, this is the correct tradeoff.

The rest of this module focuses on Level 3.

---

## Job Types: Scheduled vs Triggered

It's worth being precise about two distinct categories of background work,
because they have different architectures:

**Triggered jobs** are created in response to something that happened.
A user registers → enqueue a welcome email job. An invoice is marked paid
→ enqueue a PDF generation job. A file is uploaded → enqueue an image
resizing job. The trigger is an event. The job exists because of that event.

**Scheduled jobs** happen on a time-based cadence, independent of user
action. Send the weekly digest every Monday. Archive old records every
night. Refresh the product catalog cache every hour. The trigger is a clock.

In practice, you often combine both. A scheduled job might itself create
triggered jobs. A "weekly digest" scheduler might run every Monday and
create individual email jobs for each user — one per user, processed by
a worker pool, retried independently if they fail.

---

## Idempotency: The Most Important Property of Background Jobs

An idempotent operation is one that produces the same result whether you
perform it once or a hundred times. This is the single most important
property a background job can have.

Here's why: in any distributed system — including a simple app with a
queue — you will eventually process the same job more than once. This is
not a theoretical edge case. It happens due to:

- **Worker crashes:** A worker picks up a job, starts processing it, and
  crashes before acknowledging completion. The queue re-delivers the job.
  Another worker processes it again.
- **Network timeouts:** A worker finishes processing but the acknowledgment
  is lost. The queue assumes failure and re-delivers.
- **Bugs in your code:** You fix a bug in a job processor and need to
  re-run failed jobs. Some of them had partially succeeded.
- **Operator action:** Someone manually retries a failed job that actually
  succeeded on the first attempt but reported failure.

If your job is not idempotent, double-processing means double-charging
a credit card, double-sending an email, or creating duplicate records.

### Making Jobs Idempotent

The techniques depend on what the job does:

**Use database upserts instead of inserts.** Instead of `INSERT INTO
subscriptions ...` which will fail or duplicate on retry, use `INSERT ...
ON CONFLICT (user_id) DO NOTHING` or `ON CONFLICT DO UPDATE`.

**Check before acting.** Before sending a welcome email, check if one
was already sent for this user. If yes, skip and succeed.

```typescript
async function processWelcomeEmail(job: Job<WelcomeEmailPayload>) {
  const { userId } = job.data;

  // Check idempotency: has this already been sent?
  const alreadySent = await db.emailLog.findOne({
    type: 'welcome_email',
    userId,
  });

  if (alreadySent) {
    console.log(`Welcome email already sent for user ${userId}, skipping`);
    return { skipped: true };
  }

  // Send the email
  await emailService.send({ to: user.email, template: 'welcome' });

  // Record that we sent it (atomically with the send, ideally)
  await db.emailLog.create({ type: 'welcome_email', userId });

  return { sent: true };
}
```

**Use idempotency keys.** For external API calls (payment processors,
email providers), pass an idempotency key with each request. Stripe,
for example, accepts an `Idempotency-Key` header. Passing the same key
twice for the same operation returns the original result instead of
creating a duplicate charge.

```typescript
async function chargeCustomer(job: Job<ChargePayload>) {
  const { userId, amount, jobId } = job.data;

  // Use the job ID as the idempotency key
  // If this request is replayed, Stripe returns the original charge
  const charge = await stripe.charges.create(
    { amount, currency: 'usd', customer: userId },
    { idempotencyKey: `charge-${jobId}` }
  );

  return { chargeId: charge.id };
}
```

**Make state transitions safe.** If your job moves a record from one
state to another (e.g., `pending` → `processing` → `complete`), ensure
the transition is guarded. A job that finds a record already in `complete`
state should succeed immediately without re-doing the work.

```typescript
async function processOrder(job: Job<OrderPayload>) {
  const order = await db.orders.findByPk(job.data.orderId);

  if (order.status === 'completed') {
    return { skipped: true, reason: 'already completed' };
  }

  // Use an atomic update to prevent race conditions
  const updated = await db.orders.update(
    { status: 'completed', completedAt: new Date() },
    { where: { id: order.id, status: 'pending' } }
  );

  if (updated[0] === 0) {
    // Another worker got there first — that's fine
    return { skipped: true, reason: 'race condition, already handled' };
  }

  // Proceed with side effects
  await fulfillOrder(order);
}
```

The key insight: idempotency is not something you bolt on after writing
your job logic. It's a design constraint you hold from the beginning. Every
job you write should be written assuming it will run more than once.

---

## The Dangers of Fire-and-Forget

"Fire-and-forget" means triggering an operation without waiting for its
result or tracking whether it succeeded. It is almost always wrong for
user-facing work.

The failure modes:

**Silent data loss.** You kick off an email send with no error handling.
The email service returns a 429 rate limit error. You don't log it, you
don't retry. The user never gets their password reset email. Nobody knows.

```typescript
// BAD: fire-and-forget with no error handling
app.post('/forgot-password', async (req, res) => {
  const user = await db.users.findByEmail(req.body.email);
  emailService.sendPasswordReset(user); // No await, no .catch()
  res.json({ message: 'Check your email' });
});
```

**Promise rejection swallowing.** In Node.js, an unhandled promise rejection
in a detached async function produces an `UnhandledPromiseRejection` warning
(or crash in newer Node versions), but the error is gone by the time you'd
try to debug it. The operation simply didn't happen.

**Memory accumulation.** If you fire off 10,000 async operations quickly
without any concurrency control, you're holding 10,000 in-flight promises
and all their associated memory. Under load, this causes heap exhaustion
and crashes the process.

**The one acceptable use case.** Fire-and-forget is appropriate only
when the operation is truly non-critical and its failure has no user impact.
Emitting a metrics event, incrementing a non-critical counter, warming a
cache. Even then, log the error if it fails.

---

## Delivery Guarantees: A Precise Vocabulary

When engineers talk about message queues and job systems, three terms
come up constantly. It's worth understanding them precisely, because
they represent real tradeoffs:

### At-Most-Once Delivery

The job runs zero or one times. If it runs, great. If the worker crashes
before completing, the job is lost and never retried. No duplicates, but
possible message loss.

**When to use it:** Metrics, analytics events, cache invalidation hints.
Work where missing one occurrence is acceptable but duplicates are costly
or confusing.

**Implementation:** Acknowledge the job immediately upon receipt, before
processing. If the worker crashes mid-processing, the queue considers it
done.

```typescript
// At-most-once: acknowledge first, then process
async function atMostOnceWorker(job: Job) {
  await queue.ack(job.id);  // Done as far as the queue is concerned
  await riskyOperation(job.data);  // If this fails, job is gone
}
```

### At-Least-Once Delivery

The job runs one or more times. The queue retries until it gets an
acknowledgment. You may process the same job multiple times, but you
will not lose jobs.

**When to use it:** Email sending, payment processing, data sync —
any work where loss is unacceptable. This is the correct default for
most user-facing background work.

**Requirement:** Your job processor must be idempotent. This is not
optional. It's the price you pay for at-least-once delivery.

**Implementation:** Only acknowledge the job after successful completion.
If the worker crashes, the queue re-delivers.

```typescript
// At-least-once: process first, acknowledge after success
async function atLeastOnceWorker(job: Job) {
  await riskyOperation(job.data);  // If this fails, job is re-delivered
  await queue.ack(job.id);         // Only ack after success
}
```

BullMQ, by default, gives you at-least-once delivery.

### Exactly-Once Delivery

The holy grail: the job runs exactly one time, no more, no less. In
distributed systems, this is extraordinarily difficult to achieve in the
general case.

**The problem:** To guarantee exactly-once, you need to atomically
acknowledge the job and complete the operation in a single transaction.
But your job queue is Redis and your database is Postgres — you can't
do a cross-system atomic commit.

**Practical exactly-once:** In practice, you achieve exactly-once *semantics*
(not exactly-once *delivery*) by combining at-least-once delivery with
idempotent processing. The job may be delivered and started more than once,
but due to idempotency, the observable effect happens exactly once.

This is the pattern used by every serious production system. Exactly-once
delivery is a theoretical ideal; idempotent at-least-once is the
engineering reality.

| Guarantee | Job Loss | Duplicates | Requirements |
|-----------|----------|------------|--------------|
| At-most-once | Possible | Never | None |
| At-least-once | Never | Possible | Idempotent processors |
| Exactly-once (true) | Never | Never | Distributed transactions |
| Exactly-once (practical) | Never | Possible but harmless | Idempotent + at-least-once |

---

## A Mental Model for the Rest of This Module

Think of your application as having two planes:

**The request plane** handles synchronous user interactions. It must be
fast (< 200ms ideally), predictable, and safe to retry. It accepts work
and delegates heavy lifting.

**The job plane** handles deferred work. It's decoupled from user
latency, runs with its own concurrency, can be scaled independently,
and has retry logic baked in.

The handoff between the planes is a queue. The request plane enqueues a
job and responds. The job plane dequeues and processes, asynchronously,
with no user waiting.

```
User Request
     │
     ▼
  [Request Handler]
     │  Enqueue job (fast)
     │  Return 202
     ▼
  [Redis Queue]
     │
     ▼
  [Job Worker]
     │  Process job (can take seconds)
     │  Retry on failure
     │  Update status
     ▼
  [Result stored in DB / notification sent]
```

This separation is what makes the rest of this module possible. Once
you have the queue as the boundary, everything else — retries, dead
letter queues, scheduling, monitoring — follows naturally from it.

---

## Exercises

### Exercise 1: Latency Budgeting

You are building an e-commerce checkout flow. The following operations
must happen when a user clicks "Place Order":

1. Validate the cart (items, prices, stock)
2. Charge the payment method
3. Create the order record in the database
4. Reserve inventory
5. Send an order confirmation email
6. Update the sales analytics dashboard
7. Notify the fulfillment warehouse via API
8. Generate a PDF receipt

For each operation, decide whether it belongs in the synchronous request
handler or in a background job. Write a justification for each decision.
Then write pseudocode showing what the request handler does vs what jobs
it enqueues.

### Exercise 2: Idempotency Analysis

Examine this job processor:

```typescript
async function processMonthlyReport(job: Job) {
  const { orgId, month, year } = job.data;

  const data = await db.transactions.findAll({
    where: { orgId, month, year },
  });

  const summary = computeSummary(data);

  await db.reports.create({
    orgId, month, year,
    summary,
    generatedAt: new Date(),
  });

  await emailService.send({
    to: org.adminEmail,
    subject: `Monthly Report - ${month}/${year}`,
    body: formatReport(summary),
  });
}
```

Identify every way this job is NOT idempotent. Rewrite it to be fully
idempotent against at-least-once delivery semantics.

### Exercise 3: Delivery Guarantee Classification

For each of the following use cases, choose the appropriate delivery
guarantee (at-most-once, at-least-once, or exactly-once via idempotent
processing) and explain your reasoning:

1. Incrementing a page view counter
2. Sending a password reset email
3. Charging a customer's credit card
4. Invalidating a CDN cache for a blog post
5. Creating a user's Stripe customer ID on first purchase
6. Recording a user's login event for audit logs

### Exercise 4: Fire-and-Forget Audit

Given this Express route, identify all the problems with the fire-and-forget
pattern and rewrite it to use proper background job semantics (you can
use pseudocode for the queue operations):

```typescript
app.post('/invite-team', async (req, res) => {
  const { teamId, emails } = req.body;
  const team = await db.teams.findByPk(teamId);

  // Send invites to all email addresses
  emails.forEach(email => {
    sendInviteEmail(team, email);  // No await, no error handling
  });

  res.json({ message: `Inviting ${emails.length} people` });
});
```

What happens if the process crashes after sending 3 of 10 invites?
What happens if `sendInviteEmail` throws? How would you fix this?

### Exercise 5: The Spectrum Decision

You're building a SaaS application with the following constraints:
- 500 users currently, expected to grow to 50,000 in 12 months
- Engineering team of 3 people
- You want to add email notifications for 5 different events
- You have PostgreSQL but no Redis yet

At what scale does each approach become appropriate? Describe the migration
path from `setImmediate` → database-backed queue → Redis-backed queue.
At what point does each approach break down, and what are the warning
signs you'd observe in production before it breaks catastrophically?
