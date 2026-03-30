# Project: EventFlow — Analytics Event Pipeline

## Context

You're the backend engineer at a B2B SaaS startup. The product team wants to answer questions like:

- "How many users visited the pricing page today?"
- "What's our feature adoption rate over the last 30 days?"
- "Which users are most active this week?"

Your job: build the analytics ingestion and query backend that makes these questions answerable — fast, cheap, and correctly — using **raw PostgreSQL only**. No ORM. Every query you write is SQL.

This is what you'll be building after companies like Amplitude, Mixpanel, and PostHog started as: a reliable event store with a query API on top.

---

## What You're Building

**EventFlow** is a two-part system:

### 1. Ingest API
Accepts analytics events from client applications. Events are things like:
- `page_view` — user visited a page
- `click` — user clicked a button
- `feature_used` — user triggered a feature
- `custom` — any arbitrary event the product team defines

Events must be stored durably and queryable by time range, user, event type, and custom properties.

### 2. Query API
Powers dashboards. Must support:
- Total event count by type over a time window
- Unique user counts (DAU, WAU, MAU)
- Time-series: events per hour/day/week
- Top pages by view count
- User-level event history
- Funnel query: how many users did A then B within 30 minutes?

---

## Constraints

1. **Raw SQL only.** Use the `pg` (node-postgres) driver directly. No Drizzle, Prisma, Knex, or any query builder.
2. **Parameterized queries mandatory.** String interpolation in SQL = instant failure. Every dynamic value goes through `$1, $2, ...` placeholders.
3. **Schema must be production-grade.** Use table partitioning for the events table (monthly range partitioning on `occurred_at`). This is not optional — explain in comments why.
4. **Batch ingest endpoint.** Support both single-event and bulk (up to 1000 events per request) ingestion. Single-event endpoint uses regular `INSERT`. Bulk endpoint uses multi-row `INSERT` with conflict handling.
5. **Materialized views required.** At least two: one for hourly aggregates, one for daily unique users. Include the refresh strategy.
6. **Data retention.** Events older than 90 days must be automatically deletable. Implement the SQL for this as a scheduled operation (doesn't need a cron in this project — just the query).
7. **Connection pooling.** Use `pg.Pool`, not `pg.Client`. Size the pool correctly and explain the sizing formula in a comment.
8. **No raw `SELECT *`.** Every query must specify columns explicitly.

---

## Deliverables

### API Endpoints

#### Ingest
```
POST /events              — Ingest a single event
POST /events/batch        — Ingest up to 1000 events
```

#### Query
```
GET /analytics/summary           — Total events by type for a date range
GET /analytics/timeseries        — Events per hour or day for a date range
GET /analytics/unique-users      — Unique user count (DAU/WAU/MAU)
GET /analytics/top-pages         — Top N pages by view count
GET /analytics/user/:userId      — All events for a specific user (paginated)
GET /analytics/funnel            — Funnel query: step A → step B conversion
```

#### Admin
```
GET /health                      — DB connection status, pool stats
POST /admin/refresh-views        — Manually trigger materialized view refresh
DELETE /admin/retention          — Delete events older than 90 days (dry-run flag)
```

---

## Schema Requirements

The database must include:

- `events` table — partitioned by month on `occurred_at`
- `users` table — user identity (may be anonymous with a device ID)
- `sessions` table — groups events into sessions (30-min inactivity timeout)
- `hourly_event_stats` materialized view
- `daily_unique_users` materialized view

Indexes must be designed for the actual query patterns above. Explain each index in a comment.

---

## Acceptance Criteria

- [ ] `POST /events` with a valid payload returns `201` with the created event ID
- [ ] `POST /events/batch` with 500 events completes in under 500ms
- [ ] `GET /analytics/timeseries?from=2024-01-01&to=2024-01-31&interval=day` returns 31 data points even for days with zero events (use `generate_series`)
- [ ] `GET /analytics/unique-users?period=last_30_days` returns a single integer, sourced from the materialized view
- [ ] `GET /analytics/funnel?stepA=page_view&stepB=click&windowMinutes=30` returns `{total, converted, conversionRate}`
- [ ] All SQL queries use parameterized placeholders — no exceptions
- [ ] Running `EXPLAIN ANALYZE` on the timeseries query shows an Index Scan (not a Seq Scan) on the events partition
- [ ] The data retention query correctly targets only events older than 90 days across all partitions
- [ ] `/health` endpoint reflects actual pool connection state

---

## Concepts This Project Exercises

From the PostgreSQL module, you will directly apply:

| Concept | Where |
|---------|-------|
| Table partitioning (range by month) | `events` schema |
| Composite indexes | `(user_id, occurred_at)`, `(event_type, occurred_at)` |
| Materialized views | `hourly_event_stats`, `daily_unique_users` |
| Window functions | Funnel query (LAG, LEAD, ROW_NUMBER) |
| CTEs | Complex analytics queries |
| `generate_series` | Zero-gap time series |
| Multi-row INSERT | Batch ingest endpoint |
| Parameterized queries | Every single query |
| `pg.Pool` + connection management | `src/db/pool.ts` |
| EXPLAIN ANALYZE interpretation | Performance testing |
| Transactions | Batch ingest (all-or-nothing) |
| `UPSERT` (ON CONFLICT) | User upsert on event ingest |

---

## Difficulty

**Intermediate–Advanced.** The SQL is the hard part — especially the funnel query and the zero-gap time series. If you haven't written window functions before, review Lesson 02 (SQL Fundamentals) and Lesson 03 (Indexes & Query Planning) before starting.

## Estimated Time

8–14 hours for a working solution with all acceptance criteria met.
