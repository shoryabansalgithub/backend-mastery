# Lesson 5: Connection Pooling

## Why This Lesson Exists

PostgreSQL connections are expensive. Not "a few milliseconds" expensive — establishing
a new connection allocates a dedicated backend process on the server, consuming roughly
5-10 MB of RAM, performing authentication, initializing session state, and negotiating
SSL. Under load, the cost of creating connections on every request can consume more
time than the queries themselves.

Connection pooling is the standard solution. But pooling is not just a performance
optimization — it's a safety mechanism. Without it, a traffic spike creates thousands
of simultaneous connection attempts, each competing for PostgreSQL's finite process
slots, crashing your database. With it, your application has a bounded, well-managed
set of connections that are reused safely across requests.

This lesson explains the problem from first principles, walks through Node.js
connection pooling with the `pg` library, covers the failure modes developers
consistently miss, and teaches you to configure a pool for production.

---

## The Cost of a PostgreSQL Connection

When your application calls `new Client()` from the `pg` library and invokes
`client.connect()`, here is what happens:

1. **TCP handshake**: 3-way handshake between your application and PostgreSQL.
2. **SSL negotiation** (if configured): multiple round trips to establish TLS.
3. **Authentication**: PostgreSQL checks credentials (md5, SCRAM-SHA-256, etc.).
4. **Backend process fork**: PostgreSQL's postmaster forks a new backend process
   to handle this connection. On Linux, this is a `fork()` syscall — inherently
   expensive for the OS.
5. **Session initialization**: The new backend allocates shared memory structures,
   loads search path, sets session defaults.

Total time on a local connection: 5-20ms. Over a network with SSL: 50-200ms.

For a simple query that takes 2ms, a new-connection-per-request strategy makes
each request 25-100x slower due to connection overhead. At 100 requests/second,
you're creating 100 connections per second — each requiring a backend fork.

### The max_connections Limit

PostgreSQL has a hard limit on concurrent connections: `max_connections` (default 100).
Each backend process uses shared memory and OS resources. PostgreSQL's documentation
recommends keeping total connections in the low hundreds — beyond that, you're
spending more OS resources managing backends than doing actual work.

```sql
-- Check current max_connections setting
SHOW max_connections;

-- Count active connections
SELECT count(*) FROM pg_stat_activity;

-- See connections per application
SELECT application_name, count(*) AS connections
FROM pg_stat_activity
GROUP BY application_name
ORDER BY connections DESC;
```

If you have 10 application servers each opening 100 connections, you need 1000
PostgreSQL connections. That exceeds the default limit and destabilizes the server.
Connection pooling solves this by multiplexing many application requests through
a small number of database connections.

---

## Connection Pooling in Node.js with `pg`

The `pg` library provides two ways to interact with PostgreSQL: `Client` and `Pool`.

### The Wrong Way: Client Per Request

```javascript
import { Client } from 'pg';

// BAD: creates a new connection on every request
export async function getUser(id: number) {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'myuser',
    password: 'mypassword',
  });
  await client.connect();  // expensive every time

  const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);

  await client.end();  // close the connection
  return result.rows[0];
}
```

Under load:
- 500 concurrent requests → 500 simultaneous `client.connect()` calls
- 500 TCP handshakes, 500 backend forks
- PostgreSQL server memory: 500 × 8MB ≈ 4GB just for connections
- `max_connections` exceeded: new connections are refused with "FATAL: sorry, too
  many clients already"

### The Right Way: Pool

```javascript
import { Pool } from 'pg';

// Create ONE pool for the entire application lifetime
export const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'mydb',
  user:     process.env.DB_USER     || 'myuser',
  password: process.env.DB_PASSWORD || '',

  // Pool configuration (explained in depth below)
  max:              10,    // maximum simultaneous connections
  min:              2,     // connections to keep alive when idle
  idleTimeoutMillis: 30000, // close idle connections after 30s
  connectionTimeoutMillis: 5000, // fail if can't get connection in 5s
  maxUses:          7500,  // recycle connection after 7500 queries (prevents memory leaks)
});

// Simple query: pool automatically manages connection lifecycle
export async function getUser(id: number) {
  const result = await pool.query(
    'SELECT id, email, name FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}
```

`pool.query()` internally:
1. Checks if a connection is available in the pool.
2. If yes: uses it, returns it to the pool after the query.
3. If no idle connection and pool is below `max`: creates a new connection.
4. If pool is at `max`: queues the request until a connection becomes available or
   `connectionTimeoutMillis` is exceeded.

### When You Need a Dedicated Client

Some operations require a dedicated client for the entire duration:
- Transactions (multiple statements must run on the same connection)
- `LISTEN`/`NOTIFY` (waiting for events)
- Advisory locks (session-level locks are tied to a specific connection)
- `COPY` operations

```javascript
export async function transferFunds(
  fromId: number,
  toId: number,
  amount: number
): Promise<void> {
  // Check out a client for the entire transaction
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock both rows to prevent concurrent transfers
    await client.query(
      'SELECT id, balance FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE',
      [[fromId, toId].sort((a, b) => a - b)]  // always lock in ascending ID order
    );

    const { rows } = await client.query(
      'SELECT balance FROM accounts WHERE id = $1',
      [fromId]
    );

    if (rows[0].balance < amount) {
      throw new Error('Insufficient funds');
    }

    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
      [amount, fromId]
    );

    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
      [amount, toId]
    );

    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;

  } finally {
    // This MUST happen regardless of success or failure
    client.release();
  }
}
```

The `finally` block is not optional. If you fail to call `client.release()`, the
connection is permanently removed from the pool. Repeat this enough times and your
pool empties — all new requests wait for connections that never return.

---

## Connection Leaks: What They Are and How to Find Them

A connection leak occurs when a client is checked out from the pool (`pool.connect()`)
but never returned (`client.release()`). The most common causes:

### Cause 1: Missing finally Block

```javascript
// LEAKS: if the query throws, client is never released
async function badQuery(id: number) {
  const client = await pool.connect();
  const result = await client.query('SELECT * FROM big_table WHERE id = $1', [id]);
  // If the query throws, we never reach this line:
  client.release();
  return result.rows[0];
}

// FIXED:
async function goodQuery(id: number) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM big_table WHERE id = $1',
      [id]
    );
    return result.rows[0];
  } finally {
    client.release();  // runs on success AND on throw
  }
}
```

### Cause 2: Forgotten Release in Transaction Error Handling

```javascript
// LEAKS: if ROLLBACK itself throws, release is never called
async function leakyTransaction() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE accounts SET balance = 0');
    await client.query('COMMIT');
    client.release();  // only reached on success
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();  // NOT reached if ROLLBACK throws
    throw err;
  }
}

// FIXED: always use finally for release
async function safeTransaction() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE accounts SET balance = 0');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();  // always runs
  }
}
```

### Cause 3: Conditional Code Paths That Skip Release

```javascript
// LEAKS: early return without releasing
async function conditionalLeak(userId: number) {
  const client = await pool.connect();
  const user = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

  if (!user.rows[0]) {
    return null;  // LEAK: client never released
  }

  const orders = await client.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
  client.release();
  return { user: user.rows[0], orders: orders.rows };
}
```

### Detecting Leaks

The `pg` Pool has a `allowExitOnIdle` option and an event system for monitoring:

```javascript
import { Pool } from 'pg';

export const pool = new Pool({ /* config */ });

// Log when connections are acquired/released (useful in development)
pool.on('connect', (client) => {
  console.log('New connection created. Total:', pool.totalCount);
});

pool.on('acquire', (client) => {
  console.log('Connection checked out. Idle:', pool.idleCount, 'Waiting:', pool.waitingCount);
});

pool.on('remove', (client) => {
  console.log('Connection removed from pool.');
});

// Monitor pool state in an endpoint (development only):
app.get('/debug/pool', (req, res) => {
  res.json({
    total:   pool.totalCount,
    idle:    pool.idleCount,
    waiting: pool.waitingCount,
  });
});
```

If `pool.idleCount` is always 0 and `pool.waitingCount` is growing, you have a leak.
If `pool.totalCount` reaches `max` and stays there while requests queue, investigate
which requests are holding connections.

The `pg` library also supports a `statement_timeout` to kill runaway queries:

```javascript
const pool = new Pool({
  // ... other config
  // Kill queries that take longer than 30 seconds
  statement_timeout: 30000,
});
```

---

## Pool Configuration Decisions

Every pool configuration parameter affects behavior under specific conditions.
There's no universal "correct" setting — you choose based on your workload.

### max: Maximum Connections

```javascript
const pool = new Pool({ max: 10 });
```

This is the most important setting. Setting it too high defeats the purpose of
pooling (you still create too many connections). Setting it too low creates a
queue under load.

**Rule of thumb**: `max` should be set such that:
```
(number of application instances) × max ≤ max_connections × 0.8
```

Leave 20% for admin tools, migrations, monitoring. For a single application server
with PostgreSQL's default `max_connections = 100`:
- `max = 80` if you have one application server
- `max = 20` if you have four application servers
- `max = 8` if you have ten application servers

A Node.js server handling typical web traffic almost never benefits from more than
10-20 connections. Node.js is single-threaded — it can't execute 100 queries in
parallel anyway. It sends one query at a time per event loop tick, then handles
other work while waiting. The realistic maximum parallelism is determined by your
event loop throughput, not the number of connections.

**Exception**: long-running analytical queries that hold connections. If you have
queries that take 5 seconds and receive 50 concurrent requests, you genuinely need
50 connections (or you queue requests). For this case, consider a separate pool
with a higher `max` for analytics vs a smaller pool for OLTP queries.

### idleTimeoutMillis: Closing Idle Connections

```javascript
const pool = new Pool({ idleTimeoutMillis: 30000 });  // 30 seconds
```

If a connection has been idle (not used) for this long, it's closed. This prevents
keeping connections open indefinitely when traffic drops overnight.

Set this shorter if you want to conserve database connections during quiet periods.
Set it longer if connection establishment is expensive (slow network, strict SSL
validation). If set too short, you'll pay connection setup cost more frequently
during traffic spikes.

`idleTimeoutMillis: 0` disables idle timeout — connections are kept open forever.
Fine in development, unwise in production.

### connectionTimeoutMillis: Request Waiting Limit

```javascript
const pool = new Pool({ connectionTimeoutMillis: 5000 });  // 5 seconds
```

If all connections are in use and a new request must wait, this is the maximum wait
time before throwing an error. When exceeded:
```
Error: timeout exceeded when trying to connect
```

This is a safety valve. Without it, requests queue indefinitely, causing memory growth
and user-facing latency that looks like a hang. With it, requests fail fast when the
pool is overloaded — fail fast is better than silent slowdown.

### min: Minimum Idle Connections

```javascript
const pool = new Pool({ min: 2 });
```

Connections to maintain even when idle. Prevents cold starts when traffic suddenly
arrives after a quiet period. Set to 0 if you want the pool to completely drain when
idle (saves DB resources, but first requests after idle periods are slower).

### A Production-Realistic Pool Configuration

```javascript
import { Pool } from 'pg';

function createPool() {
  const pool = new Pool({
    host:     process.env.DB_HOST!,
    port:     parseInt(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_NAME!,
    user:     process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,

    // SSL for production
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA }
      : false,

    max:                    10,
    min:                    2,
    idleTimeoutMillis:      30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout:      30_000,  // kill queries after 30s
    maxUses:                7_500,   // recycle connections to prevent memory leaks
  });

  // Validate on startup
  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
    // Don't exit — let the pool recover and recreate connections
  });

  return pool;
}

// Singleton: one pool per process
export const pool = createPool();
```

---

## PgBouncer: External Connection Pooling

When you have many application instances (or connections to PostgreSQL that exceed
what the `pg` library's in-process pool can safely manage), you add PgBouncer —
a dedicated connection pooler that sits between your application and PostgreSQL.

```
Application (10 servers × 50 connections) = 500 connections to PgBouncer
         ↕
      PgBouncer
         ↕
PostgreSQL (20 connections total)
```

PgBouncer maintains a small, stable set of connections to PostgreSQL, and
multiplexes thousands of application connections through them.

### PgBouncer Pooling Modes

PgBouncer has three modes with different granularities of connection reuse.

**Session Mode**: a server connection is assigned to a client connection for the
entire client session. When the client disconnects, the server connection returns
to the pool.

This is the safest mode. All PostgreSQL features work (transactions, prepared
statements, session-level settings). But you only get multiplexing when clients
disconnect, which is not frequent in connection-pooled applications.

**Transaction Mode**: a server connection is assigned to a client for one transaction
(from `BEGIN` to `COMMIT/ROLLBACK`). Between transactions, the connection returns
to the pool.

This is the most commonly used mode. It provides real multiplexing: a single server
connection can serve many clients as long as they're not in a transaction simultaneously.
Trade-offs: session-level features stop working. `SET LOCAL` variables, temporary
tables, `LISTEN/NOTIFY`, and session-level advisory locks do not survive between
transactions.

**Statement Mode**: a server connection is held only for one SQL statement. Highest
multiplexing, but transactions are completely broken (each statement commits independently).
Used only for specialized read-only, auto-commit workloads.

### PgBouncer Configuration

A minimal `pgbouncer.ini`:

```ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
listen_addr       = 127.0.0.1
listen_port       = 6432
auth_type         = scram-sha-256
auth_file         = /etc/pgbouncer/userlist.txt

pool_mode         = transaction

; Max connections FROM applications to PgBouncer
max_client_conn   = 1000

; Max connections FROM PgBouncer to PostgreSQL
default_pool_size = 20

; How long to wait for a server connection
server_connect_timeout = 5
; How long an idle server connection is kept
server_idle_timeout    = 30

; How long a client waits for a server if all are busy
client_login_timeout   = 10
```

Your application then connects to PgBouncer's port (6432) instead of PostgreSQL's
direct port (5432). From the application's perspective, it's just another PostgreSQL
server.

### Prepared Statements and Transaction Mode

A critical compatibility issue: prepared statements do not work with PgBouncer in
transaction mode. Prepared statements are session-level objects. When PgBouncer
reassigns connections between transactions, the prepared statement disappears.

The `pg` library's `Pool` creates prepared statements automatically when you use
the same query string repeatedly. This breaks under PgBouncer transaction mode.

Solution: configure PgBouncer's `prepared_statements = true` (PgBouncer 1.22+),
which transparently rewrites prepared statements to work in transaction mode. Or
use extended query protocol disabled (`disable_prepared_statements = true` in some
drivers).

In Node.js with `pg`, avoid automatic preparation by using the object query form
with `name` omitted or by using `pool.query()` (which does not cache prepared
statements across connections the same way `client.query()` does).

---

## Health Checks

A pool is useless if the connections it holds are to a database that's down or
unreachable. Implement a health check endpoint that tests a live connection.

```javascript
// Health check: verifies the pool can reach the database
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1');
    return result.rows[0]['?column?'] === 1;
  } catch (err) {
    return false;
  }
}

// Express health endpoint
app.get('/health', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();

  if (!dbHealthy) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'unreachable',
    });
    return;
  }

  res.json({
    status: 'ok',
    database: 'connected',
    pool: {
      total:   pool.totalCount,
      idle:    pool.idleCount,
      waiting: pool.waitingCount,
    },
  });
});
```

Load balancers use this endpoint to determine whether to send traffic to an
instance. If the database is unreachable and the health check returns 503, the
load balancer stops routing to this instance.

---

## Graceful Shutdown with a Pool

When your application receives a shutdown signal (`SIGTERM`), you must:
1. Stop accepting new requests.
2. Wait for in-flight requests to complete.
3. Close the pool (releases all connections).

```javascript
import { Pool } from 'pg';
import express from 'express';

export const pool = new Pool({ /* config */ });
const app = express();

// Your routes here...

const server = app.listen(3000, () => {
  console.log('Server listening on port 3000');
});

// Graceful shutdown handler
async function shutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  // Step 1: Stop accepting new HTTP connections
  server.close(async () => {
    console.log('HTTP server closed. Draining pool...');

    try {
      // Step 2: End all pool connections
      // pool.end() waits for in-flight queries to complete
      await pool.end();
      console.log('Pool drained. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('Error during pool shutdown:', err);
      process.exit(1);
    }
  });

  // Failsafe: force exit after 30 seconds
  setTimeout(() => {
    console.error('Shutdown timed out. Force exiting.');
    process.exit(1);
  }, 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

`pool.end()` is important. Without it:
- PostgreSQL sees abrupt TCP disconnections, which it handles but logs as errors.
- Active transactions may not be rolled back cleanly.
- Connection slots may be held briefly after process exit.

With `pool.end()`, PostgreSQL receives a proper disconnection message, cleans up
the session, and frees resources immediately.

---

## What Happens Without Pooling Under Load

To make the problem concrete, here is what happens when a naive application (one
connection per request) faces sudden load:

**t=0**: Application receives 1 req/s. Creates 1 connection, makes query, closes. Fine.

**t=60**: Traffic spike. 200 req/s suddenly.

**t=60.001**: 200 simultaneous `new Client()` + `connect()` calls.

**t=60.050**: PostgreSQL's postmaster is forking backend processes as fast as it can.
CPU spikes. Each fork allocates ~8MB of shared memory.

**t=60.200**: `max_connections` (100) exceeded. New connection attempts receive:
`FATAL: sorry, too many clients already`.

**t=60.201**: Application's error handlers log connection failures. Some requests
succeed (those that connected before the limit), most fail.

**t=60.500**: PostgreSQL under heavy memory pressure from 100 backends. Query latency
on the successful connections grows due to memory contention.

**t=61**: Traffic normalizes. Application creates 0 new connections (no pooling).
Each request still creates a new connection — but now 200 connections are trying to
close while 200 more try to open. Connection churn is maxing out the OS's ability
to handle TCP state transitions.

With a pool of 10:

**t=60**: 200 req/s. Pool has 10 connections. Requests 1-10 get connections
immediately. Requests 11-200 wait in the pool's queue. Queue drains as fast as the
10 connections can process queries. No new connections beyond 10.

**t=60**: PostgreSQL sees 10 connections, same as before. No stress. All queries
execute at normal latency. The queue depth grows briefly, then shrinks as queries
complete. Users see slightly higher latency (queue wait) but no failures.

---

## Exercises

### Exercise 1: Diagnose the Leak

A developer writes this route handler:

```javascript
app.post('/transfer', async (req, res) => {
  const { fromId, toId, amount } = req.body;
  const client = await pool.connect();

  await client.query('BEGIN');
  const fromAccount = await client.query(
    'SELECT balance FROM accounts WHERE id = $1 FOR UPDATE',
    [fromId]
  );

  if (fromAccount.rows[0].balance < amount) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Insufficient funds' });
    return;  // <-- potential leak
  }

  await client.query(
    'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
    [amount, fromId]
  );
  await client.query(
    'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
    [amount, toId]
  );
  await client.query('COMMIT');
  client.release();

  res.json({ success: true });
});
```

1. Identify all paths where `client.release()` is not called.
2. What symptom would you see in production from this leak?
3. Rewrite the handler with no leaks.

### Exercise 2: Pool Sizing

You're deploying a Node.js API server with these characteristics:
- Expected peak concurrent requests: 500
- Average query duration: 20ms
- Database: PostgreSQL with `max_connections = 200`
- Deployment: 5 application server instances

Calculate:
1. At 500 concurrent requests with 20ms average query time, how many connections
   are actually needed simultaneously? (Hint: think about throughput, not request count.)
2. What `max` pool size would you set per application server?
3. How many total PostgreSQL connections does this consume at peak?
4. Leave 20% of `max_connections` for admin tools. Does your sizing fit?

### Exercise 3: Implement a Query Helper

Write a TypeScript module `db.ts` that exports:
- A typed `query<T>(sql: string, params?: unknown[]): Promise<T[]>` helper that
  uses the pool and properly handles errors.
- A `transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>` helper
  that wraps a function in a transaction, handling BEGIN/COMMIT/ROLLBACK and
  always releasing the client.

The `transaction` helper should be usable like this:

```typescript
const result = await transaction(async (client) => {
  const { rows } = await client.query('SELECT balance FROM accounts WHERE id = $1', [1]);
  await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [rows[0].balance - 100, 1]);
  return rows[0].balance - 100;
});
```

Include TypeScript types throughout. Do not use `any`.

### Exercise 4: PgBouncer Mode Decision

You're running a Node.js API that uses the `pg` library. The API:
- Uses prepared statements (via `pg`'s automatic preparation)
- Uses `LISTEN/NOTIFY` for real-time notifications on one connection
- Has several endpoints that use multi-statement transactions
- Needs to support 2000 concurrent connections from 20 application servers

Your PgBouncer configuration allows 100 PostgreSQL connections.

1. Which PgBouncer mode would you choose? Explain the trade-offs.
2. Which feature(s) would be broken by your chosen mode, and how would you work around them?
3. Sketch the connection architecture (application → PgBouncer → PostgreSQL).

### Exercise 5: Health Check and Shutdown

Implement a production-grade Node.js server module that:
1. Creates a `pg` Pool with appropriate configuration for a production environment
   (include SSL setup, reasonable timeouts, and pool size).
2. Exports a `checkHealth()` function that returns `{ status, latencyMs, pool }`.
3. Implements graceful shutdown that:
   - Stops accepting new requests.
   - Waits up to 30 seconds for in-flight requests to drain.
   - Calls `pool.end()` before exiting.
   - Force-exits after 30 seconds if drain doesn't complete.
4. Registers `SIGTERM` and `SIGINT` handlers.

Write this as a complete TypeScript module with proper types. It should be suitable
for a real production deployment.
