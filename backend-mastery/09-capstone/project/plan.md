# Lynk: Implementation Plan

This plan breaks the capstone into nine phases. Earlier phases give you a
working system that you continuously improve. You should be able to demo
a working URL shortener after Phase 2, with each subsequent phase adding
correctness, performance, or operability.

Read the entire plan before writing a line of code. Several decisions made
early (schema design, short code generation, module structure) are difficult
to change later. Understanding where you are going makes the journey shorter.

---

## Phase 1: Core Data Layer

**Goal:** PostgreSQL schema created, migrations running, connection pool
working. No HTTP layer yet.

### Step 1.1: Project structure

```
lynk/
├── src/
│   ├── db/
│   │   ├── pool.ts          # pg Pool singleton
│   │   ├── migrations/
│   │   │   ├── 001_create_users.sql
│   │   │   ├── 002_create_urls.sql
│   │   │   └── 003_create_clicks.sql
│   │   └── migrate.ts       # Migration runner
│   ├── redis/
│   │   └── client.ts        # ioredis singleton
│   ├── lib/
│   │   ├── logger.ts        # Pino
│   │   └── metrics.ts       # prom-client
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   └── index.ts
├── load-test/
│   └── k6.js
├── nginx/
│   └── nginx.conf
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

### Step 1.2: Write migrations

Write three SQL migration files. Run them in order. Each migration file
must be idempotent (use `CREATE TABLE IF NOT EXISTS`).

The clicks table partitioned by month requires you to think ahead. Create
partitions for the next 12 months as part of the initial migration. In
production, you would automate this; for the project, creating them manually
is fine.

### Step 1.3: Migration runner

```typescript
// src/db/migrate.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

async function migrate() {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrations = [
    '001_create_users',
    '002_create_urls',
    '003_create_clicks',
  ];

  for (const version of migrations) {
    const already = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [version]
    );
    if (already.rowCount > 0) {
      console.log(`Migration ${version}: already applied`);
      continue;
    }

    const sql = readFileSync(
      join(__dirname, 'migrations', `${version}.sql`),
      'utf8'
    );

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      await pool.query('COMMIT');
      console.log(`Migration ${version}: applied`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

### Step 1.4: Connection pool configuration

```typescript
// src/db/pool.ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,              // Max connections in pool
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});
```

The `max: 20` is deliberate. PostgreSQL handles ~100-500 connections total
before performance degrades. With two app instances each holding 20
connections, you are using 40 of the budget. Leave room for your analytics
consumer and for manual psql sessions during incidents.

### Verification

```bash
# Start only postgres and redis for now
docker compose up -d postgres redis

# Run migrations
DATABASE_URL=postgresql://... npx ts-node src/db/migrate.ts

# Verify schema
docker compose exec postgres psql -U lynk -d lynk -c '\dt'
```

---

## Phase 2: Basic URL CRUD (No Caching)

**Goal:** All API endpoints work correctly against PostgreSQL. No Redis yet.
No rate limiting. No auth. This is the "make it work" phase.

### Step 2.1: Short code generation

```typescript
// src/lib/shortcode.ts
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateRandomCode(length = 7): string {
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
}

export async function generateUniqueShortCode(
  db: Pool,
  length = 7
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRandomCode(length);
    const result = await db.query(
      'SELECT 1 FROM urls WHERE short_code = $1',
      [code]
    );
    if (result.rowCount === 0) return code;
  }
  // Extremely rare: 5 collisions in a row. Increase code length.
  return generateUniqueShortCode(db, length + 1);
}
```

### Step 2.2: URL validation

Before storing a URL, validate it:
- Must be a valid URL (use `new URL(input)` — it throws on invalid URLs)
- Must use `http:` or `https:` scheme (prevent `javascript:` XSS)
- Must not be longer than 2048 characters
- Must not be the domain you are hosting on (prevent redirect loops)

```typescript
function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ValidationError('Invalid URL format');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationError('URL must use http or https');
  }
  if (url.hostname === process.env.BASE_DOMAIN) {
    throw new ValidationError('Cannot shorten this domain');
  }
  return url;
}
```

### Step 2.3: Route handlers

Implement all routes in `src/routes/`. Keep handlers thin — business logic
in `src/services/`.

```typescript
// src/services/url.service.ts
export class UrlService {
  async createUrl(originalUrl: string, userId: string): Promise<Url> { ... }
  async getByShortCode(shortCode: string): Promise<Url | null> { ... }
  async listByUser(userId: string, cursor?: string, limit = 20): Promise<Page<Url>> { ... }
  async updateUrl(shortCode: string, userId: string, updates: Partial<Url>): Promise<Url> { ... }
  async deleteUrl(shortCode: string, userId: string): Promise<void> { ... }
}
```

### Step 2.4: Redirect handler

The redirect handler is the most important route. Keep it as fast as possible.

```typescript
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  // Validate format to avoid unnecessary DB queries
  if (!/^[a-zA-Z0-9_-]{4,12}$/.test(shortCode)) {
    return res.status(404).send('Not found');
  }

  const url = await urlService.getByShortCode(shortCode);

  if (!url || !url.isActive) {
    // Phase 4 will add: urlNotFoundTotal.inc()
    return res.status(404).send('Short URL not found');
  }

  // Queue analytics (Phase 4)
  // cacheService.set(shortCode, url.originalUrl); // Phase 3

  res.redirect(302, url.originalUrl);
});
```

The format validation (`/^[a-zA-Z0-9_-]{4,12}$/`) prevents SQL injection
attempts disguised as short codes and avoids DB lookups for clearly invalid
codes.

### Verification

```bash
# Test each endpoint manually
curl -X POST http://localhost:3000/api/urls \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

curl -L http://localhost:3000/<shortCode>

# Check the database
docker compose exec postgres psql -U lynk -d lynk \
  -c "SELECT * FROM urls ORDER BY created_at DESC LIMIT 5;"
```

---

## Phase 3: Redis Caching Layer

**Goal:** The read path serves from Redis. A cache miss falls back to
PostgreSQL and populates the cache. Cache hits are measurably faster.

### Step 3.1: Cache service

```typescript
// src/services/cache.service.ts
import { redis } from '../redis/client';

const TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

export const cacheService = {
  async get(shortCode: string): Promise<string | null> {
    return redis.get(`url:cache:${shortCode}`);
  },

  async set(shortCode: string, originalUrl: string): Promise<void> {
    await redis.setex(`url:cache:${shortCode}`, TTL_SECONDS, originalUrl);
  },

  async invalidate(shortCode: string): Promise<void> {
    await redis.del(`url:cache:${shortCode}`);
  },
};
```

### Step 3.2: Wire into redirect handler

```typescript
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  if (!/^[a-zA-Z0-9_-]{4,12}$/.test(shortCode)) {
    return res.status(404).send('Not found');
  }

  // Cache hit path (fast)
  const cached = await cacheService.get(shortCode);
  if (cached) {
    metrics.cacheHitsTotal.inc();
    // Phase 4: queue click event (non-blocking)
    return res.redirect(302, cached);
  }

  // Cache miss — fall back to PostgreSQL
  metrics.cacheMissesTotal.inc();
  const url = await urlService.getByShortCode(shortCode);

  if (!url || !url.isActive) {
    // Cache negative result too (prevents repeated DB hits for non-existent codes)
    // Use a shorter TTL for negative cache
    await redis.setex(`url:cache:${shortCode}:miss`, 60, '1');
    return res.status(404).send('Not found');
  }

  // Populate cache (write-through)
  await cacheService.set(shortCode, url.originalUrl);

  // Phase 4: queue click event

  res.redirect(302, url.originalUrl);
});
```

### Step 3.3: Write-through on URL creation

In `urlService.createUrl()`, after the INSERT, also write to cache:

```typescript
async createUrl(originalUrl: string, userId: string): Promise<Url> {
  const shortCode = await generateUniqueShortCode(this.db);

  const result = await this.db.query(
    'INSERT INTO urls (short_code, original_url, user_id) VALUES ($1, $2, $3) RETURNING *',
    [shortCode, originalUrl, userId]
  );
  const url = result.rows[0];

  // Write-through: populate cache immediately so the first redirect is a hit
  await cacheService.set(shortCode, originalUrl);

  return url;
}
```

### Step 3.4: Cache invalidation on deactivate/delete

```typescript
async updateUrl(shortCode: string, userId: string, updates: Partial<Url>): Promise<Url> {
  // ... update in PostgreSQL ...

  // If deactivating, remove from cache immediately
  if (updates.isActive === false) {
    await cacheService.invalidate(shortCode);
  }

  return updatedUrl;
}

async deleteUrl(shortCode: string, userId: string): Promise<void> {
  // ... delete from PostgreSQL ...
  await cacheService.invalidate(shortCode);
}
```

### Verification

```bash
# Warm the cache
curl http://localhost:3000/<shortCode>

# Second request should be faster and hit Redis
time curl http://localhost:3000/<shortCode>

# Verify cache key exists in Redis
docker compose exec redis redis-cli GET "url:cache:<shortCode>"

# Check metrics
curl http://localhost:3000/metrics | grep cache
```

---

## Phase 4: Async Analytics Pipeline (Redis Streams)

**Goal:** Every redirect queues a click event. A consumer reads from the
stream and writes to PostgreSQL in batches. The redirect path does NOT wait
for the DB write.

### Step 4.1: Publish click events

In the redirect handler, add the stream write BEFORE the redirect response
but do NOT await it. Fire and forget:

```typescript
// In redirect handler:
const clickEvent = {
  shortCode,
  clickedAt: Date.now().toString(),
  ip: req.ip || '',
  userAgent: req.headers['user-agent'] || '',
  referer: req.headers.referer || '',
};

// Fire and forget — do NOT await
redis.xadd('clicks:stream', '*', ...Object.entries(clickEvent).flat())
  .catch((err) => logger.error({ err }, 'Failed to queue click event'));

res.redirect(302, originalUrl);
```

The `*` tells Redis to auto-generate the message ID using the current
timestamp. The spread of `Object.entries(clickEvent).flat()` converts the
object into the key-value alternating format Redis XADD expects.

### Step 4.2: Consumer group setup

On startup (or in a migration), create the consumer group if it does not exist:

```typescript
async function setupStreams() {
  try {
    // MKSTREAM creates the stream if it does not exist
    await redis.xgroup('CREATE', 'clicks:stream', 'analytics-workers', '$', 'MKSTREAM');
    logger.info('Consumer group created');
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      // Group already exists — not an error
      return;
    }
    throw err;
  }
}
```

### Step 4.3: Consumer loop

```typescript
// src/consumers/click-consumer.ts
async function startClickConsumer() {
  const BATCH_SIZE = 100;
  const BLOCK_MS = 5000;  // Block for 5s waiting for new messages

  logger.info('Click consumer started');

  while (true) {
    try {
      const results = await redis.xreadgroup(
        'GROUP', 'analytics-workers', 'consumer-1',
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', 'clicks:stream', '>'  // '>' means new, undelivered messages
      );

      if (!results || results.length === 0) continue;

      const [, messages] = results[0] as [string, [string, string[]][]];
      if (!messages || messages.length === 0) continue;

      // Batch insert into PostgreSQL
      const clicks = messages.map(([id, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        return { id, ...obj };
      });

      await insertClicksBatch(clicks);

      // Acknowledge all processed messages
      const ids = messages.map(([id]) => id);
      await redis.xack('clicks:stream', 'analytics-workers', ...ids);

      logger.debug({ count: messages.length }, 'Click batch processed');
    } catch (err) {
      logger.error({ err }, 'Click consumer error');
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Back off on error
    }
  }
}

async function insertClicksBatch(clicks: ClickEvent[]) {
  if (clicks.length === 0) return;

  // Build multi-row INSERT for efficiency
  const values = clicks.map((_, i) => {
    const base = i * 5;
    return `($${base + 1}, to_timestamp($${base + 2}::bigint / 1000), $${base + 3}, $${base + 4}, $${base + 5})`;
  }).join(', ');

  const params = clicks.flatMap((c) => [
    c.shortCode,
    c.clickedAt,
    c.ip || null,
    c.userAgent || null,
    c.referer || null,
  ]);

  await pool.query(
    `INSERT INTO clicks (short_code, clicked_at, ip_address, user_agent, referer)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params
  );
}
```

Start the consumer as part of your main process (using `setImmediate` or as a
background task), or in a separate Docker service. Starting it in the same
process is simpler; a separate service scales better.

### Step 4.4: Pending message recovery

When a consumer crashes mid-batch, the messages are in the pending entries
list (PEL) — delivered but not acknowledged. On startup, check for pending
messages and process them:

```typescript
async function recoverPendingMessages() {
  const pending = await redis.xpending(
    'clicks:stream',
    'analytics-workers',
    '-',   // From the beginning
    '+',   // To the end
    100    // At most 100
  );

  if (pending.length > 0) {
    logger.info({ count: pending.length }, 'Recovering pending click messages');
    // Claim and process them
    const ids = pending.map((p: any) => p[0]);
    const claimed = await redis.xclaim(
      'clicks:stream', 'analytics-workers', 'consumer-1',
      0,  // Min idle time 0 (claim immediately)
      ...ids
    );
    if (claimed.length > 0) {
      await insertClicksBatch(/* parse claimed messages */);
      await redis.xack('clicks:stream', 'analytics-workers', ...ids);
    }
  }
}
```

### Verification

```bash
# Follow a short URL a few times
for i in $(seq 1 10); do curl -s http://localhost:3000/<shortCode>; done

# Check the stream
docker compose exec redis redis-cli XLEN clicks:stream
docker compose exec redis redis-cli XRANGE clicks:stream - + COUNT 5

# After consumer processes them, check PostgreSQL
docker compose exec postgres psql -U lynk -d lynk \
  -c "SELECT short_code, count(*) FROM clicks GROUP BY short_code;"
```

---

## Phase 5: Rate Limiting (Redis Token Bucket)

**Goal:** The write API is rate limited per authenticated user. Distributed —
works correctly with two app instances.

### Step 5.1: Implement the Lua-script token bucket

Use the Lua script approach from Lesson 5 (performance-and-resilience).
The key improvements for production:

- Key: `rate:{userId}:{windowStart}` where `windowStart` is `Math.floor(Date.now() / windowMs) * windowMs`
- Use a sliding window counter, not a fixed window (fixed window allows 2x
  the limit at window boundaries)
- Return `{ allowed: boolean, remaining: number, resetAt: number }`

### Step 5.2: Middleware

```typescript
// src/middleware/rate-limit.ts
export function rateLimitMiddleware(options: {
  max: number;
  windowSeconds: number;
}) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return next(); // Not authenticated — handled by auth middleware

    const result = await checkRateLimit(req.user.userId, options);

    res.setHeader('X-RateLimit-Limit', options.max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);

    if (!result.allowed) {
      metrics.rateLimitRejectionsTotal.inc();
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: result.resetAt - Math.floor(Date.now() / 1000),
      });
    }

    next();
  };
}

// Apply only to write endpoints
app.post('/api/urls',
  authenticate,
  rateLimitMiddleware({ max: 100, windowSeconds: 60 }),
  createUrlHandler
);
```

### Verification

```bash
# 101 rapid requests — the 101st should return 429
for i in $(seq 1 101); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost/api/urls \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    -d '{"url": "https://example.com"}'
done
# Should see 100 "201"s and 1 "429"

# Distributed test: alternate between the two app instances
# (same user ID, rate limit should still apply across both)
```

---

## Phase 6: Auth (JWT API Keys)

**Goal:** Write endpoints require a valid JWT. The JWT is issued once as an
"API key" — long-lived, suitable for programmatic access.

### Step 6.1: Token issuing

```typescript
// POST /api/auth/register
// POST /api/auth/regenerate-key

function issueApiKey(userId: string, email: string): string {
  return jwt.sign(
    {
      sub: userId,
      email,
      type: 'api_key',
    },
    process.env.JWT_SECRET!,
    {
      expiresIn: '365d',
      issuer: 'lynk',
      algorithm: 'HS256',
    }
  );
}
```

### Step 6.2: Auth middleware

```typescript
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
      issuer: 'lynk',
    }) as { sub: string; email: string; type: string };

    if (payload.type !== 'api_key') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    req.user = { userId: payload.sub, email: payload.email };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'API key expired — regenerate at /api/auth/regenerate-key' });
    }
    return res.status(401).json({ error: 'Invalid API key' });
  }
}
```

The redirect handler `GET /:shortCode` must NOT require authentication.
This is public. Only write operations require auth.

---

## Phase 7: Docker Compose Multi-Instance Setup

**Goal:** Two app instances behind nginx. Both serve the same data via shared
PostgreSQL and Redis. The load balancer distributes requests between them.

### Step 7.1: nginx configuration

```nginx
# nginx/nginx.conf
events {
  worker_connections 4096;
}

http {
  upstream lynk_backend {
    server app1:3000;
    server app2:3000;
    keepalive 64;  # Keep connections open to backends
  }

  server {
    listen 80;
    server_name _;

    # Pass real client IP to app
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;

    # Important for Node.js graceful shutdown
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    location / {
      proxy_pass http://lynk_backend;
    }
  }
}
```

### Step 7.2: Docker Compose

Add `app1` and `app2` services with identical configuration, differentiated
only by `INSTANCE_ID`. Use `extends` or anchor YAML to avoid repetition:

```yaml
# docker-compose.yml
x-app-base: &app-base
  build: .
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
  env_file: .env
  environment:
    PORT: 3000
    NODE_ENV: production

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
    <<: *app-base
    environment:
      INSTANCE_ID: app1

  app2:
    <<: *app-base
    environment:
      INSTANCE_ID: app2
```

### Step 7.3: Verify load balancing

```bash
# Add INSTANCE_ID to every log line and response header
# Check that requests alternate between app1 and app2
for i in $(seq 1 10); do
  curl -s http://localhost/ -o /dev/null -D - | grep "x-instance-id"
done
# Should see app1 and app2 alternating
```

---

## Phase 8: Observability

**Goal:** Full Pino logging, Prometheus metrics, health checks. This is
largely the same as the ShipIt project. Apply the patterns from Lessons 4
and 5 to Lynk.

### Additional Lynk-specific metrics

Beyond the standard HTTP metrics from Phase 3 (ShipIt), add:

```typescript
const cacheHitsTotal = new Counter({ name: 'lynk_cache_hits_total', ... });
const cacheMissesTotal = new Counter({ name: 'lynk_cache_misses_total', ... });
const urlCreationsTotal = new Counter({ name: 'lynk_url_creations_total', ... });
const urlRedirectsTotal = new Counter({ name: 'lynk_url_redirects_total', ... });
const clickQueueDepth = new Gauge({
  name: 'lynk_click_queue_depth',
  help: 'Number of unprocessed click events in the stream',
  async collect() {
    const len = await redis.xlen('clicks:stream');
    this.set(len);
  },
});
```

The `clickQueueDepth` gauge is collected asynchronously — it queries Redis
when Prometheus scrapes. If this grows unboundedly, the consumer is down or
falling behind. Alert on `lynk_click_queue_depth > 10000`.

---

## Phase 9: Load Testing

**Goal:** The k6 load test demonstrates 10,000 req/s on the read path with
p99 < 50ms.

### Step 9.1: Write the k6 script

```javascript
// load-test/k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const redirectSuccess = new Rate('redirect_success_rate');
const cacheHitLatency = new Trend('cache_hit_latency_ms');
const cacheMissLatency = new Trend('cache_miss_latency_ms');

export const options = {
  scenarios: {
    // Read path: ramp up to 10k req/s over 1 minute, hold for 2 minutes
    read_path: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 500,
      stages: [
        { target: 1000, duration: '30s' },
        { target: 5000, duration: '30s' },
        { target: 10000, duration: '30s' },
        { target: 10000, duration: '120s' },
      ],
    },
    // Write path: 10 req/s constant (100x less than reads)
    write_path: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      duration: '3m',
    },
  },
  thresholds: {
    'http_req_duration{scenario:read_path}': ['p(99)<50', 'p(95)<20'],
    'http_req_duration{scenario:write_path}': ['p(99)<500'],
    redirect_success_rate: ['rate>0.999'],
    http_req_failed: ['rate<0.001'],
  },
};

// Pre-create short codes in setup()
export function setup() {
  const codes = [];
  for (let i = 0; i < 100; i++) {
    const res = http.post(
      'http://localhost/api/urls',
      JSON.stringify({ url: `https://example.com/page-${i}` }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${__ENV.API_KEY}`,
        },
      }
    );
    if (res.status === 201) {
      codes.push(res.json('shortCode'));
    }
  }
  console.log(`Created ${codes.length} short URLs for load test`);
  return { codes };
}

export default function (data) {
  if (__ENV.SCENARIO === 'write') {
    // Write scenario
    const res = http.post(
      'http://localhost/api/urls',
      JSON.stringify({ url: `https://example.com/${Date.now()}` }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${__ENV.API_KEY}`,
        },
      }
    );
    check(res, { 'url created': (r) => r.status === 201 });
    return;
  }

  // Read scenario (default)
  const code = data.codes[Math.floor(Math.random() * data.codes.length)];
  const start = Date.now();
  const res = http.get(`http://localhost/${code}`, {
    redirects: 0,
  });
  const duration = Date.now() - start;

  const success = check(res, {
    'is 302': (r) => r.status === 302,
    'has location': (r) => !!r.headers['Location'],
  });

  redirectSuccess.add(success ? 1 : 0);
}
```

### Step 9.2: Warm the cache before the load test

The first request for each short code is a cache miss (slow). Warm all
100 codes before starting the sustained load:

```bash
# In load-test/warm.sh
for code in $(cat load-test/codes.txt); do
  curl -s -o /dev/null http://localhost/$code
done
echo "Cache warmed"
```

Or do it in k6's `setup()` function with a warmup loop before returning the
data to the main function.

### Step 9.3: Run and document

```bash
API_KEY=<your-api-key> k6 run load-test/k6.js

# Save results
API_KEY=<your-api-key> k6 run --out json=results.json load-test/k6.js
```

Create `load-test/results.md` with:
- Test date and hardware
- Which thresholds passed
- Peak req/s achieved
- p50, p95, p99, max latency at peak
- Any bottleneck identified and what you changed

---

## Architecture Decision Records (ADR)

### ADR-001: Redis cache TTL = 5 minutes

**Context:** URL redirects need to be fast. Serving from Redis is 10-100x
faster than PostgreSQL. But cached data can be stale if a URL is deactivated.

**Decision:** Cache TTL of 5 minutes (300 seconds). On deactivation or
deletion, proactively invalidate the cache entry.

**Consequences:** A deactivated URL can still redirect for up to 5 minutes
if the cache entry is not invalidated (e.g., if the app that handles the
PATCH request fails after writing to PostgreSQL but before writing to Redis).
This is acceptable for a URL shortener. The proactive invalidation handles
the normal case; the TTL handles edge cases.

**Alternative considered:** 1-minute TTL — fewer stale hits but 5x more
cache misses and thus 5x more PostgreSQL reads.

### ADR-002: Async click recording via Redis Streams

**Context:** Recording clicks synchronously adds a PostgreSQL write to the
redirect hot path, increasing p99 latency and coupling redirect availability
to analytics availability.

**Decision:** Publish click events to a Redis Stream. A separate consumer
reads in batches and writes to PostgreSQL. Redirects do not wait for the
write to complete.

**Consequences:** Click data is eventually consistent — up to ~5 seconds
behind real-time depending on consumer batch timing and load. If the consumer
is down, clicks queue up in the stream (bounded by Redis memory). If Redis
is down, clicks are lost (acceptable — analytics data, not business-critical).

**Alternative considered:** Message queue (RabbitMQ, Kafka) — more durable
but significantly higher operational complexity for this scale.

### ADR-003: Keyset pagination for URL listing

**Context:** Users may have thousands of URLs. Offset pagination
(`LIMIT 20 OFFSET N`) scans and discards N rows on every page — O(N) per
page.

**Decision:** Keyset pagination using the `id` column. The cursor is the
`id` of the last item on the previous page: `WHERE id < $cursor ORDER BY id
DESC LIMIT 20`.

**Consequences:** Pages are not randomly accessible (cannot jump to page 5).
The cursor is an integer ID, not a page number. The URL listing API does not
support random page access — only forward pagination. This is the correct
tradeoff for an API consumed programmatically.

**Alternative considered:** Cursor as base64-encoded JSON containing both
`id` and `created_at` — more opaque but allows compound sort keys.

### ADR-004: Short code generation — random base62

**Context:** Short codes must be unique, URL-safe, and reasonably short (7
characters). Generated codes must not be enumerable.

**Decision:** 7 random base62 characters (62^7 = 3.5 trillion possibilities).
Check for collision and retry (up to 5 times). Increase length to 8 if 5
collisions occur (extremely rare).

**Consequences:** Codes are not enumerable (cannot guess adjacent codes).
Rare collision retries add a small latency tail on the write path. At 100
million URLs, the birthday problem gives a collision probability of < 0.001%
per code — negligible.

**Alternative considered:** PostgreSQL sequence + base62 encode — zero
collisions but codes are sequential and enumerable (security concern).

### ADR-005: Long-lived JWT as API key

**Context:** Lynk is a developer API. Users need to authenticate
programmatically. Refresh token flows add complexity for CLI and script
usage.

**Decision:** Issue a single long-lived JWT (1 year expiry) as an API key.
The user stores it once and uses it in all requests. Compromised keys are
revoked by regenerating (new JWT, old one becomes invalid only after natural
expiry — this is a known limitation of stateless JWTs).

**Consequences:** Compromised keys remain valid until expiry (up to 1 year)
unless a token revocation list is implemented (adds statefulness). For a
URL shortener, this risk is acceptable.

**Alternative considered:** Opaque token stored in database — fully revocable
but requires a DB lookup on every API request (defeats JWT's statelessness).

---

## Testing Strategy

### Unit tests

- `generateUniqueShortCode()` — mock the DB, test retry behavior
- `validateUrl()` — all edge cases: invalid format, non-http, too long
- JWT issue and verification
- Cache service — mock Redis
- Rate limit logic — mock Redis

### Integration tests

- Redirect flow end-to-end: create URL → verify cache miss → redirect →
  verify cache populated → redirect again → verify cache hit
- Analytics pipeline: follow URL → wait for consumer → verify DB row exists
- Rate limiting across instances: send over the limit → verify 429

### Load test

- k6 script (see Phase 9)
- Must be run against a running Compose stack, not a test DB

### Test structure

```
tests/
├── unit/
│   ├── shortcode.test.ts
│   ├── url-validation.test.ts
│   └── rate-limit.test.ts
├── integration/
│   ├── redirect.test.ts
│   ├── analytics.test.ts
│   └── rate-limit-distributed.test.ts
└── load/
    └── k6.js  (symlinked to load-test/k6.js)
```

Use a separate test database (different `DATABASE_URL` in `NODE_ENV=test`).
Run `beforeEach` teardown to clean the `urls` and `clicks` tables between
tests. Never share state between tests.

---

## Pre-Submission Checklist

Before submitting, verify every item:

- [ ] `docker compose up --build` starts all services cleanly
- [ ] `docker compose down -v && docker compose up --build` still works (no state leakage)
- [ ] `GET /health` returns 200 with all dependencies healthy
- [ ] `GET /metrics` returns valid Prometheus format with all required metrics
- [ ] Creating a URL requires auth; redirecting does not
- [ ] Rate limit is respected across both app instances (test with `curl` alternating ports 3000 and 3001)
- [ ] Deactivating a URL (`PATCH /api/urls/:code { "isActive": false }`) removes it from the Redis cache immediately
- [ ] Clicks appear in the PostgreSQL `clicks` table within 10 seconds of the redirect
- [ ] k6 load test passes all thresholds
- [ ] Logs are structured JSON in production mode
- [ ] No `.env` file committed to git
- [ ] `plan.md` ADRs are filled in with your actual decisions (not just the templates)
- [ ] `load-test/results.md` contains actual numbers from your run
