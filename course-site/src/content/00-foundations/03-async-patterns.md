# Lesson 3: Async Patterns

## Why Async Matters on the Backend

In Lesson 2, we learned that Node.js uses a single-threaded event loop. That means every
time your code waits for something -- a database query, a file read, an HTTP request --
it must *yield* control back to the event loop. Otherwise, the entire server freezes.

Async programming is not optional in Node.js. It's the fundamental paradigm. Let's trace
the evolution from callbacks to streams, understanding why each pattern exists and when
to use it.

---

## Callbacks: Where It All Started

A callback is a function you pass to another function, saying "call me when you're done."
It's the simplest possible async pattern.

```typescript
import * as fs from "fs";

// "Read this file. When you're done, call this function."
fs.readFile("/etc/hosts", "utf-8", (err, data) => {
  if (err) {
    console.error("Failed to read file:", err.message);
    return;
  }
  console.log("File contents:", data);
});

console.log("This runs BEFORE the file is read!");
```

The Node.js callback convention:
1. The callback is always the **last** argument
2. The first parameter of the callback is **always** the error (or `null`)
3. Success data comes after the error

```typescript
// The pattern:
function doSomething(input: string, callback: (err: Error | null, result?: string) => void): void {
  // ...
}
```

### Why Callbacks Are Problematic

The callback pattern works fine for single operations. But backend code rarely does just
one thing. You read from a database, then call an API, then write to a file, then send
a response. Each step depends on the previous one.

```typescript
// Callback Hell (aka "Pyramid of Doom")
// Real production code actually looked like this in early Node.js

function handleUserRegistration(email: string, password: string, callback: (err: Error | null) => void) {
  // Step 1: Check if user exists
  database.findUser(email, (err, existingUser) => {
    if (err) {
      callback(err);
      return;
    }
    if (existingUser) {
      callback(new Error("User already exists"));
      return;
    }

    // Step 2: Hash the password
    crypto.hash(password, (err, hashedPassword) => {
      if (err) {
        callback(err);
        return;
      }

      // Step 3: Create the user
      database.createUser(email, hashedPassword, (err, user) => {
        if (err) {
          callback(err);
          return;
        }

        // Step 4: Send welcome email
        emailService.sendWelcome(email, (err) => {
          if (err) {
            // Do we rollback the user creation? This gets complicated...
            console.error("Failed to send welcome email:", err);
          }

          // Step 5: Log the event
          analytics.track("user_registered", user.id, (err) => {
            if (err) {
              console.error("Failed to track event:", err);
            }

            callback(null); // Finally done!
          });
        });
      });
    });
  });
}
```

Count the nesting levels. Count the error handling repetition. Imagine debugging this.
Imagine adding a step in the middle. This is why Promises were invented.

---

## Promises: Taming the Callback Chaos

A Promise represents a value that will be available *in the future*. It can be in one
of three states:

```
┌──────────┐     resolve(value)    ┌───────────┐
│ PENDING  │ ────────────────────> │ FULFILLED │
│          │                       │  (value)  │
└──────────┘                       └───────────┘
     │
     │        reject(reason)       ┌───────────┐
     └────────────────────────────>│ REJECTED  │
                                   │  (reason) │
                                   └───────────┘
```

Once a Promise is fulfilled or rejected, it **never changes state again**. This is a
critical property. A fulfilled Promise always holds the same value. This makes Promises
predictable and composable.

### Building a Promise from Scratch

To truly understand Promises, let's build a simplified version:

```typescript
type Resolve<T> = (value: T) => void;
type Reject = (reason: Error) => void;
type Executor<T> = (resolve: Resolve<T>, reject: Reject) => void;
type OnFulfilled<T, U> = (value: T) => U | SimplePromise<U>;
type OnRejected<U> = (reason: Error) => U | SimplePromise<U>;

class SimplePromise<T> {
  private state: "pending" | "fulfilled" | "rejected" = "pending";
  private value: T | undefined;
  private reason: Error | undefined;
  private onFulfilledCallbacks: Array<(value: T) => void> = [];
  private onRejectedCallbacks: Array<(reason: Error) => void> = [];

  constructor(executor: Executor<T>) {
    const resolve: Resolve<T> = (value) => {
      if (this.state !== "pending") return; // Can't change state once settled
      this.state = "fulfilled";
      this.value = value;
      // Execute all waiting .then() callbacks
      this.onFulfilledCallbacks.forEach((cb) => cb(value));
    };

    const reject: Reject = (reason) => {
      if (this.state !== "pending") return;
      this.state = "rejected";
      this.reason = reason;
      this.onRejectedCallbacks.forEach((cb) => cb(reason));
    };

    try {
      executor(resolve, reject);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  then<U>(onFulfilled?: OnFulfilled<T, U>, onRejected?: OnRejected<U>): SimplePromise<U> {
    return new SimplePromise<U>((resolve, reject) => {
      const handleFulfilled = (value: T) => {
        try {
          if (onFulfilled) {
            const result = onFulfilled(value);
            if (result instanceof SimplePromise) {
              result.then(resolve, reject);
            } else {
              resolve(result);
            }
          } else {
            resolve(value as unknown as U);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const handleRejected = (reason: Error) => {
        try {
          if (onRejected) {
            const result = onRejected(reason);
            if (result instanceof SimplePromise) {
              result.then(resolve, reject);
            } else {
              resolve(result);
            }
          } else {
            reject(reason);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      if (this.state === "fulfilled") {
        // Already resolved -- schedule callback (async, like real Promises)
        queueMicrotask(() => handleFulfilled(this.value!));
      } else if (this.state === "rejected") {
        queueMicrotask(() => handleRejected(this.reason!));
      } else {
        // Still pending -- save callbacks for later
        this.onFulfilledCallbacks.push(handleFulfilled);
        this.onRejectedCallbacks.push(handleRejected);
      }
    });
  }

  catch<U>(onRejected: OnRejected<U>): SimplePromise<U> {
    return this.then(undefined, onRejected);
  }
}
```

**Why build this?** Because now you understand that:
1. `.then()` returns a NEW Promise (that's what makes chaining work)
2. Callbacks are stored and executed later (that's the async part)
3. The executor runs **synchronously** (the constructor calls your function immediately)
4. State transitions are one-way (pending -> fulfilled OR pending -> rejected)

### Using Promises: The Callback Hell Rewrite

```typescript
function handleUserRegistration(email: string, password: string): Promise<void> {
  return database.findUser(email)
    .then((existingUser) => {
      if (existingUser) throw new Error("User already exists");
      return crypto.hash(password);
    })
    .then((hashedPassword) => {
      return database.createUser(email, hashedPassword);
    })
    .then((user) => {
      // Fire-and-forget: don't let email failure block registration
      emailService.sendWelcome(email).catch(console.error);
      return analytics.track("user_registered", user.id);
    })
    .catch((err) => {
      // One error handler for the entire chain
      console.error("Registration failed:", err.message);
      throw err; // Re-throw to propagate to caller
    });
}
```

Flat instead of nested. One error handler instead of five. Readable from top to bottom.

---

## Async/Await: Promises Made Beautiful

`async/await` is syntactic sugar over Promises. It makes async code look synchronous,
which makes it easier to read and reason about.

```typescript
// The same registration flow with async/await:
async function handleUserRegistration(email: string, password: string): Promise<void> {
  const existingUser = await database.findUser(email);
  if (existingUser) {
    throw new Error("User already exists");
  }

  const hashedPassword = await crypto.hash(password);
  const user = await database.createUser(email, hashedPassword);

  // Fire-and-forget for non-critical operations
  emailService.sendWelcome(email).catch(console.error);
  await analytics.track("user_registered", user.id);
}
```

This reads like synchronous code, but it's fully async. At each `await`, the function
*suspends* and yields control back to the event loop. Other requests are handled. When
the awaited Promise resolves, execution resumes.

### What `await` Actually Does

```typescript
// This:
const user = await getUser(id);
console.log(user.name);

// Is equivalent to this:
getUser(id).then((user) => {
  console.log(user.name);
});
```

The compiler transforms `await` into `.then()` chains. You write clean code; the runtime
sees Promise chains.

### Common Mistake: Sequential When You Mean Parallel

```typescript
// BAD: These run one after another (sequential)
// Total time: ~300ms (100 + 100 + 100)
async function getPageData(userId: string) {
  const user = await getUser(userId);         // 100ms
  const posts = await getPosts(userId);       // 100ms
  const notifications = await getNotifications(userId); // 100ms
  return { user, posts, notifications };
}

// GOOD: These run at the same time (parallel)
// Total time: ~100ms (all three overlap)
async function getPageData(userId: string) {
  const [user, posts, notifications] = await Promise.all([
    getUser(userId),
    getPosts(userId),
    getNotifications(userId),
  ]);
  return { user, posts, notifications };
}
```

**What would happen if you always used sequential awaits?** Your server would handle
requests 3x slower in this example. Multiply that across hundreds of endpoints, and your
server needs 3x more resources. The `Promise.all` pattern is one of the simplest
performance wins in backend development.

### Error Handling with Async/Await

```typescript
// Approach 1: try/catch (most common)
async function getUser(id: string): Promise<User> {
  try {
    const user = await database.findUser(id);
    if (!user) throw new Error("User not found");
    return user;
  } catch (error) {
    // error is 'unknown' in strict mode (TypeScript 4.4+)
    if (error instanceof Error) {
      console.error(`Failed to get user ${id}:`, error.message);
    }
    throw error; // Re-throw to let caller handle it
  }
}

// Approach 2: Catch on the Promise directly (useful for non-critical operations)
async function handleRequest() {
  const user = await getUser("123").catch(() => null);
  if (!user) {
    // Handle missing user
  }
}

// Approach 3: Wrapper that returns [error, data] tuple (Go-style)
async function tryCatch<T>(promise: Promise<T>): Promise<[Error, null] | [null, T]> {
  try {
    const data = await promise;
    return [null, data];
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), null];
  }
}

// Usage:
const [err, user] = await tryCatch(getUser("123"));
if (err) {
  console.error(err.message);
  return;
}
// user is User here (TypeScript narrows it)
```

---

## Promise Combinators: Controlling Concurrency

### Promise.all -- All Must Succeed

```typescript
// Resolves when ALL promises resolve. Rejects if ANY rejects.
const results = await Promise.all([
  fetchUser("123"),
  fetchOrders("123"),
  fetchPreferences("123"),
]);
// results: [User, Order[], Preferences]

// If ANY of these fails, the entire Promise.all rejects.
// The other promises are NOT cancelled (they keep running), but their
// results are ignored.
```

**When to use:** When you need ALL the data and can't proceed without it.

**The danger:** If one of 10 parallel requests fails, you lose all 10 results.

### Promise.allSettled -- Get All Results Regardless

```typescript
// Resolves when ALL promises settle (fulfill OR reject).
// Never rejects. You get the status of each promise.
const results = await Promise.allSettled([
  fetchUser("123"),
  fetchOrders("123"),
  fetchPreferences("123"),
]);

// results: [
//   { status: "fulfilled", value: User },
//   { status: "rejected", reason: Error },
//   { status: "fulfilled", value: Preferences },
// ]

// Process results individually:
for (const result of results) {
  if (result.status === "fulfilled") {
    console.log("Got:", result.value);
  } else {
    console.error("Failed:", result.reason.message);
  }
}
```

**When to use:** When partial data is acceptable. "Show what you can, degrade gracefully."

### Promise.race -- First One Wins

```typescript
// Resolves/rejects with the FIRST promise that settles.
// All other promises are ignored (but keep running).

// Classic use case: timeout
async function fetchWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]);
}

// If fetchUser takes longer than 5 seconds, we get a timeout error
const user = await fetchWithTimeout(fetchUser("123"), 5000);
```

**When to use:** Timeouts, selecting the fastest source, implementing deadlines.

### Promise.any -- First Success Wins

```typescript
// Resolves with the FIRST promise that FULFILLS.
// Only rejects if ALL promises reject.

// Use case: try multiple data sources, use whoever responds first
async function fetchFromFastestMirror(url: string): Promise<Response> {
  return Promise.any([
    fetch(`https://mirror1.example.com${url}`),
    fetch(`https://mirror2.example.com${url}`),
    fetch(`https://mirror3.example.com${url}`),
  ]);
}

// If mirror1 is slow and mirror2 is fast, you get mirror2's response.
// If all mirrors fail, you get an AggregateError with all the failures.
```

**When to use:** Redundant sources, hedged requests, fallback patterns.

### Practical Pattern: Controlled Concurrency

`Promise.all` with 10,000 items will fire 10,000 requests simultaneously. That can
overwhelm your database, hit rate limits, or run out of file descriptors. You need
controlled concurrency:

```typescript
async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = [];
  const executing: Promise<void>[] = [];

  for (const [index, item] of items.entries()) {
    const promise = fn(item).then((result) => {
      results[index] = result;
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove settled promises
      const settled = executing.filter((p) => {
        let settled = false;
        p.then(() => (settled = true), () => (settled = true));
        return settled;
      });
      // Simpler approach: track indices
    }
  }

  await Promise.all(executing);
  return results;
}

// A cleaner implementation using a semaphore pattern:
async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  // Start `concurrency` workers
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

// Usage: process 10,000 users, 50 at a time
const results = await mapConcurrent(userIds, 50, async (id) => {
  return await fetchUser(id);
});
```

---

## Streams: Handling Data That Doesn't Fit in Memory

Everything we've discussed so far assumes your data fits in memory. Read the whole file,
parse the whole response, process the whole result set. But what happens when it doesn't?

Imagine:
- A 10GB log file
- A database query that returns 1 million rows
- A real-time data feed that never ends
- An HTTP response body being sent to a slow client

You can't `await` the whole thing. You need **streams**.

### The Analogy

Think of a garden hose vs a bucket. With a bucket (Promises), you wait until the entire
bucket is full, then carry it. With a hose (streams), water flows continuously -- you
process it as it arrives.

```
Promise approach (bucket):
[Read entire file] ──> [Process all data] ──> [Write entire output]
Memory usage: O(file_size)

Stream approach (hose):
[Read chunk] ──> [Process chunk] ──> [Write chunk] ──> repeat
Memory usage: O(chunk_size)  -- constant regardless of file size!
```

### The Four Types of Streams

```
┌────────────┐     ┌─────────────┐     ┌────────────┐
│  Readable  │ ──> │  Transform  │ ──> │  Writable  │
│            │     │             │     │            │
│  Source of │     │ Transforms  │     │ Destination│
│  data      │     │ data        │     │ for data   │
└────────────┘     └─────────────┘     └────────────┘

           ┌────────────┐
           │   Duplex   │
           │            │
           │ Both read  │
           │ and write  │
           └────────────┘
```

1. **Readable**: Produces data. File reads, HTTP request bodies, database cursors.
2. **Writable**: Consumes data. File writes, HTTP response bodies, logging.
3. **Transform**: Both readable and writable. Modifies data as it passes through.
   Compression, encryption, parsing.
4. **Duplex**: Both readable and writable, but the two sides are independent.
   TCP sockets, WebSockets.

### Reading a File with Streams

```typescript
import { createReadStream } from "fs";

// BAD: Reads entire file into memory
import { readFile } from "fs/promises";
const data = await readFile("huge-file.csv", "utf-8"); // 10GB in memory!

// GOOD: Processes file chunk by chunk
const stream = createReadStream("huge-file.csv", {
  encoding: "utf-8",
  highWaterMark: 64 * 1024, // 64KB chunks
});

let lineCount = 0;

stream.on("data", (chunk: string) => {
  // Each chunk is ~64KB of the file
  lineCount += chunk.split("\n").length - 1;
});

stream.on("end", () => {
  console.log(`File has ${lineCount} lines`);
});

stream.on("error", (err) => {
  console.error("Failed to read file:", err.message);
});
```

### Writing with Streams

```typescript
import { createWriteStream } from "fs";

const output = createWriteStream("output.csv");

// Write header
output.write("id,name,email\n");

// Write 1 million rows without holding them all in memory
for (let i = 0; i < 1_000_000; i++) {
  const row = `${i},User ${i},user${i}@example.com\n`;

  // write() returns false if the internal buffer is full
  const canContinue = output.write(row);

  if (!canContinue) {
    // Wait for the stream to drain before writing more
    await new Promise<void>((resolve) => output.once("drain", resolve));
  }
}

// Signal that we're done writing
output.end();

// Wait for all data to be flushed
await new Promise<void>((resolve) => output.on("finish", resolve));
```

### Transform Streams

Transform streams are the most powerful pattern for data processing:

```typescript
import { Transform, TransformCallback } from "stream";

// A transform that converts CSV rows to JSON
class CsvToJsonTransform extends Transform {
  private headers: string[] = [];
  private isFirstChunk = true;
  private buffer = "";

  constructor() {
    super({
      readableObjectMode: true, // Output objects, not buffers
    });
  }

  _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");

    // Keep the last partial line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim() === "") continue;

      if (this.isFirstChunk && this.headers.length === 0) {
        this.headers = line.split(",").map((h) => h.trim());
        this.isFirstChunk = false;
        continue;
      }

      const values = line.split(",").map((v) => v.trim());
      const obj: Record<string, string> = {};
      this.headers.forEach((header, i) => {
        obj[header] = values[i] || "";
      });

      this.push(obj);
    }

    callback();
  }

  _flush(callback: TransformCallback): void {
    // Process any remaining data in the buffer
    if (this.buffer.trim()) {
      const values = this.buffer.split(",").map((v) => v.trim());
      const obj: Record<string, string> = {};
      this.headers.forEach((header, i) => {
        obj[header] = values[i] || "";
      });
      this.push(obj);
    }
    callback();
  }
}
```

### The Pipeline Function: Composing Streams Safely

Piping streams manually with `.pipe()` has a problem: if one stream errors, the others
aren't automatically cleaned up. The `pipeline` function from `stream/promises` fixes this:

```typescript
import { pipeline } from "stream/promises";
import { createReadStream, createWriteStream } from "fs";
import { createGzip } from "zlib";
import { Transform } from "stream";

// Process a CSV file: read -> transform -> compress -> write
await pipeline(
  createReadStream("input.csv"),
  new CsvToJsonTransform(),
  new Transform({
    objectMode: true,
    transform(obj, encoding, callback) {
      // Filter: only keep active users
      if (obj.status === "active") {
        callback(null, JSON.stringify(obj) + "\n");
      } else {
        callback(); // Skip this object
      }
    },
  }),
  createGzip(),
  createWriteStream("active-users.json.gz")
);

// If ANY stream in the pipeline errors, ALL streams are properly closed.
// No resource leaks. No hanging file descriptors.
```

---

## Backpressure: The Silent Performance Killer

Backpressure occurs when a writable stream can't consume data as fast as a readable
stream produces it. Without handling it, data accumulates in memory until your process
crashes.

### The Analogy

Imagine a factory assembly line. Station A produces widgets at 100/minute. Station B
can only process 50/minute. Without backpressure, widgets pile up between stations
until they overflow onto the floor.

With backpressure, Station A slows down to match Station B's speed. The line flows
smoothly.

### Backpressure in Node.js

```typescript
import { createReadStream, createWriteStream } from "fs";

const source = createReadStream("huge-file.dat"); // Fast reader (SSD)
const dest = createWriteStream("/network-drive/output.dat"); // Slow writer (network)

// BAD: No backpressure handling
source.on("data", (chunk) => {
  dest.write(chunk);
  // If dest can't keep up, chunks buffer in memory.
  // With a 10GB file, this will eventually crash.
});

// GOOD: Using .pipe() -- handles backpressure automatically
source.pipe(dest);
// When dest's internal buffer is full, source is automatically paused.
// When dest drains, source resumes. Beautiful.

// BEST: Using pipeline for proper error handling
import { pipeline } from "stream/promises";
await pipeline(source, dest);
```

### Manual Backpressure Handling

Sometimes you need manual control:

```typescript
import { Readable, Writable } from "stream";

// A slow consumer
const slowWriter = new Writable({
  write(chunk, encoding, callback) {
    // Simulate slow processing
    setTimeout(() => {
      process.stdout.write(".");
      callback();
    }, 100);
  },
});

// A fast producer with backpressure awareness
const fastReader = new Readable({
  read(size) {
    for (let i = 0; i < 10; i++) {
      const data = Buffer.alloc(1024, "x");
      const canPushMore = this.push(data);

      if (!canPushMore) {
        // The consumer is overwhelmed -- stop producing
        // Readable will call read() again when the consumer is ready
        return;
      }
    }
  },
});

// pipeline handles the backpressure dance between them
import { pipeline } from "stream/promises";
await pipeline(fastReader, slowWriter);
```

### What Would Happen Without Backpressure?

```typescript
// Simulating what happens without backpressure
const results: Buffer[] = [];
let memoryUsage = process.memoryUsage().heapUsed;

const interval = setInterval(() => {
  const current = process.memoryUsage().heapUsed;
  const growthMB = (current - memoryUsage) / 1024 / 1024;
  console.log(`Memory growth: +${growthMB.toFixed(1)}MB`);
}, 1000);

// Producer is fast, consumer is slow
// Without backpressure, memory grows until OOM
const fastSource = createReadStream("10gb-file.dat");
const slowDest = new Writable({
  highWaterMark: 16, // Tiny buffer to demonstrate the problem
  write(chunk, encoding, callback) {
    // Slow consumer: 100ms per chunk
    setTimeout(callback, 100);
  },
});

// If you just do fastSource.on('data', chunk => slowDest.write(chunk))
// memory will balloon. Use pipeline instead.
```

---

## Async Iterators: The Modern Stream API

Node.js streams implement the async iterator protocol, giving you a much cleaner
API with `for await...of`:

```typescript
import { createReadStream } from "fs";
import * as readline from "readline";

// Process a file line by line with async iteration
async function processLogFile(filePath: string): Promise<void> {
  const fileStream = createReadStream(filePath);
  const lines = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let errorCount = 0;
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber++;
    if (line.includes("ERROR")) {
      errorCount++;
      console.log(`Line ${lineNumber}: ${line}`);
    }
  }

  console.log(`\nFound ${errorCount} errors in ${lineNumber} lines`);
}

// Process database results with async iteration
async function* fetchUsersInBatches(batchSize: number): AsyncGenerator<User[]> {
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const batch = await database.query(
      "SELECT * FROM users LIMIT $1 OFFSET $2",
      [batchSize, offset]
    );

    if (batch.length === 0) {
      hasMore = false;
    } else {
      yield batch;
      offset += batchSize;
    }
  }
}

// Usage:
for await (const batch of fetchUsersInBatches(100)) {
  for (const user of batch) {
    await processUser(user);
  }
}
```

### Async Generators for Data Processing Pipelines

```typescript
// Build composable async pipelines with generators

async function* readLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      yield line;
    }
  }

  if (buffer) yield buffer;
}

async function* filter<T>(
  source: AsyncIterable<T>,
  predicate: (item: T) => boolean
): AsyncGenerator<T> {
  for await (const item of source) {
    if (predicate(item)) {
      yield item;
    }
  }
}

async function* map<T, U>(
  source: AsyncIterable<T>,
  transform: (item: T) => U
): AsyncGenerator<U> {
  for await (const item of source) {
    yield transform(item);
  }
}

async function* take<T>(source: AsyncIterable<T>, count: number): AsyncGenerator<T> {
  let taken = 0;
  for await (const item of source) {
    yield item;
    taken++;
    if (taken >= count) return;
  }
}

// Compose them:
const lines = readLines("access.log");
const errorLines = filter(lines, (line) => line.includes("500"));
const timestamps = map(errorLines, (line) => line.split(" ")[0]);
const firstTen = take(timestamps, 10);

for await (const timestamp of firstTen) {
  console.log(`Server error at: ${timestamp}`);
}
// Reads only as much of the file as needed to find 10 errors!
```

---

## Putting It All Together: A Real-World Example

Let's build a complete example that uses multiple async patterns: a function that
processes a large CSV file, enriches each row with data from an API, and writes
the results to a new file -- all with proper backpressure, concurrency limits, and
error handling.

```typescript
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Transform, TransformCallback } from "stream";
import * as readline from "readline";

interface RawRecord {
  userId: string;
  action: string;
  timestamp: string;
}

interface EnrichedRecord extends RawRecord {
  userName: string;
  email: string;
}

// Step 1: Parse CSV to objects (Transform stream)
class CsvParser extends Transform {
  private headers: string[] | null = null;

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    const line = chunk.toString().trim();
    if (!line) return callback();

    const values = line.split(",");

    if (!this.headers) {
      this.headers = values;
      return callback();
    }

    const record: Record<string, string> = {};
    this.headers.forEach((h, i) => (record[h] = values[i] || ""));
    this.push(record);
    callback();
  }
}

// Step 2: Enrich with API data (Transform stream with concurrency control)
class Enricher extends Transform {
  private pending = 0;
  private readonly maxConcurrency = 10;

  constructor(private readonly apiBaseUrl: string) {
    super({ objectMode: true });
  }

  async _transform(record: RawRecord, _encoding: string, callback: TransformCallback): Promise<void> {
    // Simple concurrency limiting
    while (this.pending >= this.maxConcurrency) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.pending++;

    try {
      const response = await fetch(`${this.apiBaseUrl}/users/${record.userId}`);
      const user = await response.json() as { name: string; email: string };

      const enriched: EnrichedRecord = {
        ...record,
        userName: user.name,
        email: user.email,
      };

      this.push(enriched);
    } catch {
      // On API failure, pass through with defaults
      this.push({ ...record, userName: "UNKNOWN", email: "UNKNOWN" });
    } finally {
      this.pending--;
    }

    callback();
  }
}

// Step 3: Convert back to CSV (Transform stream)
class JsonToCsv extends Transform {
  private headerWritten = false;

  constructor() {
    super({ objectMode: true });
  }

  _transform(record: EnrichedRecord, _encoding: string, callback: TransformCallback): void {
    if (!this.headerWritten) {
      const headers = Object.keys(record).join(",") + "\n";
      this.push(headers);
      this.headerWritten = true;
    }

    const values = Object.values(record).join(",") + "\n";
    this.push(values);
    callback();
  }
}

// Run the pipeline
async function processFile(inputPath: string, outputPath: string): Promise<void> {
  const lineReader = readline.createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  // Convert readline to a readable stream
  const lineStream = new Transform({
    objectMode: true,
    transform(line, encoding, callback) {
      this.push(line);
      callback();
    },
  });

  // Pipe readline into our transform
  lineReader.on("line", (line) => lineStream.write(line));
  lineReader.on("close", () => lineStream.end());

  await pipeline(
    lineStream,
    new CsvParser(),
    new Enricher("https://api.example.com"),
    new JsonToCsv(),
    createWriteStream(outputPath)
  );

  console.log(`Done! Processed file saved to ${outputPath}`);
}
```

---

## Exercises

### Exercise 1: Build Your Own Promise.all

Implement `myPromiseAll` that behaves like `Promise.all`:
- Takes an array of promises
- Returns a promise that resolves with an array of results
- Rejects if any promise rejects
- Results must be in the same order as the input (not execution order)

Do NOT use `Promise.all` in your implementation.

### Exercise 2: Retry with Exponential Backoff

Implement an async `retry` function:
- Takes an async function, max attempts, and initial delay
- On failure, waits `delay * 2^attempt` milliseconds before retrying
- Adds random jitter (0-50% of delay) to prevent thundering herd
- Returns the successful result or throws the last error

```typescript
const result = await retry(
  () => fetch("https://flaky-api.com/data"),
  5,          // max 5 attempts
  1000        // start with 1s delay, then 2s, 4s, 8s, 16s
);
```

### Exercise 3: Stream Pipeline

Write a program that:
1. Reads a large text file (create a test file with 100,000+ lines)
2. Filters lines containing a search term (Transform stream)
3. Numbers each matching line (Transform stream)
4. Writes the results to an output file

Use `pipeline` from `stream/promises`. Measure memory usage with
`process.memoryUsage()` to prove it stays constant regardless of input size.

### Exercise 4: Async Generator Pipeline

Rewrite Exercise 3 using async generators instead of Transform streams. Which
approach do you find more readable? Which gives you more control?

### Exercise 5: Concurrent Task Queue

Build a `TaskQueue` class:

```typescript
const queue = new TaskQueue(3); // max 3 concurrent tasks

// Add 100 tasks -- only 3 run at a time
for (let i = 0; i < 100; i++) {
  queue.add(async () => {
    await processItem(i);
  });
}

await queue.drain(); // Wait for all tasks to complete
```

Requirements:
- Tasks start immediately up to the concurrency limit
- New tasks start as previous ones complete
- `drain()` resolves when all tasks are done
- Errors in individual tasks don't prevent other tasks from running
- `drain()` rejects with an AggregateError if any tasks failed
