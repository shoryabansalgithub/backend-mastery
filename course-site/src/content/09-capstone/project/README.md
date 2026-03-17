# Lynk: A URL Shortener at Scale

## Overview

Lynk is your capstone project. It is the same problem you solved in Module
01 — shorten URLs, redirect short codes — but the constraints have changed
entirely. Module 01 was about making it work. Lynk is about making it work
at 10,000 requests per second.

This is a synthesis project. Every module feeds into it:

- **Module 01** (HTTP/Express): the API surface and routing
- **Module 02** (PostgreSQL): the persistent data layer
- **Module 03** (Redis): caching, rate limiting, streams
- **Module 04** (Auth): JWT-based API key authentication for write operations
- **Module 05** (Testing): test strategy across all layers
- **Module 06** (Architecture): separation of concerns, async patterns
- **Module 07** (Advanced APIs): pagination, streaming
- **Module 08** (Scaling/Production): Docker, observability, CI/CD

At 10,000 req/s, decisions you could ignore at 10 req/s suddenly matter
enormously. This document explains what you are building, why each
architectural decision was made, and what you must deliver to pass.

---

## The Problem

Users can create short URLs (authentication required). Anyone can follow
a short URL (public). The system records a click event for every redirect.
The read path (redirects) is the hot path — it handles 100x more traffic
than the write path.

### The constraint

The read path must handle **10,000 requests per second** with:
- p99 latency < 50ms
- p99 latency < 10ms for cache hits
- Error rate < 0.1%

At 10,000 req/s, you cannot hit PostgreSQL on every request. A typical
PostgreSQL instance handles 1,000-5,000 simple queries per second. Even
if it could handle the load, the latency would be 10-50ms per query — your
entire latency budget for a single cache hit.

The answer is Redis. Redis handles 100,000-500,000 operations per second
with sub-millisecond latency. Cache the `shortCode → originalUrl` mapping.
Serve redirects from Redis on the hot path. Fall back to PostgreSQL only on
cache miss.

---

## Architecture

```
                         Internet
                            │
                     ┌──────▼──────┐
                     │    nginx    │
                     │ (port 80)   │
                     └──┬───────┬──┘
                        │       │
               ┌────────▼─┐   ┌─▼────────┐
               │  Lynk #1 │   │  Lynk #2 │
               │ (port 3000)  │ (port 3001)
               └────┬─────┘   └─────┬────┘
                    │               │
         ┌──────────▼───────────────▼──────────┐
         │                                      │
    ┌────▼─────┐                      ┌────────▼────────┐
    │  Redis   │                      │   PostgreSQL    │
    │          │                      │                 │
    │ - Cache  │                      │ - urls table    │
    │ - Rate   │                      │ - clicks table  │
    │   limits │                      │   (partitioned) │
    │ - Stream │                      │                 │
    │   (clicks│                      │                 │
    │   queue) │                      └─────────────────┘
    └──────────┘
         │
    ┌────▼──────────┐
    │ Click Consumer│  (background process, same app or separate)
    │ Reads stream  │
    │ Writes to PG  │
    └───────────────┘
```

### Request flow: Read path (redirect)

```
Client → GET /:shortCode
  1. Check Redis cache: GET url:cache:{shortCode}
     → Hit: 302 to cached URL  (< 5ms, Redis only)
     → Miss: continue
  2. Query PostgreSQL: SELECT original_url, is_active FROM urls WHERE short_code = $1
     → Not found: 404
     → Found: populate Redis cache (SETEX, 5min TTL), 302 redirect
  3. Queue click event: XADD clicks:stream {shortCode, timestamp, ip, userAgent}
     (async, non-blocking — does NOT wait for this)
```

### Request flow: Write path (create URL)

```
Client → POST /api/urls  { Authorization: Bearer <jwt> }
  1. Verify JWT (sync — no DB lookup required)
  2. Check rate limit: Redis token bucket
  3. Generate short code (collision-resistant)
  4. INSERT into PostgreSQL
  5. Write-through: SET in Redis cache immediately
  6. Return { shortCode, originalUrl, createdAt }
```

### Click analytics pipeline

```
Redis Stream: clicks:stream
  └── Consumer Group: analytics-workers
       └── Consumer: analytics-1
            → Read batch of 100 events
            → Bulk INSERT into clicks table
            → XACK to confirm processing
```

---

## API Endpoints

### Public endpoints (no auth)

```
GET  /:shortCode
     → 302 Found, Location: <originalUrl>
     → 404 Not Found (if code does not exist or is deactivated)

GET  /health
     → 200 { status, uptime, timestamp, dependencies: { redis, postgres } }
     → 503 if any dependency is down

GET  /metrics
     → 200 Prometheus text format
```

### Authenticated endpoints (JWT Bearer token required)

```
POST /api/urls
     Body: { "url": "https://example.com/very-long-url" }
     → 201 { shortCode, originalUrl, shortUrl, createdAt }
     → 400 (invalid URL)
     → 401 (missing/invalid auth)
     → 429 (rate limited)

GET  /api/urls
     Query: ?cursor=<lastId>&limit=20
     → 200 { data: [...], nextCursor, hasMore }
     → 401

GET  /api/urls/:shortCode
     → 200 { shortCode, originalUrl, createdAt, clickCount, isActive }
     → 401
     → 404

PATCH /api/urls/:shortCode
     Body: { "isActive": false }
     → 200 { shortCode, isActive }
     → 401, 403, 404

DELETE /api/urls/:shortCode
     → 204 No Content
     → 401, 403, 404

GET  /api/urls/:shortCode/analytics
     Query: ?from=2024-01-01&to=2024-01-31
     → 200 { shortCode, totalClicks, clicksByDay: [...] }
     → 401, 403, 404
```

---

## Data Models

### PostgreSQL schema

```sql
-- Users (API key holders)
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- URLs
CREATE TABLE urls (
  id           BIGSERIAL PRIMARY KEY,
  short_code   TEXT UNIQUE NOT NULL,
  original_url TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Partial index for active URLs only (most read queries filter on this)
  CONSTRAINT short_code_format CHECK (short_code ~ '^[a-zA-Z0-9_-]{4,12}$')
);

CREATE INDEX idx_urls_short_code ON urls (short_code) WHERE is_active = true;
CREATE INDEX idx_urls_user_id ON urls (user_id, created_at DESC);

-- Clicks (write-optimized, partitioned by month)
CREATE TABLE clicks (
  id         BIGSERIAL,
  short_code TEXT NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address INET,
  user_agent TEXT,
  referer    TEXT
) PARTITION BY RANGE (clicked_at);

-- Create monthly partitions (can be automated)
CREATE TABLE clicks_2024_01 PARTITION OF clicks
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Index for analytics queries
CREATE INDEX idx_clicks_short_code_at ON clicks (short_code, clicked_at DESC);
```

### Redis data structures

```
url:cache:{shortCode}   → STRING    "https://original.url"
                          TTL: 300 seconds (5 minutes)
                          Purpose: read-path cache

rate:{userId}           → STRING    "47" (current request count)
                          TTL: set to window end
                          Purpose: API rate limiting

clicks:stream           → STREAM    { shortCode, clickedAt, ip, userAgent }
                          Purpose: async analytics queue
```

### JWT payload (API key)

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "type": "api_key",
  "iat": 1710000000,
  "exp": 1741536000
}
```

API keys are long-lived JWTs (1 year). Issued once, stored by the user.
Not refresh-token based — the user can regenerate their key by calling
`POST /api/auth/regenerate-key`.

---

## Architecture Decisions You Must Justify

### Why Redis for caching?

Redis operates in memory with a network round-trip time of < 1ms on the
same machine or < 5ms across a local network. This is the fundamental
physics of the problem. A PostgreSQL query, even a simple indexed lookup
with a warm buffer cache, takes 1-10ms. At 10,000 req/s, that is 10,000
connections/second to PostgreSQL — far beyond its capacity.

Your TTL choice matters. Consider: if a user deactivates a URL, how long
before the cache expires and the deactivation takes effect? A 5-minute
TTL is a reasonable default, but this should be a configurable constant
(`CACHE_TTL_SECONDS`). You must document this tradeoff in your code.

### Why async analytics?

If you record a click synchronously — INSERT INTO clicks every time someone
follows a redirect — you have added a PostgreSQL write to the hot path.
That write takes 5-20ms. You have just increased your p99 latency for
what was previously a Redis-only operation from < 5ms to 25ms.

More importantly, if the analytics database is slow or temporarily
unavailable, it breaks redirects. Your redirect path is now coupled to
the availability of your analytics subsystem. A Redis Stream decouples
them: publish the click event in < 1ms, process it in the background.

The tradeoff: analytics are eventually consistent, not real-time. A click
might take a few seconds to appear in the analytics endpoint. For a URL
shortener, this is acceptable. Document it as a deliberate decision.

### Why keyset pagination for URL listing?

`GET /api/urls?page=5&limit=20` is offset pagination. The database
query becomes `SELECT ... ORDER BY created_at DESC LIMIT 20 OFFSET 80`.
At offset 80, the database scans and discards 80 rows before returning
20. At offset 10,000, it scans and discards 10,000 rows.

Keyset pagination uses a cursor pointing to the last seen item:
`GET /api/urls?cursor=<lastId>&limit=20` becomes
`SELECT ... WHERE id < $lastId ORDER BY id DESC LIMIT 20`.
This is an indexed lookup — constant time regardless of how many pages deep.

For a URL shortener where a user might have thousands of URLs, keyset
pagination is the only viable approach at scale.

### Short code generation strategy

You need 6-8 character codes that are unique, URL-safe, and hard to
enumerate. Options:

**Option A: Random base62** — generate 6 random base62 characters (62^6
= 56 billion possibilities). Insert and retry on collision. At low volume,
collisions are vanishingly rare (birthday problem: you need ~100,000 codes
before a 1% collision probability).

**Option B: Sequential + base62 encode** — use a PostgreSQL sequence and
base62-encode the integer. Perfectly unique, no retries needed. Downside:
codes are enumerable (code N+1 always exists if code N does).

**Option C: Hash-based** — take the first 8 characters of
`sha256(originalUrl + salt)`. Same URL always produces the same code
(deduplication), but collision probability increases with URL count.

Recommendation: use Option A for simplicity. Implement with a loop:
```typescript
async function generateUniqueShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRandomCode(7); // 7 base62 chars
    const exists = await db.exists(code);
    if (!exists) return code;
  }
  throw new Error('Failed to generate unique short code after 5 attempts');
}
```

Document which strategy you chose and why.

---

## Docker Compose Setup

The Compose file must run two app instances behind nginx for load balancing:

```yaml
# docker-compose.yml (abbreviated — implement fully)
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app1
      - app2

  app1:
    build: .
    environment:
      - PORT=3000
      - INSTANCE_ID=app1
      # ... all required env vars

  app2:
    build: .
    environment:
      - PORT=3000
      - INSTANCE_ID=app2

  postgres:
    image: postgres:16-alpine
    # ... health check, volumes

  redis:
    image: redis:7-alpine
    # ... health check, volumes
```

```nginx
# nginx/nginx.conf
events { worker_connections 1024; }

http {
  upstream lynk_backend {
    server app1:3000;
    server app2:3000;
  }

  server {
    listen 80;

    location / {
      proxy_pass http://lynk_backend;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
  }
}
```

---

## Getting Started

### Prerequisites

- Docker Desktop with at least 4 GB RAM allocated
- Node.js 20 for local development and running tests
- k6 for load testing
- `psql` client for database inspection

### Setup

```bash
git clone <your-lynk-repo>
cd lynk
cp .env.example .env
# Edit .env — set JWT_SECRET to a random 256-bit string

docker compose up --build

# Run database migrations
docker compose exec app1 node dist/migrate.js

# Create a test user and get an API key
curl -X POST http://localhost/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
# Returns: { "apiKey": "eyJ..." }

# Create a short URL
curl -X POST http://localhost/api/urls \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very-long-url"}'
# Returns: { "shortCode": "abc1234", "shortUrl": "http://localhost/abc1234" }

# Follow the short URL
curl -L http://localhost/abc1234
```

### Running the load test

```bash
# Start the full stack
docker compose up -d

# Run k6 load test (from host machine)
k6 run load-test/k6.js

# View real-time metrics during the test
open http://localhost:3001/metrics  # Or configure Grafana
```

---

## Grading Criteria

| Criterion | Points | How it is evaluated |
|---|---|---|
| Core redirect path with Redis caching | 20 | k6 load test: p99 < 50ms at 1000 req/s |
| 10k req/s on read path | 15 | k6 load test: 10k req/s, p99 < 50ms |
| Write path with PostgreSQL | 10 | URLs created, persisted across restarts |
| Async analytics pipeline | 10 | Clicks recorded; Redis Stream → PG; no impact on redirect latency |
| Redis-based rate limiting | 10 | Limit respected across 2 instances; correct 429 response |
| JWT authentication | 5 | Write endpoints require valid JWT; redirects are public |
| Keyset pagination | 5 | `GET /api/urls` uses cursor, not offset |
| Docker Compose (2 instances + nginx) | 10 | `docker compose up` → nginx serving both instances |
| Observability | 5 | Structured logs, Prometheus metrics, health check |
| k6 load test script | 5 | Tests read path, write path, mixed; thresholds defined |
| Architecture decisions justified | 5 | Comments/ADRs in plan.md or code |
| **Total** | **100** | |

### The 10k req/s requirement

This is achievable on a modern laptop with the correct architecture. The
key is that the read path must touch Redis only (not PostgreSQL) on cache
hits. Redis running locally handles 100,000+ operations per second. The
bottleneck will be your Node.js application's throughput, not Redis.

With two Node.js instances behind nginx, you have two event loops handling
requests. At 10,000 req/s through nginx, each instance handles ~5,000 req/s.
A lean Express handler making one Redis call can handle this comfortably.

The most common failure modes:
1. Hitting PostgreSQL on the read path (ensure cache is warm before load test)
2. Logging synchronously at INFO level on every request (reduce to DEBUG,
   or use async pino transport)
3. Middleware overhead (keep middleware count low on the redirect route)

---

## Stretch Goals

1. **Short code deduplication**: if a user submits the same URL twice, return
   the existing short code rather than creating a new one. This requires
   either a unique index on `(user_id, original_url)` or a hash-based
   lookup. Measure the impact on write-path latency.

2. **Custom short codes**: allow the user to specify their own short code in
   `POST /api/urls` (`{ "url": "...", "customCode": "my-brand" }`). Handle
   collisions with a clear error.

3. **QR code generation**: `GET /api/urls/:shortCode/qr` returns a PNG QR
   code for the short URL. This is CPU-bound work — move it to a worker
   thread. Measure how it affects event loop lag without workers vs with.

4. **Click analytics by country**: add GeoIP lookup (using a free MaxMind
   database) in the click consumer. Record country code in the clicks table.
   Expose `GET /api/urls/:shortCode/analytics/geo` returning clicks by
   country.

5. **Kubernetes manifests**: convert your Docker Compose setup to Kubernetes
   manifests (Deployments, Services, ConfigMaps, Secrets, HorizontalPodAutoscaler).
   Deploy to a local Minikube or k3d cluster. Demonstrate rolling deployment
   with zero downtime.

6. **Read replica for analytics**: set up a PostgreSQL read replica in
   Docker Compose (using logical replication). Route analytics queries to
   the replica, write queries to the primary. Observe that heavy analytics
   queries on the replica do not affect write-path latency.
