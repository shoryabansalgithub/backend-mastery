# Lesson 4: Observability

## Why Observability Is Not Just Logging

Production software fails in ways you did not predict. If you could predict
every failure mode, you would have prevented it. The question is not "will
something go wrong?" but "when it does, how quickly can I understand what
happened and why?"

Observability is the property of a system that makes it possible to understand
its internal state from external outputs. A system is observable if you can
ask questions about it that you did not think to ask when you built it —
and get answers.

Three distinct types of data give you different angles on system behavior.
They are complementary, not substitutes.

**Logs** tell you what happened. A timestamped record of discrete events —
a request received, a query executed, an error thrown. Logs answer "what?"
They are great for debugging specific incidents but noisy at scale and
expensive to store and query in high volumes.

**Metrics** tell you how much and how fast. Numerical measurements aggregated
over time — request rate, error rate, latency percentiles, CPU usage, queue
depth. Metrics answer "how?" They are cheap to store (just numbers) and
fast to query, making them ideal for alerting and dashboards.

**Traces** tell you where time went. A trace follows a single request as it
propagates through a distributed system — from the load balancer to the
application to the database to the cache and back. Traces answer "where?"
They are essential for understanding latency in distributed systems.

Together, they form the "three pillars of observability." Each pillar is
less useful without the others. An error rate spike (metric) tells you
something is wrong. The error logs tell you what the errors are. A trace
tells you exactly where in the request path the error occurred and how long
each step took.

---

## Structured Logging with Pino

Most applications log with `console.log`. This produces free-form text:

```
Request received: GET /api/users
Error: Connection timeout after 5000ms
User 42 logged in from 192.168.1.1
```

This is readable to humans. It is a nightmare for machines. Every log
shipper, every search query, every alert rule needs to parse arbitrary text.
Add a change to a log message format and your alert regex breaks.

Structured logging emits JSON instead:

```json
{"level":30,"time":1710000000000,"pid":42,"hostname":"webapp-1","reqId":"req-123","method":"GET","url":"/api/users","statusCode":200,"responseTime":14}
{"level":50,"time":1710000001000,"pid":42,"hostname":"webapp-1","reqId":"req-124","err":{"type":"Error","message":"Connection timeout after 5000ms","stack":"..."},"msg":"Database error"}
{"level":30,"time":1710000002000,"pid":42,"hostname":"webapp-1","userId":"42","ip":"192.168.1.1","msg":"User logged in"}
```

Every field is independently queryable. Grep by `userId`, filter by `level`,
aggregate by `statusCode`. Log aggregation systems (Loki, Elasticsearch,
Datadog) parse JSON automatically.

### Why Pino

Pino is the fastest JSON logger for Node.js. It achieves this speed with
a key architectural decision: it does minimal work in the hot path. Pino
writes serialized JSON to stdout as quickly as possible. Log processing
(pretty-printing, filtering, shipping to external systems) happens in a
separate process, not blocking the main event loop.

At high throughput, the difference matters. `console.log` with string
concatenation can consume 10-15% of CPU on a busy server. Pino's overhead
is negligible.

### Setting up Pino

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // In development: pretty-print. In production: JSON.
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,

  // Base fields included in every log line
  base: {
    service: 'myapp',
    version: process.env.APP_VERSION || 'unknown',
    env: process.env.NODE_ENV,
  },

  // Redact sensitive fields before logging
  redact: {
    paths: ['req.headers.authorization', 'body.password', 'body.creditCard'],
    censor: '[REDACTED]',
  },
});

export default logger;
```

### Log levels

| Level | Number | Use for |
|---|---|---|
| `trace` | 10 | Extremely verbose; timing inside functions |
| `debug` | 20 | Diagnostic information useful during development |
| `info` | 30 | Normal operational events; request completed, cache hit |
| `warn` | 40 | Unexpected but recoverable; slow query, retrying |
| `error` | 50 | Errors that require attention; failed request, exception |
| `fatal` | 60 | Unrecoverable; process about to exit |

In production, set `LOG_LEVEL=info`. Debug and trace logs are expensive at
volume and expose information about internals. In development or when
investigating an incident, drop to `debug`.

### Request logging with child loggers

Pino's child logger creates a new logger that inherits the parent's
configuration and adds extra fields to every log line it produces.

```typescript
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import logger from './logger';

// Request logging middleware
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const reqId = (req.headers['x-request-id'] as string) || randomUUID();
  const startTime = Date.now();

  // Attach a child logger with request context to the request object
  req.log = logger.child({
    reqId,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });

  // Set the request ID in the response so clients can correlate
  res.setHeader('x-request-id', reqId);

  // Log request completion
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      responseTime: Date.now() - startTime,
    }, 'Request completed');
  });

  next();
}

// Use the request logger in route handlers
app.get('/api/users/:id', async (req, res) => {
  req.log.debug({ userId: req.params.id }, 'Fetching user');

  try {
    const user = await db.getUser(req.params.id);
    if (!user) {
      req.log.warn({ userId: req.params.id }, 'User not found');
      return res.status(404).json({ error: 'Not found' });
    }
    req.log.info({ userId: req.params.id }, 'User fetched successfully');
    res.json(user);
  } catch (err) {
    req.log.error({ err, userId: req.params.id }, 'Failed to fetch user');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

Every log line in a request handler now automatically includes `reqId`,
`method`, and `url` — without you having to pass those around. The entire
request lifecycle is traceable by filtering logs for a single `reqId`.

### Startup and shutdown logs

```typescript
// Startup
logger.info({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  nodeVersion: process.version,
}, 'Server starting');

server.listen(port, () => {
  logger.info({ port }, 'Server listening');
});

// Shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — starting graceful shutdown');
  server.close(() => {
    logger.info('HTTP server closed');
  });
  await dbPool.end();
  logger.info('Database pool closed');
  logger.info('Graceful shutdown complete');
  process.exit(0);
});

// Uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — process will exit');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
```

---

## Metrics with Prometheus

Prometheus is a pull-based metrics system. Your application exposes a
`/metrics` endpoint that returns metrics in Prometheus text format. Prometheus
scrapes this endpoint on a schedule (typically every 15 seconds), stores
the data in a time-series database, and makes it queryable with PromQL.

This pull model has an important implication: your application does not need
to know where Prometheus is. You just expose the endpoint. Prometheus finds
you (via service discovery or static configuration).

### Metric types

#### Counter

A monotonically increasing value. It only goes up. Use for events that can
be counted: requests served, errors thrown, emails sent.

```typescript
import { Counter } from 'prom-client';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Increment in middleware
app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode.toString(),
    });
  });
  next();
});
```

Query in PromQL: `rate(http_requests_total[5m])` gives requests per second
averaged over the last 5 minutes.

#### Gauge

A value that can go up and down. Use for current state: active connections,
queue length, memory usage, temperature.

```typescript
import { Gauge } from 'prom-client';

const activeConnections = new Gauge({
  name: 'http_active_connections',
  help: 'Number of active HTTP connections',
});

// Track connections
server.on('connection', () => activeConnections.inc());
server.on('close', () => activeConnections.dec());
```

#### Histogram

Records the distribution of observed values in configurable buckets. Use
for measuring durations and sizes where you want percentiles.

```typescript
import { Histogram } from 'prom-client';

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  // Bucket boundaries in seconds
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode.toString(),
    });
  });
  next();
});
```

Query in PromQL: `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` gives the 95th percentile latency.

#### Summary

Similar to Histogram, but pre-computes quantiles in the application. Use
when you need accurate quantiles at a specific moment and cannot wait for
PromQL to compute them from buckets. Less common than Histogram.

The practical choice: almost always use Histogram. Histograms are
aggregatable across instances (you can compute p95 across a fleet of
servers). Summaries are per-instance and cannot be meaningfully aggregated.

### When to use which metric type

| Metric type | When to use | Example |
|---|---|---|
| Counter | Events that only happen (never un-happen) | Requests, errors, bytes sent |
| Gauge | Current state | Active connections, queue depth, cache size |
| Histogram | Distribution of measurements | Request duration, response size, queue wait time |
| Summary | Quantiles when histogram buckets are unknown | Rarely needed |

### Setting up prom-client

```typescript
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';

// Create a custom registry (instead of using the default global one)
// This lets you have multiple independent registries and makes testing easier
export const registry = new Registry();

// Collect default Node.js metrics: heap usage, GC, event loop lag, etc.
collectDefaultMetrics({
  register: registry,
  prefix: 'nodejs_',  // Prefix all default metric names
});

// ---- Application metrics ----

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests received',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const activeHttpConnections = new Gauge({
  name: 'http_active_connections',
  help: 'Number of currently active HTTP connections',
  registers: [registry],
});

export const urlCreationsTotal = new Counter({
  name: 'url_creations_total',
  help: 'Total number of short URLs created',
  registers: [registry],
});

// ---- Metrics endpoint ----

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
```

### Node.js runtime metrics from collectDefaultMetrics

When you call `collectDefaultMetrics()`, prom-client automatically collects:

| Metric | What it measures |
|---|---|
| `nodejs_eventloop_lag_seconds` | How far behind the event loop is |
| `nodejs_heap_size_used_bytes` | V8 heap currently in use |
| `nodejs_heap_size_total_bytes` | V8 heap committed from OS |
| `nodejs_external_memory_bytes` | Memory used by C++ objects tied to V8 |
| `nodejs_gc_duration_seconds` | Time spent in garbage collection |
| `nodejs_active_handles_total` | Open handles (sockets, timers, etc.) |
| `process_cpu_seconds_total` | CPU time (user + system) |
| `process_resident_memory_bytes` | RSS: actual memory in RAM |

Event loop lag deserves special attention. The Node.js event loop is
single-threaded. If the lag is high (tens or hundreds of milliseconds),
something is blocking the event loop — a CPU-intensive computation, a
large synchronous operation, or a deeply nested promise chain. High event
loop lag translates directly to slow response times for all clients.

---

## Correlation IDs for Request Tracing

In a monolithic application, a `reqId` in your logs is enough to trace a
single request. Every log line for that request has the same ID.

In a distributed system, a request might pass through an API gateway, a
Node.js service, a Python service, and a database query. Each service
generates its own logs. Without a shared identifier, correlating those logs
across services requires timestamps and guesswork.

Correlation IDs solve this. The first service in the chain generates a
unique ID. Every subsequent service extracts it from the incoming request
headers, logs it with its own log lines, and propagates it in outgoing
requests.

```typescript
import { randomUUID } from 'node:crypto';
import axios from 'axios';

const TRACE_HEADER = 'x-trace-id';

// Middleware: extract or generate trace ID
export function traceMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = (req.headers[TRACE_HEADER] as string) || randomUUID();

  // Attach to request
  req.traceId = traceId;

  // Echo back in response
  res.setHeader(TRACE_HEADER, traceId);

  // Create a child logger with the trace ID
  req.log = logger.child({ traceId });

  next();
}

// When calling another service, propagate the trace ID
async function callDownstreamService(traceId: string, data: unknown) {
  return axios.post('https://other-service/api/endpoint', data, {
    headers: {
      [TRACE_HEADER]: traceId,   // Propagate
      'Content-Type': 'application/json',
    },
  });
}
```

Now, given a trace ID, you can search every service's logs simultaneously
and reconstruct the full request journey. Tools like Grafana Loki make this
a single query.

---

## Distributed Tracing Concepts

Distributed tracing is the formalized version of correlation IDs. It uses
a standard model (OpenTelemetry, formerly OpenTracing) to represent request
flows.

A **trace** is the complete journey of a request through a system.

A **span** is one unit of work within that journey: a single HTTP request,
a single database query, a single cache lookup. Spans have a start time,
a duration, and a set of attributes.

Spans are nested: the root span is the incoming HTTP request. It has child
spans for the database query, the cache lookup, and the external API call
it makes. Each child span records how long that operation took.

```
Trace: GET /api/users/42    (total: 45ms)
├── span: authenticate JWT  (2ms)
├── span: check cache       (3ms) — miss
├── span: query PostgreSQL  (35ms)
│   └── span: connection pool wait (5ms)
└── span: serialize response (0.5ms)
```

Viewing this trace tells you immediately that 35ms of the 45ms total was
spent in PostgreSQL — and 5ms of that was waiting for a connection from the
pool. That is an actionable optimization target.

Propagation headers carry the trace context between services. The W3C
Traceparent header is the standard:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              │  └─ trace ID (128-bit)                └─ span ID (64-bit)
              └─ version
```

OpenTelemetry is the ecosystem standard for instrumentation. It provides
SDKs for every major language and exporters for every major tracing backend
(Jaeger, Zipkin, Tempo, Datadog, Honeycomb).

---

## Alerting Philosophy

Most teams alert wrong. They alert on causes rather than symptoms.

**Cause-based alerting:**
- CPU usage > 80% for 5 minutes
- Memory usage > 70%
- Error log rate > 10/minute

**Symptom-based alerting:**
- Error rate > 1% of requests for 5 minutes
- p99 request latency > 2 seconds for 5 minutes
- Successful request rate dropped > 10% from baseline

The difference: symptoms are what users experience. Causes are what might
be causing the symptom — but high CPU does not always mean users are
affected, and users can be affected without high CPU.

Alert on symptoms. Investigate causes. Use dashboards (not alerts) to
monitor CPU, memory, and other internal metrics.

### The four golden signals

Google SRE defined four golden signals — the minimum set of metrics for
any user-facing service:

| Signal | Metric | Alert when |
|---|---|---|
| Latency | p50, p95, p99 request duration | p99 > SLO threshold |
| Traffic | Requests per second | Drops unexpectedly (can indicate an upstream problem) |
| Errors | Error rate (4xx/5xx) | Error rate > N% for M minutes |
| Saturation | Queue depth, connection pool utilization | Approaching 100% |

### Alert fatigue

Sending too many alerts trains humans to ignore them. Every alert that
fires and requires no action is noise that reduces trust in the alerting
system.

Each alert should:
1. Be actionable — there is something a human can do right now
2. Be urgent — if not addressed immediately, users are affected
3. Not self-resolve — if it always fixes itself, do not alert on it

Non-urgent issues belong in dashboards, not alerts. If you find yourself
dismissing an alert repeatedly without taking action, the alert should be
removed or demoted to a dashboard panel.

---

## Complete Observability Setup

```typescript
// src/observability/index.ts

import pino from 'pino';
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// ---- Logger ----

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: {
    service: process.env.SERVICE_NAME || 'app',
    version: process.env.APP_VERSION || '0.0.0',
    env: process.env.NODE_ENV,
  },
  redact: {
    paths: ['req.headers.authorization', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
});

// ---- Metrics Registry ----

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'nodejs_' });

export const metrics = {
  httpRequestsTotal: new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  }),

  httpRequestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),

  activeConnections: new Gauge({
    name: 'http_active_connections',
    help: 'Active HTTP connections',
    registers: [registry],
  }),
};

// ---- Request Middleware ----

export function observabilityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const traceId = (req.headers['x-trace-id'] as string) || randomUUID();
  const startTime = process.hrtime.bigint();

  req.traceId = traceId;
  req.log = logger.child({ traceId, method: req.method, url: req.url });

  res.setHeader('x-trace-id', traceId);
  metrics.activeConnections.inc();

  req.log.debug('Request received');

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationSeconds = Number(durationNs) / 1e9;
    const route = (req.route?.path as string) || req.path;
    const status = res.statusCode.toString();

    metrics.httpRequestsTotal.inc({ method: req.method, route, status });
    metrics.httpRequestDuration.observe(
      { method: req.method, route, status },
      durationSeconds
    );
    metrics.activeConnections.dec();

    req.log.info({
      statusCode: res.statusCode,
      durationMs: Math.round(durationSeconds * 1000),
    }, 'Request completed');
  });

  next();
}

// ---- Routes ----

// Register these before your app routes
export function registerObservabilityRoutes(app: any) {
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  app.get('/health', async (_req: Request, res: Response) => {
    // Implement real health checks here
    const health = {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    res.json(health);
  });
}
```

---

## Exercises

### Exercise 1: Structured Logging Audit

Take an existing Node.js application that uses `console.log`. Replace every
`console.log`, `console.error`, and `console.warn` with Pino equivalents.
Run in development and observe pino-pretty output. Run with `NODE_ENV=
production` and observe raw JSON output. Pipe the JSON output to `jq` to
query specific fields: `node app.js 2>&1 | jq 'select(.level == 50)'` (only
errors).

### Exercise 2: Request ID Tracing

Add request ID middleware to a multi-route Express app. Make two routes: one
that calls a helper function, and one that calls another route internally via
`axios`. Log at every step, including inside the helper function. Verify
that all log lines for a single request share the same `reqId`. Send 10
concurrent requests and verify that log lines are correctly associated with
their respective requests despite interleaving.

### Exercise 3: Prometheus Metrics Dashboard

Set up a local Prometheus + Grafana stack with Docker Compose. Add the
prom-client setup from this lesson to your app. Generate traffic with a
simple load script. In Grafana, create a dashboard with four panels:
1. Request rate by route (counter, `rate()`)
2. p50, p95, p99 latency by route (histogram, `histogram_quantile()`)
3. Active connections (gauge)
4. Node.js event loop lag (default metric)

### Exercise 4: Alerting Rules

Write Prometheus alerting rules (in YAML format) for your app:
1. Error rate > 5% for 2 minutes
2. p95 latency > 500ms for 5 minutes
3. Event loop lag > 100ms for 1 minute
4. Active connections > 80% of configured max

Configure Alertmanager to send alerts to a webhook (use webhook.site to
capture them). Intentionally trigger each alert and verify the webhook
receives it.

### Exercise 5: Event Loop Blocking

Write a route that does a CPU-intensive synchronous computation (e.g.,
compute the 40th Fibonacci number synchronously). Add event loop lag metric
collection. Use `clinic doctor` or a custom interval check to measure event
loop lag before and during load on this route. Use Prometheus to correlate
event loop lag spikes with requests to this route. Document what you
observe and how you would fix it (see next lesson for the answer).

---

## Summary

| Pillar | Tool | Answers |
|---|---|---|
| Logs | Pino | What happened, with what parameters, at what time |
| Metrics | Prometheus + prom-client | How much, how fast, how often |
| Traces | OpenTelemetry + Jaeger | Where time went in a distributed request |

| Metric type | Use for |
|---|---|
| Counter | Cumulative events (only go up) |
| Gauge | Current state (up and down) |
| Histogram | Duration/size distributions; enables percentiles |

| Alert on | Do not alert on |
|---|---|
| Error rate > threshold | CPU > 80% |
| p99 latency > SLO | Memory > 70% |
| Traffic drop > N% | Log rate |

Next lesson: Performance and resilience — profiling, memory leaks, circuit
breakers, rate limiting, and graceful shutdown.
