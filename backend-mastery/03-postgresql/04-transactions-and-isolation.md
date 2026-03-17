# Lesson 4: Transactions and Isolation

## Why This Lesson Exists

Transactions are the most misunderstood feature in databases. Most developers know
the surface syntax: `BEGIN`, `COMMIT`, `ROLLBACK`. Some can recite "ACID." But the
hard problems — the ones that produce real bugs in production systems — involve the
interaction between concurrent transactions. Two users reading and writing the same
data at the same time. Bank accounts that should balance but don't. Order quantities
that go negative. Inventory oversold by 200 units.

These bugs are invisible in development, where you're the only user. They appear
only under load, with real concurrent requests. And they're the kind of bug that
corrupts data silently — no error, no exception, just wrong numbers.

This lesson explains the problem from the ground up: what ACID actually guarantees,
what isolation levels actually mean, what anomalies each level prevents (and permits),
and how to use locks, SELECT FOR UPDATE, and savepoints to protect the invariants
your application depends on.

---

## ACID: What Each Property Actually Means

ACID is an acronym. People recite it without understanding what each property
guarantees — and more importantly, what it does not guarantee.

### Atomicity

**A transaction either commits fully or rolls back fully. There is no partial success.**

Imagine transferring $100 from account A to account B:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;  -- debit A
UPDATE accounts SET balance = balance + 100 WHERE id = 2;  -- credit B
COMMIT;
```

If the database crashes between the two UPDATEs, atomicity guarantees that on
recovery, neither update persists. Account A keeps its $100. Account B never gets
credit. The database is in the same state as before the transaction started.

What atomicity does NOT guarantee: that your application code is correct, or that
your business logic has no bugs. If you accidentally credit the wrong account and
commit, atomicity doesn't save you — the commit is final.

### Consistency

**A transaction takes the database from one valid state to another valid state.**

"Valid state" means all constraints, foreign keys, check constraints, and triggers
are satisfied. You cannot commit a transaction that violates these rules.

```sql
BEGIN;
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
VALUES (9999, 1, 1, 29.99);
-- If order 9999 doesn't exist, this violates the foreign key constraint.
-- The INSERT will fail, and the transaction cannot commit in this state.
COMMIT;  -- This commit will fail if the INSERT failed
```

What consistency does NOT guarantee: business-level consistency that isn't encoded
as a constraint. If your business rule is "a user can't have two pending orders,"
and you haven't written that as a check constraint or enforced it in your application,
the database will happily allow it.

### Isolation

**Concurrent transactions behave as if they were executed serially.**

This is the property most developers get wrong — and it's the most nuanced. "Behave
as if executed serially" is the ideal. In practice, perfect isolation has a cost.
PostgreSQL offers multiple isolation levels that trade isolation strength for
performance. We'll spend most of this lesson on isolation.

### Durability

**Once a transaction commits, it persists — even if the system crashes immediately after.**

PostgreSQL achieves durability through its Write-Ahead Log (WAL). Every change is
written to the WAL before the change is made to the actual data pages. On crash
recovery, PostgreSQL replays the WAL to restore committed transactions. This is why
`fsync = off` in PostgreSQL configuration is dangerous — it disables the guarantee
that WAL writes reach physical storage.

What durability does NOT guarantee: data on physically destroyed media. If your
storage hardware fails, PostgreSQL's WAL won't help. This is why replication and
backups exist.

---

## Transaction Syntax

```sql
-- Start a transaction explicitly
BEGIN;
-- or: START TRANSACTION;

-- All statements here are part of the same transaction
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;

-- Commit: make changes permanent
COMMIT;

-- Rollback: undo all changes since BEGIN
ROLLBACK;
```

Every statement in PostgreSQL is implicitly wrapped in a transaction if no explicit
`BEGIN` is active. This means a bare `UPDATE accounts SET balance = 0` is
automatically committed. This surprises developers coming from other environments.

```sql
-- These are equivalent:
DELETE FROM old_logs WHERE created_at < now() - interval '1 year';

-- and:
BEGIN;
DELETE FROM old_logs WHERE created_at < now() - interval '1 year';
COMMIT;
```

### Error Handling in Transactions

When a statement fails inside an explicit transaction, the transaction enters an
"error state." No further statements will execute until you issue a ROLLBACK.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;  -- succeeds
UPDATE accounts SET balance = balance + 100 WHERE id = 99999;  -- fails: id not found
-- Transaction is now in error state. Even SELECT won't work:
SELECT * FROM accounts;
-- ERROR: current transaction is aborted, commands ignored until end of transaction block
ROLLBACK;  -- must rollback to clear the error state
```

In application code using the `pg` library in Node.js:

```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, 1]);
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [100, 2]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;  // re-throw after rollback
} finally {
  client.release();  // ALWAYS release the client back to the pool
}
```

The `try/catch/finally` pattern is mandatory. If you forget the ROLLBACK, the
transaction stays open, holding locks, until the connection is closed. If you forget
`client.release()`, the connection leaks and your pool starves.

---

## Isolation Levels and Anomalies

PostgreSQL implements four isolation levels. Each level prevents certain classes
of anomalies. Understanding the anomalies first makes the levels meaningful.

### Anomaly 1: Dirty Read

A transaction reads data written by a concurrent uncommitted transaction.

**Timeline:**

```
Time | Transaction A                        | Transaction B
-----+--------------------------------------+----------------------------------
  1  | BEGIN;                               |
  2  | UPDATE accounts SET balance = 500    |
     |   WHERE id = 1;  -- was 100          |
  3  |                                      | BEGIN;
  4  |                                      | SELECT balance FROM accounts
     |                                      |   WHERE id = 1;
     |                                      | -- Dirty read: sees 500 (uncommitted)
  5  | ROLLBACK;  -- A decides to cancel    |
  6  |                                      | -- B used a value that never existed!
     |                                      | COMMIT;
```

Transaction B made a decision based on a value that was rolled back. The data
B read never actually existed in the committed database. This is a dirty read.

**PostgreSQL never allows dirty reads** — even at Read Uncommitted, PostgreSQL
behaves as Read Committed. The SQL standard permits dirty reads at Read Uncommitted
but does not require them.

### Anomaly 2: Non-Repeatable Read

A transaction reads the same row twice and gets different values because a concurrent
transaction committed a change between the two reads.

**Timeline:**

```
Time | Transaction A                        | Transaction B
-----+--------------------------------------+----------------------------------
  1  | BEGIN;                               |
  2  | SELECT balance FROM accounts         |
     |   WHERE id = 1;  -- result: 100      |
  3  |                                      | BEGIN;
  4  |                                      | UPDATE accounts SET balance = 500
     |                                      |   WHERE id = 1;
  5  |                                      | COMMIT;
  6  | SELECT balance FROM accounts         |
     |   WHERE id = 1;  -- result: 500      |
     | -- Same query, different result!      |
  7  | -- A's logic is now invalid          |
  8  | COMMIT;                              |
```

Transaction A read the balance as 100, did some computation, then read it again
and got 500. If A was computing a report that expected consistency across reads,
the report is wrong.

### Anomaly 3: Phantom Read

A transaction re-runs a query and gets different rows because a concurrent transaction
inserted or deleted rows that match the WHERE condition.

**Timeline:**

```
Time | Transaction A                        | Transaction B
-----+--------------------------------------+----------------------------------
  1  | BEGIN;                               |
  2  | SELECT count(*) FROM orders          |
     |   WHERE user_id = 5;  -- result: 3   |
  3  |                                      | BEGIN;
  4  |                                      | INSERT INTO orders (user_id, status)
     |                                      |   VALUES (5, 'pending');
  5  |                                      | COMMIT;
  6  | SELECT count(*) FROM orders          |
     |   WHERE user_id = 5;  -- result: 4   |
     | -- "Phantom" row appeared            |
  7  | COMMIT;                              |
```

The new row that appeared is called a "phantom." It wasn't there on the first read,
but a committed concurrent insert made it visible on the second read.

### Anomaly 4: Serialization Anomaly

Two transactions that would produce different results if run in either serial order
(A then B, or B then A) manage to produce a result that matches neither serial
order. This is the broadest anomaly — it encompasses race conditions that don't
fit neatly into the above categories.

A classic example: two transactions each read a count, decide to insert if the
count is below a threshold, and both insert, violating the intended invariant.

---

## The Four Isolation Levels

| Isolation Level  | Dirty Read | Non-Repeatable Read | Phantom Read | Serialization Anomaly |
|------------------|------------|---------------------|--------------|----------------------|
| Read Uncommitted | Possible*  | Possible            | Possible     | Possible             |
| Read Committed   | Prevented  | Possible            | Possible     | Possible             |
| Repeatable Read  | Prevented  | Prevented           | Prevented†   | Possible             |
| Serializable     | Prevented  | Prevented           | Prevented    | Prevented            |

*PostgreSQL prevents dirty reads even at Read Uncommitted.
†PostgreSQL's MVCC prevents phantom reads at Repeatable Read (better than the SQL standard requires).

### Read Committed (PostgreSQL Default)

Each statement in the transaction sees a snapshot of committed data as of the moment
that statement begins. Different statements within the same transaction can see
different committed data.

```sql
BEGIN;
-- Statement 1: sees data committed before this moment
SELECT count(*) FROM orders WHERE status = 'pending';  -- result: 10

-- (Another transaction commits 5 more pending orders here)

-- Statement 2: sees data committed before THIS statement begins
SELECT count(*) FROM orders WHERE status = 'pending';  -- result: 15

COMMIT;
```

Read Committed is appropriate when:
- You're doing single-statement reads/writes (most CRUD operations)
- The transaction is short and doesn't depend on consistency across multiple reads

Read Committed is NOT appropriate when:
- Your transaction logic makes decisions based on multiple reads that must be consistent
- You're implementing any kind of "check-then-act" logic

### Repeatable Read

The transaction takes a snapshot at the moment of the first statement, and every
subsequent statement in the transaction sees that same snapshot.

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;

SELECT count(*) FROM orders WHERE status = 'pending';  -- result: 10
-- (Another transaction inserts 5 more pending orders and commits)
SELECT count(*) FROM orders WHERE status = 'pending';  -- still 10
-- The snapshot doesn't change during the transaction.

COMMIT;
```

Under Repeatable Read, if you try to UPDATE a row that another transaction has
modified since your snapshot, PostgreSQL will detect the conflict. If the other
transaction committed, your UPDATE will fail (serialization error). If it rolled
back, yours proceeds.

Repeatable Read is appropriate for:
- Analytics queries that span multiple statements and need a consistent view
- Reports that join across tables and must see a consistent state

### Serializable

The strongest isolation. PostgreSQL guarantees that if your transaction commits,
its effects are equivalent to some serial execution order. It uses Serializable
Snapshot Isolation (SSI), detecting serialization anomalies via dependency tracking
and aborting transactions that would violate serializability.

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;
-- If PostgreSQL detects that your transaction's result would differ from any
-- possible serial execution, it aborts with:
-- ERROR: could not serialize access due to read/write dependencies among transactions

-- Your application must retry on this error.
COMMIT;
```

Serializable is appropriate for:
- Financial calculations where correctness is paramount
- Inventory management with exact quantity guarantees
- Any "check-then-act" pattern where you need guaranteed consistency

The cost: Serializable has higher overhead (dependency tracking) and more transaction
aborts (requiring retries). It's not the default because most web applications don't
need it — and when they think they do, they often use explicit locking instead.

---

## SELECT FOR UPDATE: Pessimistic Locking

Sometimes you need to lock rows before modifying them, ensuring no other transaction
can change them between your read and your write. This is pessimistic locking.

```sql
BEGIN;

-- Lock the account row for the duration of this transaction
SELECT balance FROM accounts WHERE id = $1 FOR UPDATE;
-- No other transaction can update or select-for-update this row until we commit.

-- Now safely compute and update
UPDATE accounts SET balance = balance - $2 WHERE id = $1;

COMMIT;
```

`SELECT FOR UPDATE` acquires a row-level lock. Other transactions that try to
`SELECT FOR UPDATE` the same row will wait until this transaction commits or rolls
back.

### FOR UPDATE vs FOR SHARE

```sql
-- FOR UPDATE: exclusive lock. Blocks other writers AND other FOR UPDATE readers.
SELECT * FROM accounts WHERE id = $1 FOR UPDATE;

-- FOR SHARE: shared lock. Allows other FOR SHARE readers, blocks writers.
SELECT * FROM accounts WHERE id = $1 FOR SHARE;
```

Use `FOR UPDATE` when you intend to modify the row. Use `FOR SHARE` when you need
to read a row and prevent concurrent modifications, but don't need to prevent
other readers.

### NOWAIT and SKIP LOCKED

```sql
-- Fail immediately if the row is already locked (instead of waiting)
SELECT * FROM jobs WHERE id = $1 FOR UPDATE NOWAIT;
-- Raises: ERROR: could not obtain lock on row in relation "jobs"

-- Skip locked rows (useful for job queue processing)
SELECT * FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 10
FOR UPDATE SKIP LOCKED;
-- Returns up to 10 pending jobs that are not currently locked by another worker.
-- Multiple workers can safely process jobs in parallel without conflict.
```

`SKIP LOCKED` is the foundation of a reliable job queue in PostgreSQL:

```javascript
// Worker process: claim jobs without conflicting with other workers
async function claimJobs(client, batchSize) {
  const result = await client.query(`
    SELECT id, payload
    FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  `, [batchSize]);
  return result.rows;
}
```

---

## Deadlocks: How They Happen and How to Avoid Them

A deadlock occurs when two (or more) transactions each hold a lock the other needs,
and both are waiting for the other to release. Neither can proceed. PostgreSQL detects
deadlocks and kills one of the transactions.

### Deadlock Scenario

```
Time | Transaction A                     | Transaction B
-----+-----------------------------------+----------------------------------
  1  | BEGIN;                            | BEGIN;
  2  | SELECT * FROM accounts            |
     |   WHERE id = 1 FOR UPDATE;        |
     | -- A holds lock on row 1          |
  3  |                                   | SELECT * FROM accounts
     |                                   |   WHERE id = 2 FOR UPDATE;
     |                                   | -- B holds lock on row 2
  4  | SELECT * FROM accounts            |
     |   WHERE id = 2 FOR UPDATE;        |
     | -- A wants lock on row 2          |
     | -- B has it. A waits.             |
  5  |                                   | SELECT * FROM accounts
     |                                   |   WHERE id = 1 FOR UPDATE;
     |                                   | -- B wants lock on row 1
     |                                   | -- A has it. B waits.
  6  | DEADLOCK DETECTED                 |
     | -- PostgreSQL kills one transaction
     | ERROR: deadlock detected           |
```

Neither transaction can proceed. PostgreSQL's deadlock detector notices the cycle
and rolls back one transaction (usually the one that was waiting shortest).

### How to Avoid Deadlocks

**Rule 1: Always acquire locks in the same order.**

If both A and B always lock accounts in ascending ID order, the deadlock above
cannot occur:

```sql
-- SAFE: always lock lower ID first
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;  -- lower first
SELECT * FROM accounts WHERE id = 2 FOR UPDATE;  -- then higher
-- No concurrent transaction can do 2 then 1, so no cycle possible.
```

**Rule 2: Keep transactions short.**

Long transactions hold locks longer, increasing the window for deadlocks. Do
computations outside the transaction, then begin a short transaction to commit
the result.

```javascript
// BAD: long computation inside the transaction
await client.query('BEGIN');
const data = await client.query('SELECT * FROM large_table FOR UPDATE');
const result = await expensiveComputation(data.rows);  // takes 2 seconds
await client.query('UPDATE large_table SET result = $1', [result]);
await client.query('COMMIT');

// GOOD: compute first, lock briefly
const data = await pool.query('SELECT * FROM large_table');  // no lock
const result = await expensiveComputation(data.rows);        // compute outside tx
await client.query('BEGIN');
// Re-validate and update atomically
await client.query('UPDATE large_table SET result = $1 WHERE version = $2', [result, data.rows[0].version]);
await client.query('COMMIT');
```

**Rule 3: Use deadlock-resistant patterns.**

For bulk operations that lock multiple rows, sort the rows by primary key before
locking:

```javascript
// Sort IDs ascending before acquiring locks
const ids = [5, 2, 8, 1].sort((a, b) => a - b);  // [1, 2, 5, 8]
await client.query(`
  SELECT id FROM accounts WHERE id = ANY($1) FOR UPDATE
`, [ids]);
// PostgreSQL will lock in table/index order, which is consistent.
```

### Detecting Deadlocks

Deadlocks leave a trace in PostgreSQL logs. Check `pg_locks` for current lock contention:

```sql
-- Find blocked queries and what's blocking them
SELECT
  blocked.pid            AS blocked_pid,
  blocked_activity.query AS blocked_query,
  blocking.pid           AS blocking_pid,
  blocking_activity.query AS blocking_query,
  now() - blocked_activity.query_start AS blocked_duration
FROM pg_locks blocked
JOIN pg_locks blocking
  ON blocking.transactionid = blocked.transactionid
  AND blocking.pid != blocked.pid
JOIN pg_stat_activity blocked_activity  ON blocked_activity.pid = blocked.pid
JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
WHERE NOT blocked.granted;
```

---

## Optimistic vs Pessimistic Locking

Two philosophies for handling concurrent access to the same data.

### Pessimistic Locking

Assume conflict will happen. Lock the resource before reading it. Wait if locked.

```sql
-- Pessimistic: lock before read
BEGIN;
SELECT * FROM products WHERE id = $1 FOR UPDATE;
-- No one else can modify this product until we commit.
UPDATE products SET stock = stock - $2 WHERE id = $1;
COMMIT;
```

Pros: No retries needed. Correct as long as locks are acquired in the right order.
Cons: Locks held for the transaction duration. Throughput limited by lock contention.

### Optimistic Locking

Assume conflict is rare. Don't lock on read. At write time, verify nothing changed.
Use a version number (or timestamp) as a change detector.

```sql
-- Add a version column to the table
ALTER TABLE products ADD COLUMN version integer NOT NULL DEFAULT 1;

-- Read without locking
SELECT id, stock, version FROM products WHERE id = $1;

-- Write only if version matches (nothing changed since we read)
UPDATE products
SET stock = stock - $2, version = version + 1
WHERE id = $1 AND version = $3;  -- $3 is the version we read
-- If 0 rows updated, someone else changed it. Application retries.
```

In Node.js:

```javascript
async function decrementStock(productId, quantity) {
  while (true) {  // retry loop
    const { rows } = await pool.query(
      'SELECT id, stock, version FROM products WHERE id = $1',
      [productId]
    );
    const product = rows[0];

    if (product.stock < quantity) throw new Error('Insufficient stock');

    const result = await pool.query(
      `UPDATE products
       SET stock = stock - $1, version = version + 1
       WHERE id = $2 AND version = $3`,
      [quantity, productId, product.version]
    );

    if (result.rowCount === 1) return;  // success
    // rowCount === 0: concurrent update. Retry.
    // In production: add max retries and exponential backoff.
  }
}
```

Pros: No lock contention. Better throughput when conflicts are rare.
Cons: Requires retry logic. Livelock possible if conflicts are frequent.

When to use which:
- **Pessimistic**: when conflicts are frequent (inventory during a flash sale), when
  you can't afford retries (payment processing), when correctness is critical.
- **Optimistic**: when conflicts are rare (updating a user's profile), when you're
  reading many rows and modifying few, when you prefer throughput over latency.

---

## Savepoints

Savepoints allow partial rollback within a transaction. You can roll back to a
named point without abandoning the entire transaction.

```sql
BEGIN;

UPDATE accounts SET balance = balance - 100 WHERE id = 1;  -- debit

SAVEPOINT after_debit;

UPDATE accounts SET balance = balance + 100 WHERE id = 2;  -- credit attempt 1

-- If the credit fails (e.g., account 2 is frozen):
ROLLBACK TO SAVEPOINT after_debit;
-- The debit is still in effect. The failed credit is undone.

-- Try credit to a different account:
UPDATE accounts SET balance = balance + 100 WHERE id = 3;  -- credit attempt 2

RELEASE SAVEPOINT after_debit;  -- savepoint no longer needed

COMMIT;
```

Savepoints are useful in complex transactions where some steps are optional or can
fail gracefully. In application code:

```javascript
await client.query('BEGIN');
await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, 1]);

await client.query('SAVEPOINT before_bonus');
try {
  await client.query('INSERT INTO bonus_log (user_id, amount) VALUES ($1, $2)', [userId, 10]);
} catch (err) {
  // Bonus logging failed (maybe bonus_log table is broken), but don't abort the whole transfer
  await client.query('ROLLBACK TO SAVEPOINT before_bonus');
}

await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [100, 2]);
await client.query('COMMIT');
```

---

## Advisory Locks

PostgreSQL provides application-level locks that your code can acquire and release
explicitly. They're stored in memory (not in any table) and don't interfere with
row-level or table-level locks.

```sql
-- Acquire a session-level advisory lock (integer key)
-- Blocks until the lock is acquired
SELECT pg_advisory_lock(42);

-- Try to acquire; returns false immediately if already locked
SELECT pg_try_advisory_lock(42);

-- Release the lock
SELECT pg_advisory_unlock(42);

-- Transaction-level advisory lock (auto-released on commit/rollback)
SELECT pg_advisory_xact_lock(42);
```

Advisory locks are useful for application-level mutual exclusion that doesn't map
naturally to row locks:

```javascript
// Ensure only one process runs the nightly billing job
async function runBillingJob(pool) {
  const lockKey = 999999;  // agreed-upon key for billing job

  const client = await pool.connect();
  try {
    // pg_try_advisory_lock returns true if acquired, false if already held
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockKey]
    );

    if (!rows[0].acquired) {
      console.log('Billing job already running. Skipping.');
      return;
    }

    // Safe to run — we have the lock
    await processBilling(client);

  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    client.release();
  }
}
```

Advisory locks are visible in `pg_locks`:

```sql
SELECT pid, locktype, classid, objid, mode, granted
FROM pg_locks
WHERE locktype = 'advisory';
```

---

## MVCC: Why Readers Don't Block Writers

A fundamental advantage of PostgreSQL over many other systems is MVCC: Multi-Version
Concurrency Control. When you start a transaction, PostgreSQL gives you a snapshot
of the database as it existed at that moment. When another transaction modifies a
row, PostgreSQL creates a new version of that row. Your snapshot continues to see
the old version. When your transaction ends, the old version becomes eligible for
cleanup (by VACUUM).

The result: **readers never block writers, and writers never block readers.**

A long-running analytics query (`SELECT` only) does not prevent inserts and updates
from happening concurrently. In a system with row-level locking (like early MySQL
with table locks), a long SELECT would block all writes on that table.

The trade-off: old row versions accumulate until VACUUM reclaims them. This is why
bloat and VACUUM matter (covered in Lesson 3). Long-running transactions prevent
VACUUM from cleaning up old versions, causing table bloat.

```sql
-- Find long-running transactions that might be preventing VACUUM
SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
FROM pg_stat_activity
WHERE state != 'idle'
  AND pg_stat_activity.query_start < now() - interval '5 minutes'
ORDER BY duration DESC;
```

---

## Exercises

### Exercise 1: Classify the Anomaly

For each scenario, identify whether it is a dirty read, non-repeatable read, phantom
read, or serialization anomaly. Assume Read Committed isolation level unless stated.

**Scenario A:**
- Transaction 1: reads the balance of account 7 (gets $1000).
- Transaction 2: updates account 7 to $2000 and commits.
- Transaction 1: reads account 7 again (gets $2000).
- Transaction 1 computes a report based on both reads.

**Scenario B:**
- Transaction 1: counts all active users (gets 500).
- Transaction 2: activates 10 new users and commits.
- Transaction 1: counts active users again (gets 510).

**Scenario C:**
- Transaction 1: reads a row that Transaction 2 has written but not yet committed.
- Transaction 2 rolls back.
- Transaction 1 makes a decision based on the value it read.

**Scenario D:**
- Transaction 1 reads: "no user has more than 3 active subscriptions"
- Transaction 2 reads: "no user has more than 3 active subscriptions"
- Both insert a 3rd subscription for the same user.
- Both commit. The user now has 4 subscriptions.

### Exercise 2: Implement a Safe Transfer

Write a Node.js function `transferFunds(fromId, toId, amount)` that:
1. Uses a transaction with explicit `BEGIN`/`COMMIT`/`ROLLBACK`.
2. Acquires row locks to prevent race conditions.
3. Validates that the source account has sufficient funds.
4. Handles the case where the account doesn't exist.
5. Always releases the database client.

Include the SQL and the JavaScript code. Explain why `SELECT FOR UPDATE` is
appropriate here rather than optimistic locking.

### Exercise 3: Identify the Isolation Bug

A developer writes this order placement code:

```javascript
async function placeOrder(userId, productId, quantity) {
  // Check stock
  const stockResult = await pool.query(
    'SELECT stock FROM products WHERE id = $1',
    [productId]
  );
  const currentStock = stockResult.rows[0].stock;

  if (currentStock < quantity) {
    throw new Error('Insufficient stock');
  }

  // Place the order (no transaction)
  await pool.query(
    'INSERT INTO orders (user_id, status) VALUES ($1, $2) RETURNING id',
    [userId, 'pending']
  );

  await pool.query(
    'UPDATE products SET stock = stock - $1 WHERE id = $2',
    [quantity, productId]
  );
}
```

1. Identify at least two concurrency bugs in this code.
2. What can go wrong if 100 users simultaneously call `placeOrder` for the last
   item in stock?
3. Rewrite the function using a transaction and `SELECT FOR UPDATE` to fix both bugs.

### Exercise 4: Deadlock Analysis

Two developers implement separate operations on the `orders` and `order_items` tables.

Developer A's function:
```sql
BEGIN;
SELECT * FROM orders WHERE id = $1 FOR UPDATE;
UPDATE order_items SET quantity = $2 WHERE order_id = $1;
COMMIT;
```

Developer B's function:
```sql
BEGIN;
SELECT * FROM order_items WHERE order_id = $1 FOR UPDATE;
UPDATE orders SET status = 'processing' WHERE id = $1;
COMMIT;
```

1. Draw a timeline showing how a deadlock can occur when both functions run on
   the same order ID simultaneously.
2. Propose a fix that prevents the deadlock without changing the business logic.

### Exercise 5: Choose the Isolation Level

For each scenario, recommend the appropriate isolation level (Read Committed,
Repeatable Read, or Serializable) and explain why. If explicit locking (`SELECT FOR
UPDATE`) is appropriate instead of or in addition to isolation level changes, say so.

**Scenario A:** A billing job reads all overdue subscriptions, computes renewal
amounts, and inserts charge records. The job runs once per day and takes 30 minutes.
During that time, users may update their subscription plans.

**Scenario B:** A user views their profile page. The page shows their name, email,
and account balance. These are three separate SELECT queries in the same request handler.

**Scenario C:** A flash sale reduces product price by 50% for the first 1000 buyers.
Each purchase must check: "is the item still on sale? has the 1000-buyer limit been
reached?" before completing the order.

**Scenario D:** A daily analytics report runs 15 sequential queries across orders,
users, and products to compute metrics. The report must be internally consistent —
it cannot show a purchase that appears in the orders table but not in the revenue total.
