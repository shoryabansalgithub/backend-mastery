# Lesson 2: SQL Fundamentals

## Why This Lesson Exists

SQL is the language of relational databases. You already understand the theory —
relations, tuples, relational algebra. Now you learn the practical tool that makes
that theory usable. But SQL is deceptive. The syntax is English-like enough that
beginners write queries that "work" while making fundamental mistakes: selecting
columns they don't need, triggering N+1 query patterns, writing JOINs without
understanding what they produce, using OFFSET for pagination on tables with millions
of rows.

This lesson builds your SQL from first principles. Every construct is explained not
just syntactically but semantically — what does the database actually do when you
write this? By the end, you'll be able to write complex multi-join queries, use
window functions to answer questions that GROUP BY can't, and read query structure
the way a chess player reads a board.

---

## The Schema We'll Use

Every example in this lesson uses the same schema. This is deliberate. Real SQL
proficiency comes from knowing your schema deeply and composing queries against it,
not from memorizing syntax in isolation.

```sql
-- Users of the platform
CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text    NOT NULL UNIQUE,
  name        text    NOT NULL,
  country     text    NOT NULL DEFAULT 'US',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Product catalog
CREATE TABLE products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text           NOT NULL,
  category    text           NOT NULL,
  price       numeric(10, 2) NOT NULL CHECK (price >= 0),
  stock       integer        NOT NULL DEFAULT 0,
  created_at  timestamptz    NOT NULL DEFAULT now()
);

-- Orders placed by users
CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id),
  status      text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Line items within an order (the junction table between orders and products)
CREATE TABLE order_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint         NOT NULL REFERENCES orders(id),
  product_id  bigint         NOT NULL REFERENCES products(id),
  quantity    integer        NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL CHECK (unit_price >= 0)
);
```

A few design notes before we continue:

- `unit_price` is stored on the line item, not pulled from the product at query time.
  Prices change. What the customer paid is a historical fact. Denormalizing it here
  is intentional and correct.
- `GENERATED ALWAYS AS IDENTITY` is the modern replacement for `serial`. It's SQL
  standard and prevents accidental overrides.
- `CHECK` constraints encode business rules at the database level. The database
  refuses a negative price — no application code required.

---

## SELECT and FROM: The Foundation

Every SQL query is a declaration of what you want. `SELECT` names the columns;
`FROM` names the source.

```sql
-- All columns from all rows
SELECT * FROM users;

-- Specific columns
SELECT id, email, name FROM users;

-- Computed columns
SELECT
  id,
  email,
  upper(name)                     AS name_upper,
  now() - created_at              AS account_age
FROM users;
```

**Never use `SELECT *` in application code.** Here is why:

1. You retrieve data you don't use, wasting network bandwidth and memory.
2. If a column is added to the table later (e.g., a large `jsonb` blob), your query
   silently starts fetching it.
3. Your query's meaning is opaque. A reader can't tell what data is actually needed.
4. Result set binding in your driver becomes fragile — column order matters.

`SELECT *` is fine in psql for exploration. It has no place in production queries.

### Column Aliases

```sql
SELECT
  u.id         AS user_id,
  u.name       AS user_name,
  u.created_at AS joined_at
FROM users u;
```

The `u` after `users` is a table alias. Use them. Long queries with repeated table
names are harder to read. Use single-letter aliases for common tables (u for users,
o for orders) and descriptive aliases for subqueries.

---

## WHERE: Filtering Rows

`WHERE` is selection in relational algebra — it filters which rows pass through.

```sql
-- Simple equality
SELECT id, email FROM users WHERE country = 'US';

-- Comparison operators: =, <>, !=, <, >, <=, >=
SELECT id, name, price FROM products WHERE price > 50.00;

-- Range
SELECT id, name, price FROM products WHERE price BETWEEN 10.00 AND 50.00;

-- Pattern matching: LIKE and ILIKE
SELECT id, email FROM users WHERE email LIKE '%@gmail.com';   -- case-sensitive
SELECT id, email FROM users WHERE email ILIKE '%@GMAIL.COM';  -- case-insensitive

-- IN: match any value in a list
SELECT id, name FROM products WHERE category IN ('Electronics', 'Books');

-- IS NULL / IS NOT NULL (never use = NULL -- it doesn't work)
SELECT id, name FROM products WHERE description IS NULL;

-- Combining conditions
SELECT id, email
FROM users
WHERE country = 'US'
  AND created_at > '2024-01-01'::timestamptz;
```

### NULL Is Not a Value

NULL in SQL means "unknown." This has a non-obvious consequence: any comparison
with NULL returns NULL (not true, not false), and NULL in a boolean context is
treated as false.

```sql
-- This returns NO rows even when name is NULL:
SELECT * FROM users WHERE name = NULL;    -- WRONG

-- Correct:
SELECT * FROM users WHERE name IS NULL;

-- NULL in expressions:
SELECT 5 + NULL;   -- result is NULL
SELECT NULL = NULL; -- result is NULL, not TRUE

-- In WHERE clauses, only rows where the condition is TRUE pass through.
-- A NULL condition means the row is excluded.
```

This catches many developers off guard. If you write `WHERE country <> 'US'`, users
whose `country` column is NULL are excluded from results, even though NULL ≠ 'US'
seems like it should be true.

---

## ORDER BY and LIMIT/OFFSET

```sql
-- Sort ascending (default)
SELECT id, name, price FROM products ORDER BY price;

-- Sort descending
SELECT id, name, price FROM products ORDER BY price DESC;

-- Multiple sort keys
SELECT id, name, category, price
FROM products
ORDER BY category ASC, price DESC;

-- LIMIT: return at most N rows
SELECT id, name, price FROM products ORDER BY price DESC LIMIT 10;

-- OFFSET: skip the first N rows
SELECT id, name, price
FROM products
ORDER BY price DESC
LIMIT 10 OFFSET 20;   -- "page 3" with page size 10
```

### The OFFSET Problem

OFFSET-based pagination is the intuitive approach, and it's wrong for large datasets.
Here is what PostgreSQL actually does when you write `LIMIT 10 OFFSET 10000`:

1. Scan and sort (or index-scan) through 10,010 rows.
2. Discard the first 10,000.
3. Return the last 10.

You're paying for 10,010 rows to get 10. At page 1,000 with page size 20, you're
discarding 19,980 rows on every request. The deeper the page, the slower the query.
This degrades linearly with offset size.

The solution is keyset pagination (also called cursor-based pagination). We'll cover
it in the project, but the intuition is: instead of "skip N rows," you say "give me
rows where id > last_seen_id." An index makes that instant regardless of how deep
you are.

---

## Aggregate Functions and GROUP BY

Aggregate functions collapse many rows into a single value.

```sql
-- COUNT: number of rows
SELECT count(*) FROM orders;
SELECT count(DISTINCT user_id) FROM orders;  -- distinct users who ordered

-- SUM, AVG, MIN, MAX
SELECT
  sum(quantity)               AS total_items_sold,
  avg(unit_price)             AS avg_item_price,
  min(unit_price)             AS cheapest_item,
  max(unit_price)             AS priciest_item
FROM order_items;
```

`GROUP BY` is where aggregates become powerful. It partitions rows into groups and
applies the aggregate to each group.

```sql
-- Orders per user
SELECT
  user_id,
  count(*)                 AS order_count,
  min(created_at)          AS first_order,
  max(created_at)          AS last_order
FROM orders
GROUP BY user_id
ORDER BY order_count DESC;
```

**The GROUP BY rule**: every column in SELECT must either appear in GROUP BY or be
wrapped in an aggregate function. This is not arbitrary. If you group by `user_id`
and try to select `email`, PostgreSQL doesn't know which email to show (even if
every row in the group has the same email — it doesn't know that without checking).

```sql
-- WRONG: email is neither in GROUP BY nor aggregated
SELECT user_id, email, count(*)
FROM orders
GROUP BY user_id;  -- Error: column "orders.email" must appear in the GROUP BY clause

-- RIGHT: join to get email after grouping
SELECT u.email, count(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.email
ORDER BY order_count DESC;
```

### HAVING: Filtering Groups

`WHERE` filters rows before grouping. `HAVING` filters groups after aggregation.

```sql
-- Users who have placed more than 5 orders
SELECT
  user_id,
  count(*) AS order_count
FROM orders
GROUP BY user_id
HAVING count(*) > 5
ORDER BY order_count DESC;

-- Categories where average price exceeds $100
SELECT
  category,
  avg(price)::numeric(10,2) AS avg_price,
  count(*)                   AS product_count
FROM products
GROUP BY category
HAVING avg(price) > 100
ORDER BY avg_price DESC;
```

You cannot use `WHERE` to filter on aggregated values. `WHERE price > avg(price)`
is meaningless — at the WHERE phase, the aggregate hasn't been computed yet.

---

## JOINs: Combining Tables

A JOIN combines rows from two or more tables based on a condition. Understanding
what each type of JOIN produces is non-negotiable.

### INNER JOIN

Returns only rows where the join condition matches in both tables. Rows with no
match in either table are excluded.

```sql
-- Every order with its user's information
SELECT
  o.id         AS order_id,
  u.email      AS user_email,
  o.status,
  o.created_at AS ordered_at
FROM orders o
INNER JOIN users u ON o.user_id = u.id;
-- Orders without a user_id would be excluded (impossible here due to FK constraint,
-- but conceptually: INNER JOIN excludes non-matching rows from both sides)
```

### LEFT JOIN (LEFT OUTER JOIN)

Returns all rows from the left table, plus matching rows from the right. If no
match exists in the right table, right-side columns are NULL.

```sql
-- All users, with their order count (including users who have never ordered)
SELECT
  u.id,
  u.email,
  count(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.email
ORDER BY order_count DESC;
```

Users with no orders have `count(o.id) = 0` — because `count(column)` counts
non-NULL values, and `o.id` is NULL when there's no matching order.

The critical distinction: `count(*)` vs `count(o.id)` in a LEFT JOIN context.
`count(*)` counts rows (including the NULL row), so a user with no orders would
show `1` instead of `0`. Always count the nullable side's column.

### RIGHT JOIN

Mirror image of LEFT JOIN — all rows from the right table, plus matching left rows.
In practice, right joins are rare. Any RIGHT JOIN can be rewritten as a LEFT JOIN
by swapping the table order, which reads more naturally.

### FULL OUTER JOIN

All rows from both tables. Where a match exists, columns are populated. Where no
match exists, the non-matching side is NULL.

```sql
-- Find any data consistency issues: orders without users, or users without orders
SELECT
  u.id   AS user_id,
  o.id   AS order_id
FROM users u
FULL OUTER JOIN orders o ON u.id = o.user_id
WHERE u.id IS NULL OR o.id IS NULL;
-- This should return no rows with a proper foreign key constraint,
-- but it's a useful diagnostic pattern.
```

### Multi-Table JOINs

Real queries join three, four, five tables. Build them incrementally.

```sql
-- Step 1: orders with users
SELECT o.id, u.email, o.status
FROM orders o
JOIN users u ON o.user_id = u.id;

-- Step 2: add order_items
SELECT o.id, u.email, o.status, oi.quantity, oi.unit_price
FROM orders o
JOIN users u ON o.user_id = u.id
JOIN order_items oi ON oi.order_id = o.id;

-- Step 3: add products
SELECT
  o.id            AS order_id,
  u.email         AS customer,
  o.status,
  p.name          AS product_name,
  oi.quantity,
  oi.unit_price,
  (oi.quantity * oi.unit_price) AS line_total
FROM orders o
JOIN users u        ON o.user_id    = u.id
JOIN order_items oi ON oi.order_id  = o.id
JOIN products p     ON oi.product_id = p.id
WHERE o.status = 'paid'
ORDER BY o.id, p.name;
```

Each `JOIN` adds one new table. The `ON` clause specifies how rows match. The
result is a flat table where each row is a combination of user + order + line item
+ product. An order with 3 items produces 3 rows.

### Join Direction Matters for LEFT JOIN

The order of tables in a LEFT JOIN determines which side keeps all rows.

```sql
-- LEFT: all users, even those without orders
SELECT u.email, o.id AS order_id
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;

-- RIGHT (equivalent but reversed): same result
SELECT u.email, o.id AS order_id
FROM orders o
RIGHT JOIN users u ON u.id = o.user_id;

-- COMMON MISTAKE: putting the "must keep all" table on the wrong side
SELECT u.email, o.id AS order_id
FROM orders o
LEFT JOIN users u ON u.id = o.user_id;
-- This keeps all orders (even those without users), not all users.
```

---

## Subqueries

A subquery is a query inside another query. They can appear in the FROM clause
(as a derived table), in the WHERE clause (as a filter), or in the SELECT list
(as a scalar subquery).

```sql
-- Subquery in WHERE: users who have placed at least one paid order
SELECT id, email
FROM users
WHERE id IN (
  SELECT DISTINCT user_id
  FROM orders
  WHERE status = 'paid'
);

-- Equivalent with EXISTS (often more efficient for large result sets):
SELECT id, email
FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.user_id = u.id AND o.status = 'paid'
);

-- Subquery in FROM: average order value per user
SELECT
  u.email,
  user_stats.avg_order_value
FROM users u
JOIN (
  SELECT
    o.user_id,
    avg(oi.quantity * oi.unit_price) AS avg_order_value
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  GROUP BY o.user_id
) AS user_stats ON user_stats.user_id = u.id;

-- Scalar subquery in SELECT: latest order date per user
SELECT
  u.email,
  (
    SELECT max(created_at)
    FROM orders o
    WHERE o.user_id = u.id
  ) AS last_order_date
FROM users u;
-- Warning: this executes the subquery once per user row. For large tables,
-- use a JOIN or LEFT JOIN instead.
```

Scalar subqueries in SELECT (the last example) are a common source of performance
problems. They're an N+1 in raw SQL — if `users` has 10,000 rows, you're running
10,000 separate subqueries. Use a lateral join or aggregate join instead.

---

## CTEs: Common Table Expressions

A CTE (WITH clause) is a named subquery that you can reference multiple times in
the same query. It improves readability and avoids repeated subexpressions.

```sql
-- Simple CTE: paid orders with their totals
WITH paid_orders AS (
  SELECT
    o.id         AS order_id,
    o.user_id,
    o.created_at,
    sum(oi.quantity * oi.unit_price) AS total
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status = 'paid'
  GROUP BY o.id, o.user_id, o.created_at
)
SELECT
  u.email,
  po.order_id,
  po.total,
  po.created_at
FROM paid_orders po
JOIN users u ON u.id = po.user_id
ORDER BY po.total DESC;
```

CTEs are not materialized by default in PostgreSQL 12+. The planner decides whether
to inline the CTE or evaluate it once. If you need guaranteed materialization (to
prevent double execution of a CTE with side effects), use `WITH ... AS MATERIALIZED`.

### Chained CTEs

Multiple CTEs can reference each other:

```sql
WITH
-- Step 1: compute revenue per order
order_revenue AS (
  SELECT
    order_id,
    sum(quantity * unit_price) AS revenue
  FROM order_items
  GROUP BY order_id
),
-- Step 2: join to orders, compute per-user totals
user_revenue AS (
  SELECT
    o.user_id,
    sum(r.revenue)   AS total_revenue,
    count(o.id)      AS order_count,
    avg(r.revenue)   AS avg_order_value
  FROM orders o
  JOIN order_revenue r ON r.order_id = o.id
  WHERE o.status = 'paid'
  GROUP BY o.user_id
),
-- Step 3: rank users by revenue
ranked_users AS (
  SELECT
    user_id,
    total_revenue,
    order_count,
    avg_order_value,
    rank() OVER (ORDER BY total_revenue DESC) AS revenue_rank
  FROM user_revenue
)
SELECT
  u.email,
  ru.total_revenue,
  ru.order_count,
  ru.avg_order_value::numeric(10,2),
  ru.revenue_rank
FROM ranked_users ru
JOIN users u ON u.id = ru.user_id
WHERE ru.revenue_rank <= 10   -- top 10 customers
ORDER BY ru.revenue_rank;
```

Read this query from top to bottom. Each CTE builds on the previous. The final
SELECT is clean and readable because all the complexity is named. This is the right
way to build complex analytical queries.

---

## Window Functions

Window functions are the most powerful feature in SQL that most developers underuse.
Unlike GROUP BY, window functions compute aggregates over a set of rows without
collapsing the result to one row per group. You get the aggregate value alongside
each individual row.

```sql
-- For every order, see the user's total order count alongside each order
SELECT
  o.id,
  o.user_id,
  o.created_at,
  count(*) OVER (PARTITION BY o.user_id) AS user_total_orders
FROM orders o;

-- Result:
-- id  | user_id | created_at          | user_total_orders
-- ----+---------+---------------------+------------------
-- 1   | 5       | 2024-01-10 ...      | 3
-- 7   | 5       | 2024-02-14 ...      | 3
-- 12  | 5       | 2024-03-01 ...      | 3
-- 2   | 9       | 2024-01-15 ...      | 1
```

The structure is: `aggregate OVER (PARTITION BY ... ORDER BY ... ROWS/RANGE ...)`.

- `PARTITION BY`: the grouping (like GROUP BY, but rows aren't collapsed)
- `ORDER BY`: defines row order within the partition for order-sensitive functions
- `ROWS/RANGE`: the frame — which rows around the current row to include

### ROW_NUMBER, RANK, DENSE_RANK

These assign a number to each row within its partition.

```sql
SELECT
  p.id,
  p.name,
  p.category,
  p.price,
  row_number()   OVER (PARTITION BY p.category ORDER BY p.price DESC) AS rn,
  rank()         OVER (PARTITION BY p.category ORDER BY p.price DESC) AS rnk,
  dense_rank()   OVER (PARTITION BY p.category ORDER BY p.price DESC) AS dense_rnk
FROM products p;
```

The difference matters when there are ties:
- `row_number()`: always unique (1, 2, 3, 4...)
- `rank()`: ties get the same number, next rank skips (1, 1, 3, 4...)
- `dense_rank()`: ties get the same number, no skips (1, 1, 2, 3...)

**Practical use**: get the top product per category.

```sql
WITH ranked_products AS (
  SELECT
    id, name, category, price,
    row_number() OVER (PARTITION BY category ORDER BY price DESC) AS rn
  FROM products
)
SELECT id, name, category, price
FROM ranked_products
WHERE rn = 1;
```

This pattern — window function in a CTE, filter on rank in the outer query — is one
of the most useful in analytical SQL.

### Running Totals with SUM OVER

```sql
SELECT
  o.id,
  o.created_at,
  oi_totals.order_total,
  sum(oi_totals.order_total) OVER (
    PARTITION BY o.user_id
    ORDER BY o.created_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS cumulative_spend
FROM orders o
JOIN (
  SELECT order_id, sum(quantity * unit_price) AS order_total
  FROM order_items
  GROUP BY order_id
) oi_totals ON oi_totals.order_id = o.id
ORDER BY o.user_id, o.created_at;
```

`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` is the frame definition: start
from the very first row in the partition, up to and including the current row.
This produces a running sum.

### LAG and LEAD: Looking at Adjacent Rows

```sql
-- For each order, show days since the user's previous order
SELECT
  o.id,
  o.user_id,
  o.created_at,
  lag(o.created_at) OVER (
    PARTITION BY o.user_id
    ORDER BY o.created_at
  ) AS previous_order_date,
  extract(day from o.created_at - lag(o.created_at) OVER (
    PARTITION BY o.user_id
    ORDER BY o.created_at
  )) AS days_since_last_order
FROM orders o
ORDER BY o.user_id, o.created_at;
```

`lag(expr)` returns the value of `expr` from the previous row in the window.
`lead(expr)` returns the value from the next row. Both accept a second argument
for the offset (default 1) and a third for the default when no row exists.

```sql
lag(o.created_at, 1, '2000-01-01'::timestamptz)
--                ^   ^
--                |   default if no previous row
--                offset (1 = one row back)
```

---

## Building Queries in Layers

Here is a complex business question: "Show me the top 5 users by total spend in
the last 90 days, with their order count, average order value, and the name of
their most-purchased product category."

Don't try to write this in one shot. Build it in layers.

```sql
-- Layer 1: order line totals for the last 90 days
WITH recent_order_items AS (
  SELECT
    o.user_id,
    o.id                               AS order_id,
    oi.product_id,
    oi.quantity * oi.unit_price        AS line_revenue
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status = 'paid'
    AND o.created_at >= now() - interval '90 days'
),
-- Layer 2: per-user order stats
user_stats AS (
  SELECT
    user_id,
    count(DISTINCT order_id)  AS order_count,
    sum(line_revenue)         AS total_spend,
    avg(line_revenue)         AS avg_line_value
  FROM recent_order_items
  GROUP BY user_id
),
-- Layer 3: per-user, per-category spend (to find favorite category)
user_category_spend AS (
  SELECT
    r.user_id,
    p.category,
    sum(r.line_revenue) AS category_spend
  FROM recent_order_items r
  JOIN products p ON p.id = r.product_id
  GROUP BY r.user_id, p.category
),
-- Layer 4: rank categories within each user
user_top_category AS (
  SELECT
    user_id,
    category,
    row_number() OVER (PARTITION BY user_id ORDER BY category_spend DESC) AS rn
  FROM user_category_spend
)
-- Final: assemble
SELECT
  u.email,
  us.order_count,
  us.total_spend::numeric(10,2),
  (us.total_spend / us.order_count)::numeric(10,2) AS avg_order_value,
  utc.category AS favorite_category
FROM user_stats us
JOIN users u ON u.id = us.user_id
JOIN user_top_category utc ON utc.user_id = us.user_id AND utc.rn = 1
ORDER BY us.total_spend DESC
LIMIT 5;
```

This query is 55 lines but every layer is independently readable. The CTEs give
names to intermediate results. No single step is incomprehensible.

---

## Reading EXPLAIN Output

Before you run a query on a large table, `EXPLAIN` shows you the query plan
PostgreSQL intends to execute.

```sql
EXPLAIN SELECT u.email, count(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.email
ORDER BY order_count DESC;
```

Output:
```
Sort  (cost=45.25..45.75 rows=200 width=40)
  Sort Key: (count(o.id)) DESC
  ->  HashAggregate  (cost=35.00..37.00 rows=200 width=40)
        Group Key: u.id
        ->  Hash Left Join  (cost=11.50..30.00 rows=1000 width=16)
              Hash Cond: (o.user_id = u.id)
              ->  Seq Scan on orders o  (cost=0.00..16.00 rows=1000 width=16)
              ->  Hash  (cost=9.00..9.00 rows=200 width=16)
                    ->  Seq Scan on users u  (cost=0.00..9.00 rows=200 width=16)
```

Read the plan from the innermost (most indented) steps outward:

1. Two sequential scans: scan all of `users`, scan all of `orders`.
2. Hash the users table.
3. Hash Left Join: for each order, probe the hash to find its user.
4. HashAggregate: group by user id, compute count.
5. Sort: sort the aggregated results.

The `cost=X..Y` values are arbitrary units. `X` is startup cost (before first row
is returned), `Y` is total cost. Higher is slower. PostgreSQL's cost estimates are
based on table statistics — they're estimates, not guarantees.

`EXPLAIN ANALYZE` actually runs the query and shows real timings:

```sql
EXPLAIN ANALYZE SELECT u.email, count(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.email
ORDER BY order_count DESC;
```

Output:
```
Sort  (cost=45.25..45.75 rows=200 width=40)
      (actual time=2.341..2.356 rows=200 loops=1)
  Sort Key: (count(o.id)) DESC
  Sort Method: quicksort  Memory: 36kB
  ->  HashAggregate  (cost=35.00..37.00 rows=200 width=40)
                     (actual time=2.150..2.210 rows=200 loops=1)
        Group Key: u.id
        Batches: 1  Memory Usage: 56kB
        ->  Hash Left Join  (cost=11.50..30.00 rows=1000 width=16)
                            (actual time=0.487..1.742 rows=1000 loops=1)
              Hash Cond: (o.user_id = u.id)
              ->  Seq Scan on orders o  (cost=0.00..16.00 rows=1000 width=16)
                                        (actual time=0.025..0.392 rows=1000 loops=1)
              ->  Hash  (cost=9.00..9.00 rows=200 width=16)
                        (actual time=0.382..0.383 rows=200 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 17kB
                    ->  Seq Scan on users u  (cost=0.00..9.00 rows=200 width=16)
                                             (actual time=0.014..0.190 rows=200 loops=1)
Planning Time: 0.418 ms
Execution Time: 2.431 ms
```

Now you see actual row counts and times. If `actual rows` differs dramatically from
`rows` (the estimate), PostgreSQL's statistics are stale — run `ANALYZE tablename`
to refresh them.

We'll cover EXPLAIN ANALYZE in depth in Lesson 3. For now, get comfortable reading
the node tree and knowing that the most indented operations happen first.

---

## Common Mistakes

### Mistake 1: The N+1 Pattern in Raw SQL

N+1 is typically discussed in ORM contexts, but it appears in raw SQL too. The
scalar subquery pattern is the most common form:

```sql
-- BAD: runs a subquery for every single user row
SELECT
  u.email,
  (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
  (SELECT max(o.created_at) FROM orders o WHERE o.user_id = u.id) AS last_order
FROM users u;

-- If there are 10,000 users, this runs 20,000 subqueries.

-- GOOD: one join, one pass
SELECT
  u.email,
  count(o.id)       AS order_count,
  max(o.created_at) AS last_order
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.email;
```

### Mistake 2: Selecting Columns You Don't Need

```sql
-- BAD: fetches everything, uses 2 columns
SELECT * FROM orders WHERE user_id = $1;

-- GOOD: fetch only what you need
SELECT id, status, created_at FROM orders WHERE user_id = $1;
```

With indexes, PostgreSQL can sometimes satisfy a query entirely from the index
without touching the main table ("covering index" / index-only scan). If you
SELECT *, that's impossible — you're forcing a table heap fetch.

### Mistake 3: Forgetting That GROUP BY Changes Granularity

A common confusion: after GROUP BY, each row represents a group, not a record.
Any column that isn't in GROUP BY must be aggregated.

```sql
-- This intends to show one row per user with their latest order,
-- but it's wrong because PostgreSQL doesn't know which order.id to show:
SELECT u.email, o.id AS latest_order_id, max(o.created_at) AS latest_order
FROM users u
JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.email;
-- Error: column "o.id" must appear in the GROUP BY clause

-- Correct approach: window function or subquery
SELECT DISTINCT ON (u.id)
  u.email,
  o.id         AS latest_order_id,
  o.created_at AS latest_order
FROM users u
JOIN orders o ON o.user_id = u.id
ORDER BY u.id, o.created_at DESC;
```

`SELECT DISTINCT ON` is a PostgreSQL extension that returns one row per unique
value of the specified columns, keeping the first row in the given ORDER BY.

### Mistake 4: Using OFFSET for Deep Pagination

Covered above, but worth repeating: OFFSET reads and discards N rows on every
query. For pagination beyond page 2 or 3, use keyset pagination.

---

## Exercises

### Exercise 1: Basic Aggregation

Using the schema above, write a query that shows:
- Each product category
- Number of products in the category
- Average price in the category
- Most expensive product name in the category

Order by average price descending. Your result should have one row per category.

Hint: to get the most expensive product name, you'll need a subquery or window
function — a plain aggregate can't return the name of the max-price product without
extra work.

### Exercise 2: Multi-Join Query

Write a query that returns, for each user who has placed at least one paid order:
- User email
- Total amount spent (sum of quantity × unit_price across all paid orders)
- Number of distinct products purchased
- Number of paid orders

Order by total amount spent descending. Users who have never ordered should not appear.

### Exercise 3: Window Function Analysis

For each order, compute:
- Order ID
- User email
- Order total (sum of line items)
- That user's running total (cumulative spend up to and including this order, ordered by order date)
- Which order number this is for the user (1st, 2nd, 3rd...)

Order the result by user_id, then order creation date.

### Exercise 4: CTE Refactor

You're given this messy query:

```sql
SELECT u.email, subq.order_count, subq.total_spend
FROM users u
JOIN (
  SELECT o.user_id, count(o.id) as order_count, sum(sub2.total) as total_spend
  FROM orders o
  JOIN (
    SELECT order_id, sum(quantity * unit_price) as total
    FROM order_items
    GROUP BY order_id
  ) sub2 ON sub2.order_id = o.id
  WHERE o.status = 'paid'
  GROUP BY o.user_id
) subq ON subq.user_id = u.id
WHERE subq.order_count >= 3
ORDER BY subq.total_spend DESC;
```

Rewrite it using CTEs to make it readable. The logic must remain identical.

### Exercise 5: Diagnose and Fix

A colleague writes this query to find the "top product" (by quantity sold) in each
category:

```sql
SELECT p.category, p.name, sum(oi.quantity) AS total_sold
FROM products p
JOIN order_items oi ON oi.product_id = p.id
GROUP BY p.category, p.name
ORDER BY p.category, total_sold DESC;
```

This returns multiple rows per category instead of one. The developer wants one
row per category showing the best-selling product. Fix the query. Explain why the
original doesn't work and what your fix does differently.
