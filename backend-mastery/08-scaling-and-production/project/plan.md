# ShipIt: Implementation Plan

This document breaks the ShipIt project into seven phases. Each phase is
independently deployable and testable — you can stop after any phase and
have a working (if incomplete) system. Work through them in order; each
phase builds on the previous.

---

## Phase 1: Dockerfile + docker-compose

**Goal:** Run Snip in Docker with `docker compose up --build`.

### Step 1.1: Write .dockerignore first

Before writing the Dockerfile, write `.dockerignore`. This is not optional —
without it, `docker build` sends your entire `node_modules` (potentially
hundreds of MB) to the Docker daemon on every build.

```
node_modules
npm-debug.log*
.git
.gitignore
.env
.env.*
*.md
*.test.ts
*.spec.ts
coverage/
dist/
.nyc_output/
.eslintrc*
.prettierrc*
docker-compose*.yml
Dockerfile*
README*
load-test/
```

### Step 1.2: Write the Dockerfile

Follow the three-stage pattern: deps → builder → production.

Key decisions to validate as you go:
- Does `docker build --target production .` succeed?
- Does `docker run -p 3000:3000 --env-file .env <image>` start the server?
- Does `docker images <image>` show a size under 300 MB?
- Does `docker run --rm <image> id` show a non-root UID?
- Does `docker run --rm <image> ls /app` NOT show `.ts` files?

### Step 1.3: Write docker-compose.yml

Start with just `app` and `redis`. Add PostgreSQL if your Snip
implementation uses it (it should).

Order to get right:
1. Redis service with health check (`redis-cli ping`)
2. PostgreSQL service with health check (`pg_isready`)
3. App service with `depends_on: condition: service_healthy` for both
4. Named volumes for Redis and PostgreSQL data
5. Environment variables loaded from `.env`
6. Port mapping for the app

### Step 1.4: Write .env.example

Document every variable the stack needs. Every variable must have a
comment explaining what it does.

```
# Application
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://snip:snip@db:5432/snip

# Redis
REDIS_URL=redis://redis:6379

# Rate limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_SECONDS=60
```

### Verification

```bash
docker compose up --build
curl http://localhost:3000/
# Should see the app respond (or at least connect — health endpoint is Phase 4)

docker compose down -v
docker compose up -d
# Should come back up without rebuild
```

**Gotcha:** If your app reads `DATABASE_URL` as `localhost:5432` hardcoded
anywhere in tests or config, it will fail inside Docker. The hostname must
be the service name (`db`). Audit all database connection strings.

**Gotcha:** The Alpine image does not have `bash`. Any `CMD` or `ENTRYPOINT`
that uses bash will fail silently. Use `sh` or (better) exec form.

---

## Phase 2: Structured Logging (Pino)

**Goal:** Replace all `console.log` / `console.error` with Pino. Every
meaningful event emits a structured JSON log line.

### Step 2.1: Install and configure Pino

```bash
npm install pino pino-pretty
npm install --save-dev @types/pino
```

Create `src/lib/logger.ts`:
- Export a singleton logger configured from `process.env.LOG_LEVEL`
- Use `pino-pretty` transport in development, raw JSON in production
- Set `base` fields: service name, version, env
- Configure `redact` for `authorization` header and `password` fields

### Step 2.2: Request logging middleware

Create `src/middleware/request-logger.ts`:
- Extract `x-request-id` header or generate a UUID
- Create a child logger with `{ traceId, method, url }`
- Attach to `req.log`
- On `res.finish`, log at `info` level with `statusCode` and `durationMs`
- Set `x-request-id` in the response header

Attach to Express: `app.use(requestLoggingMiddleware)` before routes.

### Step 2.3: Replace all console calls

Systematically search and replace:
```bash
grep -rn "console\." src/
```

Replace each one with the appropriate Pino call:
- `console.log` → `req.log.info(...)` (in request context) or `logger.info(...)` (elsewhere)
- `console.error` → `logger.error({ err }, 'message')`
- `console.warn` → `logger.warn(...)`

The pattern for errors: always pass the error as the first argument in a
`{ err }` object, not as a string or part of the message:
```typescript
// BAD
logger.error(`Database error: ${err.message}`);

// GOOD
logger.error({ err }, 'Database query failed');
```

### Step 2.4: Startup and shutdown logs

In `src/index.ts`, add:
- `logger.info({ port, nodeEnv, nodeVersion }, 'Server starting')` before `listen()`
- `logger.info({ port }, 'Server listening')` in the listen callback
- `logger.info({ signal }, 'Shutdown signal received')` in SIGTERM handler (Phase 5)

### Verification

```bash
NODE_ENV=development node -r ts-node/register src/index.ts
# Should see pretty-printed colored output

NODE_ENV=production node dist/index.js
# Should see raw JSON, one object per line

# Pipe to jq to verify structure
NODE_ENV=production node dist/index.js 2>&1 | jq '.level, .msg, .traceId'
```

**Gotcha:** Pino writes to stdout. Make sure you have not accidentally
redirected stderr only. Use `2>&1 | jq` to see all output.

**Gotcha:** `req.log` is not available on the `req` object by default.
You need to augment the Express `Request` type:
```typescript
// src/types/express.d.ts
import { Logger } from 'pino';
declare global {
  namespace Express {
    interface Request {
      log: Logger;
      traceId: string;
    }
  }
}
```

---

## Phase 3: Prometheus Metrics

**Goal:** `GET /metrics` returns valid Prometheus text format with all
required metrics populated.

### Step 3.1: Install prom-client

```bash
npm install prom-client
```

### Step 3.2: Create metrics module

Create `src/lib/metrics.ts`:
- Create a custom `Registry` (not the default global one — easier to test)
- Call `collectDefaultMetrics({ register: registry })`
- Define and export all required metrics (Counter, Histogram, Gauge)
- Export the registry

Defining metrics once at module load time is correct. Do NOT define metrics
inside route handlers or middleware constructors.

### Step 3.3: Metrics middleware

Add HTTP metrics collection to the request logger middleware (or create a
separate middleware):
- `httpRequestsTotal.inc(...)` on `res.finish`
- `httpRequestDuration.startTimer()` at request start, `end(...)` on finish
- `activeConnections.inc()` on request, `activeConnections.dec()` on finish

The `route` label is tricky: `req.path` gives you the literal path with
IDs embedded (`/abc123`), which creates high cardinality. Use `req.route?.
path` instead, which gives you the Express route pattern (`/:shortCode`).
Check `req.route` after the route handlers have matched; it is undefined
before.

### Step 3.4: Register the metrics endpoint

```typescript
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
```

Register this before your other routes. It must not go through
authentication middleware.

### Step 3.5: Increment business metrics in handlers

In `POST /api/urls` handler: `urlCreationsTotal.inc()`
In `GET /:shortCode` handler: `urlRedirectsTotal.inc()` on success,
`urlNotFoundTotal.inc()` on miss
In rate limit middleware: `rateLimitRejectionsTotal.inc()`

### Verification

```bash
curl http://localhost:3000/metrics | grep "http_requests_total"
# Should see metric definitions and current values

# Make a few requests, then check again
for i in $(seq 1 10); do curl -s http://localhost:3000/health; done
curl http://localhost:3000/metrics | grep "http_requests_total"
# Counter should have incremented
```

**Gotcha:** Do not put slashes in label values. `req.route?.path` might
return `undefined` for unmatched routes (404s). Use a fallback:
```typescript
const route = (req.route?.path as string) || 'unmatched';
```

---

## Phase 4: Health Check Endpoint

**Goal:** `GET /health` accurately reflects whether the app can serve traffic.

### Step 4.1: Implement the health check

```typescript
app.get('/health', async (req, res) => {
  const checks = await Promise.allSettled([
    checkRedis(),
    checkDatabase(),
  ]);

  const redis = checks[0].status === 'fulfilled'
    ? { status: 'ok' }
    : { status: 'error', error: checks[0].reason.message };

  const database = checks[1].status === 'fulfilled'
    ? { status: 'ok' }
    : { status: 'error', error: checks[1].reason.message };

  const allOk = redis.status === 'ok' && database.status === 'ok';

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dependencies: { redis, database },
  });
});
```

The `checkRedis()` function must issue an actual `PING` command and await
the response. The `checkDatabase()` function must execute `SELECT 1` and
await the result. Do not just check if the connection object exists — check
if it works.

### Step 4.2: Update the Dockerfile HEALTHCHECK

The Dockerfile's HEALTHCHECK should hit `/health`:
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1
```

### Verification

```bash
# Normal operation
curl http://localhost:3000/health
# { "status": "ok", "dependencies": { "redis": { "status": "ok" }, ... } }

# With Redis stopped
docker compose stop redis
curl http://localhost:3000/health
# HTTP 503, { "status": "degraded", ... }
# redis.status should be "error"

docker compose start redis
curl http://localhost:3000/health
# Back to 200 ok
```

---

## Phase 5: Graceful Shutdown

**Goal:** `docker stop <container>` results in zero dropped requests.

### Step 5.1: Implement the shutdown handler

In `src/index.ts`:

```typescript
let isShuttingDown = false;

// Middleware to reject new requests during shutdown
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'Server shutting down' });
  }
  next();
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');
  isShuttingDown = true;

  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 30_000).unref();

  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await db.end();
      logger.info('Database pool closed');
      await redis.quit();
      logger.info('Redis connection closed');
      clearTimeout(timeout);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### Step 5.2: Test it manually

```bash
# Start the app
docker compose up -d

# Send a slow request (your app needs a slow endpoint for testing)
curl -s "http://localhost:3000/test/slow?delay=5000" &

# Immediately send SIGTERM
docker stop snip  # This sends SIGTERM, waits 10s, then SIGKILL

# Check logs
docker logs snip
```

In the logs you should see:
1. "Shutdown signal received"
2. (5 seconds pass while the slow request completes)
3. "HTTP server closed"
4. "Database pool closed"
5. "Redis connection closed"
6. "Graceful shutdown complete"

And `docker stop` should complete in ~5 seconds, not 10 (not hitting the
SIGKILL timeout).

**Gotcha:** `docker stop` defaults to a 10-second timeout before SIGKILL.
If your in-flight requests take longer than 10 seconds, they will be killed.
Increase the timeout: `docker stop --time 30 snip` or set
`stop_grace_period: 30s` in docker-compose.yml.

**Gotcha:** If your Dockerfile uses shell form for CMD (`CMD node dist/index.js`),
Node.js does not receive SIGTERM because `/bin/sh` is PID 1, not Node. Always
use exec form: `CMD ["node", "dist/index.js"]`.

---

## Phase 6: GitHub Actions CI

**Goal:** Push to any branch → tests run. Push to main → tests run, then
Docker image builds and pushes to GHCR.

### Step 6.1: Set up the repository

- Push your code to GitHub
- Go to Settings → Actions → General → enable "Read and write permissions"
  for `GITHUB_TOKEN` (needed to push to GHCR)
- No secrets are needed for GHCR with `GITHUB_TOKEN` — it is automatic

### Step 6.2: Write the workflow

Create `.github/workflows/ci.yml`.

Key configuration details:
- Services (postgres, redis) in the job use `options:` for health checks and `ports:` to expose to localhost
- Use `actions/setup-node@v4` with `cache: npm` for fast installs
- The build job must have `permissions: packages: write` to push to GHCR
- Use `docker/metadata-action` to generate consistent image tags
- Use `cache-from: type=gha` and `cache-to: type=gha,mode=max` for layer caching

### Step 6.3: Verify

```bash
git push origin main
# Go to GitHub Actions tab
# Watch the workflow run
# After success: docker pull ghcr.io/<owner>/<repo>:latest
```

**Gotcha:** Service containers in GitHub Actions expose ports to `localhost`
on the runner, but your test code's `DATABASE_URL` must use `localhost`, not
a service name. Unlike Compose, there is no DNS for service names on the runner.

**Gotcha:** GHCR image names must be lowercase. `github.repository` is
`Owner/RepoName` — use `${{ env.IMAGE_NAME }}` set to `${{ github.repository }}`
and pipe through lowercase: `echo "$IMAGE" | tr '[:upper:]' '[:lower:]'`.

---

## Phase 7: k6 Load Test

**Goal:** A passing load test proves the containerized app handles sustained
traffic within defined SLOs.

### Step 7.1: Write the load test

Create `load-test/k6.js` using the template from the project README.

### Step 7.2: Run against the Compose stack

```bash
docker compose up -d
k6 run load-test/k6.js
```

### Step 7.3: Interpret results

k6 outputs a summary. Key metrics to check:
- `http_req_duration` p95: is it under 200ms?
- `http_req_failed`: is the failure rate under 1%?
- `redirect_success_rate`: is it above 99%?

If thresholds fail, k6 exits with a non-zero code. Investigate by looking
at the app logs: `docker compose logs app --since 2m`.

### Step 7.4: Document results

Create `load-test/results.md` with:
- When you ran the test
- Hardware (your laptop specs / number of CPUs)
- Results for all three thresholds
- Any bottlenecks observed (CPU, database connections, etc.)

**Gotcha:** k6 cannot resolve Docker service names. Run the load test from
your host machine and use `localhost:3000`. If running k6 in Docker, use
`host.docker.internal:3000`.

---

## Key Decisions

### Why Pino over Winston?

Pino is significantly faster than Winston at high log volumes — benchmark
comparisons show 5-10x difference. At 10,000 requests/second, each emitting
2-3 log lines, that is 20,000-30,000 log writes per second. Winston's
synchronous string formatting would become a bottleneck. Pino offloads
formatting to a transport process.

Additionally, Pino's JSON output is more consistent. Winston's JSON output
can vary depending on the configured formatters, making log parsing brittle.

### Why a custom Registry for Prometheus?

The default global registry is a singleton. If you accidentally define the
same metric name twice (common in tests that run setup code multiple times),
you get an error. A custom registry isolates each test run and allows
cleanup between tests.

### Why named volumes rather than bind mounts for database data?

Bind mounts on Docker Desktop (macOS, Windows) have severe I/O performance
problems because the host filesystem is shared across the VM boundary.
PostgreSQL on a bind mount can be 10-50x slower than on a named volume.
Named volumes live inside the Linux VM and get native filesystem performance.

### Why `condition: service_healthy` over `depends_on` with just a service name?

`depends_on: db` only waits for the container to start, not for PostgreSQL
to be ready. PostgreSQL takes 3-10 seconds to initialize. Without
`service_healthy`, your app will try to connect before the database accepts
connections, causing connection errors and potentially a crash loop.

### Why `stop_grace_period: 30s` in docker-compose.yml?

The default Docker stop timeout is 10 seconds. A database query or a slow
client can easily take longer. Setting a 30-second grace period gives
in-flight requests time to complete before the container is forcefully killed.

---

## Gotchas to Watch Out For

| Gotcha | Symptom | Fix |
|---|---|---|
| Shell form CMD | SIGTERM not received by Node | Use exec form: `CMD ["node", "dist/index.js"]` |
| node_modules in bind mount | Wrong architecture binaries | Add `/app/node_modules` anonymous volume |
| No .dockerignore | Slow builds, huge context | Create before first build |
| Metric label cardinality | OOM in Prometheus | Use `req.route?.path`, not `req.path` |
| `localhost` vs service name | Connection refused in Docker | Use service names inside Docker, localhost outside |
| Missing health check | Compose starts app before DB ready | Add `condition: service_healthy` |
| V8 heap defaults | OOM kill at 80% container memory | Set `--max-old-space-size` to ~80% of limit |
| `.env` committed | Credentials in git history | Add to `.gitignore` immediately |
| `GITHUB_TOKEN` case | GHCR push permission denied | Check repository settings → Actions permissions |
