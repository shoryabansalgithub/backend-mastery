# EventFlow — Exhaustive Implementation Plan

## 1. Project Structure

```
eventflow/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                  # Express app + server startup
│   ├── db/
│   │   ├── pool.ts               # pg.Pool singleton + health check
│   │   ├── schema.sql            # Full DDL: tables, indexes, views
│   │   └── migrations/
│   │       ├── 001-initial.sql
│   │       └── 002-materialized-views.sql
│   ├── routes/
│   │   ├── events.ts             # POST /events, POST /events/batch
│   │   ├── analytics.ts          # GET /analytics/*
│   │   └── admin.ts              # POST /admin/refresh-views, DELETE /admin/retention
│   ├── services/
│   │   ├── ingestion.ts          # Business logic for storing events
│   │   └── analytics.ts          # Business logic for all query types
│   ├── middleware/
│   │   ├── validate.ts           # Zod validation middleware
│   │   └── errorHandler.ts       # Centralized error handler
│   └── types.ts                  # All TypeScript types
```

---

## 2. Database Schema (Full DDL)

### `src/db/schema.sql`

```sql
-- Enable uuid generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS TABLE
-- ============================================================
-- Stores user identity. Users may be anonymous (no email).
-- Upserted on every event ingest via ON CONFLICT DO UPDATE.
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id  TEXT NOT NULL UNIQUE,  -- The ID the client sends (device ID or user ID)
  email        TEXT,
  properties   JSONB NOT NULL DEFAULT '{}',
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the external_id lookup on every ingest
CREATE INDEX idx_users_external_id ON users(external_id);

-- ============================================================
-- SESSIONS TABLE
-- ============================================================
-- Groups events into sessions (30-min inactivity = new session).
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  -- Sessions closed via UPDATE when a new session starts for this user
  properties  JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);

-- ============================================================
-- EVENTS TABLE — PARTITIONED BY MONTH
-- ============================================================
-- Why partition? At 25K DAU with ~50 events/user/day = 1.25M events/day.
-- After 90 days that's ~112M rows. A single table with that many rows
-- makes pruning expensive (full table scan to delete old rows).
-- Monthly partitions let Postgres skip entire partitions during queries
-- (partition pruning) and drop old data with DROP TABLE on the partition.
CREATE TABLE events (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  session_id   UUID REFERENCES sessions(id),
  event_type   TEXT NOT NULL,           -- 'page_view', 'click', 'feature_used', 'custom'
  event_name   TEXT NOT NULL,           -- specific name, e.g. 'pricing_page_view'
  properties   JSONB NOT NULL DEFAULT '{}',  -- arbitrary metadata
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedup key: prevents double-counting if client retries
  idempotency_key TEXT UNIQUE
) PARTITION BY RANGE (occurred_at);

-- Create monthly partitions for 12 months
-- In production, create these programmatically or via cron
CREATE TABLE events_2024_01 PARTITION OF events
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE events_2024_02 PARTITION OF events
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- ... (create for each month you need, or use a function below)

-- ============================================================
-- INDEXES ON EVENTS
-- ============================================================
-- Why these specific indexes?

-- 1. (user_id, occurred_at): Powers GET /analytics/user/:userId with date range filter.
--    user_id first because we always filter by user first, then sort by time.
CREATE INDEX idx_events_user_time ON events(user_id, occurred_at DESC);

-- 2. (event_type, occurred_at): Powers summary queries like "all page_views today".
--    Covers the most common WHERE + ORDER BY pattern.
CREATE INDEX idx_events_type_time ON events(event_type, occurred_at DESC);

-- 3. (event_name, occurred_at): Powers funnel queries where we filter by specific event name.
CREATE INDEX idx_events_name_time ON events(event_name, occurred_at DESC);

-- 4. GIN on properties: Powers filtering by event properties, e.g. properties->>'page' = '/pricing'
CREATE INDEX idx_events_properties ON events USING GIN(properties);

-- ============================================================
-- MATERIALIZED VIEWS
-- ============================================================

-- View 1: Hourly event counts (powers time-series charts)
-- Refresh strategy: CONCURRENTLY every hour via cron.
-- CONCURRENTLY requires a unique index to allow reads during refresh.
CREATE MATERIALIZED VIEW hourly_event_stats AS
  SELECT
    date_trunc('hour', occurred_at) AS hour,
    event_type,
    event_name,
    COUNT(*) AS event_count,
    COUNT(DISTINCT user_id) AS unique_users
  FROM events
  GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX idx_hourly_stats_unique
  ON hourly_event_stats(hour, event_type, event_name);

-- View 2: Daily unique users (powers DAU/WAU/MAU metrics)
CREATE MATERIALIZED VIEW daily_unique_users AS
  SELECT
    date_trunc('day', occurred_at) AS day,
    COUNT(DISTINCT user_id) AS unique_users,
    COUNT(*) AS total_events
  FROM events
  GROUP BY 1;

CREATE UNIQUE INDEX idx_daily_unique_users_unique
  ON daily_unique_users(day);
```

---

## 3. Connection Pool (`src/db/pool.ts`)

```typescript
import { Pool, PoolConfig } from 'pg';

// Pool sizing formula: cpu_count * 2 + 1
// On a 2-core server: 2 * 2 + 1 = 5 connections
// This prevents connection exhaustion while maximizing throughput.
// Too many connections = more context switching overhead than benefit.
const config: PoolConfig = {
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'eventflow',
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,    // release idle connections after 30s
  connectionTimeoutMillis: 5_000, // fail fast if can't connect within 5s
};

export const pool = new Pool(config);

// Verify connectivity on startup
export async function checkConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

// Helper: run a query and always release the connection
export async function query<T>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

// Helper: run multiple queries in a transaction
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>
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
```

---

## 4. Type Definitions (`src/types.ts`)

```typescript
export interface RawEvent {
  userId: string;          // external user/device ID
  sessionId?: string;
  eventType: 'page_view' | 'click' | 'feature_used' | 'custom';
  eventName: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;     // ISO 8601, defaults to NOW() if omitted
  idempotencyKey?: string;
}

export interface StoredEvent {
  id: string;
  userId: string;
  sessionId: string | null;
  eventType: string;
  eventName: string;
  properties: Record<string, unknown>;
  occurredAt: Date;
  receivedAt: Date;
}

export interface TimeSeriesPoint {
  bucket: string;   // ISO 8601 truncated to interval
  eventCount: number;
  uniqueUsers: number;
}

export interface FunnelResult {
  total: number;
  converted: number;
  conversionRate: number; // 0–1
}

export interface AnalyticsSummaryRow {
  eventType: string;
  eventName: string;
  count: number;
  uniqueUsers: number;
}
```

---

## 5. Ingest Service (`src/services/ingestion.ts`)

### Single Event Insert
```typescript
const INSERT_EVENT = `
  INSERT INTO events (
    user_id, session_id, event_type, event_name,
    properties, occurred_at, idempotency_key
  )
  SELECT
    u.id, $2, $3, $4, $5, $6, $7
  FROM users u
  WHERE u.external_id = $1
  RETURNING id, occurred_at
`;

// User upsert (always run before event insert)
const UPSERT_USER = `
  INSERT INTO users (external_id, last_seen)
  VALUES ($1, NOW())
  ON CONFLICT (external_id)
  DO UPDATE SET last_seen = NOW()
  RETURNING id
`;
```

### Batch Insert (multi-row)
For bulk inserts, build a single multi-row INSERT:
```typescript
// For N events, generate:
// INSERT INTO events (user_id, event_type, ...) VALUES
// ((SELECT id FROM users WHERE external_id = $1), $2, ...),
// ((SELECT id FROM users WHERE external_id = $N+1), $N+2, ...);

function buildBatchInsert(events: RawEvent[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const valueClauses: string[] = [];

  events.forEach((event, i) => {
    const base = i * 7; // 7 params per event
    params.push(
      event.userId,           // $base+1
      event.eventType,        // $base+2
      event.eventName,        // $base+3
      event.properties ?? {}, // $base+4
      event.occurredAt ?? new Date().toISOString(), // $base+5
      event.idempotencyKey ?? null,  // $base+6
      event.sessionId ?? null        // $base+7
    );
    valueClauses.push(
      `((SELECT id FROM users WHERE external_id = $${base+1}), $${base+7}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6})`
    );
  });

  const sql = `
    INSERT INTO events (user_id, session_id, event_type, event_name, properties, occurred_at, idempotency_key)
    VALUES ${valueClauses.join(', ')}
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  return { sql, params };
}
```

---

## 6. Analytics Queries (`src/services/analytics.ts`)

### Summary Query
```sql
SELECT
  event_type,
  event_name,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_id) AS unique_users
FROM events
WHERE occurred_at >= $1
  AND occurred_at < $2
  AND ($3::text IS NULL OR event_type = $3)
GROUP BY event_type, event_name
ORDER BY event_count DESC;
```
Uses materialized view when date range aligns with pre-aggregated data.

### Time-Series with Zero Gaps (generate_series)
```sql
-- generate_series produces one row per interval bucket, even with no events
-- The LEFT JOIN ensures zero-count buckets appear as 0, not missing rows
WITH buckets AS (
  SELECT generate_series(
    date_trunc($3, $1::timestamptz),
    date_trunc($3, $2::timestamptz),
    ('1 ' || $3)::interval
  ) AS bucket
)
SELECT
  b.bucket,
  COALESCE(COUNT(e.id), 0) AS event_count,
  COALESCE(COUNT(DISTINCT e.user_id), 0) AS unique_users
FROM buckets b
LEFT JOIN events e
  ON date_trunc($3, e.occurred_at) = b.bucket
  AND ($4::text IS NULL OR e.event_type = $4)
GROUP BY b.bucket
ORDER BY b.bucket;
-- $1=from, $2=to, $3=interval ('hour'|'day'|'week'), $4=event_type (nullable)
```

### Funnel Query (session-based)
```sql
-- Find users who did eventA and then eventB within windowMinutes
WITH step_a AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    occurred_at AS step_a_time
  FROM events
  WHERE event_name = $1          -- stepA
    AND occurred_at >= $3
    AND occurred_at < $4
  ORDER BY user_id, occurred_at
),
step_b AS (
  SELECT DISTINCT ON (a.user_id)
    a.user_id
  FROM step_a a
  JOIN events e
    ON e.user_id = a.user_id
    AND e.event_name = $2        -- stepB
    AND e.occurred_at > a.step_a_time
    AND e.occurred_at <= a.step_a_time + ($5 * INTERVAL '1 minute')
  ORDER BY a.user_id
)
SELECT
  (SELECT COUNT(*) FROM step_a) AS total,
  (SELECT COUNT(*) FROM step_b) AS converted;
-- $1=stepA, $2=stepB, $3=from, $4=to, $5=windowMinutes
```

### Unique Users (from materialized view)
```sql
SELECT COALESCE(SUM(unique_users), 0) AS unique_users
FROM daily_unique_users
WHERE day >= $1 AND day < $2;
```

### Top Pages
```sql
SELECT
  properties->>'page' AS page,
  COUNT(*) AS view_count,
  COUNT(DISTINCT user_id) AS unique_viewers
FROM events
WHERE event_type = 'page_view'
  AND occurred_at >= $1
  AND occurred_at < $2
  AND properties ? 'page'
GROUP BY properties->>'page'
ORDER BY view_count DESC
LIMIT $3;
```

### User Event History (Keyset Pagination)
```sql
SELECT id, event_type, event_name, properties, occurred_at
FROM events
WHERE user_id = (SELECT id FROM users WHERE external_id = $1)
  AND ($2::timestamptz IS NULL OR occurred_at < $2)  -- cursor
ORDER BY occurred_at DESC
LIMIT $3;
-- $1=externalUserId, $2=cursor (last occurred_at from prev page), $3=limit
```

---

## 7. Data Retention Query

```sql
-- Step 1: Identify partition names for months > 90 days old
-- (In production, DROP these partition tables directly)
SELECT tablename
FROM pg_tables
WHERE tablename LIKE 'events_%'
  AND tablename < 'events_' || to_char(NOW() - INTERVAL '90 days', 'YYYY_MM');

-- Step 2: For the current partition (partial retention within current month)
DELETE FROM events
WHERE occurred_at < NOW() - INTERVAL '90 days';

-- In a real system, you'd DROP old partition tables entirely:
-- DROP TABLE IF EXISTS events_2023_12;
-- This is O(1) vs O(N) for DELETE
```

---

## 8. Zod Validation Schemas

```typescript
import { z } from 'zod';

export const EventSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().uuid().optional(),
  eventType: z.enum(['page_view', 'click', 'feature_used', 'custom']),
  eventName: z.string().min(1).max(100),
  properties: z.record(z.unknown()).optional().default({}),
  occurredAt: z.string().datetime().optional(),
  idempotencyKey: z.string().max(255).optional(),
});

export const BatchEventSchema = z.object({
  events: z.array(EventSchema).min(1).max(1000),
});

export const TimeSeriesQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  interval: z.enum(['hour', 'day', 'week']).default('day'),
  eventType: z.string().optional(),
});

export const FunnelQuerySchema = z.object({
  stepA: z.string().min(1),
  stepB: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
  windowMinutes: z.number().int().min(1).max(1440).default(30),
});
```

---

## 9. API Routes

### `src/routes/events.ts`
```
POST /events        body: EventSchema         → 201 { id, occurredAt }
POST /events/batch  body: BatchEventSchema    → 201 { inserted: number, skipped: number }
```

### `src/routes/analytics.ts`
```
GET /analytics/summary        ?from&to&eventType          → AnalyticsSummaryRow[]
GET /analytics/timeseries     ?from&to&interval&eventType → TimeSeriesPoint[]
GET /analytics/unique-users   ?period=last_7|last_30|last_90  → { uniqueUsers: number }
GET /analytics/top-pages      ?from&to&limit              → { page, viewCount, uniqueViewers }[]
GET /analytics/user/:userId   ?cursor&limit               → StoredEvent[]
GET /analytics/funnel         ?stepA&stepB&from&to&windowMinutes → FunnelResult
```

### `src/routes/admin.ts`
```
POST   /admin/refresh-views   → { refreshed: ['hourly_event_stats', 'daily_unique_users'] }
DELETE /admin/retention       ?dryRun=true  → { wouldDelete: number } | { deleted: number }
GET    /health                → { status: 'ok', pool: { total, idle, waiting } }
```

---

## 10. Environment Variables

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=eventflow
DB_USER=postgres
DB_PASSWORD=secret
DB_POOL_MAX=10
PORT=3000
NODE_ENV=development
```

---

## 11. Error Handling

pg errors have a `code` property. Map these to HTTP errors:

```typescript
const PG_ERROR_CODES = {
  '23505': 409, // unique_violation → idempotency key conflict (not an error, just skip)
  '23503': 400, // foreign_key_violation → invalid user ID
  '22P02': 400, // invalid_text_representation → bad UUID format
  '42P01': 500, // undefined_table → partition doesn't exist (create it)
};
```

---

## 12. Testing Approach

### Seed data
```sql
-- Insert 10k events spread across last 90 days for testing
INSERT INTO users (external_id) VALUES ('user-001'), ('user-002'), ('user-003');

-- Use generate_series to create realistic time-distributed events
INSERT INTO events (user_id, event_type, event_name, occurred_at)
SELECT
  (SELECT id FROM users WHERE external_id = 'user-00' || (1 + floor(random() * 3)::int)),
  (ARRAY['page_view','click','feature_used'])[ceil(random()*3)::int],
  'test_event',
  NOW() - (random() * INTERVAL '90 days')
FROM generate_series(1, 10000);
```

### EXPLAIN ANALYZE verification
After seeding, run:
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) FROM events
WHERE event_type = 'page_view'
  AND occurred_at >= NOW() - INTERVAL '7 days';
```
Expected: `Index Scan using idx_events_type_time on events_YYYY_MM` — NOT a `Seq Scan`.
