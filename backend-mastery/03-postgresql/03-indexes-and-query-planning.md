# Lesson 3: Indexes and Query Planning

## Why This Lesson Exists

Indexes are the single highest-leverage performance tool in a relational database.
A query that takes 10 seconds without an index can take 0.5 milliseconds with one.
That's a 20,000x improvement from a single line of SQL. But indexes are not magic.
Add them incorrectly and you slow down writes, waste disk space, and sometimes make
reads slower too.

This lesson gives you a model of what an index actually is, how PostgreSQL decides
whether to use one, how to read the execution plans that tell you what's happening,
and how to make principled decisions about which indexes your schema needs.

---

## What Is an Index?

An index is a separate data structure that PostgreSQL maintains alongside your table.
It maps column values to the physical locations (heap page + offset) of matching rows.
When you query with a WHERE clause on an indexed column, PostgreSQL can go directly
to the relevant pages instead of reading the entire table.

The analogy: a book's index. To find every mention of "B-tree," you don't re-read
the entire book. You look up "B-tree" in the index, which tells you pages 42, 87,
and 134. You flip to those three pages. You read three pages instead of 800.

### The Default: B-Tree

Every index you create without specifying a type is a B-tree (balanced tree). Understanding
the B-tree structure explains most index behavior.

A B-tree is a tree where:
- Each node holds multiple keys, sorted in order.
- All leaf nodes are at the same depth.
- Each leaf node stores keys and pointers to heap rows.
- Interior nodes store keys and pointers to child nodes.

```
                        [40 | 80]
                       /    |    \
              [10|20|30]  [50|60|70]  [85|90|95]
              |  |  |  |  |  |  |  |  |  |  |  |
             rows rows rows rows rows rows rows rows
```

To find rows where `price = 60`:
1. Start at root: 60 > 40 and 60 < 80, go to middle child.
2. Middle child: 60 is between 50 and 70, go to that leaf.
3. Found key 60. Follow the pointer to the heap row.

The depth of a B-tree on a table with N rows is proportional to log(N). For a table
with 1 billion rows, the tree height is around 30 levels. Finding any value requires
at most 30 node reads — each node is typically one 8KB database page. Compare that
to a sequential scan: 1 billion rows might occupy millions of pages.

### What B-Trees Are Optimized For

B-trees support:
- Equality: `WHERE price = 49.99`
- Range: `WHERE price BETWEEN 10 AND 50`
- Prefix pattern: `WHERE name LIKE 'Apple%'` (because 'Apple%' is a range on the sorted values)
- Ordering: `ORDER BY price` (the tree is already sorted — PostgreSQL walks the leaves in order)

B-trees do NOT support:
- Suffix/contains patterns: `WHERE name LIKE '%phone'`
- Full-text search (use GIN indexes with `tsvector`)
- Nearest-neighbor / similarity search (use GiST or HNSW with pgvector)
- Array membership (use GIN indexes)

### Other Index Types

| Type | Use Case |
|------|----------|
| B-tree | Default. Equality, ranges, sorting. |
| GIN | Arrays, JSONB, full-text search. "Contains" operations. |
| GiST | Geometric data, nearest-neighbor, range types. |
| BRIN | Very large tables where data is physically ordered (e.g., time-series log tables). |
| Hash | Equality only. Rarely better than B-tree in practice. |

We'll use B-tree throughout this lesson. GIN appears in the project for full-text search.

---

## The Cost of a Full Table Scan

A sequential scan reads every page in the table, every row, and evaluates the WHERE
condition for each. For a table with 10 million rows spread across 50,000 pages, that
is 50,000 page reads for every query.

Set up a demonstration table:

```sql
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL,
  event_type text        NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata   jsonb
);

-- Insert 1 million test rows
INSERT INTO events (user_id, event_type, occurred_at)
SELECT
  (random() * 10000)::bigint + 1,
  (ARRAY['click','view','purchase','logout','login'])[floor(random() * 5 + 1)],
  now() - (random() * interval '365 days')
FROM generate_series(1, 1000000);

-- Update statistics so the planner has accurate information
ANALYZE events;
```

Now run a query and examine the plan:

```sql
EXPLAIN ANALYZE
SELECT id, event_type, occurred_at
FROM events
WHERE user_id = 5000;
```

Output (before any indexes):
```
Seq Scan on events  (cost=0.00..24846.00 rows=100 width=29)
                    (actual time=0.082..156.334 rows=98 loops=1)
  Filter: (user_id = 5000)
  Rows Removed by Filter: 999902
Planning Time: 0.124 ms
Execution Time: 156.488 ms
```

156 milliseconds for a single user lookup. The scan removed 999,902 rows that didn't
match. Now add an index:

```sql
CREATE INDEX idx_events_user_id ON events (user_id);
```

Run the same query:

```sql
EXPLAIN ANALYZE
SELECT id, event_type, occurred_at
FROM events
WHERE user_id = 5000;
```

Output:
```
Index Scan using idx_events_user_id on events
  (cost=0.42..401.10 rows=100 width=29)
  (actual time=0.058..0.712 rows=98 loops=1)
  Index Cond: (user_id = 5000)
Planning Time: 0.287 ms
Execution Time: 0.789 ms
```

0.789 milliseconds. A 200x improvement. This is what an index does.

---

## How to Read EXPLAIN ANALYZE Output

`EXPLAIN ANALYZE` is your primary diagnostic tool. Every performance investigation
starts here. Learning to read it fluently is not optional.

```sql
EXPLAIN ANALYZE
SELECT u.email, count(e.id) AS event_count
FROM users u
JOIN events e ON e.user_id = u.id
WHERE e.event_type = 'purchase'
  AND e.occurred_at >= now() - interval '30 days'
GROUP BY u.id, u.email
ORDER BY event_count DESC
LIMIT 20;
```

Output:
```
Limit  (cost=18423.50..18423.55 rows=20 width=40)
       (actual time=182.341..182.350 rows=20 loops=1)
  ->  Sort  (cost=18423.50..18448.50 rows=10000 width=40)
            (actual time=182.335..182.339 rows=20 loops=1)
        Sort Key: (count(e.id)) DESC
        Sort Method: top-N heapsort  Memory: 26kB
        ->  HashAggregate  (cost=18103.50..18203.50 rows=10000 width=40)
                           (actual time=181.829..182.119 rows=9817 loops=1)
              Group Key: u.id
              Batches: 1  Memory Usage: 3089kB
              ->  Hash Join  (cost=9.00..17853.50 rows=20000 width=24)
                             (actual time=0.582..170.892 rows=19834 loops=1)
                    Hash Cond: (e.user_id = u.id)
                    ->  Seq Scan on events e
                          (cost=0.00..27346.00 rows=20000 width=16)
                          (actual time=0.076..163.211 rows=19834 loops=1)
                          Filter: ((event_type = 'purchase')
                                    AND (occurred_at >= (now() - '30 days'::interval)))
                          Rows Removed by Filter: 980166
                    ->  Hash  (cost=5.00..5.00 rows=200 width=16)
                              (actual time=0.314..0.314 rows=200 loops=1)
                        Buckets: 1024  Batches: 1  Memory Usage: 17kB
                        ->  Seq Scan on users u
                              (cost=0.00..5.00 rows=200 width=16)
                              (actual time=0.022..0.175 rows=200 loops=1)
Planning Time: 0.857 ms
Execution Time: 182.461 ms
```

### Anatomy of a Plan Node

Each node has this structure:
```
NodeType  (cost=startup..total rows=estimated_rows width=estimated_row_bytes)
          (actual time=startup..total rows=actual_rows loops=iterations)
```

Key fields:
- **cost**: planner's estimate. Startup = time to first row. Total = time for all rows.
- **actual time**: real measured milliseconds.
- **rows**: estimated vs actual. Large discrepancies indicate stale statistics.
- **loops**: how many times this node executed (relevant for nested loops).
- **width**: estimated bytes per row.

### Reading the Tree

The tree is executed bottom-up. Find the most-indented nodes first:

1. `Seq Scan on users`: reads all 200 users. Fast, 200 rows.
2. `Hash`: builds a hash table from the users scan. 0.314ms.
3. `Seq Scan on events`: reads all 1,000,000 events, filters to purchase events in
   last 30 days. This is the bottleneck — 163ms, discarding 980,166 rows.
4. `Hash Join`: probes the user hash table for each qualifying event.
5. `HashAggregate`: groups by user, counts events.
6. `Sort` + `Limit`: sort by count, take top 20.

The slow step is obvious: the sequential scan on events that discards 98% of rows.
We need a composite index on `(event_type, occurred_at)`:

```sql
CREATE INDEX idx_events_type_date ON events (event_type, occurred_at DESC);
```

Re-run the EXPLAIN ANALYZE:

```
Limit  (cost=1523.20..1523.25 rows=20 width=40)
       (actual time=12.441..12.450 rows=20 loops=1)
  ->  Sort  (cost=1523.20..1548.20 rows=10000 width=40)
            (actual time=12.437..12.440 rows=20 loops=1)
        Sort Key: (count(e.id)) DESC
        ->  HashAggregate  (cost=1203.20..1303.20 rows=10000 width=40)
                           (actual time=12.123..12.310 rows=9817 loops=1)
              ->  Hash Join  (cost=9.00..953.20 rows=20000 width=24)
                             (actual time=0.472..7.892 rows=19834 loops=1)
                    Hash Cond: (e.user_id = u.id)
                    ->  Bitmap Heap Scan on events e
                          (cost=423.00..921.80 rows=20000 width=16)
                          (actual time=0.987..5.912 rows=19834 loops=1)
                          Recheck Cond: ((event_type = 'purchase')
                            AND (occurred_at >= (now() - '30 days'::interval)))
                          ->  Bitmap Index Scan on idx_events_type_date
                                (cost=0.00..418.00 rows=20000 width=0)
                                (actual time=0.834..0.834 rows=19834 loops=1)
                                Index Cond: ((event_type = 'purchase')
                                  AND (occurred_at >= ...))
              ->  Hash on users: ...
Planning Time: 1.124 ms
Execution Time: 12.571 ms
```

182ms → 12ms. The sequential scan is gone, replaced by a Bitmap Index Scan.

---

## Sequential Scan vs Index Scan vs Bitmap Scan

These are the three fundamental ways PostgreSQL reads rows from a table. Understanding
when each appears and why is core to reading query plans.

### Sequential Scan

Reads every page in the table, in physical order. Fast when you need most of the rows
(low selectivity) or when the table is tiny (fits in a few pages — a sequential scan
of 100 rows is faster than an index lookup because you skip the index traversal).

PostgreSQL will choose a sequential scan over an index scan when it estimates that
the index scan would require more page reads. This happens when the query matches
a large fraction of the table (typically >5-15% of rows, depending on table size).

### Index Scan

Traverses the B-tree to find matching keys, then follows pointers to heap rows
one at a time. Fast for high-selectivity queries (few matching rows). Each heap
fetch may hit a different page, so random I/O is the cost.

For a query matching 10 rows out of 1,000,000, an index scan does: ~30 B-tree
node reads + 10 heap page reads. A sequential scan does ~50,000 page reads. Index
wins dramatically.

For a query matching 200,000 rows out of 1,000,000, an index scan fetches 200,000
heap rows. Each might be on a different page. That's potentially 200,000 random
I/O operations. A sequential scan reads 50,000 pages sequentially — which modern
storage handles in one pass. Sequential scan may actually win here.

### Bitmap Scan

A hybrid. PostgreSQL:
1. Does a Bitmap Index Scan: traverses the index and builds a bitmap of page numbers
   (not row pointers — page numbers).
2. Does a Bitmap Heap Scan: reads those pages in physical order, rechecking conditions.

This avoids the random I/O problem of a plain Index Scan. For medium-selectivity
queries (the examples above with 20,000 matching rows out of 1,000,000), a bitmap
scan reads the needed pages in sequential order instead of jumping around randomly.

The "Recheck Cond" line in a Bitmap Heap Scan is because the bitmap is at page
granularity. Multiple rows on the same page might match or not — the recheck
evaluates the condition again at the row level.

---

## Composite Indexes and Column Ordering

A composite index covers multiple columns. Column ordering matters enormously.

```sql
CREATE INDEX idx_events_user_type ON events (user_id, event_type);
```

This index sorts rows first by `user_id`, then by `event_type` within each user.
It can efficiently answer:

- `WHERE user_id = 5000` (leading column — prefix of the index)
- `WHERE user_id = 5000 AND event_type = 'purchase'` (full index)
- `ORDER BY user_id, event_type` (already sorted)

It cannot efficiently answer:

- `WHERE event_type = 'purchase'` (not the leading column — index not usable for
  this alone; PostgreSQL would need to scan the entire index, which is nearly as
  slow as scanning the table)

### The Leading Column Rule

A composite index `(a, b, c)` can be used for queries filtering on:
- `a`
- `a, b`
- `a, b, c`

But not for queries filtering on only `b`, only `c`, or `b, c`. The leading
column must be present.

This has a practical implication for index design. Given this query:

```sql
WHERE user_id = 5000 AND event_type = 'purchase'
```

Both `(user_id, event_type)` and `(event_type, user_id)` can serve this query.
Which column should be first? Put the more selective column first (the one that
reduces the result set more). If there are 50 event types but 10,000 users, then
`user_id` has lower selectivity per value (roughly 100 events per user) while
`event_type` with a specific value also returns ~200,000 rows. Measure — don't guess.

Also consider which queries exist without the other column:
- If `WHERE user_id = 5000` (no event_type filter) is common, put `user_id` first.
- If `WHERE event_type = 'purchase'` (no user_id filter) is common, put `event_type` first.

Often you need both indexes. Two indexes on the same table is fine — the planner
picks the best one per query.

---

## Partial Indexes

A partial index only indexes rows matching a condition. If you only query a subset
of your data, a partial index is smaller, faster to build, and faster to query.

```sql
-- Only index events that are purchases (the most queried type)
CREATE INDEX idx_events_purchase_user ON events (user_id)
WHERE event_type = 'purchase';

-- Only index active orders (most queries filter to non-cancelled)
CREATE INDEX idx_orders_active_user ON orders (user_id)
WHERE status NOT IN ('cancelled', 'refunded');
```

A partial index can only be used when the query's WHERE clause is at least as
restrictive as the index predicate. If the index requires `event_type = 'purchase'`,
a query without that condition can't use it.

```sql
-- Uses the partial index:
SELECT * FROM events WHERE user_id = 5000 AND event_type = 'purchase';

-- Cannot use the partial index (query is broader than index):
SELECT * FROM events WHERE user_id = 5000;
```

Partial indexes are particularly effective for:
- "Soft delete" patterns: `WHERE deleted_at IS NULL` (most queries only want active records)
- Status-filtered tables: `WHERE status = 'active'`
- Rare conditions: `WHERE is_admin = true` (only 0.1% of users)

---

## Expression Indexes

An expression index indexes the result of a function or expression, not the raw column.

```sql
-- Enable case-insensitive email lookups without storing a separate column
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- Query must use the same expression to leverage the index:
SELECT id FROM users WHERE lower(email) = lower($1);  -- uses index
SELECT id FROM users WHERE email = $1;               -- may not use index
                                                     -- (depends on collation)
```

Expression indexes are also useful for computed values:

```sql
-- Index the year component of a timestamp for year-based range queries
CREATE INDEX idx_events_year ON events (extract(year FROM occurred_at));

-- Find all events in 2024 efficiently
SELECT * FROM events WHERE extract(year FROM occurred_at) = 2024;
```

**Warning**: the expression in the query must exactly match the expression in the
index definition. `lower(email)` and `LOWER(email)` are the same, but
`extract(year FROM occurred_at)` and `date_part('year', occurred_at)` are different
function calls — only one will use the expression index.

---

## Covering Indexes: The INCLUDE Clause

An index normally stores only the indexed key columns, plus heap pointers. To
satisfy a query, PostgreSQL uses the index to find row locations, then fetches
the full row from the heap (table pages) to get non-indexed columns.

A covering index includes additional columns in the index leaf pages via `INCLUDE`.
When a query needs only those columns, PostgreSQL can satisfy the query entirely
from the index — no heap fetch. This is an "index-only scan."

```sql
-- Index on user_id, but also carry event_type and occurred_at in the leaves
CREATE INDEX idx_events_user_covering
ON events (user_id)
INCLUDE (event_type, occurred_at);
```

Now this query can be answered without touching the heap:

```sql
-- Index-only scan: gets user_id (key) + event_type + occurred_at (included)
SELECT event_type, occurred_at
FROM events
WHERE user_id = 5000
ORDER BY occurred_at DESC;
```

EXPLAIN output will show `Index Only Scan` instead of `Index Scan`. The difference
is that no heap pages are read — every needed value is in the index itself.

The trade-off: `INCLUDE` columns increase index size. The index must be updated
whenever those columns change. Include only columns that are frequently selected
together in queries that already filter on the key column.

---

## When Indexes Make Things Worse

The case for NOT indexing is just as real as the case for indexing.

### Low Cardinality Columns

Cardinality = number of distinct values. A `boolean` column has cardinality 2.
An `is_active` flag where 99% of rows are `true` has effective cardinality 1 for
most queries.

```sql
-- BAD index: status has 4 possible values, 'paid' is 80% of rows
CREATE INDEX idx_orders_status ON orders (status);

-- When querying for paid orders:
SELECT * FROM orders WHERE status = 'paid';
-- PostgreSQL may ignore this index entirely. Fetching 80% of the table
-- via random index lookups is slower than a sequential scan.
```

For low-cardinality columns where you do query a rare value:

```sql
-- GOOD: partial index on the rare value
CREATE INDEX idx_orders_cancelled ON orders (user_id)
WHERE status = 'cancelled';
-- Now this is efficient because 'cancelled' is rare, and the index is small.
```

### Write-Heavy Tables

Every index is maintained on every INSERT, UPDATE, and DELETE. Each index update
requires a B-tree insertion, which sometimes requires page splits and rebalancing.

For a table that receives 100,000 inserts per second, 10 indexes mean 1,000,000
B-tree insertions per second. This becomes a bottleneck. Monitor `pg_stat_user_indexes`
to see which indexes are rarely scanned — those are candidates for removal.

```sql
-- Find indexes that are rarely (or never) used
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan < 100
ORDER BY idx_scan;
```

---

## Index Bloat and VACUUM

PostgreSQL uses MVCC (Multi-Version Concurrency Control) for concurrency. When you
UPDATE a row, the old version is kept in the heap for transactions that might still
need it. This creates "dead tuples." Over time, dead tuples accumulate — both in
the heap and in indexes. Index pages full of dead tuple pointers are "index bloat."

### VACUUM

`VACUUM` reclaims space occupied by dead tuples, making it available for future
inserts. It does NOT, by default, return space to the OS — it just marks pages as
reusable within PostgreSQL.

`VACUUM FULL` reclaims space and returns it to the OS, but requires an exclusive
lock on the table. Use it only during maintenance windows.

```sql
-- Manual vacuum on a specific table:
VACUUM events;

-- With analysis (updates planner statistics):
VACUUM ANALYZE events;

-- Verbose output to see what it's doing:
VACUUM VERBOSE events;
```

### Autovacuum

You almost never need to run VACUUM manually. PostgreSQL's autovacuum daemon runs
automatically based on configurable thresholds.

```sql
-- Check autovacuum status for your tables:
SELECT
  relname,
  n_dead_tup,
  n_live_tup,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

When `n_dead_tup` is very high relative to `n_live_tup`, autovacuum hasn't run
recently enough (or is configured too conservatively). Signs of bloat: table size
growing without corresponding data growth, sequential scans slower than expected.

### REINDEX

If an index itself becomes bloated (many dead index entries), rebuild it:

```sql
-- Rebuild a specific index (takes a lock briefly):
REINDEX INDEX CONCURRENTLY idx_events_user_id;

-- Rebuild all indexes on a table:
REINDEX TABLE CONCURRENTLY events;
```

The `CONCURRENTLY` option builds the new index without holding a lock on the table.
It takes longer but doesn't block production reads and writes.

---

## NULL Handling in Indexes

NULLs are stored in B-tree indexes by default (at the "high" end of the sort order).
This means `IS NULL` and `IS NOT NULL` queries can use indexes.

```sql
-- Create index including NULLs (default):
CREATE INDEX idx_orders_shipped_at ON orders (shipped_at);

-- Both of these can use the index:
SELECT * FROM orders WHERE shipped_at IS NULL;        -- finds unshipped orders
SELECT * FROM orders WHERE shipped_at > '2024-01-01'; -- range scan
```

However, if you want to exclude NULL from the index (to make it smaller when NULL
is common), use a partial index:

```sql
-- Only index rows where shipped_at is not null
CREATE INDEX idx_orders_shipped_at_notnull ON orders (shipped_at)
WHERE shipped_at IS NOT NULL;

-- This query can use it:
SELECT * FROM orders WHERE shipped_at > '2024-01-01';

-- This query cannot (the index doesn't have NULL rows):
SELECT * FROM orders WHERE shipped_at IS NULL;
```

Unique indexes treat each NULL as distinct. This means `UNIQUE` on a nullable
column allows multiple NULL values:

```sql
CREATE TABLE items (
  id   serial PRIMARY KEY,
  sku  text UNIQUE  -- NULLs are allowed and don't violate the unique constraint
);

INSERT INTO items (sku) VALUES (NULL);
INSERT INTO items (sku) VALUES (NULL);  -- succeeds: two NULLs in a UNIQUE column
INSERT INTO items (sku) VALUES ('ABC');
INSERT INTO items (sku) VALUES ('ABC');  -- fails: duplicate non-NULL value
```

This is correct per SQL standard and intentional: NULL means "unknown," so two
unknown values are not necessarily the same value.

---

## A Complete Index Design Workflow

Here is the thought process for indexing a schema. Use this when designing or auditing.

**Step 1: List your queries.** Every index should serve at least one real query.
Don't index speculatively.

**Step 2: Identify the WHERE and JOIN conditions.** These columns are candidates
for index keys.

**Step 3: Identify ORDER BY and GROUP BY columns.** These benefit from indexes too
(sorted indexes avoid a sort step).

**Step 4: Check cardinality.** High cardinality columns (user_id, email, timestamp)
make good index keys. Low cardinality (boolean, status) usually don't.

**Step 5: Consider composite indexes.** If multiple columns consistently appear
together in queries, a single composite index is better than two separate ones.

**Step 6: Consider partial indexes.** If you always filter on a specific value
(e.g., `WHERE deleted_at IS NULL`), a partial index eliminates the common filter
from the key.

**Step 7: Run EXPLAIN ANALYZE before and after.** Don't assume the index helps.
Measure.

**Step 8: Monitor in production.** Use `pg_stat_user_indexes` to find unused indexes.
Remove them.

---

## Exercises

### Exercise 1: Index an Existing Schema

Given the `events` table from this lesson, and these common application queries:

```sql
-- Query A: All events for a user, newest first
SELECT id, event_type, occurred_at, metadata
FROM events
WHERE user_id = $1
ORDER BY occurred_at DESC
LIMIT 50;

-- Query B: Count of purchase events in the last 7 days
SELECT count(*) FROM events
WHERE event_type = 'purchase'
  AND occurred_at >= now() - interval '7 days';

-- Query C: Users who have more than 100 events
SELECT user_id, count(*) AS event_count
FROM events
GROUP BY user_id
HAVING count(*) > 100;
```

Design indexes for Query A and Query B. For each index:
1. Write the `CREATE INDEX` statement.
2. Explain which EXPLAIN ANALYZE node type you expect (Index Scan, Bitmap Scan, etc.)
3. Explain why you chose that column order (for composite indexes).

Query C is not indexable in a way that helps — explain why.

### Exercise 2: Read an EXPLAIN ANALYZE Plan

A developer shows you this EXPLAIN ANALYZE output and asks why the query is slow:

```
Seq Scan on orders  (cost=0.00..89234.00 rows=3 width=32)
                    (actual time=2341.234..2341.241 rows=3 loops=1)
  Filter: ((status = 'shipped') AND (user_id = 42))
  Rows Removed by Filter: 5000000
Planning Time: 0.312 ms
Execution Time: 2341.289 ms
```

Answer these questions:
1. What is happening in this query plan?
2. Why is PostgreSQL doing a sequential scan instead of an index scan?
3. What index (or indexes) would fix this?
4. After adding the index, what node type do you expect to see?

### Exercise 3: Partial Index Decision

You have a `notifications` table with 50 million rows:

```sql
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL,
  message    text        NOT NULL,
  is_read    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

95% of notifications have `is_read = true`. The most common query is:

```sql
SELECT id, message, created_at
FROM notifications
WHERE user_id = $1 AND is_read = false
ORDER BY created_at DESC;
```

1. Would a regular index on `(user_id, is_read)` be good or bad here? Explain.
2. Write a partial index that is better suited to this query pattern.
3. How much smaller is your partial index compared to a full index on `(user_id, is_read)`?
   (Express this as an approximation.)

### Exercise 4: Covering Index

Given this query that runs very frequently:

```sql
SELECT email, name, created_at
FROM users
WHERE country = 'US'
ORDER BY created_at DESC
LIMIT 100;
```

1. Create a basic index on `country` and show what the EXPLAIN plan would look like
   (describe it — you don't need a live database).
2. Create a covering index that enables an index-only scan for this query.
3. What is the trade-off of the covering index vs the basic index?

### Exercise 5: Diagnose Index Bloat

You're reviewing a production PostgreSQL instance and see this output from
`pg_stat_user_tables`:

```
relname       | n_dead_tup | n_live_tup | last_autovacuum
--------------+------------+------------+---------------------
user_sessions | 18,000,000 |  2,000,000 | 2024-01-01 03:00:00
```

Today's date is 2024-03-01.

1. What does `n_dead_tup = 18,000,000` tell you about this table?
2. Why might autovacuum be failing to keep up?
3. What immediate action would you take?
4. What longer-term changes to the autovacuum configuration might help?
   (Look up `autovacuum_vacuum_scale_factor` and `autovacuum_vacuum_threshold`.)
