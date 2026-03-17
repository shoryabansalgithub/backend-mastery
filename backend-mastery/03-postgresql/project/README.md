# Project: SchemaForge

## Overview

Build the database layer for a multi-tenant SaaS platform. SchemaForge is not a toy
CRUD app. It has the complexity of a real product: multiple tenants sharing one
database, role-based access within tenants, a flexible content model, full-text search,
audit trails, and the query patterns that real product teams actually need to answer
their business questions.

The rules are strict: no ORM. Raw SQL only, via the `pg` library. You write the
migrations. You write every query. You understand every index decision you make.
By the end, you will know exactly what your database is doing and why.

---

## Schema

Build these tables in order. The order matters — foreign keys enforce it.

### users

```sql
CREATE TABLE users (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text        NOT NULL,
  name         text        NOT NULL,
  password_hash text       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_format CHECK (email LIKE '%@%')
);

CREATE INDEX idx_users_email ON users (lower(email));
CREATE INDEX idx_users_created_at ON users (created_at DESC);
```

### organizations

```sql
CREATE TABLE organizations (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         text        NOT NULL,
  name         text        NOT NULL,
  plan         text        NOT NULL DEFAULT 'free'
                 CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organizations_slug_unique UNIQUE (slug),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9-]+$')
);

CREATE INDEX idx_organizations_slug ON organizations (slug);
```

### org_members

```sql
CREATE TABLE org_members (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_members_unique UNIQUE (org_id, user_id)
);

CREATE INDEX idx_org_members_org    ON org_members (org_id);
CREATE INDEX idx_org_members_user   ON org_members (user_id);
CREATE INDEX idx_org_members_owners ON org_members (org_id) WHERE role = 'owner';
```

### tags

```sql
CREATE TABLE tags (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  color        text        NOT NULL DEFAULT '#6366f1',
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tags_org_name_unique UNIQUE (org_id, name)
);

CREATE INDEX idx_tags_org ON tags (org_id);
```

### posts

```sql
CREATE TABLE posts (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_id    bigint      NOT NULL REFERENCES users(id),
  title        text        NOT NULL,
  body         text        NOT NULL DEFAULT '',
  status       text        NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Full-text search vector (updated via trigger)
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED,

  CONSTRAINT posts_published_consistency
    CHECK (status != 'published' OR published_at IS NOT NULL)
);

CREATE INDEX idx_posts_org             ON posts (org_id);
CREATE INDEX idx_posts_author          ON posts (author_id);
CREATE INDEX idx_posts_org_status      ON posts (org_id, status);
CREATE INDEX idx_posts_published       ON posts (org_id, published_at DESC)
  WHERE status = 'published';
CREATE INDEX idx_posts_search          ON posts USING GIN (search_vector);
CREATE INDEX idx_posts_created         ON posts (created_at DESC);
```

### post_tags

```sql
CREATE TABLE post_tags (
  post_id    bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id     bigint NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,

  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX idx_post_tags_tag ON post_tags (tag_id);
```

### audit_log

```sql
CREATE TABLE audit_log (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  action       text        NOT NULL,
  entity_type  text        NOT NULL,
  entity_id    bigint,
  diff         jsonb,
  ip_address   inet,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_org      ON audit_log (org_id, occurred_at DESC);
CREATE INDEX idx_audit_log_actor    ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_log_entity   ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_log_action   ON audit_log (org_id, action, occurred_at DESC);
```

---

## Requirements

### Migrations

- All schema changes must be in numbered SQL migration files: `migrations/001_initial_schema.sql`, `migrations/002_add_foo.sql`, etc.
- Each migration file must be idempotent (safe to run twice without error).
- Each migration must have a matching rollback file: `migrations/001_initial_schema.down.sql`.
- Write a migration runner in `src/migrate.ts` that:
  - Tracks applied migrations in a `schema_migrations` table.
  - Runs only un-applied migrations.
  - Runs migrations in a transaction (if a migration fails, no partial changes persist).
  - Prints which migrations were applied.

### CRUD Operations

Implement these using the `pg` library directly. No Knex, no Sequelize, no Drizzle.

**Users:**
- `createUser(email, name, passwordHash): Promise<User>`
- `getUserById(id): Promise<User | null>`
- `getUserByEmail(email): Promise<User | null>`
- `updateUser(id, fields: Partial<User>): Promise<User>`

**Organizations:**
- `createOrg(slug, name, ownerUserId): Promise<Organization>`
  — Must create the org AND the owner's membership in one transaction.
- `getOrgBySlug(slug): Promise<Organization | null>`
- `getOrgMembers(orgId): Promise<OrgMember[]>`
  — Return member info joined with user name and email.
- `addMember(orgId, userId, role): Promise<OrgMember>`
- `updateMemberRole(orgId, userId, role): Promise<OrgMember>`
- `removeMember(orgId, userId): Promise<void>`
  — Must prevent removing the last owner.

**Posts:**
- `createPost(orgId, authorId, title, body, status): Promise<Post>`
- `getPostById(id, orgId): Promise<Post | null>`
  — Always scope to org (tenant isolation).
- `updatePost(id, orgId, fields): Promise<Post>`
- `deletePost(id, orgId): Promise<void>`
- `publishPost(id, orgId): Promise<Post>`
  — Sets status to 'published' and `published_at` to now().

**Tags:**
- `createTag(orgId, name, color): Promise<Tag>`
- `getTagsByOrg(orgId): Promise<Tag[]>`
- `attachTags(postId, tagIds): Promise<void>` — replace all tags on a post atomically.

### Complex Queries to Implement

These are the queries that prove you understand SQL. Each must be a named function in
`src/queries/`.

#### Q1: Posts Feed with Author and Tags

Return a paginated feed of published posts for an organization. Each post includes
the author's name, the list of tags (as an array), and a snippet of the body.

Requirements:
- Keyset pagination: accept `cursor` (last seen `published_at` + `id`) and `limit`.
- Return posts in descending `published_at` order.
- Include tag names as a single array per post (not one row per tag).
- Truncate body to 200 characters for the snippet.
- Do not use OFFSET.

Signature: `getPostsFeed(orgId, limit, cursor?): Promise<PostFeedItem[]>`

#### Q2: Full-Text Search

Search published posts within an organization by text query. Return results ranked
by relevance.

Requirements:
- Use `tsvector` and `to_tsquery` or `websearch_to_tsquery`.
- Return a `relevance` score alongside each result.
- Include author name and tags.
- Support highlighting matched terms using `ts_headline`.
- Paginated (keyset, same pattern as Q1).

Signature: `searchPosts(orgId, query, limit, cursor?): Promise<SearchResult[]>`

#### Q3: Member Activity Report

For each member of an organization, compute:
- Total posts authored (all statuses)
- Published posts in the last 30 days
- Most recently authored post title and date
- Member role
- Days since they joined

Return ordered by published posts in last 30 days descending.

Signature: `getMemberActivityReport(orgId): Promise<MemberActivity[]>`

#### Q4: Tag Usage Statistics

For each tag in an organization:
- Number of posts using the tag (total)
- Number of published posts using the tag
- Most recent post using the tag (title + date)
- Percentage of all org posts that use this tag

Return only tags that have been used at least once, ordered by usage count descending.

Signature: `getTagStats(orgId): Promise<TagStats[]>`

#### Q5: Audit Trail with Pagination

Return the audit log for an organization, supporting:
- Optional filter by `actor_id`.
- Optional filter by `action` (e.g., 'post.create', 'member.remove').
- Optional filter by `entity_type`.
- Date range filter (`from`, `to`).
- Keyset pagination by `occurred_at` + `id`.
- Include actor name and email (joined from users, handle null for deleted users).

Signature: `getAuditLog(orgId, filters, limit, cursor?): Promise<AuditEntry[]>`

#### Q6: Organization Dashboard Summary

A single query (using CTEs) that returns:
- Total members
- Total posts by status (draft count, published count, archived count)
- New posts in the last 7 days
- Top 3 most active authors (by published posts, last 30 days)
- Top 5 most used tags

This must be a single database round-trip. No multiple queries assembled in JavaScript.

Signature: `getOrgDashboard(orgId): Promise<OrgDashboard>`

### Transaction Requirements

You must demonstrate transactions in these specific places:

1. `createOrg`: org creation + owner membership in one transaction.
2. `attachTags`: DELETE existing tags + INSERT new tags atomically.
3. `removeMember`: check last owner constraint + delete in one transaction.
4. `publishPost`: validate post exists and is a draft before updating.
5. Any CRUD operation that writes to `audit_log`: the write and the audit log entry
   must succeed or fail together.

### Audit Logging

Every mutation (create, update, delete) on posts, organizations, and org_members must
insert a row into `audit_log`. The `diff` column must contain the changed fields
(for updates: `{ before: {...}, after: {...} }`).

Implement audit logging inside the transaction that performs the mutation — not as
a separate subsequent call.

### Connection Pooling

In `src/db.ts`:
- Configure the pool with explicit `max`, `min`, `idleTimeoutMillis`, `connectionTimeoutMillis`.
- Export a `query<T>()` helper and a `transaction<T>()` helper.
- Implement a `checkHealth()` function.
- Register SIGTERM and SIGINT handlers that call `pool.end()` before exit.

---

## Expected Output Examples

### Post Feed

```json
[
  {
    "id": 42,
    "title": "Getting Started with PostgreSQL",
    "snippet": "PostgreSQL is a powerful, open-source relational database. In this post we cover the basics of setting up your first schema and writing your...",
    "author_name": "Alice Chen",
    "published_at": "2024-03-15T10:30:00.000Z",
    "tags": ["postgresql", "tutorial", "databases"]
  },
  {
    "id": 38,
    "title": "Index Strategy for High-Traffic APIs",
    "snippet": "Choosing the wrong indexes can be worse than having no indexes at all. This post walks through a systematic approach to index design starting from...",
    "author_name": "Bob Kim",
    "published_at": "2024-03-12T14:00:00.000Z",
    "tags": ["performance", "postgresql"]
  }
]
```

### Full-Text Search

```json
[
  {
    "id": 42,
    "title": "Getting Started with PostgreSQL",
    "headline": "...covering the basics of <b>PostgreSQL</b> and writing your first <b>query</b>...",
    "relevance": 0.6831,
    "author_name": "Alice Chen",
    "published_at": "2024-03-15T10:30:00.000Z",
    "tags": ["postgresql", "tutorial"]
  }
]
```

### Member Activity Report

```json
[
  {
    "user_id": 1,
    "name": "Alice Chen",
    "email": "alice@example.com",
    "role": "owner",
    "days_since_joined": 94,
    "total_posts": 12,
    "published_last_30_days": 4,
    "most_recent_post_title": "Advanced Window Functions",
    "most_recent_post_date": "2024-03-14T09:00:00.000Z"
  }
]
```

### Organization Dashboard

```json
{
  "total_members": 8,
  "posts_by_status": {
    "draft": 3,
    "published": 24,
    "archived": 7
  },
  "new_posts_last_7_days": 5,
  "top_authors": [
    { "name": "Alice Chen", "published_count": 4 },
    { "name": "Bob Kim",    "published_count": 3 },
    { "name": "Carol Lee",  "published_count": 2 }
  ],
  "top_tags": [
    { "name": "postgresql",   "post_count": 12 },
    { "name": "performance",  "post_count": 8 },
    { "name": "tutorial",     "post_count": 7 },
    { "name": "transactions", "post_count": 5 },
    { "name": "indexes",      "post_count": 4 }
  ]
}
```

---

## Getting Started

### 1. Start PostgreSQL with Docker

```bash
docker run \
  --name schemaforge-pg \
  -e POSTGRES_DB=schemaforge \
  -e POSTGRES_USER=schemaforge \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  -d postgres:16

# Verify it's running
docker exec -it schemaforge-pg psql -U schemaforge -c "SELECT version();"
```

### 2. Install Dependencies

```bash
cd starter
npm install
```

The starter `package.json` includes `pg`, `@types/pg`, and `tsx`.

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your database credentials
```

Required environment variables:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=schemaforge
DB_USER=schemaforge
DB_PASSWORD=secret
NODE_ENV=development
```

### 4. Run Migrations

```bash
npx tsx src/migrate.ts
```

Expected output:
```
Applying migration: 001_initial_schema.sql
Applying migration: 002_seed_data.sql
Done. 2 migration(s) applied.
```

### 5. Explore the Starter Code

```
src/
  db.ts               -- Pool configuration and query helpers (implement this)
  migrate.ts          -- Migration runner (implement this)
  types.ts            -- TypeScript interfaces for all entities
  crud/
    users.ts          -- User CRUD (implement this)
    organizations.ts  -- Organization CRUD (implement this)
    posts.ts          -- Post CRUD (implement this)
    tags.ts           -- Tag operations (implement this)
  queries/
    feed.ts           -- Q1: Posts feed (implement this)
    search.ts         -- Q2: Full-text search (implement this)
    reports.ts        -- Q3, Q4, Q6: Reports (implement this)
    audit.ts          -- Q5: Audit trail (implement this)
migrations/
  001_initial_schema.sql   -- Write this
  001_initial_schema.down.sql
```

---

## Grading Criteria

1. **Schema correctness** (20%) — All constraints, indexes, and foreign keys match the
   specification. Migrations are idempotent. Rollbacks work.

2. **Query correctness** (30%) — All six complex queries return the correct data. Keyset
   pagination works correctly at the boundary conditions (first page, empty result, cursor
   from last item).

3. **Transaction integrity** (20%) — The five required transaction sites all behave
   atomically. Test by forcing failures mid-transaction (kill the process, throw an error
   after first update) and verify the database is left in a consistent state.

4. **Audit completeness** (10%) — Every mutation produces an audit log entry with
   correct `diff` content. Audit write and data write always succeed or fail together.

5. **Connection pooling** (10%) — Pool is correctly configured. `query()` and
   `transaction()` helpers are properly implemented with no leaks. Graceful shutdown
   works.

6. **Code quality** (10%) — TypeScript types throughout. No `any`. Functions are small
   and focused. SQL is readable (formatted, uses CTEs for complex queries).

---

## Stretch Goals

- **Row-Level Security (RLS)**: Implement PostgreSQL RLS policies so that an
  `org_id` session variable automatically filters all queries to the current tenant.
  Remove all `WHERE org_id = $1` from application code.

- **Recursive CTE**: Add a `comments` table where comments can reply to other comments
  (threaded). Write a recursive CTE that fetches an entire comment thread with depth
  indication.

- **LISTEN/NOTIFY**: When a post is published, send a PostgreSQL NOTIFY on channel
  `post_published` with the post ID and org ID as the payload. Implement a subscriber
  in Node.js that receives these notifications.

- **Partitioned Audit Log**: Partition the `audit_log` table by `occurred_at` (monthly
  partitions). Write a script that creates the next 3 months of partitions.

- **EXPLAIN Analysis Script**: Write a script that runs each of the six complex queries
  with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, parses the output, and reports total
  execution time, buffer hits/misses, and the costliest node for each query.
