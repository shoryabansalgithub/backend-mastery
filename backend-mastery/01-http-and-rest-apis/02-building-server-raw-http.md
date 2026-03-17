# Lesson 2: Building a Server with Node's HTTP Module

## What You'll Learn

In the last lesson, you built an HTTP server from raw TCP. It was painful and buggy.
Now you'll see how Node's `http` module handles all those edge cases for you, and
you'll build a real server with routing, request body parsing, and proper response
handling -- all without a framework.

---

## Why Not Jump Straight to Express?

Because Express is a convenience layer over `http.createServer()`. If you don't
understand the underlying API, you won't understand:

- Why `req.body` is `undefined` without middleware
- How streaming works
- What Express is actually doing when you call `res.json()`
- How to debug when things go wrong at the HTTP level

Think of Express as automatic transmission. It's great for daily driving. But if
you've never driven stick, you don't really understand what "gear" means, and you
can't troubleshoot when the automatic behaves strangely.

---

## Node's `http` Module: What It Does for You

Remember all the bugs in our raw TCP server? Here's what `http` handles:

| Problem | How `http` Solves It |
|---------|---------------------|
| Chunked TCP data | Buffers and parses complete HTTP messages |
| Keep-alive connections | Manages connection lifecycle |
| Header parsing | Parses headers into an object |
| Request line parsing | Gives you `req.method`, `req.url` |
| Content-Length management | Sets it automatically for `res.end(data)` |
| Transfer-Encoding: chunked | Handles streaming responses |
| Connection timeouts | `server.timeout` configuration |
| Malformed requests | Returns 400 automatically |

That's a lot of work we don't have to do.

---

## Your First `http` Server

```typescript
// 01-basic-server.ts
import * as http from "http";

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);
  console.log("Headers:", req.headers);

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello, World!");
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
```

Let's break this down:

### `http.createServer(callback)`

Creates a server. The callback fires for every incoming HTTP request. It receives two
arguments:

- `req` (IncomingMessage) -- the parsed request
- `res` (ServerResponse) -- your tool for building the response

### The Request Object (`req`)

```typescript
req.method;     // "GET", "POST", etc.
req.url;        // "/api/users?page=2" (path + query string)
req.headers;    // { host: "localhost:3000", accept: "*/*", ... }
req.httpVersion; // "1.1"
```

Notice: `req.url` includes the query string but NOT the host. And headers are
already parsed into an object with **lowercased keys** (the `http` module does this
for you).

### The Response Object (`res`)

```typescript
res.writeHead(statusCode, headers);  // Set status and headers
res.write(chunk);                    // Send a chunk of the body
res.end(finalChunk?);               // End the response (optionally with a final chunk)
res.statusCode = 200;               // Alternative: set status without writeHead
res.setHeader("Content-Type", "application/json"); // Set one header
```

**Important:** You must call `res.end()` to finish the response. If you forget,
the client hangs forever waiting for more data. This is the #1 mistake beginners
make with raw `http` servers.

### Bad Code: Forgetting `res.end()`

```typescript
// BUG: Client hangs forever
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.write("Hello!");
  // Forgot res.end() -- the response never completes
});
```

### Fixed:

```typescript
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello!"); // write + end in one call
});
```

---

## Routing by Hand

Express gives you `app.get("/users", handler)`. Without Express, you parse the URL
yourself:

```typescript
// 02-routing.ts
import * as http from "http";
import { URL } from "url";

const server = http.createServer((req, res) => {
  // Parse the URL to separate path from query string
  const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method!;

  // Set default headers for all JSON responses
  res.setHeader("Content-Type", "application/json");

  // Route: GET /
  if (method === "GET" && path === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({ message: "Welcome to the API" }));
    return;
  }

  // Route: GET /users
  if (method === "GET" && path === "/users") {
    const page = parsedUrl.searchParams.get("page") || "1";
    const users = [
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ];
    res.writeHead(200);
    res.end(JSON.stringify({ page: Number(page), users }));
    return;
  }

  // Route: GET /users/:id (dynamic segment)
  const userMatch = path.match(/^\/users\/(\d+)$/);
  if (method === "GET" && userMatch) {
    const userId = Number(userMatch[1]);
    res.writeHead(200);
    res.end(JSON.stringify({ id: userId, name: "Placeholder" }));
    return;
  }

  // 404 for everything else
  res.writeHead(404);
  res.end(JSON.stringify({ error: `Cannot ${method} ${path}` }));
});

server.listen(3000, () => {
  console.log("Server on http://localhost:3000");
});
```

### The Pain Points

Already you can see problems:

1. **Every route is an if/else chain.** With 50 endpoints, this becomes unreadable.
2. **Dynamic segments require regex.** `/users/:id` has to be matched with a regular
   expression.
3. **No separation of concerns.** All route logic is in one callback.
4. **Query string parsing is manual.** The `URL` constructor helps, but it's still
   boilerplate.

This is the motivation for Express's router. But first, let's handle the hardest part
of raw HTTP: reading request bodies.

---

## Reading Request Bodies: The Stream Problem

Here's something that surprises everyone: `req` does not have a `.body` property.
There's no `req.body`. The request body arrives as a **stream of chunks**, and you
have to assemble it yourself.

### Why is the body a stream?

Think about a file upload. A client might send a 2GB video file. Should Node.js
wait until all 2GB are in memory before calling your handler? That would:

1. Use 2GB of RAM per upload
2. Make the client wait with no feedback
3. Crash your server if multiple uploads happen simultaneously

Instead, Node.js gives you the body as a readable stream. Data arrives in chunks
(typically 16KB-64KB each), and you decide what to do with each chunk -- buffer it,
write it to disk, pipe it somewhere, or reject the request early if it's too large.

### Reading a JSON Body

For small JSON bodies (which is most API requests), we buffer the chunks and parse
when done:

```typescript
// 03-read-body.ts
import * as http from "http";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_SIZE = 1024 * 1024; // 1MB limit

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;

      if (totalSize > MAX_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return readBody(req).then((text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON");
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method!;

  res.setHeader("Content-Type", "application/json");

  // POST /users -- create a user
  if (method === "POST" && path === "/users") {
    try {
      const body = await parseJsonBody(req);

      if (!body || typeof body !== "object") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Request body must be a JSON object" }));
        return;
      }

      const { name, email } = body as { name?: string; email?: string };

      if (!name || !email) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "name and email are required" }));
        return;
      }

      // "Create" the user
      const newUser = { id: Date.now(), name, email };

      res.writeHead(201);
      res.end(JSON.stringify(newUser));
    } catch (err) {
      if ((err as Error).message === "Invalid JSON") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON in request body" }));
      } else if ((err as Error).message === "Request body too large") {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "Request body too large" }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: `Cannot ${method} ${path}` }));
});

server.listen(3000, () => {
  console.log("Server on http://localhost:3000");
});
```

Test it:

```bash
# Successful creation
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com"}'

# Missing fields
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada"}'

# Invalid JSON
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d 'not json'
```

### Thought Experiment

Our `readBody` function has a 1MB size limit. What happens if we remove it? A
malicious client could send an endless stream of data:

```bash
# Don't actually run this against a server without a size limit
yes "aaaaaaaaaa" | curl -X POST http://localhost:3000/users -d @-
```

This would consume memory until your Node.js process crashes with an out-of-memory
error. Size limits on request bodies are a security requirement, not an optional
nicety.

---

## A More Complete Server: Putting It Together

Let's build a small but proper server with multiple routes and proper error handling:

```typescript
// 04-complete-server.ts
import * as http from "http";

// ============ Helpers ============

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(Object.assign(new Error("Body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ============ In-Memory Store ============

interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

let nextId = 1;
const todos: Map<number, Todo> = new Map();

// ============ Route Handlers ============

async function handleListTodos(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const completed = url.searchParams.get("completed");

  let result = Array.from(todos.values());

  if (completed === "true") {
    result = result.filter((t) => t.completed);
  } else if (completed === "false") {
    result = result.filter((t) => !t.completed);
  }

  sendJson(res, 200, { todos: result, total: result.length });
}

async function handleGetTodo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number
): Promise<void> {
  const todo = todos.get(id);
  if (!todo) {
    sendJson(res, 404, { error: `Todo ${id} not found` });
    return;
  }
  sendJson(res, 200, todo);
}

async function handleCreateTodo(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = (await readJsonBody(req)) as { title?: string } | null;

  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    sendJson(res, 400, { error: "title is required and must be a non-empty string" });
    return;
  }

  const todo: Todo = {
    id: nextId++,
    title: body.title.trim(),
    completed: false,
    createdAt: new Date().toISOString(),
  };

  todos.set(todo.id, todo);
  sendJson(res, 201, todo);
}

async function handleUpdateTodo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number
): Promise<void> {
  const todo = todos.get(id);
  if (!todo) {
    sendJson(res, 404, { error: `Todo ${id} not found` });
    return;
  }

  const body = (await readJsonBody(req)) as {
    title?: string;
    completed?: boolean;
  } | null;

  if (!body) {
    sendJson(res, 400, { error: "Request body is required" });
    return;
  }

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      sendJson(res, 400, { error: "title must be a non-empty string" });
      return;
    }
    todo.title = body.title.trim();
  }

  if (body.completed !== undefined) {
    if (typeof body.completed !== "boolean") {
      sendJson(res, 400, { error: "completed must be a boolean" });
      return;
    }
    todo.completed = body.completed;
  }

  sendJson(res, 200, todo);
}

async function handleDeleteTodo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number
): Promise<void> {
  if (!todos.has(id)) {
    sendJson(res, 404, { error: `Todo ${id} not found` });
    return;
  }

  todos.delete(id);
  sendJson(res, 204, null);
}

// ============ Router ============

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method!;

  try {
    // GET /todos
    if (method === "GET" && path === "/todos") {
      return await handleListTodos(req, res);
    }

    // POST /todos
    if (method === "POST" && path === "/todos") {
      return await handleCreateTodo(req, res);
    }

    // Routes with :id parameter
    const todoMatch = path.match(/^\/todos\/(\d+)$/);
    if (todoMatch) {
      const id = Number(todoMatch[1]);

      if (method === "GET") return await handleGetTodo(req, res, id);
      if (method === "PATCH") return await handleUpdateTodo(req, res, id);
      if (method === "DELETE") return await handleDeleteTodo(req, res, id);

      // Method exists but wrong HTTP method
      res.setHeader("Allow", "GET, PATCH, DELETE");
      sendJson(res, 405, { error: `Method ${method} not allowed on ${path}` });
      return;
    }

    // Nothing matched
    sendJson(res, 404, { error: `Cannot ${method} ${path}` });
  } catch (err: unknown) {
    const error = err as Error & { statusCode?: number };
    const statusCode = error.statusCode || 500;
    const message =
      statusCode >= 500 ? "Internal server error" : error.message;

    if (statusCode >= 500) {
      console.error("Unhandled error:", error);
    }

    sendJson(res, statusCode, { error: message });
  }
});

server.listen(3000, () => {
  console.log("Todo API on http://localhost:3000");
  console.log("Endpoints:");
  console.log("  GET    /todos");
  console.log("  POST   /todos");
  console.log("  GET    /todos/:id");
  console.log("  PATCH  /todos/:id");
  console.log("  DELETE /todos/:id");
});
```

### What We Had to Build by Hand

Look at how much code that is for a five-endpoint API. We built:

- A URL parser
- A JSON body reader with size limits
- A JSON response helper
- Input validation (primitive)
- Error handling with status codes
- A pattern-matching router
- Method-not-allowed handling

Express gives you all of this (and more) in a few lines. But now you *understand*
what it's doing.

---

## Why This Approach Doesn't Scale

### Problem 1: The Router Is a Mess

With 50 endpoints, our if/else chain becomes unmanageable. We need a way to declare
routes cleanly and have them matched efficiently. Express uses a routing tree (trie)
that matches paths in O(path-length) time, not O(number-of-routes).

### Problem 2: No Middleware

Every handler needs to do its own body parsing, authentication checking, input
validation, and error handling. There's massive code duplication. What we need is a
way to compose reusable "layers" that process the request before it reaches the
handler. That's middleware.

### Problem 3: No Composability

Want to add logging to all routes? You have to modify every handler. Want to add
CORS headers? Same problem. Want to mount a group of routes under a prefix? Manual
string manipulation. Frameworks solve this with router composition and middleware
stacks.

### Problem 4: The Response API Is Low-Level

`res.writeHead()` + `res.end(JSON.stringify(...))` is verbose. Express gives you
`res.json()`, `res.status()`, `res.redirect()` -- ergonomic APIs that do the right
thing.

### Problem 5: No Static File Serving

Serving files from disk means reading the file, setting the right Content-Type based
on the extension, handling 304 Not Modified, handling Range requests for video
streaming... Express's `express.static()` handles all of this.

---

## Streaming Responses

Before we leave the `http` module, let's look at one thing frameworks often hide:
streaming responses. This is powerful for large datasets.

```typescript
// 05-streaming.ts
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Transfer-Encoding": "chunked", // Node sets this automatically when streaming
    });

    let count = 0;
    const interval = setInterval(() => {
      count++;
      res.write(`Chunk ${count} at ${new Date().toISOString()}\n`);

      if (count >= 5) {
        clearInterval(interval);
        res.end("Stream complete.\n");
      }
    }, 1000);

    // Clean up if client disconnects early
    req.on("close", () => {
      clearInterval(interval);
    });
    return;
  }

  // Stream a large JSON array without building it all in memory
  if (req.url === "/large-dataset") {
    res.writeHead(200, { "Content-Type": "application/json" });

    res.write('{"items":[');

    for (let i = 0; i < 10000; i++) {
      const comma = i > 0 ? "," : "";
      const item = JSON.stringify({
        id: i,
        value: `item-${i}`,
        timestamp: new Date().toISOString(),
      });
      res.write(comma + item);
    }

    res.write("]}");
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Try /stream or /large-dataset");
});

server.listen(3000, () => {
  console.log("Streaming server on http://localhost:3000");
});
```

### When to Stream

- **Large datasets:** Instead of loading 1M rows into memory, stream them
- **Real-time data:** Server-Sent Events (SSE) use streaming
- **File downloads:** Stream from disk instead of loading entire file into memory

### When NOT to Stream

- **Small JSON responses:** Just use `res.end(JSON.stringify(data))`. The overhead
  of streaming isn't worth it for a 1KB response.
- **When you need Content-Length:** Streaming uses `Transfer-Encoding: chunked`,
  which means you can't set `Content-Length` upfront (because you don't know the
  total size). Some clients prefer `Content-Length` for progress bars.

---

## The `http` Module's Hidden Features

A few things worth knowing that you might not discover on your own:

### Server Timeout

```typescript
const server = http.createServer(handler);
server.timeout = 30_000; // 30 seconds -- close idle connections
server.keepAliveTimeout = 5_000; // Close keep-alive connections after 5s idle
server.headersTimeout = 60_000; // Max time to receive headers
```

### Listening on Multiple Interfaces

```typescript
// Only accessible from localhost (development)
server.listen(3000, "127.0.0.1");

// Accessible from any interface (production -- usually behind a reverse proxy)
server.listen(3000, "0.0.0.0");

// Listen on a Unix socket (for Nginx proxying)
server.listen("/tmp/myapp.sock");
```

### Getting the Server Address

```typescript
server.listen(0, () => {
  // Port 0 = let the OS pick an available port (great for tests)
  const addr = server.address() as { port: number };
  console.log(`Listening on port ${addr.port}`);
});
```

### Graceful Shutdown

```typescript
process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");

  server.close(() => {
    // All existing connections have been closed
    console.log("Server closed");
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown");
    process.exit(1);
  }, 10_000);
});
```

This matters in production. When your deploy system sends SIGTERM, you want to
finish handling in-flight requests before shutting down -- not drop them mid-response.

---

## Key Takeaways

1. `http.createServer()` handles TCP buffering, header parsing, keep-alive, and
   chunked encoding for you.
2. Request bodies are streams, not properties. You must read and buffer them yourself.
3. Always call `res.end()` -- forgetting it makes the client hang.
4. Always set a body size limit -- without one, you're vulnerable to memory
   exhaustion.
5. Hand-rolled routing doesn't scale past a handful of endpoints.
6. The lack of middleware means massive code duplication.
7. These limitations are exactly why frameworks like Express exist.

---

## Exercises

### Exercise 1: Build a Notes API

Using only `http.createServer()` (no Express), build an API with these endpoints:

- `GET /notes` -- list all notes (support `?search=keyword` to filter by title)
- `POST /notes` -- create a note with `{ title, body }` (both required)
- `GET /notes/:id` -- get a single note
- `PUT /notes/:id` -- replace a note entirely
- `DELETE /notes/:id` -- delete a note

Requirements:
- Store notes in a Map
- Validate all inputs (return 400 for bad data)
- Return proper status codes (201 for creation, 204 for deletion, 404 for missing)
- Handle JSON parse errors gracefully
- Limit request body to 10KB

### Exercise 2: Request Timer Middleware (Without Express)

Write a higher-order function that wraps a request handler and logs how long each
request takes:

```typescript
function withTiming(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  // Your implementation here
}

// Usage:
const server = http.createServer(
  withTiming(async (req, res) => {
    // ... your handler
  })
);
```

The log should include: method, path, status code, response time in ms.

Hint: You'll need to intercept `res.writeHead()` to capture the status code.

### Exercise 3: Streaming Line Counter

Create an endpoint `POST /count-lines` that accepts a plain text body of any size
and returns how many lines it contains -- **without buffering the entire body in
memory**. Process the body stream chunk by chunk, counting `\n` characters as they
arrive.

Test it with: `curl -X POST http://localhost:3000/count-lines -d @bigfile.txt`

### Exercise 4: Graceful Shutdown

Add graceful shutdown to the Todo API from this lesson:

1. Track all active connections
2. On SIGTERM/SIGINT, stop accepting new connections
3. Wait for existing requests to complete
4. Force-close after a 5-second timeout
5. Log how many connections were active at shutdown time

Test by starting the server, sending a slow request (add a `setTimeout` in a
handler), and hitting Ctrl+C.

### Exercise 5: Content Negotiation

Modify the Todo API so the `GET /todos` endpoint checks the `Accept` header and
responds with:

- `application/json` -- normal JSON response
- `text/plain` -- a text table of todos
- `text/csv` -- CSV format with header row

If the client sends an unsupported Accept type, return `406 Not Acceptable`.

Test with: `curl -H "Accept: text/csv" http://localhost:3000/todos`
