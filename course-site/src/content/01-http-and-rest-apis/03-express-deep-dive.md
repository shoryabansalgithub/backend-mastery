# Lesson 3: Express Deep Dive

## What You'll Learn

Express is the most popular Node.js web framework, and for good reason -- it's
minimal, flexible, and well-understood. But most tutorials teach you *what* to type
without explaining *why* it works. In this lesson, you'll understand Express from
the inside out: how middleware chains work, why `next()` exists, and how the request
lifecycle flows through your application.

---

## Why Express?

After Lesson 2, you know the pain of building HTTP servers by hand. Express solves
those problems:

| Raw `http` Problem | Express Solution |
|---------------------|-----------------|
| If/else routing mess | `app.get()`, `app.post()`, `Router` |
| Manual body parsing | `express.json()` middleware |
| No reusable layers | Middleware stack |
| Verbose response API | `res.json()`, `res.status()`, `res.send()` |
| No composability | `app.use()`, route groups |

But Express is **not magic**. It's approximately 2000 lines of code that create an
elegant abstraction over `http.createServer()`. Let's understand how.

---

## Express Is Just `http.createServer()` With Sugar

When you write:

```typescript
import express from "express";
const app = express();
app.listen(3000);
```

Under the hood, Express does roughly this:

```typescript
import * as http from "http";

const server = http.createServer((req, res) => {
  // Express processes this request through its middleware stack
  app.handle(req, res);
});

server.listen(3000);
```

The `app` object IS the request handler. `app.listen()` is a convenience wrapper
around `http.createServer()`. In fact, you can use Express with an existing HTTP
server:

```typescript
import * as http from "http";
import express from "express";

const app = express();
const server = http.createServer(app);
server.listen(3000);
```

This is the same thing. Understanding this demystifies Express -- it's not a
different world from `http`, it's a layer on top.

---

## The Middleware Chain: Express's Core Concept

Everything in Express is middleware. Route handlers? Middleware. Error handlers?
Middleware. Body parsers? Middleware. CORS? Middleware.

### What Is Middleware?

A middleware function receives the request, the response, and a `next` function:

```typescript
function myMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Do something with req/res
  // Then either:
  //   a) Call next() to pass control to the next middleware
  //   b) Send a response (res.json(), res.send(), etc.) to end the chain
}
```

### How the Chain Works

When a request arrives, Express runs through its middleware stack **in order of
registration**. Each middleware can:

1. **Pass** -- call `next()` to run the next middleware
2. **Respond** -- send a response and stop the chain
3. **Error** -- call `next(error)` to jump to the error handler

Analogy: Think of an airport security line. Your luggage (the request) goes through
a series of checkpoints:

1. Ticket check (authentication middleware)
2. X-ray machine (body parsing middleware)
3. Metal detector (validation middleware)
4. Gate agent (route handler)

At any checkpoint, they can reject you (send a response) or wave you through
(`next()`). The order matters -- you can't go through the metal detector before the
ticket check.

### Visualizing the Flow

```
Request arrives
  |
  v
Middleware 1: logger
  |  (calls next())
  v
Middleware 2: express.json()
  |  (parses body, calls next())
  v
Middleware 3: auth check
  |  (valid token? calls next() : sends 401)
  v
Route handler: GET /users
  |  (sends response)
  v
Response sent to client
```

If middleware 3 sends a 401, the route handler never runs. The chain short-circuits.

---

## Building Your First Express Server

```typescript
// 01-basic-express.ts
import express from "express";

const app = express();

// Middleware 1: Log every request
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.url}`);

  // This runs AFTER the response is sent
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`<-- ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });

  next(); // Pass to the next middleware
});

// Middleware 2: Parse JSON bodies
app.use(express.json());

// Route handler: GET /
app.get("/", (req, res) => {
  res.json({ message: "Hello, Express!" });
});

// Route handler: POST /echo
app.post("/echo", (req, res) => {
  res.json({
    youSent: req.body,
    timestamp: new Date().toISOString(),
  });
});

app.listen(3000, () => {
  console.log("Express server on http://localhost:3000");
});
```

### What `express.json()` Actually Does

Remember our `readJsonBody()` function from Lesson 2? `express.json()` does the
same thing but better:

1. Checks `Content-Type` header -- only parses if it's `application/json`
2. Reads the body stream (with configurable size limit, default 100KB)
3. Parses the JSON
4. Attaches the result to `req.body`
5. Calls `next()`

If parsing fails, it calls `next(error)` with a `SyntaxError`, which triggers your
error handler.

```typescript
// Customize the JSON parser
app.use(express.json({
  limit: "1mb",          // Max body size (default: "100kb")
  strict: true,          // Only accept arrays and objects (default: true)
  type: "application/json", // Which Content-Type to parse (default)
}));
```

---

## Understanding `next()` Deeply

`next()` is the most misunderstood part of Express. Let's clear it up.

### `next()` -- Continue to next middleware

```typescript
app.use((req, res, next) => {
  req.startTime = Date.now(); // Attach data to the request
  next(); // Continue
});
```

### `next("route")` -- Skip to next route handler

```typescript
app.get(
  "/users/:id",
  (req, res, next) => {
    if (req.params.id === "me") {
      next("route"); // Skip this route's remaining handlers
    } else {
      next(); // Continue to the next handler in this route
    }
  },
  (req, res) => {
    // This handles /users/123, /users/456, etc.
    res.json({ userId: req.params.id });
  }
);

app.get("/users/me", (req, res) => {
  // This handles /users/me (reached via next("route"))
  res.json({ userId: "current-user" });
});
```

### `next(error)` -- Jump to error handler

```typescript
app.get("/risky", (req, res, next) => {
  try {
    throw new Error("Something broke");
  } catch (err) {
    next(err); // Jumps to the error-handling middleware
  }
});

// Error handler (4 parameters -- Express detects this by argument count)
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});
```

### Bad Code: Calling `next()` AND Sending a Response

```typescript
// BUG: "Can't set headers after they are sent"
app.get("/broken", (req, res, next) => {
  res.json({ hello: "world" });
  next(); // This will try to run the next middleware, which might also try to respond
});
```

**Rule: Either call `next()` OR send a response. Never both.**

### Bad Code: Forgetting `next()` in Middleware

```typescript
// BUG: Request hangs -- middleware never passes control forward
app.use((req, res, next) => {
  console.log("I log but never call next()");
  // Forgot next() -- the request stops here
});

app.get("/", (req, res) => {
  // This never runs
  res.json({ message: "unreachable" });
});
```

### Bad Code: Forgetting to Return After Sending

```typescript
// BUG: Sends two responses
app.get("/users/:id", (req, res) => {
  const user = users.get(req.params.id);

  if (!user) {
    res.status(404).json({ error: "Not found" });
    // Forgot to return! Code continues executing.
  }

  // This runs even after the 404, causing "headers already sent" error
  res.json(user);
});
```

### Fixed:

```typescript
app.get("/users/:id", (req, res) => {
  const user = users.get(req.params.id);

  if (!user) {
    return res.status(404).json({ error: "Not found" }); // Return stops execution
  }

  res.json(user);
});
```

Using `return` before `res.json()` is an Express idiom you'll see everywhere. Get
in the habit.

---

## The Request Lifecycle in Detail

Let's trace a request through a realistic Express app:

```typescript
import express from "express";
import morgan from "morgan";

const app = express();

// Layer 1: Request logging (runs for ALL requests)
app.use(morgan("dev"));

// Layer 2: Parse JSON bodies (runs for ALL requests)
app.use(express.json());

// Layer 3: Custom middleware -- add request ID
app.use((req, res, next) => {
  req.headers["x-request-id"] =
    req.headers["x-request-id"] || crypto.randomUUID();
  next();
});

// Layer 4: Router-level middleware for /api routes
const apiRouter = express.Router();

apiRouter.use((req, res, next) => {
  // Only runs for routes under /api
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: "Authorization required" });
  }
  next();
});

apiRouter.get("/users", (req, res) => {
  res.json({ users: [] });
});

apiRouter.post("/users", (req, res) => {
  res.status(201).json({ user: req.body });
});

app.use("/api", apiRouter);

// Layer 5: 404 handler (runs if no route matched)
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.url}` });
});

// Layer 6: Error handler (runs if next(error) was called)
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(3000);
```

### Trace: `GET /api/users` with valid auth

```
1. morgan         --> logs "GET /api/users" to console, calls next()
2. express.json() --> no body to parse, calls next()
3. request-id     --> generates UUID, attaches to headers, calls next()
4. apiRouter auth --> checks Authorization header, finds token, calls next()
5. apiRouter GET  --> matches /users, sends { users: [] }
```

### Trace: `GET /api/users` WITHOUT auth

```
1. morgan         --> logs, calls next()
2. express.json() --> calls next()
3. request-id     --> attaches UUID, calls next()
4. apiRouter auth --> no token! sends 401. Chain stops here.
```

### Trace: `GET /nonexistent`

```
1. morgan         --> logs, calls next()
2. express.json() --> calls next()
3. request-id     --> attaches UUID, calls next()
4. apiRouter      --> path doesn't match /api, skipped
5. 404 handler    --> sends 404 response
```

---

## Router-Level vs App-Level Middleware

### App-Level Middleware

Registered on the `app` object. Runs for every request (unless filtered by path):

```typescript
// Runs for ALL requests
app.use(express.json());

// Runs only for requests starting with /admin
app.use("/admin", adminMiddleware);
```

### Router-Level Middleware

Registered on a `Router` object. Only runs when the router is matched:

```typescript
const usersRouter = express.Router();

// Only runs for requests matched by this router
usersRouter.use((req, res, next) => {
  console.log("Users router middleware");
  next();
});

usersRouter.get("/", listUsers);
usersRouter.post("/", createUser);
usersRouter.get("/:id", getUser);

// Mount the router -- these routes now live under /users
app.use("/users", usersRouter);
```

When you call `app.use("/users", usersRouter)`, Express strips the `/users` prefix
before passing the request to the router. Inside the router, paths are relative:

- Client requests `GET /users/123`
- Express matches the `/users` prefix and routes to `usersRouter`
- Inside the router, `req.url` is `/123`, matching the `/:id` route
- `req.baseUrl` is `/users`, `req.originalUrl` is `/users/123`

### Why Use Routers?

Separation of concerns. Each router is a self-contained module:

```typescript
// routes/users.ts
import { Router } from "express";

const router = Router();

router.get("/", (req, res) => { /* list users */ });
router.post("/", (req, res) => { /* create user */ });
router.get("/:id", (req, res) => { /* get user */ });
router.patch("/:id", (req, res) => { /* update user */ });
router.delete("/:id", (req, res) => { /* delete user */ });

export default router;
```

```typescript
// routes/posts.ts
import { Router } from "express";

const router = Router();

router.get("/", (req, res) => { /* list posts */ });
router.post("/", (req, res) => { /* create post */ });
// ...

export default router;
```

```typescript
// app.ts
import express from "express";
import usersRouter from "./routes/users";
import postsRouter from "./routes/posts";

const app = express();

app.use(express.json());
app.use("/api/users", usersRouter);
app.use("/api/posts", postsRouter);
```

Clean, modular, testable. Each route file knows nothing about the others.

---

## `express.json()` and `express.static()`

### `express.json()`

We covered this above, but here's one subtle gotcha:

```typescript
app.use(express.json());

app.post("/data", (req, res) => {
  console.log(req.body); // undefined! Why?
});
```

If the client doesn't send `Content-Type: application/json`, `express.json()` skips
the request. `req.body` stays `undefined`. This catches everyone at least once.

```bash
# This works (Content-Type is set automatically with -d and JSON detection)
curl -X POST http://localhost:3000/data \
  -H "Content-Type: application/json" \
  -d '{"key":"value"}'

# This does NOT work -- curl sends Content-Type: application/x-www-form-urlencoded
curl -X POST http://localhost:3000/data -d '{"key":"value"}'
```

### `express.static()`

Serves files from a directory:

```typescript
// Serve files from the "public" directory
app.use(express.static("public"));

// With a URL prefix
app.use("/assets", express.static("public"));
```

What it handles for you:
- Sets correct `Content-Type` based on file extension
- Handles `If-Modified-Since` / `304 Not Modified` (caching)
- Handles `Range` requests (video seeking)
- Blocks directory traversal attacks (`../../../etc/passwd`)
- Sets `ETag` headers

For API-only servers, you rarely need this. But it's useful for serving
documentation, a frontend build, or uploaded files.

---

## Template for a Well-Structured Express App

Here's the pattern I use for every Express project. It's not the only way, but it
separates concerns cleanly:

```
src/
  index.ts          # Entry point: creates server, starts listening
  app.ts            # Express app setup: middleware, routes
  routes/
    users.ts        # Route definitions for /users
    posts.ts        # Route definitions for /posts
  middleware/
    auth.ts         # Authentication middleware
    validate.ts     # Request validation middleware
    errorHandler.ts # Centralized error handler
  services/
    userService.ts  # Business logic for users
    postService.ts  # Business logic for posts
  types.ts          # Shared TypeScript types
```

### `src/app.ts` -- The Application Setup

```typescript
import express from "express";
import morgan from "morgan";
import usersRouter from "./routes/users";
import postsRouter from "./routes/posts";
import { errorHandler } from "./middleware/errorHandler";

export function createApp(): express.Application {
  const app = express();

  // ============ Global Middleware ============
  app.use(morgan("dev"));
  app.use(express.json({ limit: "1mb" }));

  // ============ Health Check ============
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============ Routes ============
  app.use("/api/users", usersRouter);
  app.use("/api/posts", postsRouter);

  // ============ 404 Handler ============
  app.use((req, res) => {
    res.status(404).json({
      error: {
        type: "NOT_FOUND",
        message: `Cannot ${req.method} ${req.url}`,
      },
    });
  });

  // ============ Error Handler ============
  app.use(errorHandler);

  return app;
}
```

### `src/index.ts` -- The Entry Point

```typescript
import { createApp } from "./app";

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
```

### Why `createApp()` Is a Function

This matters for testing. You can create a fresh app instance for each test:

```typescript
import { createApp } from "../src/app";
import request from "supertest";

describe("Users API", () => {
  const app = createApp(); // Fresh instance -- no state leaks between tests

  it("should create a user", async () => {
    const response = await request(app)
      .post("/api/users")
      .send({ name: "Ada", email: "ada@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe("Ada");
  });
});
```

---

## Async Error Handling in Express

Express 4 doesn't catch errors from async handlers. This is a well-known gotcha:

### Bad Code: Unhandled Promise Rejection

```typescript
// BUG: If getUser() rejects, Express never catches it.
// The request hangs, and an UnhandledPromiseRejection warning fires.
app.get("/users/:id", async (req, res) => {
  const user = await getUser(req.params.id); // Throws!
  res.json(user);
});
```

### Fix Option 1: Try/Catch

```typescript
app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    res.json(user);
  } catch (err) {
    next(err); // Forward to error handler
  }
});
```

This works but adding try/catch to every handler is tedious.

### Fix Option 2: Async Wrapper

```typescript
function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// Usage -- no try/catch needed
app.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const user = await getUser(req.params.id);
    res.json(user);
  })
);
```

### Fix Option 3: Express 5 (or `express-async-errors`)

Express 5 natively catches async errors. If you're on Express 4, the
`express-async-errors` package patches Express to handle this:

```typescript
import "express-async-errors"; // Just import it -- it patches Express globally

// Now this works without try/catch or wrappers
app.get("/users/:id", async (req, res) => {
  const user = await getUser(req.params.id); // If this throws, error handler catches it
  res.json(user);
});
```

For this course, we'll use the async wrapper approach because it's explicit and
works without patching.

---

## Express Alternatives: When and Why

Express was created in 2010. It's battle-tested and has the largest ecosystem. But
it has limitations:

### Fastify

- **2-3x faster** than Express (optimized JSON serialization, schema-based validation)
- Built-in TypeScript support
- Schema-based request/response validation (generate docs automatically)
- Async-first (no need for async wrappers)
- Plugin architecture instead of middleware

```typescript
import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/users/:id", {
  schema: {
    params: {
      type: "object",
      properties: { id: { type: "string" } },
    },
    response: {
      200: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
  handler: async (request, reply) => {
    return { id: request.params.id, name: "Ada" };
  },
});
```

### Hono

- **Ultra-lightweight** (14KB). Runs on Cloudflare Workers, Deno, Bun, Node.js
- Express-like API but modern
- Built-in TypeScript with type-safe routes
- Great for edge computing / serverless

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/users/:id", (c) => {
  return c.json({ id: c.req.param("id"), name: "Ada" });
});

export default app;
```

### When to Choose What

| Choose Express When | Choose Fastify When | Choose Hono When |
|--------------------|--------------------|-----------------|
| Huge ecosystem needed | Performance matters | Deploying to edge/serverless |
| Team knows Express | Want built-in validation | Need multi-runtime support |
| Lots of middleware available | Starting a new project | Want smallest bundle |
| Legacy codebase | Need OpenAPI generation | Modern stack, TypeScript-first |

For this course, we use Express because:
1. It's the most widely used -- you'll encounter it in jobs
2. Its concepts transfer to every other framework
3. Its middleware pattern is the foundation for understanding all server frameworks

---

## Key Takeaways

1. Express is a thin layer over `http.createServer()`. The `app` IS the request
   handler.
2. Everything in Express is middleware. The order of `app.use()` calls defines the
   processing pipeline.
3. Each middleware must either call `next()` or send a response. Never both. Never
   neither.
4. `Router` objects let you group routes and middleware into modular, composable
   units.
5. Express 4 doesn't catch async errors. Use try/catch, an async wrapper, or
   `express-async-errors`.
6. Structure your app with `createApp()` as a factory function for testability.
7. Express is not the only option. Fastify is faster, Hono is lighter. But Express's
   concepts are universal.

---

## Exercises

### Exercise 1: Middleware Ordering

Without running the code, predict the console output for this request: `GET /hello`

```typescript
app.use((req, res, next) => { console.log("A"); next(); });
app.use((req, res, next) => { console.log("B"); next(); });
app.get("/hello", (req, res, next) => { console.log("C"); next(); });
app.get("/hello", (req, res) => { console.log("D"); res.send("done"); });
app.use((req, res, next) => { console.log("E"); next(); });
```

Now change the request to `GET /world` and predict again. Then run the code and
verify.

### Exercise 2: Build an Async Middleware Chain

Create three async middlewares that each add data to the request:

1. `addTimestamp` -- attaches `req.timestamp` (current ISO string)
2. `addRequestId` -- attaches `req.requestId` (random UUID)
3. `slowAuth` -- simulates a slow auth check (100ms delay), attaches `req.userId`

Wire them up so they run in sequence for all routes under `/api`. Create a route
`GET /api/debug` that returns all three values as JSON. Verify the timestamp is
before the current time (proving the middlewares ran first).

### Exercise 3: Router Composition

Create three separate Router instances:

- `usersRouter` with routes: `GET /`, `POST /`, `GET /:id`
- `postsRouter` with routes: `GET /`, `POST /`, `GET /:id`
- `adminRouter` with routes: `GET /stats`, `POST /ban/:userId`

Mount them under `/api/users`, `/api/posts`, and `/admin`. Add a middleware to
`adminRouter` that checks for an `X-Admin-Key` header (hardcoded value). Verify
that the admin middleware only affects admin routes, not user or post routes.

### Exercise 4: Custom `res.json()` Replacement

Express's `res.json()` is convenient, but let's understand what it does. Write a
middleware that adds a `res.sendJson(statusCode, data)` method to every response.
Your method should:

1. Set `Content-Type: application/json`
2. Set `Content-Length` correctly (using `Buffer.byteLength`)
3. Stringify the data with 2-space indentation in development, compact in production
4. Call `res.end()` with the result

Test that it works identically to `res.json()` by sending responses both ways and
comparing.

### Exercise 5: Error Handler Hierarchy

Build an Express app with this error handling behavior:

1. A `ValidationError` class (status 400) with a `details` array of field errors
2. An `AuthenticationError` class (status 401) with a `reason` field
3. A `NotFoundError` class (status 404) with a `resource` field
4. All other errors return 500

Create route handlers that throw each type, and a single error-handling middleware
that formats them consistently as:

```json
{
  "error": {
    "type": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [...]
  }
}
```

For 500 errors, log the full stack trace to console but only send a generic message
to the client.
