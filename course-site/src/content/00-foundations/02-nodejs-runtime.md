# Lesson 2: The Node.js Runtime

## What Actually Happens When You Run `node file.ts`?

Before we write a single line of backend code, you need a mental model of what's running
your code. Most developers treat Node.js as a black box -- code goes in, responses come
out. But when things go wrong (and they will), you need to understand the machine.

Let's trace what happens step by step.

### Step 1: TypeScript to JavaScript

Node.js doesn't understand TypeScript natively. When you run `npx tsx file.ts`, here's
what happens:

```
your-file.ts
    |
    v
[TypeScript Compiler / SWC / esbuild]
    |  - Strips type annotations
    |  - Transforms modern syntax
    |  - Does NOT do runtime type checking
    v
your-file.js  (in memory, not written to disk with tsx)
    |
    v
[Node.js / V8 Engine]
    |
    v
Execution
```

**Key insight:** Types are erased at runtime. TypeScript is a *development-time* tool.
Once your code runs, it's plain JavaScript. This is why runtime validation (checking user
input, API responses) is still necessary even in TypeScript.

```typescript
// This type exists at compile time:
interface User {
  name: string;
  age: number;
}

// At runtime, this is just: function greet(user) { ... }
function greet(user: User): string {
  return `Hello, ${user.name}`;
}

// TypeScript catches this at compile time:
// greet({ name: 123 }); // Error!

// But at runtime, nothing stops this:
const data = JSON.parse('{"name": 123}');
greet(data); // No error! "Hello, 123"
```

### Step 2: V8 Takes Over

V8 is Google's JavaScript engine -- the same one in Chrome. When Node.js receives your
JavaScript, V8 processes it through several phases:

```
JavaScript Source Code
    |
    v
[Parser] --> Abstract Syntax Tree (AST)
    |
    v
[Ignition Interpreter] --> Bytecode
    |                          |
    |   (runs immediately)     |
    v                          v
[TurboFan Compiler]    (watches "hot" code)
    |
    v
Optimized Machine Code  (runs FAST)
```

**Ignition** is the interpreter. It compiles JavaScript to bytecode and starts executing
immediately. This is why Node.js starts fast -- it doesn't wait to compile everything.

**TurboFan** is the optimizing compiler. It watches which functions run frequently ("hot"
functions) and compiles them to optimized machine code. This is why Node.js gets faster
over time for repeated operations.

**What would happen if V8 only had an interpreter?** Every function call would be
interpreted from bytecode every time. Your server would be 10-100x slower for
CPU-intensive operations.

**What would happen if V8 only had a compiler?** Startup would be very slow because
*everything* would need to be compiled before the first line executes. Your development
feedback loop would suffer.

The two-phase approach gives you the best of both worlds: fast startup AND fast execution
of hot paths.

---

## The Event Loop: The Heartbeat of Node.js

This is the most important concept in Node.js backend development. If you understand
the event loop, you understand Node.js. If you don't, you'll write code that "works"
but breaks under load.

### The Analogy

Imagine a restaurant with **one chef** (the main thread). This chef can only do one
thing at a time. But the restaurant has **helpers** (the thread pool and OS):

- Customer orders food (incoming request)
- Chef reads the order and tells a helper: "Go get the ingredients from the pantry" (async I/O)
- While the helper is in the pantry, the chef starts on the NEXT order
- Helper comes back with ingredients. Chef finishes that dish.

The chef never waits. The chef always has something to do. That's the event loop.

If the chef tried to go to the pantry themselves for every order, they'd be walking
back and forth constantly, and other customers would wait. That's what **blocking** code
does.

### The Event Loop Phases

The event loop is not a simple "check for callbacks" loop. It has distinct phases, each
with its own queue of callbacks:

```
   ┌───────────────────────────────────────────────┐
   │                   TIMERS                       │
   │   (setTimeout, setInterval callbacks)          │
   └──────────────────┬────────────────────────────┘
                      │
   ┌──────────────────▼────────────────────────────┐
   │              PENDING CALLBACKS                 │
   │   (I/O callbacks deferred from previous loop)  │
   └──────────────────┬────────────────────────────┘
                      │
   ┌──────────────────▼────────────────────────────┐
   │              IDLE / PREPARE                    │
   │   (internal use only)                          │
   └──────────────────┬────────────────────────────┘
                      │
   ┌──────────────────▼────────────────────────────┐
   │                  POLL                          │
   │   (retrieve new I/O events;                    │
   │    execute I/O-related callbacks)              │
   │   *** Most time spent here ***                 │
   └──────────────────┬────────────────────────────┘
                      │
   ┌──────────────────▼────────────────────────────┐
   │                  CHECK                         │
   │   (setImmediate callbacks)                     │
   └──────────────────┬────────────────────────────┘
                      │
   ┌──────────────────▼────────────────────────────┐
   │              CLOSE CALLBACKS                   │
   │   (socket.on('close'), etc.)                   │
   └──────────────────┬────────────────────────────┘
                      │
                      └──────── Loop back to TIMERS
```

Let's walk through each phase.

### Phase 1: Timers

Executes callbacks scheduled by `setTimeout()` and `setInterval()`.

```typescript
// This callback will be placed in the Timers queue
// after AT LEAST 100ms have passed
setTimeout(() => {
  console.log("Timer fired!");
}, 100);
```

**Important:** The delay is a *minimum*, not a guarantee. If the event loop is busy
executing other callbacks, the timer callback will be delayed until the loop reaches
the timers phase again.

```typescript
// Demonstration: setTimeout is not precise
const start = Date.now();

setTimeout(() => {
  const elapsed = Date.now() - start;
  console.log(`Timer fired after ${elapsed}ms`); // Might be 105ms, 110ms, etc.
}, 100);

// This blocks the event loop for 200ms!
// The timer callback can't run until this finishes.
const end = Date.now() + 200;
while (Date.now() < end) {
  // Busy wait (NEVER do this in real code)
}
```

### Phase 2: Pending Callbacks

Executes I/O callbacks that were deferred to the next loop iteration. For example, if a
TCP socket receives a connection error, the error callback might be queued here.

You rarely interact with this phase directly.

### Phase 3: Idle / Prepare

Internal use only. Node.js uses this for housekeeping. You don't need to worry about it.

### Phase 4: Poll

This is where Node.js spends most of its time. The poll phase does two things:

1. **Calculates how long it should block and wait** for I/O events
2. **Processes events in the poll queue** (file reads, network responses, etc.)

When the event loop enters the poll phase:
- If there are callbacks in the poll queue, it executes them synchronously until the
  queue is empty or a system-dependent limit is reached.
- If there are NO callbacks, it checks if there are `setImmediate` callbacks. If so,
  it moves to the Check phase. If not, it waits for new callbacks to be added.

```typescript
import * as fs from "fs";

// This callback will be queued in the Poll phase
// when the file read completes
fs.readFile("/etc/hosts", (err, data) => {
  console.log("File read complete!");
});
```

### Phase 5: Check

Executes `setImmediate()` callbacks. This phase runs immediately after the poll phase.

```typescript
setImmediate(() => {
  console.log("setImmediate callback");
});
```

### Phase 6: Close Callbacks

Handles close events, like `socket.on('close', ...)`.

```typescript
import * as net from "net";

const server = net.createServer((socket) => {
  socket.on("close", () => {
    console.log("Socket closed"); // Runs in Close Callbacks phase
  });
});
```

---

## process.nextTick vs setImmediate

This trips up everyone. The names are confusing -- `nextTick` runs *before* `setImmediate`,
even though "next tick" sounds like it should be later.

### process.nextTick

`process.nextTick` is NOT part of the event loop. It runs at the **end of the current
operation**, before the event loop moves to the next phase. It's like cutting in line.

```
Current Phase Executing
    |
    v
[All process.nextTick callbacks]  <-- Runs here, between phases
    |
    v
[All Promise microtask callbacks] <-- Then here
    |
    v
Next Phase
```

### setImmediate

`setImmediate` runs in the **Check phase** of the event loop -- the next time the event
loop reaches that phase.

### The Difference in Practice

```typescript
// Order of execution:
console.log("1: Script start");

setTimeout(() => console.log("2: setTimeout"), 0);

setImmediate(() => console.log("3: setImmediate"));

process.nextTick(() => console.log("4: nextTick"));

Promise.resolve().then(() => console.log("5: Promise"));

console.log("6: Script end");

// Output:
// 1: Script start
// 6: Script end
// 4: nextTick        (nextTick queue, before event loop continues)
// 5: Promise         (microtask queue, after nextTick)
// 2: setTimeout      (timers phase - but order with setImmediate varies)
// 3: setImmediate    (check phase)
```

**Why does nextTick run before Promise?** Both are "microtasks" in the general sense,
but Node.js processes the nextTick queue before the Promise microtask queue.

### The Execution Priority Ladder

```
HIGHEST PRIORITY
    |
    |  1. Synchronous code (runs to completion)
    |  2. process.nextTick callbacks
    |  3. Promise microtasks (.then, .catch, .finally, await)
    |  4. Event loop phases (timers, poll, check, etc.)
    |
LOWEST PRIORITY
```

### What Would Happen If You Abused process.nextTick?

```typescript
// DANGER: This starves the event loop!
function recursive() {
  process.nextTick(recursive);
}
recursive();

// nextTick callbacks run BEFORE the event loop moves to the next phase.
// If you keep adding nextTick callbacks, the event loop NEVER progresses.
// setTimeout callbacks never fire. I/O never completes. Server is frozen.
```

This is called "starvation." The nextTick queue has higher priority than everything
else, so filling it indefinitely blocks the entire event loop.

`setImmediate` doesn't have this problem because it runs in a specific phase:

```typescript
// This is safe -- the event loop can process other work between iterations
function recursive() {
  setImmediate(recursive);
}
recursive();
// Other callbacks (timers, I/O) still get to run
```

**Rule of thumb:** Use `setImmediate` unless you have a specific reason to use
`process.nextTick`. The main valid use case for `nextTick` is ensuring a callback runs
before any I/O, like emitting an event after a constructor returns.

---

## libuv and the Thread Pool

You keep hearing "Node.js is single-threaded." This is a half-truth.

**Your JavaScript code runs on a single thread.** That's true. But Node.js itself uses
multiple threads behind the scenes, managed by a C library called **libuv**.

### The Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     YOUR CODE                           │
│                  (Single Thread)                        │
│   const data = await fs.promises.readFile("big.csv");   │
│   const response = await fetch("https://api.com");      │
│   const hash = crypto.pbkdf2Sync(password, salt, ...);  │
└─────────────────────────┬───────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────┐
│                    NODE.JS / V8                         │
│               Event Loop (Single Thread)                │
│           Manages callbacks and scheduling              │
└─────────┬──────────────────────────────┬────────────────┘
          │                              │
          v                              v
┌─────────────────────┐    ┌─────────────────────────────┐
│      libuv           │    │     Operating System        │
│   Thread Pool        │    │   (epoll/kqueue/IOCP)       │
│   (4 threads         │    │                             │
│    by default)       │    │   Network I/O               │
│                      │    │   (handled directly by OS)  │
│   File system I/O    │    │                             │
│   DNS lookups        │    │   Non-blocking sockets      │
│   Crypto operations  │    │   handled natively          │
│   Compression        │    │                             │
└──────────────────────┘    └─────────────────────────────┘
```

### What Uses the Thread Pool?

Not all async operations are equal. Some use the thread pool, some go directly to the OS:

**Thread Pool (libuv workers):**
- File system operations (`fs.readFile`, `fs.writeFile`, etc.)
- DNS lookups (`dns.lookup`)
- Crypto operations (`crypto.pbkdf2`, `crypto.randomBytes`)
- Compression (`zlib.gzip`, `zlib.deflate`)

**OS-level async (no thread pool):**
- Network I/O (TCP, UDP, HTTP)
- Timers
- Child processes
- Signals

### Why Does This Matter?

The thread pool has a **default size of 4**. If you have 5 concurrent file reads, one
has to wait:

```typescript
import * as fs from "fs/promises";

// These 5 file reads will use the thread pool
// But the pool only has 4 threads by default
// So 4 run in parallel, and 1 waits

const start = Date.now();

await Promise.all([
  fs.readFile("file1.txt"),
  fs.readFile("file2.txt"),
  fs.readFile("file3.txt"),
  fs.readFile("file4.txt"),
  fs.readFile("file5.txt"), // This one waits for a thread
]);

console.log(`Took ${Date.now() - start}ms`);
```

You can increase the thread pool size:

```bash
# Set before starting Node.js
UV_THREADPOOL_SIZE=16 node server.js
```

But there's a limit (128 threads). And more threads means more memory. The right answer
is usually to design around the constraint, not throw threads at it.

### What Would Happen If There Were No Thread Pool?

File system operations would block the main thread. While reading a file, your server
couldn't handle any requests. This is exactly what happens with synchronous file APIs:

```typescript
import * as fs from "fs";

// BAD: This blocks the entire event loop!
const data = fs.readFileSync("huge-file.csv");
// While this reads, NO requests are handled. Your server is frozen.

// GOOD: This uses the thread pool, event loop keeps running
fs.readFile("huge-file.csv", (err, data) => {
  // Server keeps handling requests while this reads
});
```

---

## Why Single-Threaded Doesn't Mean Slow

People hear "single-threaded" and assume Node.js is slow. This comes from comparing
it to multi-threaded servers like Java or Go. But the comparison is misleading.

### The Multi-Threaded Model

```
Request 1 ──> [Thread 1] ──> Waiting for DB... ──> Process ──> Response
Request 2 ──> [Thread 2] ──> Waiting for DB... ──> Process ──> Response
Request 3 ──> [Thread 3] ──> Waiting for DB... ──> Process ──> Response
Request 4 ──> [Thread 4] ──> Waiting for DB... ──> Process ──> Response
Request 5 ──> WAITING (no available threads)

Each thread:
  - Allocates ~1MB of stack memory
  - Requires context switching by the OS
  - Spends 95% of its time WAITING for I/O
```

### The Event Loop Model

```
Request 1 ──┐
Request 2 ──┤
Request 3 ──┼──> [Single Thread / Event Loop]
Request 4 ──┤    - Never waits for I/O
Request 5 ──┘    - Registers callbacks and moves on
                 - Processes responses as they arrive

Memory per connection: ~few KB (just the callback and data)
No context switching overhead
```

### The Math

Most backend operations are **I/O-bound**, not CPU-bound. Your server spends most of
its time waiting:
- Waiting for the database to respond (~1-50ms)
- Waiting for an external API (~50-500ms)
- Waiting for file system reads (~0.1-10ms)
- Waiting for the client to send data (~variable)

During all that waiting, a thread-per-request model has threads sitting idle, consuming
memory and requiring OS scheduling. The event loop model has one thread doing useful
work.

For a server handling 10,000 concurrent connections:
- **Thread-per-request:** 10,000 threads * 1MB = ~10GB just for thread stacks
- **Event loop:** 1 thread + callbacks in memory = ~tens of MB

### When Single-Threaded IS Slow

CPU-intensive operations block the event loop. If your code does heavy computation,
no other request can be processed:

```typescript
// BAD: Blocks the event loop for potentially seconds
app.get("/fibonacci/:n", (req, res) => {
  const n = parseInt(req.params.n);
  const result = fibonacci(n); // CPU-bound: blocks everything!
  res.json({ result });
});

function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
```

While `fibonacci(45)` computes (takes several seconds), your server handles zero
requests. Every client is frozen.

### Solutions for CPU-Intensive Work

```typescript
// Solution 1: Worker Threads (Node.js built-in)
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

if (isMainThread) {
  // Main thread: spawn a worker for CPU-intensive work
  app.get("/fibonacci/:n", async (req, res) => {
    const n = parseInt(req.params.n);
    const result = await runInWorker(n);
    res.json({ result });
  });

  function runInWorker(n: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: n });
      worker.on("message", resolve);
      worker.on("error", reject);
    });
  }
} else {
  // Worker thread: does the heavy computation
  const result = fibonacci(workerData);
  parentPort!.postMessage(result);
}

// Solution 2: Break work into chunks with setImmediate
async function fibonacciNonBlocking(n: number): Promise<number> {
  // For large computations, yield to the event loop periodically
  const memo = new Map<number, number>();

  function fib(n: number): number {
    if (n <= 1) return n;
    if (memo.has(n)) return memo.get(n)!;
    const result = fib(n - 1) + fib(n - 2);
    memo.set(n, result);
    return result;
  }

  return new Promise((resolve) => {
    setImmediate(() => resolve(fib(n)));
  });
}
```

---

## Visualizing the Complete Picture

Let's trace a real HTTP request through the entire system:

```
1. Client sends HTTP request
        │
        v
2. OS receives TCP packet, notifies Node.js via epoll/kqueue/IOCP
        │
        v
3. Event Loop (Poll Phase) picks up the event
        │
        v
4. Your request handler runs:
   ┌──────────────────────────────────────────┐
   │  app.get("/users/:id", async (req, res) => {
   │
   │    // 5. Parse request (synchronous, main thread)
   │    const id = req.params.id;
   │
   │    // 6. Database query (async, goes to OS via network)
   │    const user = await db.query("SELECT ...");
   │    // Event loop handles other requests while waiting!
   │
   │    // 7. File read (async, goes to thread pool)
   │    const avatar = await fs.readFile(`avatars/${id}.png`);
   │    // Event loop handles other requests while waiting!
   │
   │    // 8. Send response (async, goes to OS via network)
   │    res.json({ user, avatar: avatar.toString("base64") });
   │  });
   └──────────────────────────────────────────┘
        │
        v
9. OS sends TCP response to client
```

At steps 6 and 7, your code is `await`ing. The event loop is NOT blocked. It's
processing other requests, running other callbacks, keeping the server alive.

---

## Memory and Garbage Collection

V8 manages memory with a garbage collector. Understanding it helps you avoid memory leaks
and performance cliffs.

### V8 Memory Layout

```
┌─────────────────────────────────────────┐
│              V8 Heap                    │
│                                         │
│  ┌──────────────┐  ┌────────────────┐  │
│  │  New Space    │  │   Old Space    │  │
│  │  (Young Gen)  │  │   (Old Gen)    │  │
│  │              │  │                │  │
│  │  Short-lived  │  │  Long-lived    │  │
│  │  objects      │  │  objects       │  │
│  │              │  │                │  │
│  │  ~1-8 MB     │  │  ~hundreds MB  │  │
│  │  Collected    │  │  Collected     │  │
│  │  frequently   │  │  less often    │  │
│  └──────────────┘  └────────────────┘  │
│                                         │
│  ┌──────────────┐  ┌────────────────┐  │
│  │  Code Space   │  │  Large Object  │  │
│  │  (compiled    │  │  Space         │  │
│  │   code)       │  │                │  │
│  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────┘
```

Most objects in a request handler are short-lived (created, used, discarded). These live
in New Space and are collected quickly (minor GC). Objects that survive multiple
collections get promoted to Old Space.

### What Would Happen If You Had a Memory Leak?

```typescript
// Classic memory leak: growing array that's never cleaned up
const requestLog: object[] = [];

app.get("/", (req, res) => {
  // Every request adds to this array. It NEVER shrinks.
  requestLog.push({
    url: req.url,
    timestamp: new Date(),
    headers: req.headers,
  });

  res.json({ status: "ok" });
});

// After 1 million requests, requestLog holds 1 million objects.
// Old Space grows. GC pauses get longer. Server gets slower.
// Eventually: "JavaScript heap out of memory" -- process crashes.
```

This is why understanding the runtime matters. The code "works" in development. In
production, under load, it kills your server.

---

## Key Runtime Numbers Every Backend Developer Should Know

```
Operation                          | Approximate Time
-----------------------------------|------------------
L1 cache reference                 | 0.5 ns
L2 cache reference                 | 7 ns
Main memory reference              | 100 ns
SSD random read                    | 150,000 ns (150 us)
Network round trip (same DC)       | 500,000 ns (500 us)
SSD sequential read (1 MB)         | 1,000,000 ns (1 ms)
Network round trip (US coast)      | 40,000,000 ns (40 ms)
Network round trip (transatlantic) | 80,000,000 ns (80 ms)

Node.js event loop tick             | ~1-2 ms under load
Database query (simple)             | 1-10 ms
Database query (complex)            | 10-100 ms
HTTP request to external API        | 50-500 ms
```

Notice the massive gap between "in-memory operations" (nanoseconds) and "I/O operations"
(milliseconds). This is why the event loop model works so well -- it fills the I/O gaps
with useful work instead of idle waiting.

---

## Cluster Module: Scaling Beyond One CPU

One thread means one CPU core. If your server has 8 cores, you're using 12.5% of your
hardware. The `cluster` module fixes this:

```typescript
import cluster from "cluster";
import { cpus } from "os";
import http from "http";

if (cluster.isPrimary) {
  const numCPUs = cpus().length;
  console.log(`Primary process ${process.pid} starting ${numCPUs} workers`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork(); // Auto-restart crashed workers
  });
} else {
  // Workers share the same port
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(`Handled by worker ${process.pid}\n`);
  }).listen(3000);

  console.log(`Worker ${process.pid} started`);
}
```

```
┌──────────────────────────────────────────────────┐
│                Primary Process                   │
│            (manages workers, no HTTP)             │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ Worker 1 │ │ Worker 2 │ │ Worker 3 │  ...     │
│  │ Port 3000│ │ Port 3000│ │ Port 3000│          │
│  │ (own V8) │ │ (own V8) │ │ (own V8) │          │
│  └──────────┘ └──────────┘ └──────────┘          │
└──────────────────────────────────────────────────┘
```

Each worker is a separate process with its own V8 instance, its own event loop, and its
own memory. The OS distributes incoming connections across workers.

In production, you'd typically use a process manager like PM2 instead of writing cluster
code yourself. But understanding the mechanism helps you reason about scaling.

---

## process.env and Runtime Configuration

Your backend reads configuration from the environment. This is a runtime concern:

```typescript
// process.env values are ALWAYS strings (or undefined)
const port = process.env.PORT; // string | undefined -- NOT number!

// Common mistake:
if (process.env.PORT === 3000) {
  // This is NEVER true! process.env.PORT is "3000" (string), not 3000 (number)
}

// Correct:
const port = parseInt(process.env.PORT ?? "3000", 10);

if (isNaN(port)) {
  console.error("PORT must be a number");
  process.exit(1);
}
```

### A Type-Safe Config Loader

```typescript
interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  nodeEnv: "development" | "production" | "test";
}

function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl: required("DATABASE_URL"),
    jwtSecret: required("JWT_SECRET"),
    nodeEnv: (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"],
  };
}

// Validate on startup -- fail fast if config is missing
const config = loadConfig();
console.log(`Server starting on ${config.host}:${config.port}`);
```

---

## Exercises

### Exercise 1: Event Loop Ordering

Without running the code, predict the output order. Then run it to verify:

```typescript
console.log("A");

setTimeout(() => console.log("B"), 0);

Promise.resolve().then(() => console.log("C"));

process.nextTick(() => console.log("D"));

setImmediate(() => console.log("E"));

Promise.resolve().then(() => {
  console.log("F");
  process.nextTick(() => console.log("G"));
});

console.log("H");
```

Write a paragraph explaining WHY the output is in that order, referencing event loop
phases and microtask queues.

### Exercise 2: Thread Pool Saturation

Write a script that:
1. Sets `UV_THREADPOOL_SIZE=2`
2. Reads 10 files concurrently using `fs.promises.readFile`
3. Measures how long each file read takes
4. Explains why some reads take longer than others

### Exercise 3: Blocking Detection

Write a middleware that detects when the event loop is blocked for more than 100ms.
Use `setInterval` and `Date.now()` to measure actual vs expected time between ticks.
Log a warning when blocking is detected.

Hint:
```typescript
let lastCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const drift = now - lastCheck - INTERVAL;
  // If drift is large, something blocked the event loop...
  lastCheck = now;
}, INTERVAL);
```

### Exercise 4: Memory Observation

Write a script that:
1. Creates 1 million small objects in a loop
2. Logs `process.memoryUsage()` at each step (every 100,000 objects)
3. Sets the objects to `null`
4. Forces garbage collection with `--expose-gc` flag and `global.gc()`
5. Logs memory usage after GC

Explain the relationship between heapUsed, heapTotal, and external.

### Exercise 5: Cluster Communication

Build a simple cluster setup where:
1. The primary process keeps a counter
2. Workers can send "increment" messages to the primary
3. Workers can request the current count from the primary
4. The primary broadcasts the updated count to all workers

This demonstrates how to share state across processes (spoiler: it's harder than shared
memory in threaded languages -- and that's by design).
