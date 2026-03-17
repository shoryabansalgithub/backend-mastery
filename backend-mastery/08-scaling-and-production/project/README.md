# ShipIt: Containerize and Observe Snip

## Overview

In Module 01 you built **Snip** — a URL shortener. It works. It runs on
your machine. Now it is time to make it shippable.

ShipIt is not about adding features. It is about taking existing software
and making it production-ready: containerized, observable, resilient, and
deployable through a repeatable automated process. This is the work that
separates "it works on my laptop" from "it runs in production at 3 AM
without anyone watching."

By the end of this project, Snip will:
- Run in a Docker container, reproducibly, on any machine
- Spin up a complete local environment (app + Redis) with one command
- Log every meaningful event as structured JSON
- Expose Prometheus metrics for request rates, latencies, and business events
- Serve a health check that reflects true dependency readiness
- Shut down gracefully when the container is told to stop
- Build, test, and push automatically when you push to GitHub

You are working with the codebase you built. If you did not complete Module 01,
a reference implementation is available in the course repository.

---

## Architecture

```
Internet
    │
    ▼
┌─────────────────────────┐
│  Snip (Node.js/Express) │   :3000
│  - URL shortener API    │
│  - /health              │
│  - /metrics             │
└──────────┬──────────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────┐  ┌────────────┐
│  Redis  │  │ PostgreSQL │
│ :6379   │  │  :5432     │
│ Rate    │  │ Persistent │
│ limiting│  │ URL store  │
└─────────┘  └────────────┘
```

Redis handles rate limiting counters and (optionally) a short-TTL cache
for the redirect path. PostgreSQL stores URLs persistently. The app is
completely stateless — no in-process state that prevents horizontal scaling.

---

## Requirements

### 1. Multi-Stage Dockerfile

The production Docker image must:
- Use a multi-stage build (at minimum: deps, builder, production stages)
- Use `node:20-alpine` as the base
- Run as a non-root user
- Include a `HEALTHCHECK` instruction
- NOT contain TypeScript source files, `tsconfig.json`, or devDependencies
- Use exec form for `CMD`/`ENTRYPOINT` so Node.js receives signals directly
- Set `NODE_OPTIONS=--max-old-space-size=400` to bound V8 heap
- Have a `.dockerignore` that excludes `node_modules`, `.git`, `.env`, and test files

The final image should be under 300 MB. Document the image size in a comment
at the top of the Dockerfile.

### 2. docker-compose.yml

The Compose file must:
- Define three services: `app`, `redis`, and (optionally) `postgres`
- Use health checks on `redis` (and `postgres` if included), with
  `condition: service_healthy` in the app's `depends_on`
- Load configuration from a `.env` file (with `.env.example` committed)
- Use named volumes for Redis (and PostgreSQL) data persistence
- Define a custom network so containers communicate by service name
- Define resource limits: app at 512 MB / 0.5 CPU
- Include a dev profile with `redis-commander` for local inspection

### 3. Structured Logging with Pino

Every meaningful event must emit a structured JSON log line. Required log
events:

| Event | Level | Required fields |
|---|---|---|
| Server starting | info | port, nodeEnv, nodeVersion |
| Server listening | info | port |
| Request received | debug | method, url, traceId |
| Request completed | info | method, url, statusCode, durationMs, traceId |
| URL created | info | shortCode, originalUrl, userId (if auth), traceId |
| URL not found | warn | shortCode, traceId |
| Rate limit exceeded | warn | clientId, limit, traceId |
| Database error | error | err (with stack), operation, traceId |
| SIGTERM received | info | — |
| Shutdown complete | info | — |
| Uncaught exception | fatal | err (with stack) |

All request-scoped logs must include `traceId` (from `x-request-id` header
or generated). Sensitive fields (`authorization` header, `password`) must
be redacted.

In development (`NODE_ENV=development`), logs should be pretty-printed via
`pino-pretty`. In production, raw JSON only.

### 4. Prometheus Metrics

The app must expose `GET /metrics` in Prometheus text format. Required metrics:

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | Counter | method, route, status_code | All HTTP requests |
| `http_request_duration_seconds` | Histogram | method, route, status_code | Request duration |
| `http_active_connections` | Gauge | — | Currently active HTTP connections |
| `url_creations_total` | Counter | — | Short URLs created |
| `url_redirects_total` | Counter | — | Successful redirects |
| `url_not_found_total` | Counter | — | Redirect miss (short code not found) |
| `rate_limit_rejections_total` | Counter | — | Requests rejected by rate limiter |

Additionally, default Node.js runtime metrics must be collected via
`collectDefaultMetrics()`.

The `/metrics` endpoint must not require authentication.

### 5. Health Check Endpoint

`GET /health` must return:

```json
{
  "status": "ok",
  "uptime": 42.3,
  "timestamp": "2024-03-17T10:00:00.000Z",
  "dependencies": {
    "redis": "ok",
    "postgres": "ok"
  }
}
```

If any dependency check fails, return HTTP 503 and set that dependency's
status to `"error"` with an `"error"` field explaining the failure.

The health check must actually test connectivity — ping Redis with `PING`,
query PostgreSQL with `SELECT 1`.

### 6. GitHub Actions CI Pipeline

Create `.github/workflows/ci.yml` with the following jobs:

**Job: test**
- Trigger: push to any branch, pull_request to main
- Runner: ubuntu-latest
- Services: PostgreSQL 16 + Redis 7 (with health checks)
- Steps: checkout, setup Node 20, `npm ci`, type check, lint, test
- Upload coverage report

**Job: build** (only on push to `main`, depends on `test`)
- Log in to GitHub Container Registry (GHCR) with `GITHUB_TOKEN`
- Build multi-stage Docker image targeting `production`
- Tag with both `sha-<commit>` and `latest`
- Push to `ghcr.io/<owner>/<repo>`
- Use GitHub Actions cache for Docker layer caching (`cache-from: type=gha`)

The workflow must fail fast: if tests fail, the build job does not run.

### 7. Graceful Shutdown

The application must handle SIGTERM correctly:

1. Set a flag to return 503 to new requests immediately
2. Call `server.close()` to stop accepting new connections
3. Wait for in-flight requests to complete (up to 30 seconds)
4. Close the database connection pool
5. Close the Redis connection
6. Log each step at `info` level
7. Exit with code 0

Verify this works by: starting the server, sending a slow request (that
takes ~5 seconds), then sending SIGTERM. Confirm the slow request completes
and the server exits cleanly.

### 8. Environment-Based Configuration

All configuration must come from environment variables. On startup, validate
that required variables are present and fail fast with a clear error if
any are missing.

Required environment variables:

```
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@localhost:5432/snip
REDIS_URL=redis://localhost:6379
LOG_LEVEL=info
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_SECONDS=60
```

The validation function must run before the server starts. If `DATABASE_URL`
is missing, the process must exit with a clear error message, not crash with
a confusing `undefined is not a string` later.

```typescript
function validateConfig() {
  const required = ['DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}
validateConfig(); // Must be first thing that runs
```

### 9. k6 Load Test

Write a k6 load test script at `load-test/k6.js` that:
- Creates 10 short URLs using `POST /api/urls`
- Performs 1000 GET requests (redirects) spread across those short codes
- Uses 10 virtual users for 30 seconds
- Defines pass/fail thresholds:
  - p95 response time < 200ms
  - Error rate < 1%
  - Redirect success rate (HTTP 302) > 99%

```javascript
// load-test/k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
    redirect_success_rate: ['rate>0.99'],
  },
};

const redirectSuccess = new Rate('redirect_success_rate');

export function setup() {
  // Create 10 short URLs before the test
  const shortCodes = [];
  for (let i = 0; i < 10; i++) {
    const res = http.post(
      'http://localhost:3000/api/urls',
      JSON.stringify({ url: `https://example.com/page-${i}` }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    shortCodes.push(res.json('shortCode'));
  }
  return { shortCodes };
}

export default function (data) {
  const code = data.shortCodes[Math.floor(Math.random() * data.shortCodes.length)];
  const res = http.get(`http://localhost:3000/${code}`, {
    redirects: 0,  // Don't follow — we want to verify the 302
  });

  const success = check(res, {
    'is 302': (r) => r.status === 302,
    'has location header': (r) => r.headers['Location'] !== undefined,
  });
  redirectSuccess.add(success);

  sleep(0.1);
}
```

---

## Getting Started

### Prerequisites

- Docker Desktop installed and running
- Node.js 20 installed locally (for running tests without Docker)
- k6 installed (for load tests): https://k6.io/docs/getting-started/installation/

### Initial setup

```bash
# Clone your Module 01 Snip codebase (or the reference implementation)
git clone <your-snip-repo> snip-shipit
cd snip-shipit

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values

# Start the full stack
docker compose up --build

# Verify health
curl http://localhost:3000/health

# Check metrics
curl http://localhost:3000/metrics | head -40

# Open Redis Commander (dev profile)
docker compose --profile dev up -d
open http://localhost:8081
```

### Running tests

```bash
# Unit + integration tests (requires .env with test database)
npm test

# Load test (requires the app to be running)
docker compose up -d
k6 run load-test/k6.js
```

### Building the Docker image manually

```bash
# Build production image
docker build --target production -t snip:local .

# Inspect size
docker images snip:local

# Run it
docker run -p 3000:3000 \
  -e DATABASE_URL="..." \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  snip:local
```

---

## Grading Criteria

| Criterion | Points | How it is evaluated |
|---|---|---|
| Multi-stage Dockerfile | 15 | Image builds, runs, is < 300 MB, runs as non-root |
| docker-compose.yml | 10 | `docker compose up` brings up full stack cleanly |
| Structured logging (Pino) | 15 | All required events logged; dev pretty-print; prod JSON |
| Prometheus metrics | 15 | All required metrics exposed at `/metrics`; correct types |
| Health check endpoint | 10 | Correctly reflects dependency status; returns 503 on failure |
| GitHub Actions CI | 10 | Tests run; image builds and pushes on merge to main |
| Graceful shutdown | 10 | SIGTERM test: in-flight requests complete; clean exit |
| Env config validation | 5 | Missing var causes clear error at startup, not crash later |
| k6 load test | 10 | Script runs; thresholds defined; results documented |
| Code quality | 5 | TypeScript, linting, no console.log, no secrets committed |
| **Total** | **105** | |

---

## Stretch Goals

These are not graded but will prepare you directly for the capstone.

1. **Redis caching on the read path**: cache the `shortCode → originalUrl`
   mapping in Redis with a 5-minute TTL. On a redirect, check Redis first.
   On a miss, query PostgreSQL and populate the cache. Add a `cache_hits_total`
   and `cache_misses_total` metric. Measure the latency difference in k6.

2. **Docker Compose with two app instances + nginx**: add an nginx service to
   docker-compose.yml configured as a round-robin load balancer in front of
   two `app` instances. Add a `server_id` field to logs (use the container
   hostname or an env var) to verify that requests are distributed.

3. **Prometheus + Grafana**: add Prometheus and Grafana services to
   docker-compose.yml (dev profile). Configure Prometheus to scrape your
   app's `/metrics` endpoint. Create a Grafana dashboard showing request
   rate, p95 latency, and active connections. Export the dashboard JSON.

4. **Startup probe**: implement a `GET /ready` endpoint (separate from
   `/health`) that returns 503 until the app has fully initialized
   (database migrations run, connection pools warmed up). Use this as the
   Compose healthcheck `start_period` trigger.

5. **Structured log querying**: set up Grafana Loki locally. Configure your
   Docker Compose to ship container logs to Loki via the Docker Loki log
   driver. Write LogQL queries to find all errors in the last hour, all
   requests to a specific short code, and all requests that exceeded 500ms.
