# Lesson 1: Relational Theory

## Why This Lesson Exists

Before you write a single SQL query, you need to understand **why** relational databases
exist and what problem they solved. Too many developers treat databases as dumb storage
bins -- throw data in, pull data out. That's like using a Ferrari to haul groceries.

Relational databases encode decades of mathematical theory about how to organize, query,
and protect data. Understanding that theory makes you dangerous. You'll know **why** certain
designs fail, **why** certain queries are slow, and **why** PostgreSQL does things the way
it does.

---

## A Brief History: How We Got Here

### The Dark Ages: Flat Files (1950s-1960s)

Imagine storing all your application data in text files. Each program reads the file,
parses it, and writes it back. Two programs running simultaneously? Data corruption.
Change the format? Rewrite every program.

This was real life for early programmers.

```
// Imagine this is your "database" -- a flat file
EMPLOYEE|001|John Smith|Engineering|75000
EMPLOYEE|002|Jane Doe|Marketing|82000
EMPLOYEE|003|Bob Wilson|Engineering|71000
```

Problems:
- No standard way to query data
- Every application reimplements parsing
- No protection against concurrent writes
- Changing the structure breaks everything

### Hierarchical Databases (1960s): IBM's IMS

IBM built IMS (Information Management System) for the Apollo moon program. Data was
organized as trees -- parent-child relationships.

```
                    Company
                   /       \
           Engineering    Marketing
           /    |    \        |
        John  Bob  Alice    Jane
```

This worked great for data that IS a tree. But what if an employee works in two
departments? What if you need to query "all employees earning over $80,000" regardless
of department? You'd have to walk every branch of every tree.

**The fundamental problem**: real-world data isn't a tree.

### Network Databases (1960s-1970s): CODASYL

The fix for hierarchical databases was to allow nodes to have multiple parents. Now you
had a graph (network) of records connected by pointers.

```
    Engineering -----> John <----- Project Alpha
         |                              |
         +----------> Bob <-------------+
         |
         +----------> Alice <---- Project Beta
```

Better! But:
- Programmers had to navigate the graph manually (follow this pointer, then that one)
- Adding a new relationship meant restructuring the physical storage
- Queries were procedural: "start at record X, follow link Y, collect records"

This is like giving someone directions by saying "turn left at the oak tree, go past the
red barn, turn right at the creek." It works, but only if you already know the landmarks.

### The Revolution: Edgar Codd and the Relational Model (1970)

In 1970, Edgar F. Codd, a mathematician at IBM, published "A Relational Model of Data
for Large Shared Data Banks." His insight was radical:

**Separate the logical organization of data from its physical storage.**

Instead of navigating pointers, you describe WHAT data you want, and the system figures
out HOW to get it. Data is organized into relations (tables) of tuples (rows) with
attributes (columns).

```
employees
+---------+-----------+---------------+--------+
| id      | name      | department_id | salary |
+---------+-----------+---------------+--------+
| 1       | John      | 10            | 75000  |
| 2       | Jane      | 20            | 82000  |
| 3       | Bob       | 10            | 71000  |
+---------+-----------+---------------+--------+

departments
+----+---------------+
| id | name          |
+----+---------------+
| 10 | Engineering   |
| 20 | Marketing     |
+----+---------------+
```

Want all employees in Engineering earning over $70,000?

```sql
SELECT e.name, e.salary
FROM employees e
JOIN departments d ON e.department_id = d.id
WHERE d.name = 'Engineering' AND e.salary > 70000;
```

You didn't say HOW to find them. You said WHAT you want. The database figures out the
optimal path. This is the **declarative** revolution.

### Why Relational Won

1. **Mathematical foundation**: Built on set theory and predicate logic. Not ad hoc.
2. **Data independence**: Change the physical storage without changing queries.
3. **Declarative queries**: Say what you want, not how to get it.
4. **Consistency guarantees**: ACID transactions (we'll cover these in Lesson 5).
5. **Ad hoc queries**: Ask questions you didn't plan for when designing the schema.

That last point is huge. With hierarchical/network databases, if you hadn't planned for
a query, you might need to restructure your entire database. With relational databases,
any combination of tables can be joined -- even ones the original designer never imagined.

---

## Relational Algebra: The Math Behind SQL

SQL is syntactic sugar over relational algebra. Understanding the algebra helps you
understand why SQL works the way it does.

A **relation** is a set of tuples (rows). Each tuple has the same set of named
attributes (columns). Let's define a tiny relation:

```
Students = {
  (id: 1, name: "Alice", major: "CS"),
  (id: 2, name: "Bob",   major: "Math"),
  (id: 3, name: "Carol", major: "CS"),
  (id: 4, name: "Dave",  major: "Physics")
}
```

### Selection (sigma): Filter Rows

Selection picks tuples that satisfy a condition. Think of it as a horizontal slice.

```
sigma_{major = "CS"}(Students) = {
  (id: 1, name: "Alice", major: "CS"),
  (id: 3, name: "Carol", major: "CS")
}
```

In SQL: `SELECT * FROM students WHERE major = 'CS';`

### Projection (pi): Pick Columns

Projection picks certain attributes. Think of it as a vertical slice.

```
pi_{name, major}(Students) = {
  (name: "Alice", major: "CS"),
  (name: "Bob",   major: "Math"),
  (name: "Carol", major: "CS"),
  (name: "Dave",  major: "Physics")
}
```

In SQL: `SELECT name, major FROM students;`

Note: in pure relational algebra, projection eliminates duplicates (it's a SET). SQL
does NOT eliminate duplicates by default -- you need `SELECT DISTINCT`.

### Cartesian Product (x): Every Combination

Given two relations, the Cartesian product pairs every tuple from one with every tuple
from the other.

```
Colors = {(c: "red"), (c: "blue")}
Sizes  = {(s: "S"), (s: "L")}

Colors x Sizes = {
  (c: "red",  s: "S"),
  (c: "red",  s: "L"),
  (c: "blue", s: "S"),
  (c: "blue", s: "L")
}
```

If Colors has N rows and Sizes has M rows, the product has N * M rows. This gets
enormous fast, which is why you almost never want a Cartesian product in practice.

In SQL: `SELECT * FROM colors CROSS JOIN sizes;`

### Join: Cartesian Product + Filter

A join is a Cartesian product followed by a selection. This is the most important
operation in relational databases.

```
Students = {
  (id: 1, name: "Alice", dept_id: 10),
  (id: 2, name: "Bob",   dept_id: 20)
}

Departments = {
  (id: 10, dept_name: "CS"),
  (id: 20, dept_name: "Math")
}

Students JOIN Departments ON Students.dept_id = Departments.id = {
  (id: 1, name: "Alice", dept_id: 10, id: 10, dept_name: "CS"),
  (id: 2, name: "Bob",   dept_id: 20, id: 20, dept_name: "Math")
}
```

In SQL:
```sql
SELECT s.name, d.dept_name
FROM students s
JOIN departments d ON s.dept_id = d.id;
```

### Union, Intersection, Difference: Set Operations

These work like set operations from math class, but both relations must have the
same attributes (same column types).

```
CS_Students   = {(name: "Alice"), (name: "Carol")}
Math_Students = {(name: "Bob"), (name: "Carol")}

-- Union: everyone in either set
CS_Students UNION Math_Students = {(name: "Alice"), (name: "Bob"), (name: "Carol")}

-- Intersection: people in both sets
CS_Students INTERSECT Math_Students = {(name: "Carol")}

-- Difference: people in first but not second
CS_Students EXCEPT Math_Students = {(name: "Alice")}
```

In SQL: `UNION`, `INTERSECT`, `EXCEPT` (we'll use these in Lesson 2).

---

## Sets and Tuples: The Foundation

### What's a Tuple?

A tuple is an ordered collection of values. In database terms, it's a row.

```
-- This is a tuple:
(1, "Alice", "CS", 3.8)

-- It corresponds to a row in a table:
-- (id, name, major, gpa)
```

Key property: a tuple has a fixed number of elements, each of a defined type. You can't
have a tuple where the second element is sometimes a string and sometimes a number (at
least not in proper relational theory).

### What's a Set?

A set is an unordered collection of unique elements. This is crucial:

1. **Unordered**: A relation has no inherent row order. When you `SELECT * FROM users`,
   the database can return rows in any order unless you specify `ORDER BY`. Don't depend
   on insertion order!

2. **Unique**: In pure relational theory, no two tuples in a relation are identical. This
   is why primary keys exist -- they guarantee uniqueness. SQL tables technically allow
   duplicate rows (unless you add constraints), which is a deviation from the theory.

### Thought Experiment: Why Uniqueness Matters

Imagine a table with no primary key:

```
purchases
+-------+--------+
| user  | item   |
+-------+--------+
| Alice | Book   |
| Alice | Book   |  <-- Is this a duplicate? Or did Alice buy two books?
+-------+--------+
```

Without a unique identifier, you can't distinguish between "Alice accidentally inserted
twice" and "Alice legitimately bought two books." This is why every table should have a
primary key.

---

## Edgar Codd's 12 Rules (Really 13, Numbered 0-12)

In 1985, Codd published 12 rules (plus a foundation rule, Rule 0) that a database must
satisfy to be considered "fully relational." No database perfectly satisfies all of them,
but they're aspirational guidelines. Here are the most important ones:

### Rule 0: Foundation Rule
The system must use its relational facilities exclusively to manage the database.

### Rule 1: Information Rule
All information must be represented as values in tables. Not hidden in metadata, not
in special system structures. Tables all the way down.

### Rule 2: Guaranteed Access Rule
Every datum must be accessible by a combination of table name, primary key value, and
column name. No ambiguity.

### Rule 3: Systematic Treatment of Null
The system must support a representation for "missing" or "inapplicable" data (NULL),
distinct from any regular value, and it must be handled consistently.

### Rule 4: Active Online Catalog
The database's structure (metadata) must itself be stored in tables that can be queried
with the same language used for data. In PostgreSQL, this is the `information_schema`
and `pg_catalog`.

```sql
-- Query the database about itself!
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public';
```

### Rule 5: Comprehensive Data Sublanguage
There must be at least one language that supports data definition, manipulation,
integrity constraints, authorization, and transactions. SQL is that language.

### Rule 6: View Updating Rule
All views that are theoretically updatable must be updatable by the system.

### Rule 7: High-Level Insert, Update, Delete
The system must support set-at-a-time operations. You should be able to INSERT, UPDATE,
or DELETE multiple rows in a single operation, not just one at a time.

### Rule 8: Physical Data Independence
Changes to physical storage (adding an index, moving to SSD, partitioning) must not
require changes to applications.

### Rule 9: Logical Data Independence
Changes to the logical schema (splitting a table, adding a column) should not require
changes to applications (to the extent possible).

### Rules 10-12
Integrity independence (constraints in the catalog, not in applications), distribution
independence (the database could be distributed without app changes), and the
non-subversion rule (you can't bypass integrity constraints via a low-level interface).

The rules you'll feel most in practice: **Rule 1** (it's all tables), **Rule 2**
(primary keys matter), **Rule 3** (NULLs are tricky), and **Rule 8** (physical
independence means you can add indexes without changing code).

---

## Why PostgreSQL Specifically

### The Database Landscape

| Feature | PostgreSQL | MySQL | SQLite |
|---------|-----------|-------|--------|
| ACID compliant | Yes | Depends on engine | Yes |
| JSON support | Excellent (jsonb) | Basic | Basic |
| Full-text search | Built-in | Basic | Extension |
| Custom types | Yes | No | No |
| Arrays | Yes | No | No |
| CTEs (WITH) | Full (recursive) | Since 8.0 | Yes |
| Window functions | Full | Since 8.0 | Since 3.25 |
| Concurrency | MVCC | Depends on engine | File-level locks |
| Extensions | Rich ecosystem | Limited | Limited |
| Licensing | True open source (PostgreSQL License) | Oracle-owned (dual license) | Public domain |

### Why Not MySQL?

MySQL has historically been "fast for simple queries." It was the "M" in LAMP stack and
powered early web apps. But:

- MySQL's default storage engine (InnoDB) only recently got features Postgres had for
  years (CTEs, window functions, proper JSON support).
- MySQL has surprising gotchas: silent data truncation, implicit type conversions,
  `GROUP BY` behavior that violates the SQL standard.
- Oracle's ownership creates licensing uncertainty.

MySQL is fine. Millions of apps run on it. But PostgreSQL gives you more power and fewer
surprises.

### Why Not SQLite?

SQLite is brilliant for its use case: embedded databases, mobile apps, testing,
single-writer scenarios. But:

- Single writer at a time (file-level locking)
- No built-in network access (it's a library, not a server)
- Limited data types (everything is basically text, integer, real, or blob)
- No user management or access control

SQLite is perfect when you need a local database. For a backend serving concurrent
requests, you need PostgreSQL.

### What Makes PostgreSQL Special

1. **Extensibility**: PostGIS for geospatial, pg_trgm for fuzzy search, pgvector for
   embeddings. The extension ecosystem is extraordinary.

2. **Standards compliance**: PostgreSQL follows the SQL standard more closely than any
   other open-source database. What you learn in Postgres transfers.

3. **MVCC (Multi-Version Concurrency Control)**: Readers never block writers and writers
   never block readers. This is why Postgres handles concurrent workloads so well.

4. **Advanced types**: Arrays, hstore, jsonb, range types, composite types, enums.
   You can model complex data without leaving the relational paradigm.

5. **Reliability**: PostgreSQL is famous for not losing your data. The development
   community is conservative about correctness -- they'd rather be slow and right than
   fast and wrong.

6. **The community**: PostgreSQL is developed by a global community, not a corporation.
   No single company can change the license, remove features, or gate functionality
   behind a paid tier.

---

## Data Types in PostgreSQL

Choosing the right data type matters. It affects storage size, query performance, and
what operations you can perform.

### Numeric Types

```sql
-- Small integer: -32768 to 32767 (2 bytes)
smallint

-- Standard integer: -2147483648 to 2147483647 (4 bytes)
integer  -- or: int, int4

-- Large integer: -9223372036854775808 to 9223372036854775807 (8 bytes)
bigint  -- or: int8

-- Exact decimal (use for money!): user-defined precision
numeric(10, 2)  -- 10 digits total, 2 after decimal
decimal(10, 2)  -- same as numeric

-- Floating point (use for science, NOT money): approximate
real       -- 4 bytes, 6 decimal digits precision
double precision  -- 8 bytes, 15 decimal digits precision

-- Auto-incrementing (legacy approach -- prefer GENERATED ALWAYS AS IDENTITY)
serial     -- integer + sequence
bigserial  -- bigint + sequence
```

**Why not use `real` or `double precision` for money?**

```sql
-- Floating point surprise:
SELECT 0.1::real + 0.2::real;
-- Result: 0.30000001192092896

-- Use numeric instead:
SELECT 0.1::numeric + 0.2::numeric;
-- Result: 0.3
```

Floating point numbers are approximations. For anything where exact decimal values
matter (money, financial calculations), use `numeric`.

### Text Types

```sql
-- Variable-length with limit
varchar(255)  -- or: character varying(255)

-- Variable-length, no limit
text  -- use this most of the time!

-- Fixed-length, padded with spaces
char(10)  -- or: character(10)  -- rarely useful
```

**Just use `text`**. In PostgreSQL, there is NO performance difference between
`varchar(n)` and `text`. The only thing `varchar(255)` gives you is a length check
constraint. If you want length validation, do it in your application layer or use a
CHECK constraint. The `text` type is simplest and most flexible.

```sql
-- These perform identically in Postgres:
CREATE TABLE example (
  name varchar(255),  -- needless limit
  name text           -- just as fast, more flexible
);

-- If you really need length enforcement at the DB level:
CREATE TABLE example (
  name text CHECK (length(name) <= 255)
);
```

### Date and Time Types

```sql
-- Date only: '2024-03-15'
date

-- Time only: '14:30:00'
time

-- Date + time WITHOUT timezone: '2024-03-15 14:30:00'
timestamp  -- or: timestamp without time zone

-- Date + time WITH timezone: '2024-03-15 14:30:00+00'
timestamptz  -- or: timestamp with time zone

-- Time interval: '3 hours', '2 days 4 hours'
interval
```

**Always use `timestamptz`** (timestamp with time zone). When you store a
`timestamp` (without timezone), PostgreSQL stores the literal value -- if your server
moves to a different timezone or you have users in multiple timezones, you'll have bugs.
`timestamptz` stores the moment in time as UTC internally and converts for display.

```sql
-- BAD: what timezone is this in? Nobody knows after insertion.
CREATE TABLE events (
  created_at timestamp DEFAULT now()
);

-- GOOD: always stores UTC, converts for display
CREATE TABLE events (
  created_at timestamptz DEFAULT now()
);
```

### UUID Type

```sql
-- Universally Unique Identifier: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
uuid
```

UUIDs are 128-bit identifiers. They're useful as primary keys because:
- They can be generated by the application (no round-trip to the database)
- They don't reveal how many records you have (unlike sequential IDs)
- They're safe across distributed systems (no coordination needed)

PostgreSQL has built-in UUID support. Generate them with `gen_random_uuid()`:

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

INSERT INTO users (name) VALUES ('Alice');
-- id is automatically generated
```

### JSONB Type

```sql
-- Binary JSON: stored in decomposed binary format
jsonb

-- Regular JSON: stored as text (rarely useful -- use jsonb)
json
```

**Use `jsonb`, not `json`**. The `json` type stores the raw text and re-parses it every
time you query it. `jsonb` stores a decomposed binary representation that's much faster
to query, supports indexing, and deduplicates keys.

```sql
CREATE TABLE product_catalog (
  id serial PRIMARY KEY,
  name text NOT NULL,
  attributes jsonb  -- flexible schema for varying product attributes
);

INSERT INTO product_catalog (name, attributes)
VALUES ('T-Shirt', '{"color": "red", "sizes": ["S", "M", "L"], "material": "cotton"}');

-- Query JSON fields:
SELECT name, attributes->>'color' AS color
FROM product_catalog
WHERE attributes @> '{"material": "cotton"}';

-- Index JSON for fast queries:
CREATE INDEX idx_attributes ON product_catalog USING GIN (attributes);
```

### Array Types

PostgreSQL supports arrays of any type:

```sql
CREATE TABLE articles (
  id serial PRIMARY KEY,
  title text NOT NULL,
  tags text[]  -- array of text
);

INSERT INTO articles (title, tags)
VALUES ('Postgres Tips', ARRAY['database', 'postgresql', 'tutorial']);

-- Query: find articles with a specific tag
SELECT title FROM articles WHERE 'postgresql' = ANY(tags);

-- Query: find articles with ALL of these tags
SELECT title FROM articles WHERE tags @> ARRAY['database', 'tutorial'];
```

### Boolean, Enum, and Special Types

```sql
-- Boolean: true, false, or null
boolean  -- or: bool

-- Enum: named set of values
CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral');
CREATE TABLE diary (
  entry_date date,
  feeling mood
);

-- Network address types
inet    -- IPv4 or IPv6 host address
cidr    -- IPv4 or IPv6 network
macaddr -- MAC address

-- Byte array (for binary data, but prefer object storage for large files)
bytea
```

---

## When to Use Relational vs Document Databases

### The Short Answer

Use a relational database (PostgreSQL) when:
- Your data has relationships (users have orders, orders have items)
- You need ACID transactions
- You need to query data in many different ways (ad hoc queries)
- Data integrity is critical (financial data, user accounts)
- Your schema is reasonably stable

Use a document database (MongoDB, DynamoDB) when:
- Your data is truly hierarchical (a document with nested sub-documents)
- Each "document" is self-contained and rarely joined with others
- Your access patterns are known and simple (key-value lookups)
- Schema flexibility is genuinely needed (not just laziness)

### The "Just Use Postgres" Position

Here's a secret that experienced backend developers know: **PostgreSQL can do 95% of
what document databases do**, thanks to `jsonb`. You get the relational power AND
document flexibility in one system.

```sql
-- Relational data (structured, queried in many ways):
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Semi-structured data that varies per user (profile preferences, settings):
CREATE TABLE user_profiles (
  user_id uuid REFERENCES users(id),
  profile jsonb NOT NULL DEFAULT '{}'
);

-- Best of both worlds!
SELECT u.email, p.profile->>'theme' AS theme
FROM users u
JOIN user_profiles p ON u.id = p.user_id
WHERE p.profile @> '{"newsletter": true}';
```

### When Document Databases Actually Win

1. **Massive scale with simple access patterns**: DynamoDB excels when you have millions
   of requests per second but only need key-value lookups.

2. **Truly schema-less data**: If every document is genuinely different (like storing
   arbitrary webhook payloads from third-party services), a document store avoids the
   overhead of constantly altering your schema.

3. **Embedded documents that are always read together**: If you always read a blog post
   with all its comments and never query comments separately, embedding them in a
   document makes that read a single operation.

### The "Just JSONB Everything" Trap

Don't do this:

```sql
-- BAD: Relational data crammed into JSONB
CREATE TABLE everything (
  id serial PRIMARY KEY,
  data jsonb
);

-- Now you've lost:
-- - Type checking (is 'age' always a number?)
-- - Foreign key constraints (does user_id reference a real user?)
-- - Standard query patterns (every query needs JSON operators)
-- - Join performance (can't efficiently join on nested fields)
-- - Clear documentation of your data model
```

JSONB is a tool for semi-structured data that genuinely varies. Using it for everything
is choosing the worst of both worlds: you lose relational guarantees without gaining the
simplicity of a purpose-built document store.

---

## Thought Experiment: Designing From Scratch

Imagine you're starting a new project -- a task management app (like Trello). You need
to store:
- Users (name, email, password hash)
- Boards (title, owner)
- Lists within boards (title, position)
- Cards within lists (title, description, due date, assigned users)
- Comments on cards
- Labels on cards (many-to-many)
- Activity log (who did what when)

**Question**: Should you use a relational database or a document database?

Think about it before reading on.

**Answer**: Relational. Almost every piece of data relates to other pieces. Cards belong
to lists, lists belong to boards, comments belong to cards AND users, labels are shared
across cards. You'll want to query "all cards assigned to user X across all boards,"
"all overdue cards," "activity for the last 24 hours." These are ad hoc queries across
relationships -- exactly what relational databases were built for.

The activity log *could* be a good candidate for JSONB (since different activities have
different metadata), but the core domain model is deeply relational.

---

## Summary

- Relational databases won because they provide **declarative queries** backed by
  **mathematical theory**, with **physical data independence** and **strong consistency**.
- **Relational algebra** (selection, projection, join, union) is the math behind SQL.
- **Sets** are unordered and unique. **Tuples** are fixed-structure rows. This is why
  primary keys and ORDER BY matter.
- **PostgreSQL** is the best general-purpose database for backend development: standards
  compliant, extensible, reliable, truly open source.
- Choose **data types** deliberately: `text` over `varchar`, `timestamptz` over
  `timestamp`, `numeric` over `float` for money, `jsonb` over `json`.
- Use **relational design** for structured, related data. Use **jsonb** for genuinely
  semi-structured data. Don't "just jsonb everything."

---

## Exercises

### Exercise 1: Historical Analysis
Write a paragraph explaining why a developer in 1968 using a hierarchical database would
struggle to answer this question: "Which employees work on more than one project?" Then
explain how the relational model makes this query trivial.

### Exercise 2: Relational Algebra
Given these relations:

```
Products = {
  (id: 1, name: "Widget", price: 25.00, category: "A"),
  (id: 2, name: "Gadget", price: 50.00, category: "B"),
  (id: 3, name: "Doohickey", price: 15.00, category: "A"),
  (id: 4, name: "Thingamajig", price: 75.00, category: "C")
}

Orders = {
  (order_id: 101, product_id: 1, quantity: 3),
  (order_id: 102, product_id: 2, quantity: 1),
  (order_id: 103, product_id: 1, quantity: 5),
  (order_id: 104, product_id: 4, quantity: 2)
}
```

Write out the result of:
1. `sigma_{price > 20}(Products)`
2. `pi_{name, price}(Products)`
3. `Products JOIN Orders ON Products.id = Orders.product_id`

### Exercise 3: Data Type Selection
For each piece of data, choose the most appropriate PostgreSQL data type and explain why:
1. A user's email address
2. A product price in USD
3. The number of items in an inventory
4. A user's preferred UI settings (dark mode, language, notification preferences)
5. The time a payment was processed
6. A list of tags for a blog post
7. A user's unique identifier that will appear in URLs

### Exercise 4: Relational vs Document
You're building a system that stores medical lab results. Each type of test (blood work,
urinalysis, imaging) has completely different fields. Results must be linked to patients
and ordering physicians. Results must be auditable (who viewed what, when). Query
patterns include: "all results for patient X", "all abnormal results in the last 24
hours", "all results ordered by Dr. Y."

Would you use a purely relational model, purely document model, or a hybrid? Justify
your choice with specific reasoning about the data's structure and query patterns.

### Exercise 5: Connect to PostgreSQL
Install PostgreSQL locally (or use Docker: `docker run --name pg -e POSTGRES_PASSWORD=secret -p 5432:5432 -d postgres:16`).
Connect using `psql` and run:

```sql
SELECT version();
SELECT current_database();
SELECT current_user;
\dt  -- list tables (there won't be any yet)
```

Create a simple table and insert a row:

```sql
CREATE TABLE test (
  id serial PRIMARY KEY,
  message text,
  created_at timestamptz DEFAULT now()
);

INSERT INTO test (message) VALUES ('Hello, PostgreSQL!');
SELECT * FROM test;
```

Verify the `created_at` column was automatically populated. Then drop the table:
```sql
DROP TABLE test;
```
