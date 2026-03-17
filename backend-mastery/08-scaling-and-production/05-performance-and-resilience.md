# Lesson 5: Performance and Resilience

## The Two Problems

Performance is about making the normal case fast. Resilience is about
making failure non-catastrophic. Both require you to understand not just what
your code does, but what the platform underneath it does.

Node.js's single-threaded event loop is its defining characteristic. It is
the source of both its strength (no thread synchronization, excellent I/O
concurrency) and its primary weakness (any CPU-bound work blocks every other
request). A Node.js server that handles ten thousand concurrent HTTP
connections can be completely paralyzed by a single recursive computation
that runs for 200 milliseconds.

Resilience has a similar asymmetry. A well-designed system can handle a
downstream service going down without failing itself. A poorly designed
system turns a downstream outage into a cascade that takes down everything
upstream. The circuit breaker pattern is the difference.

This lesson covers profiling to find problems, memory management to prevent
leaks, worker threads to escape the single-threaded trap, graceful shutdown
to survive deployments, and circuit breakers and rate limiting to survive
hostile or failing environments.

---

## Node.js Performance Profiling

### The --prof flag

Node.js ships with a built-in V8 profiler. Run your application with the
`--prof` flag and V8 writes a sampling profile to a file:

```bash
node --prof dist/index.js
```

This generates a file named `isolate-XXXXXXXXXXXXXXXX-XXXX-v8.log`. Process
it with the built-in tick processor:

```bash
node --prof-process isolate-*.log > profile.txt
cat profile.txt
```

The output shows which functions are consuming the most time, categorized
by JavaScript, C++, GC, and idle. Look for functions in the "Statistical
profiling" section with high counts.

### clinic.js

Clinic is a higher-level profiling toolkit that wraps the V8 profiler and
adds visualization. It is designed for profiling real HTTP workloads.

```bash
npm install -g clinic
npm install -g autocannon   # HTTP load generator

# Profile: generates a flame graph
clinic flame -- node dist/index.js
# In another terminal, generate load:
autocannon -c 100 -d 30 http://localhost:3000/api/users

# Diagnose: detects common antipatterns
clinic doctor -- node dist/index.js
```

The flame graph shows a stack trace where width equals time. Wide boxes near
the top of a call stack are hot functions. If a wide box is in your code
(not in Node internals), that is your optimization target.

### Identifying CPU-bound work

The symptoms of CPU-bound work in a Node.js server:

- Response times for ALL routes increase simultaneously, even simple ones
- Event loop lag (measurable with `perf_hooks`) spikes during load
- CPU usage for the Node.js process hits 100% on a single core while other
  cores are idle
- `clinic doctor` reports "event loop blocked" warnings

The pattern that causes it:

```typescript
// BLOCKING: this runs synchronously, blocking the event loop
app.get('/expensive', (req, res) => {
  const result = heavyComputation(); // 100ms of pure CPU work
  res.json(result);
});
```

While `heavyComputation()` runs for 100ms, every other request (a simple
ping, a cache lookup, anything) is frozen. With 100 concurrent requests to
this endpoint, response time for a simple request becomes 10 seconds.

---

## Worker Threads for CPU Work

Worker threads are Node.js's solution to CPU-bound work. They run JavaScript
in separate threads, each with its own event loop and V8 instance. The main
thread communicates with workers via message passing. Workers do not share
JavaScript memory with the main thread (though they can share `SharedArrayBuffer`).

```typescript
// worker.ts — the CPU-intensive code
import { parentPort, workerData } from 'node:worker_threads';

function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const result = fibonacci(workerData.n);
parentPort!.postMessage({ result });
```

```typescript
// main.ts — the main thread stays unblocked
import { Worker } from 'node:worker_threads';
import path from 'node:path';

function runFibonacciInWorker(n: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.resolve(__dirname, 'worker.js'),
      { workerData: { n } }
    );

    worker.on('message', ({ result }) => resolve(result));
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

app.get('/fibonacci/:n', async (req, res) => {
  const n = parseInt(req.params.n, 10);
  // This does NOT block the event loop
  const result = await runFibonacciInWorker(n);
  res.json({ result });
});
```

### Worker pool

Creating a new worker per request is expensive (startup overhead, memory).
For high-throughput scenarios, maintain a pool of workers:

```typescript
import { Worker } from 'node:worker_threads';

interface PoolTask {
  data: unknown;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class WorkerPool {
  private workers: Worker[] = [];
  private queue: PoolTask[] = [];
  private idleWorkers: Worker[] = [];

  constructor(
    private workerFile: string,
    private poolSize: number = navigator.hardwareConcurrency ?? 4,
  ) {
    for (let i = 0; i < poolSize; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    const worker = new Worker(this.workerFile);

    worker.on('message', (result) => {
      const task = this.queue.shift();
      if (task) {
        worker.postMessage(task.data);
        task.resolve(result);
      } else {
        this.idleWorkers.push(worker);
      }
    });

    worker.on('error', (err) => {
      // Worker crashed — remove it and create a replacement
      this.workers = this.workers.filter((w) => w !== worker);
      this.addWorker();
      // Reject any pending task
      const task = this.queue.shift();
      if (task) task.reject(err);
    });

    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  run(data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const idleWorker = this.idleWorkers.pop();
      if (idleWorker) {
        const task = { data, resolve, reject };
        idleWorker.postMessage(data);
        // Store resolve/reject so message handler can call them
        this.queue.push(task);
      } else {
        this.queue.push({ data, resolve, reject });
      }
    });
  }

  async terminate() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

const pool = new WorkerPool('./worker.js', 4);
```

Use worker threads when: computation is CPU-intensive (> 10ms), it is
parallelizable (multiple independent computations), and the work is
embarrassingly parallel (no shared mutable state between tasks). Good
candidates: image/PDF processing, cryptography, JSON parsing of massive
payloads, data compression, code compilation.

---

## Memory Leak Patterns

Memory leaks in Node.js are insidious because they show up gradually as
increasing heap usage over time. The process may run fine for days, then
crash with an OOM error during peak traffic.

### Pattern 1: Event listeners never removed

```typescript
// LEAK: a listener is added every time this function runs
function processEvent(emitter: EventEmitter) {
  emitter.on('data', (chunk) => {
    // handle chunk
  });
  // The listener is never removed
}

// Called 10,000 times → 10,000 listeners → memory keeps growing
setInterval(() => processEvent(someEmitter), 1);

// FIX: use once() if you only need the event once, or remove explicitly
function processEventFixed(emitter: EventEmitter) {
  const handler = (chunk: Buffer) => {
    // handle chunk
    emitter.off('data', handler); // Remove after handling
  };
  emitter.on('data', handler);
}
```

Node.js warns when an emitter has more than 10 listeners by default. Take
this warning seriously — it often indicates a leak.

### Pattern 2: Closures holding references

```typescript
// LEAK: the outer array reference is held by the closure
function createHandler(largeData: Buffer) {
  // largeData cannot be GC'd as long as the handler exists
  return function handler(req: Request) {
    console.log(largeData.slice(0, 10));  // Only uses 10 bytes but holds all
  };
}

const handlers = new Map();
app.get('/register', (req, res) => {
  const data = Buffer.alloc(1024 * 1024); // 1 MB
  handlers.set(req.query.id, createHandler(data));
  // handlers grows unboundedly if entries are never removed
});
```

The fix: be explicit about what needs to be held. If the closure only needs
10 bytes, copy those 10 bytes and release the rest:

```typescript
function createHandler(largeData: Buffer) {
  const needed = Buffer.from(largeData.slice(0, 10)); // Only keep what's needed
  return function handler(req: Request) {
    console.log(needed);
  };
}
```

### Pattern 3: Caches without eviction

```typescript
// LEAK: the cache grows forever
const cache = new Map<string, unknown>();

app.get('/data/:id', async (req, res) => {
  if (cache.has(req.params.id)) {
    return res.json(cache.get(req.params.id));
  }
  const data = await fetchData(req.params.id);
  cache.set(req.params.id, data); // Never evicted
  res.json(data);
});
```

Fix: use LRU eviction (evict the least recently used entry when the cache
is full) or TTL-based eviction:

```typescript
import LRU from 'lru-cache';

const cache = new LRU<string, unknown>({
  max: 1000,             // At most 1000 entries
  ttl: 5 * 60 * 1000,   // Each entry expires after 5 minutes
});
```

### Finding leaks with heap snapshots

```typescript
// Take a heap snapshot programmatically
import { writeHeapSnapshot } from 'node:v8';

app.get('/debug/heap-snapshot', (req, res) => {
  const filename = writeHeapSnapshot('/tmp');
  res.json({ filename });
});
```

Then open the snapshot in Chrome DevTools (chrome://inspect → Memory →
Load). Use the "Comparison" view to diff two snapshots taken before and
after suspected leak activity. Objects that grow between snapshots are
suspect.

---

## Graceful Shutdown

A graceful shutdown is the opposite of being killed. When a process receives
SIGTERM (from `docker stop`, a Kubernetes pod eviction, a deployment script,
or `systemctl stop`), it should:

1. Stop accepting new connections
2. Finish processing all in-flight requests
3. Close database connections (allows the pool to drain, transactions to commit)
4. Close other resources (queues, file handles, workers)
5. Exit cleanly

This ensures deployments do not drop requests and database connections are
released cleanly rather than being hard-closed.

```typescript
import http from 'node:http';
import { Pool } from 'pg';
import Redis from 'ioredis';
import logger from './logger';

const server = http.createServer(app);
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Track active connections for graceful drain
let isShuttingDown = false;

// Reject new requests during shutdown
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  next();
});

server.listen(3000, () => {
  logger.info({ port: 3000 }, 'Server started');
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');
  isShuttingDown = true;

  // Stop accepting new TCP connections
  server.close(() => {
    logger.info('HTTP server: no longer accepting new connections');
  });

  // Set a hard timeout — if shutdown takes too long, force exit
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000);

  forceExitTimeout.unref(); // Don't keep process alive just for this timer

  try {
    // Wait for in-flight requests (server.close above waits for this)
    // Close database connections
    await db.end();
    logger.info('Database pool closed');

    // Close Redis connections
    await redis.quit();
    logger.info('Redis connection closed');

    clearTimeout(forceExitTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Crash recovery — log before dying
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  // In Node 18+, unhandled rejections crash the process by default
  // This handler gives you a chance to log before that happens
});
```

---

## Circuit Breaker Pattern

When a downstream service is failing or slow, requests pile up waiting
for it. Without a circuit breaker, your server becomes a traffic jam:
all threads/connections block on the failing service, your response times
grow, your client connection pool exhausts, and the entire system slows
down — a cascade.

The circuit breaker prevents this. It monitors calls to a downstream service.
When failures exceed a threshold, it "opens" the circuit: subsequent calls
fail immediately without even attempting the downstream request. After a
timeout, it enters "half-open" state: allows one trial request. If that
succeeds, the circuit closes (normal operation). If it fails, the circuit
stays open.

```typescript
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOptions {
  failureThreshold: number;    // Number of failures to trip the breaker
  successThreshold: number;    // Successes in half-open to close
  timeout: number;             // Ms to wait before trying half-open
  halfOpenMaxCalls: number;    // Max concurrent calls in half-open
}

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private halfOpenCalls = 0;

  constructor(private options: CircuitBreakerOptions) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.options.timeout) {
        throw new Error('Circuit breaker is OPEN — request rejected');
      }
      // Timeout elapsed — try half-open
      this.state = 'half-open';
      this.halfOpenCalls = 0;
    }

    if (this.state === 'half-open') {
      if (this.halfOpenCalls >= this.options.halfOpenMaxCalls) {
        throw new Error('Circuit breaker is HALF-OPEN — at capacity');
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
        console.log('Circuit breaker: CLOSED (recovered)');
      }
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (
      this.state === 'closed' &&
      this.failureCount >= this.options.failureThreshold
    ) {
      this.state = 'open';
      console.log(`Circuit breaker: OPEN (after ${this.failureCount} failures)`);
    } else if (this.state === 'half-open') {
      this.state = 'open';
      this.successCount = 0;
      console.log('Circuit breaker: OPEN (half-open probe failed)');
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// Usage
const paymentCircuit = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30_000,         // Try again after 30 seconds
  halfOpenMaxCalls: 1,
});

app.post('/api/orders', async (req, res) => {
  try {
    const result = await paymentCircuit.call(() =>
      paymentService.charge(req.body)
    );
    res.json(result);
  } catch (err) {
    if (err.message.includes('Circuit breaker')) {
      // Service is known to be down — respond fast with a meaningful error
      res.status(503).json({
        error: 'Payment service temporarily unavailable',
        retryAfter: 30,
      });
    } else {
      res.status(500).json({ error: 'Payment failed' });
    }
  }
});
```

The circuit breaker pattern implements **fail fast** semantics. Instead of
making users wait 30 seconds for a request that will time out anyway, you
fail immediately with a clear error. This frees up server resources, gives
users useful information, and prevents cascade failures.

### Bulkhead pattern

Named after the watertight compartments in a ship — if one compartment
floods, it does not sink the ship. In software, a bulkhead isolates
resources so one component's failure cannot exhaust resources needed by
other components.

```typescript
// Without bulkhead: one slow endpoint exhausts the entire connection pool
const dbPool = new Pool({ max: 20 }); // Shared by everyone

// With bulkhead: separate pools for different concerns
const analyticsPool = new Pool({ max: 3 });  // Analytics can have 3 connections max
const apiPool = new Pool({ max: 15 });        // API always has connections available

// If analytics goes haywire and holds all 3 connections, the API still has 15
```

---

## Rate Limiting

Rate limiting protects your service from being overwhelmed by a single
client — whether malicious (DoS) or just misconfigured.

### Token bucket algorithm

The token bucket model:
- A bucket holds up to `capacity` tokens
- Tokens are added at a constant rate (`refillRate` per second)
- Each request consumes one token
- If the bucket is empty, the request is rejected
- Unused tokens accumulate up to the capacity ceiling

This allows bursts (consuming accumulated tokens) while enforcing an
average rate over time.

```typescript
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,    // Max tokens (burst size)
    private refillRate: number,  // Tokens added per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  consume(count = 1): boolean {
    this.refill();

    if (this.tokens < count) {
      return false; // Rate limit exceeded
    }

    this.tokens -= count;
    return true;
  }

  private refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
```

### Leaky bucket algorithm

The leaky bucket model:
- Requests enter a queue (the bucket)
- Requests drain from the queue at a fixed rate (the leak)
- If the queue is full, new requests are rejected
- This smooths traffic to a constant rate — no bursts

```typescript
class LeakyBucket {
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(
    private capacity: number,     // Max queue size
    private drainRateMs: number,  // Process one request every N ms
  ) {}

  add(handler: () => void): boolean {
    if (this.queue.length >= this.capacity) {
      return false; // Bucket full — drop request
    }

    this.queue.push(handler);
    this.drain();
    return true;
  }

  private drain() {
    if (this.processing) return;
    this.processing = true;

    const interval = setInterval(() => {
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        clearInterval(interval);
        this.processing = false;
      }
    }, this.drainRateMs);
  }
}
```

### Comparison

| Aspect | Token bucket | Leaky bucket |
|---|---|---|
| Allows bursts | Yes (up to capacity) | No (fixed drain rate) |
| Output rate | Variable | Constant |
| Best for | APIs with bursty clients | Smooth rate enforcement |
| Typical use | API rate limiting | Traffic shaping |

### Redis-based rate limiting for distributed systems

In-memory rate limiters (like the above) only work for a single process.
With multiple app instances, each has its own bucket. A client can send 10x
the limit if there are 10 instances.

The fix: use Redis as shared state with atomic operations.

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

async function isRateLimited(
  clientId: string,
  limit: number,
  windowSeconds: number
): Promise<{ limited: boolean; remaining: number; resetAt: number }> {
  const key = `rate_limit:${clientId}`;

  // Lua script for atomic check-and-increment
  // Runs atomically on the Redis server — no race conditions
  const script = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local current = redis.call('GET', key)
    if current == false then
      -- First request in window
      redis.call('SET', key, 1, 'EX', window)
      return {1, limit - 1, now + window}
    end

    local count = tonumber(current)
    if count >= limit then
      local ttl = redis.call('TTL', key)
      return {count, 0, now + ttl}
    end

    redis.call('INCR', key)
    local ttl = redis.call('TTL', key)
    return {count + 1, limit - count - 1, now + ttl}
  `;

  const [count, remaining, resetAt] = (await redis.eval(
    script,
    1,
    key,
    limit.toString(),
    windowSeconds.toString(),
    Math.floor(Date.now() / 1000).toString()
  )) as [number, number, number];

  return {
    limited: count > limit,
    remaining,
    resetAt,
  };
}

// Middleware
function rateLimitMiddleware(limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Use IP or authenticated user ID as the client identifier
    const clientId = req.user?.userId || req.ip;
    const result = await isRateLimited(clientId, limit, windowSeconds);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);

    if (result.limited) {
      res.setHeader('Retry-After', result.resetAt - Math.floor(Date.now() / 1000));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: result.resetAt,
      });
    }

    next();
  };
}

// Apply: 100 requests per minute per client
app.use('/api', rateLimitMiddleware(100, 60));
```

---

## Horizontal Scaling and Statelessness

Horizontal scaling means running multiple copies of your application behind
a load balancer. It is the primary scaling strategy for web services.

For horizontal scaling to work, your application must be **stateless**:
any instance must be able to handle any request. State stored in process
memory breaks this. If a user's session is stored in `req.session` in
an in-memory object, that session only exists on the instance that created
it. If the next request goes to a different instance, the session is not
there.

### What you cannot store in process memory

| State | Problem | Solution |
|---|---|---|
| Session data | Only on one instance | Redis or database sessions |
| Rate limit counters | Each instance has own counter | Redis |
| WebSocket connections | Client connects to one instance | Redis pub/sub or sticky sessions |
| Temporary files | Only accessible on one machine | Object storage (S3, GCS) |
| In-memory cache | Cold on new instances | Redis cache |
| Circuit breaker state | Each instance trips independently | Redis (or accept per-instance) |

The rule: if it needs to be shared across instances, it must live outside
any single instance. Redis is the standard solution for shared ephemeral
state. PostgreSQL is the standard solution for shared persistent state.

### What is fine to store in process memory

- Application configuration (read-only, same on all instances)
- Compiled regular expressions (computation cache, idempotent)
- Database connection pools (per-instance, that is the point)
- Module caches (static, compiled at startup)
- Short-lived local caches with TTL (acceptable eventual consistency)

---

## Exercises

### Exercise 1: Profile a Slow Endpoint

Write an Express route with a synchronous, CPU-intensive function (e.g.,
sort a large array 1000 times, or compute a large prime). Use `autocannon
-c 50 -d 10` to load-test it. Run with `--prof` and process the profile.
Identify the hot function. Now fix it using `worker_threads`. Re-run the
load test and compare p99 latency before and after.

### Exercise 2: Manufacture a Memory Leak

Write a Node.js script with a deliberate memory leak (event listener
accumulation or unbounded cache). Take a heap snapshot after startup and
after 60 seconds of activity. Open both in Chrome DevTools. Use the
"Comparison" view to identify the growing objects. Fix the leak and verify
the heap stabilizes.

### Exercise 3: Circuit Breaker Under Failure

Wire the circuit breaker from this lesson to a mock "payment service"
that:
- Succeeds normally
- Fails with 100% probability when `PAYMENT_SERVICE_DOWN=true` is set
- Recovers when the env var is removed

Write a test script that:
1. Sends 3 successful requests (circuit: closed)
2. Sets `PAYMENT_SERVICE_DOWN=true`
3. Sends 5 requests (circuit trips open after threshold)
4. Sends another request (should fail immediately with circuit open error)
5. Waits for the timeout
6. Sends one request (circuit half-open — passes through)
7. Removes the failure flag
8. Sends one more request (circuit closes)

Log circuit state transitions at each step.

### Exercise 4: Redis Rate Limiter

Implement the Redis-based rate limiter from this lesson. Test it by:
1. Sending 10 requests in rapid succession (limit: 5/minute)
2. Verifying that requests 1-5 succeed and 6-10 return 429
3. Checking the `X-RateLimit-*` headers on each response
4. Waiting 60 seconds and verifying requests succeed again

Then test the distributed behavior: run two instances of your app on
different ports. Alternate requests between them. Verify that the combined
rate limit is respected (e.g., 3 requests to instance 1 + 3 to instance 2
= 6 total, which exceeds the limit of 5).

### Exercise 5: Complete Resilience Stack

Combine everything from this lesson into a single service:
- A route that calls a "downstream service" (mock with random failures)
- Circuit breaker around the downstream call
- Rate limiting (Redis) on the calling route
- Worker thread for any CPU-intensive processing in the handler
- Graceful SIGTERM handler that drains connections
- Prometheus metrics: circuit state, rate limit rejections, worker thread
  queue depth

Load test the full stack with autocannon. Watch all metrics in real time.
Manually trigger a downstream failure and observe the circuit breaker trip.
Send `docker stop` and verify graceful shutdown with no dropped requests.

---

## Summary

| Problem | Solution |
|---|---|
| CPU-bound blocking | Worker threads; offload to separate thread |
| Memory leaks | Remove event listeners; bounded caches with LRU/TTL |
| Deployment drops | Graceful SIGTERM handler; drain in-flight requests |
| Downstream failures | Circuit breaker; fail fast instead of cascading |
| Resource exhaustion | Bulkhead; separate pools per concern |
| Traffic spikes | Rate limiting; token bucket (bursts) or leaky bucket (smooth) |
| Horizontal scaling | Stateless processes; shared state in Redis/PostgreSQL |

| Profiling tool | Use for |
|---|---|
| `--prof` + `--prof-process` | Low-level CPU profiling, no dependencies |
| `clinic flame` | Flame graph of hot paths under real load |
| `clinic doctor` | Diagnose event loop blocking, memory, I/O |
| V8 heap snapshot | Identify memory leaks via object comparison |

Next module: the ShipIt project — containerize and add full observability
to the URL shortener from Module 01.
