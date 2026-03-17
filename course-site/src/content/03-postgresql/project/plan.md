# SchemaForge: Implementation Plan

## Before You Start

Read the README fully before touching code. Understand all six complex queries before
writing the first migration — your index choices depend on knowing what queries you'll
be running. The schema and the queries are designed together.

Also: do not look at solutions until you're stuck. The value of this project is in the
struggle. When you hit a wall, use `EXPLAIN ANALYZE` before asking anyone for help.
The plan usually tells you what's wrong.

---

## Key Decisions (Read This First)

### Why Keyset Pagination Over OFFSET

The posts feed and search results both use keyset pagination. Here is why OFFSET is
wrong for production:

`LIMIT 20 OFFSET 1000` causes PostgreSQL to scan and discard 1,000 rows, then return
20. At page 50, you've discarded 1,000 rows for 20 results. At page 500, you've
discarded 10,000 rows for 20. Cost grows linearly with page depth.

Keyset pagination replaces `OFFSET N` with `WHERE (published_at, id) < (cursor_date, cursor_id)`.
With a composite index on `(published_at DESC, id DESC)`, this is a single B-tree
seek regardless of how deep you are. Page 1 and page 1,000,000 have identical cost.

The trade-off: you can't jump to page N. You can only go forward (or backward with
a reversed cursor). For a content feed or search results, this is the right trade-off.
Users scroll, they don't jump to page 847.

Implementation pattern:

```sql
-- First page (no cursor):
SELECT id, title, published_at FROM posts
WHERE org_id = $1 AND status = 'published'
ORDER BY published_at DESC, id DESC
LIMIT $2;

-- Subsequent pages (with cursor from last item):
SELECT id, title, published_at FROM posts
WHERE org_id = $1 AND status = 'published'
  AND (published_at, id) < ($cursor_date::timestamptz, $cursor_id::bigint)
ORDER BY published_at DESC, id DESC
LIMIT $2;

-- The index that makes both fast:
CREATE INDEX idx_posts_published ON posts (org_id, published_at DESC, id DESC)
WHERE status = 'published';
```

The cursor you return to the caller is the `published_at` + `id` of the last item
in the current page. The client sends it back in the next request. If the result
has fewer than `limit` rows, there are no more pages.

### Why tsvector for Full-Text Search

The naive approach to search is `WHERE title ILIKE '%postgres%'`. Problems:

1. Cannot use a B-tree index. Forces a sequential scan.
2. No relevance ranking — all matches are equal.
3. No linguistic intelligence — 'postgres' doesn't match 'postgresql', 'indexing'
   doesn't match 'indexes'.

PostgreSQL's full-text search uses `tsvector` (preprocessed document) and `tsquery`
(preprocessed query). The preprocessing applies:
- Tokenization: split text into words.
- Normalization: lowercase, remove punctuation.
- Stemming: reduce words to root form ('running' → 'run', 'indexes' → 'index').
- Stop word removal: ignore 'the', 'a', 'is'.

The `posts` table stores a `search_vector` column generated as:
```sql
to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
```

This is a `GENERATED ALWAYS AS ... STORED` column — PostgreSQL computes and stores
it automatically when the row is inserted or updated. You never maintain it manually.

A GIN index on `search_vector` makes searches fast:
```sql
CREATE INDEX idx_posts_search ON posts USING GIN (search_vector);
```

A GIN (Generalized Inverted Index) is optimized for "does this document contain this
token?" — exactly what full-text search needs. B-tree can't do this.

Query pattern:
```sql
SELECT id, title, ts_rank(search_vector, query) AS relevance
FROM posts,
     websearch_to_tsquery('english', $1) AS query
WHERE org_id = $2
  AND status = 'published'
  AND search_vector @@ query
ORDER BY relevance DESC, published_at DESC
LIMIT $3;
```

`websearch_to_tsquery` parses user input the way Google does: `postgres indexes` becomes
an AND of 'postgres' AND 'index'. `"exact phrase"` becomes a phrase search.
`-exclude` excludes a term. Users don't need to learn query syntax.

### Why a Single Round-Trip for the Dashboard

The dashboard query (Q6) uses multiple CTEs inside one SQL statement. The alternative
is 6 separate queries assembled in JavaScript. The single-query approach wins because:

- One network round-trip vs six.
- PostgreSQL can optimize across all the CTEs together.
- The result is atomically consistent — all numbers come from the same snapshot.
- If the database is slow, you wait once, not six times.

The CTEs are internally named, readable, and individually testable. This is the right
use of SQL for analytical work.

### Why Not an ORM

An ORM is the right choice for many projects. It's not the right choice for a learning
project about PostgreSQL. ORMs hide:

- The actual SQL being generated (which is often wrong or slow).
- How JOINs work.
- The difference between an N+1 and a proper JOIN.
- Index decisions (ORMs add generic indexes, not necessarily the right ones).
- Transaction boundaries (some ORMs autocommit by default).

By writing raw SQL, you learn what the ORM is doing for you. After this project,
you'll use an ORM with understanding, not blind trust.

---

## File Structure

```
schemaforge/
├── .env.example
├── .env                        (not committed)
├── package.json
├── tsconfig.json
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 001_initial_schema.down.sql
│   └── 002_seed_data.sql       (optional: sample data for development)
└── src/
    ├── db.ts                   (pool, query helper, transaction helper, health check)
    ├── migrate.ts              (migration runner)
    ├── types.ts                (TypeScript interfaces)
    ├── crud/
    │   ├── users.ts
    │   ├── organizations.ts
    │   ├── posts.ts
    │   └── tags.ts
    └── queries/
        ├── feed.ts             (Q1: posts feed)
        ├── search.ts           (Q2: full-text search)
        ├── reports.ts          (Q3, Q4, Q6: member activity, tag stats, dashboard)
        └── audit.ts            (Q5: audit trail query)
```

---

## Phase 1: Setup

**Goal**: Docker PostgreSQL running, project structure created, pool configured.

### 1.1 Docker

```bash
docker run \
  --name schemaforge-pg \
  -e POSTGRES_DB=schemaforge \
  -e POSTGRES_USER=schemaforge \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  -d postgres:16
```

Verify: `docker exec -it schemaforge-pg psql -U schemaforge -c "\conninfo"`

### 1.2 Project Init

```bash
mkdir schemaforge && cd schemaforge
npm init -y
npm install pg
npm install --save-dev @types/pg tsx typescript
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

### 1.3 Pool Configuration (src/db.ts)

Implement this first. Everything else depends on it.

```typescript
import { Pool, PoolClient } from 'pg';

const pool = new Pool({
  host:                    process.env.DB_HOST     ?? 'localhost',
  port:                    parseInt(process.env.DB_PORT ?? '5432'),
  database:                process.env.DB_NAME     ?? 'schemaforge',
  user:                    process.env.DB_USER     ?? 'schemaforge',
  password:                process.env.DB_PASSWORD ?? 'secret',
  max:                     10,
  min:                     2,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis:  5_000,
  statement_timeout:       30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkHealth() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start };
  }
}

async function shutdown(signal: string) {
  console.log(`${signal} received. Closing pool...`);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export { pool };
```

Test the pool before proceeding: write a small script that calls `query('SELECT 1')`
and logs the result. If this fails, nothing else will work.

---

## Phase 2: Schema Migrations

**Goal**: All tables exist, all indexes created, migrations tracked.

### 2.1 The schema_migrations Table

Your migration runner needs to track which migrations have been applied. Before
applying any migration, create this table if it doesn't exist:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

This table is managed by the migration runner, not a migration file.

### 2.2 Migration File Structure

Each `migrations/NNN_name.sql` should be idempotent. Use `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, and `DO $$ BEGIN ... EXCEPTION WHEN ... END $$` blocks
for constraints that might already exist.

`migrations/001_initial_schema.sql` creates all seven tables and all indexes in the
correct order (respect foreign key dependencies):
1. `users`
2. `organizations`
3. `org_members` (references users, organizations)
4. `tags` (references organizations)
5. `posts` (references organizations, users)
6. `post_tags` (references posts, tags)
7. `audit_log` (references organizations, users)

The corresponding `001_initial_schema.down.sql` drops all tables in reverse order:
```sql
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS post_tags;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS org_members;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS users;
```

### 2.3 Migration Runner (src/migrate.ts)

The runner must:
1. Create `schema_migrations` if it doesn't exist.
2. Read migration filenames from `migrations/` directory, sort ascending.
3. For each migration not in `schema_migrations`, run it in a transaction.
4. Insert the migration version into `schema_migrations` on success.
5. On failure, rollback the transaction and exit with an error message showing
   which migration failed and the error text.

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { pool } from './db';

async function migrate() {
  const client = await pool.connect();
  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Find applied migrations
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const applied = new Set(rows.map(r => r.version));

    // Find all migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log(`Done. ${count} migration(s) applied.`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err.message);
  process.exit(1);
});
```

### 2.4 Verify Schema

After running migrations, connect with psql and check:
```sql
\dt                     -- list all tables
\d posts                -- describe posts table, check constraints
\di                     -- list all indexes
SELECT * FROM schema_migrations;
```

---

## Phase 3: Core CRUD Operations

**Goal**: All CRUD functions working, transactions in the required places, audit log
entries being created.

### 3.1 TypeScript Interfaces (src/types.ts)

Define interfaces for every entity before writing SQL. This forces you to think
about the shape of your data.

```typescript
export interface User {
  id:            bigint;
  email:         string;
  name:          string;
  password_hash: string;
  created_at:    Date;
  updated_at:    Date;
}

export interface Organization {
  id:         bigint;
  slug:       string;
  name:       string;
  plan:       'free' | 'pro' | 'enterprise';
  created_at: Date;
  updated_at: Date;
}

export interface OrgMember {
  id:        bigint;
  org_id:    bigint;
  user_id:   bigint;
  role:      'owner' | 'admin' | 'member' | 'viewer';
  joined_at: Date;
  // Joined fields (when queried with user info)
  name?:     string;
  email?:    string;
}

// ... etc for Post, Tag, PostTag, AuditLog
```

Note: PostgreSQL's `bigint` maps to JavaScript's `string` or `bigint` in the `pg`
driver. Be aware of this when comparing IDs or doing arithmetic.

### 3.2 Implement in This Order

1. **users.ts**: simplest. No foreign keys, no transactions needed for basic CRUD.
   Test each function before moving on.

2. **organizations.ts**: `createOrg` must use a transaction (creates org + owner membership).
   This is the first non-trivial transaction you'll write.

3. **posts.ts**: `createPost`, `updatePost` must write to `audit_log` in the same
   transaction. Test by inserting a post, then checking `audit_log`.

4. **tags.ts**: `attachTags` is the hardest CRUD operation. You DELETE all existing
   `post_tags` for the post, then INSERT the new ones. This must be atomic — if the
   INSERT fails, the DELETE must roll back.

### 3.3 Testing CRUD

Write small test scripts (not a full test framework — just standalone `tsx` scripts):

```typescript
// scripts/test-crud.ts
import { createUser, getUserByEmail } from '../src/crud/users';
import { createOrg } from '../src/crud/organizations';
import { pool } from '../src/db';

async function main() {
  // Create a user
  const user = await createUser('alice@example.com', 'Alice', 'hashed');
  console.log('Created user:', user.id, user.email);

  // Retrieve it
  const fetched = await getUserByEmail('alice@example.com');
  console.assert(fetched?.id === user.id, 'Round-trip failed');

  // Create an org (should create membership too)
  const org = await createOrg('alice-co', 'Alice Co', user.id);
  console.log('Created org:', org.id, org.slug);

  // Verify membership was created
  // ...

  console.log('All tests passed');
  await pool.end();
}

main().catch(console.error);
```

Run: `npx tsx scripts/test-crud.ts`

---

## Phase 4: Complex Queries

**Goal**: All six complex queries implemented and returning correct results.

### Build Each Query in psql First

Do NOT write the TypeScript wrapper until the SQL works correctly in psql.
Use `\timing on` in psql to see query time. Use `EXPLAIN ANALYZE` to verify
index usage for each query.

### Q1: Posts Feed — Step by Step

```sql
-- Step 1: basic fetch
SELECT id, title, published_at FROM posts
WHERE org_id = 1 AND status = 'published'
ORDER BY published_at DESC, id DESC
LIMIT 10;

-- Step 2: add author name
SELECT p.id, p.title, p.published_at, u.name AS author_name
FROM posts p
JOIN users u ON u.id = p.author_id
WHERE p.org_id = 1 AND p.status = 'published'
ORDER BY p.published_at DESC, p.id DESC
LIMIT 10;

-- Step 3: add tags as an array
SELECT
  p.id,
  p.title,
  left(p.body, 200) AS snippet,
  p.published_at,
  u.name AS author_name,
  coalesce(
    array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL),
    '{}'::text[]
  ) AS tags
FROM posts p
JOIN users u ON u.id = p.author_id
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags t ON t.id = pt.tag_id
WHERE p.org_id = 1 AND p.status = 'published'
GROUP BY p.id, u.name
ORDER BY p.published_at DESC, p.id DESC
LIMIT 10;

-- Step 4: add keyset cursor
SELECT
  p.id,
  p.title,
  left(p.body, 200) AS snippet,
  p.published_at,
  u.name AS author_name,
  coalesce(
    array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL),
    '{}'::text[]
  ) AS tags
FROM posts p
JOIN users u ON u.id = p.author_id
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags t ON t.id = pt.tag_id
WHERE p.org_id = 1
  AND p.status = 'published'
  AND (p.published_at, p.id) < ('2024-03-10'::timestamptz, 40)  -- cursor
GROUP BY p.id, u.name
ORDER BY p.published_at DESC, p.id DESC
LIMIT 10;
```

Verify with `EXPLAIN ANALYZE` that step 4 uses `idx_posts_published`.

### Q2: Full-Text Search — Key Points

The `search_vector` column is already maintained by the database. Your query just
needs to use it:

```sql
SELECT
  p.id,
  p.title,
  ts_headline(
    'english',
    p.body,
    query,
    'MaxWords=35, MinWords=15, StartSel=<b>, StopSel=</b>'
  ) AS headline,
  ts_rank(p.search_vector, query) AS relevance,
  u.name AS author_name,
  p.published_at
FROM posts p,
     websearch_to_tsquery('english', $1) AS query
JOIN users u ON u.id = p.author_id
WHERE p.org_id = $2
  AND p.status = 'published'
  AND p.search_vector @@ query
ORDER BY relevance DESC, p.published_at DESC
LIMIT $3;
```

The `FROM posts p, websearch_to_tsquery(...) AS query` syntax creates a lateral
join — `query` is available as a named value in the rest of the query.

### Q3: Member Activity — Use a CTE

The "most recently authored post" per member is the classic `ROW_NUMBER()` over
partition pattern. Use a CTE to compute rankings, then filter to `rn = 1`.

Sketch:
```sql
WITH member_posts AS (
  -- all posts by each member in this org
  SELECT author_id, id, title, created_at
  FROM posts
  WHERE org_id = $1
),
recent_posts AS (
  -- published posts in last 30 days
  SELECT author_id, count(*) AS published_last_30
  FROM posts
  WHERE org_id = $1
    AND status = 'published'
    AND created_at >= now() - interval '30 days'
  GROUP BY author_id
),
latest_post AS (
  -- the most recent post per author (any status)
  SELECT author_id, title, created_at,
         row_number() OVER (PARTITION BY author_id ORDER BY created_at DESC) AS rn
  FROM member_posts
)
SELECT
  om.user_id,
  u.name,
  u.email,
  om.role,
  extract(day from now() - om.joined_at)::int AS days_since_joined,
  count(mp.id) AS total_posts,
  coalesce(rp.published_last_30, 0) AS published_last_30_days,
  lp.title AS most_recent_post_title,
  lp.created_at AS most_recent_post_date
FROM org_members om
JOIN users u ON u.id = om.user_id
LEFT JOIN member_posts mp ON mp.author_id = om.user_id
LEFT JOIN recent_posts rp ON rp.author_id = om.user_id
LEFT JOIN latest_post lp ON lp.author_id = om.user_id AND lp.rn = 1
WHERE om.org_id = $1
GROUP BY om.user_id, u.name, u.email, om.role, om.joined_at,
         rp.published_last_30, lp.title, lp.created_at
ORDER BY published_last_30_days DESC;
```

Write and test each CTE separately before combining.

### Q6: Dashboard — Single Round-Trip

This is the most complex query. It returns different data types in one result set.
One approach: use a single CTE that returns a JSON object per "section":

```sql
WITH
total_members AS (...),
posts_by_status AS (...),
new_posts AS (...),
top_authors AS (...),
top_tags AS (...)
SELECT
  json_build_object(
    'total_members',       (SELECT count FROM total_members),
    'posts_by_status',     (SELECT counts FROM posts_by_status),
    'new_posts_last_7d',   (SELECT count FROM new_posts),
    'top_authors',         (SELECT authors FROM top_authors),
    'top_tags',            (SELECT tags FROM top_tags)
  ) AS dashboard;
```

The type of `dashboard` is `jsonb`. Your TypeScript function parses it into the
`OrgDashboard` interface.

---

## Phase 5: Transactions and Edge Cases

**Goal**: All transaction requirements working. Edge cases handled.

### Audit Log Pattern

Every mutation that requires audit logging should follow this pattern:

```typescript
async function updatePost(id: bigint, orgId: bigint, fields: Partial<Post>): Promise<Post> {
  return transaction(async (client) => {
    // 1. Fetch current state (for diff)
    const { rows: current } = await client.query<Post>(
      'SELECT * FROM posts WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (!current[0]) throw new Error('Post not found');

    // 2. Apply update
    const { rows: updated } = await client.query<Post>(
      `UPDATE posts SET title = coalesce($3, title), body = coalesce($4, body),
                        updated_at = now()
       WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [id, orgId, fields.title ?? null, fields.body ?? null]
    );

    // 3. Write audit log (same transaction)
    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, fields.actorId, 'post.update', 'post', id,
       JSON.stringify({ before: current[0], after: updated[0] })]
    );

    return updated[0]!;
  });
}
```

### removeMember: Last Owner Guard

```typescript
async function removeMember(orgId: bigint, userId: bigint): Promise<void> {
  return transaction(async (client) => {
    // Check: is this person an owner?
    const { rows: memberRows } = await client.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (!memberRows[0]) throw new Error('Member not found');

    if (memberRows[0].role === 'owner') {
      // Count other owners
      const { rows: ownerCount } = await client.query(
        `SELECT count(*) AS n FROM org_members
         WHERE org_id = $1 AND role = 'owner' AND user_id != $2`,
        [orgId, userId]
      );
      if (parseInt(ownerCount[0]!.n) === 0) {
        throw new Error('Cannot remove the last owner of an organization');
      }
    }

    await client.query(
      'DELETE FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
  });
}
```

### Testing Transaction Atomicity

Write a test that verifies rollback:

```typescript
// Force a failure mid-transaction and verify nothing was written
async function testTransactionRollback() {
  const beforeCount = await query<{n: string}>('SELECT count(*) AS n FROM posts');

  try {
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO posts (org_id, author_id, title) VALUES (1, 1, $1)',
        ['test post']
      );
      // Force an error mid-transaction
      throw new Error('Simulated failure');
    });
  } catch (e) { /* expected */ }

  const afterCount = await query<{n: string}>('SELECT count(*) AS n FROM posts');
  console.assert(
    beforeCount[0]?.n === afterCount[0]?.n,
    'Post count should not change after failed transaction'
  );
  console.log('Transaction rollback: PASSED');
}
```

---

## Testing Approach

This project does not require a test framework. Tests are executable scripts in
`scripts/test-*.ts`. Each script:
1. Sets up known data (insert test users, orgs, posts).
2. Calls the function under test.
3. Uses `console.assert` to verify results.
4. Cleans up test data.
5. Reports pass/fail.

Key things to test:
- Keyset cursor is correct at boundaries (first page, last page, empty result).
- Full-text search returns results in relevance order.
- `removeMember` rejects last-owner removal.
- `attachTags` is atomic (if tags array includes a nonexistent tag ID, no tags change).
- Audit log entry appears for every tested mutation.
- `publishPost` fails if post is already published.

For each complex query, manually insert known data and verify the query returns
expected results before considering it done.

---

## Common Mistakes to Avoid

**Forgetting tenant scoping.** Every post query must include `WHERE org_id = $1`.
Without it, you're reading another tenant's data. This is a security bug. Consider
adding a lint rule or code review checklist item: "does every query that touches a
tenanted table include org_id in the WHERE clause?"

**Not releasing clients.** Every `pool.connect()` must be paired with `client.release()`
in a `finally` block. If you use the `transaction()` helper for all transactions,
this is handled for you. Never bypass the helper.

**Comparing bigint IDs with ===.** The `pg` driver returns `bigint` columns as strings
in JavaScript. `id === 42` will be false when `id` is `"42"`. Use `BigInt(id)` or
compare as strings.

**Using `count(*)` in a LEFT JOIN result.** `count(*)` counts all rows including the
NULL row. After a LEFT JOIN, an unmatched row gives you a NULL on the right side —
you still have one row, so `count(*) = 1`. Use `count(right_table.id)` which skips NULLs.

**Using OFFSET for the search results cursor.** Full-text search results with OFFSET
have the same problem as any other OFFSET pagination. At page 100 of search results,
you're discarding 2,000 rows. Use `(ts_rank(...), id) <` as the keyset for search too,
accepting the trade-off that ranked relevance makes keyset pagination more complex.

**Not running ANALYZE after large inserts.** After inserting test data, run
`ANALYZE table_name` or PostgreSQL will use stale statistics and may choose wrong plans.
