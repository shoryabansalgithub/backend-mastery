# Lesson 4: Error Handling

## Why Most Error Handling Is Wrong

Error handling is where backend developers spend the least thought and pay the highest
price. The typical approach -- wrap everything in `try/catch`, log the error, return
500 -- is like a doctor who treats every illness with aspirin. It "works" until it
doesn't.

Good error handling means your system:
- Tells you exactly what went wrong and where
- Recovers from transient failures automatically
- Fails gracefully when recovery isn't possible
- Never corrupts data, even in failure scenarios
- Shuts down cleanly when told to

Let's build this understanding from first principles.

---

## Throwing vs Returning Errors

There are two fundamentally different approaches to error handling, and the choice matters
more than most developers realize.

### Approach 1: Throwing (Exceptions)

```typescript
async function getUser(id: string): Promise<User> {
  const user = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  if (!user) {
    throw new Error("User not found");
  }
  return user;
}

// Caller must know to catch (but nothing in the type forces them to)
try {
  const user = await getUser("123");
  console.log(user.name);
} catch (err) {
  // What kind of error? Network? Not found? Invalid input?
  // We don't know without inspecting the error.
}
```

**Problems with throwing:**
1. **Invisible in types.** `Promise<User>` doesn't tell you the function can fail.
2. **Easy to forget catching.** No compile-time enforcement.
3. **Catch is too broad.** `catch` grabs everything -- your error, a typo in your code,
   a stack overflow, anything.
4. **Flow disruption.** Exceptions jump up the call stack. It's hard to trace where
   control goes.

### Approach 2: Returning (Result Type)

```typescript
type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

async function getUser(id: string): Promise<Result<User, "NOT_FOUND" | "DB_ERROR">> {
  try {
    const user = await db.query("SELECT * FROM users WHERE id = $1", [id]);
    if (!user) {
      return { ok: false, error: "NOT_FOUND", message: `User ${id} not found` };
    }
    return { ok: true, value: user };
  } catch (err) {
    return { ok: false, error: "DB_ERROR", message: "Database query failed" };
  }
}

// Caller MUST handle the error (the type system enforces it)
const result = await getUser("123");
if (!result.ok) {
  // TypeScript knows the exact error types here
  switch (result.error) {
    case "NOT_FOUND": return res.status(404).json({ error: result.message });
    case "DB_ERROR": return res.status(500).json({ error: "Internal error" });
  }
}
// TypeScript knows result.value is User here
console.log(result.value.name);
```

**When to use which:**

| Use Throwing When...                | Use Result When...                    |
|-------------------------------------|---------------------------------------|
| Programmer error (bug in code)      | Expected failure (user not found)     |
| Unrecoverable state                 | Recoverable condition                 |
| Framework boundary (Express needs it)| Business logic                       |
| Truly exceptional circumstances     | Multiple possible failure modes       |

The rule of thumb: **throw for bugs, return for expected failures.**

---

## The Result Type: A Complete Implementation

Let's build a production-quality Result type:

```typescript
// Core Result type
type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

// Constructors
function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E extends string>(error: E, message: string): Result<never, E> {
  return { ok: false, error, message };
}

// Utility: wrap a throwing function into a Result-returning function
function tryCatch<T, E extends string>(
  fn: () => T,
  errorType: E,
  errorMessage?: string
): Result<T, E> {
  try {
    return Ok(fn());
  } catch (err) {
    const msg = errorMessage ?? (err instanceof Error ? err.message : String(err));
    return Err(errorType, msg);
  }
}

// Utility: wrap an async throwing function
async function tryCatchAsync<T, E extends string>(
  fn: () => Promise<T>,
  errorType: E,
  errorMessage?: string
): Promise<Result<T, E>> {
  try {
    const value = await fn();
    return Ok(value);
  } catch (err) {
    const msg = errorMessage ?? (err instanceof Error ? err.message : String(err));
    return Err(errorType, msg);
  }
}

// Utility: map over a successful Result
function mapResult<T, U, E extends string>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (result.ok) {
    return Ok(fn(result.value));
  }
  return result;
}

// Utility: chain Results (flatMap)
function flatMapResult<T, U, E1 extends string, E2 extends string>(
  result: Result<T, E1>,
  fn: (value: T) => Result<U, E2>
): Result<U, E1 | E2> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}
```

### Chaining Results in Practice

```typescript
type ValidationError = "INVALID_EMAIL" | "WEAK_PASSWORD" | "NAME_TOO_SHORT";
type PersistenceError = "DUPLICATE_EMAIL" | "DB_ERROR";
type CreateUserError = ValidationError | PersistenceError;

function validateEmail(email: string): Result<string, "INVALID_EMAIL"> {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(email)) {
    return Err("INVALID_EMAIL", `"${email}" is not a valid email`);
  }
  return Ok(email);
}

function validatePassword(password: string): Result<string, "WEAK_PASSWORD"> {
  if (password.length < 8) {
    return Err("WEAK_PASSWORD", "Password must be at least 8 characters");
  }
  return Ok(password);
}

function validateName(name: string): Result<string, "NAME_TOO_SHORT"> {
  if (name.trim().length < 2) {
    return Err("NAME_TOO_SHORT", "Name must be at least 2 characters");
  }
  return Ok(name.trim());
}

async function createUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<Result<User, CreateUserError>> {
  // Validate all fields
  const emailResult = validateEmail(input.email);
  if (!emailResult.ok) return emailResult;

  const passwordResult = validatePassword(input.password);
  if (!passwordResult.ok) return passwordResult;

  const nameResult = validateName(input.name);
  if (!nameResult.ok) return nameResult;

  // Check for existing user
  const existing = await tryCatchAsync(
    () => db.findUserByEmail(emailResult.value),
    "DB_ERROR" as const
  );
  if (!existing.ok) return existing;
  if (existing.value) {
    return Err("DUPLICATE_EMAIL", `Email ${input.email} is already registered`);
  }

  // Create the user
  return tryCatchAsync(
    () => db.createUser({
      email: emailResult.value,
      passwordHash: hashPassword(passwordResult.value),
      name: nameResult.value,
    }),
    "DB_ERROR" as const,
    "Failed to create user in database"
  );
}
```

---

## Custom Error Classes

When you DO throw errors (for bugs or at framework boundaries), use custom error classes
to carry structured information:

```typescript
// Base application error
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error classes
class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} with id "${id}" not found`, "NOT_FOUND", 404, true, {
      resource,
      id,
    });
  }
}

class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message, "VALIDATION_ERROR", 400, true, { field, value });
  }
}

class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT", 409, true);
  }
}

class DatabaseError extends AppError {
  constructor(message: string, public readonly query?: string) {
    super(message, "DATABASE_ERROR", 500, true, { query });
  }
}

class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, "UNAUTHORIZED", 401, true);
  }
}

class AuthorizationError extends AppError {
  constructor(message: string = "Insufficient permissions") {
    super(message, "FORBIDDEN", 403, true);
  }
}
```

### Why Custom Error Classes?

```typescript
// WITHOUT custom errors -- what kind of error is this?
app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    res.json(user);
  } catch (err) {
    // Is this a "user not found"? A database timeout? A bug in our code?
    // We have no idea. We can only look at the message string.
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Internal error" });
    }
  }
});

// WITH custom errors -- structured and predictable
app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    res.json(user);
  } catch (err) {
    if (err instanceof AppError) {
      // We know exactly what happened
      res.status(err.statusCode).json({
        error: err.code,
        message: err.message,
        ...(err.context && { details: err.context }),
      });
    } else {
      // Unknown error -- this is a bug
      console.error("Unexpected error:", err);
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
});
```

---

## Operational Errors vs Programmer Errors

This distinction is critical for building reliable systems.

### Operational Errors

Things that **will happen** in production, even in correctly written code:
- Database connection timeout
- External API returns 500
- User submits invalid input
- Disk is full
- Network is temporarily unavailable

**You handle these.** Retry, return an error response, log and move on.

### Programmer Errors

**Bugs in your code:**
- Reading property of `undefined`
- Passing wrong number of arguments
- Failing to handle a Promise rejection
- Type assertion that's wrong at runtime
- Off-by-one errors

**You fix these.** They should crash the process (in production, let a process manager
restart it). If you try to "handle" a bug, you're just hiding it.

```typescript
// Operational error: HANDLE IT
async function fetchExternalData(url: string): Promise<Result<Data, "FETCH_ERROR">> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return Err("FETCH_ERROR", `API returned ${response.status}`);
    }
    return Ok(await response.json());
  } catch {
    return Err("FETCH_ERROR", `Failed to reach ${url}`);
  }
}

// Programmer error: DON'T CATCH, FIX IT
function processUser(user: User): void {
  // If user is undefined here, that's a BUG.
  // Don't wrap in try/catch. Fix the caller.
  console.log(user.name.toUpperCase());
}
```

### The Danger of Catching Programmer Errors

```typescript
// BAD: Hiding bugs behind catch-all error handling
app.get("/users/:id", async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    // Typo: user.nmae instead of user.name
    const response = { name: user.nmae, email: user.email };
    res.json(response);
  } catch (err) {
    // This catches the TypeError from the typo!
    // The response is 500, not the 404 or 200 you'd expect.
    // And you might never notice the bug.
    res.status(500).json({ error: "Something went wrong" });
  }
});

// BETTER: Only catch expected errors
app.get("/users/:id", async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    // If there's a typo here, it throws UNCAUGHT.
    // The process crashes. You notice immediately.
    // Fix the bug.
    const response = { name: user.name, email: user.email };
    res.json(response);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      throw err; // Re-throw unexpected errors (programmer errors)
    }
  }
});
```

---

## Graceful Shutdown

When your server receives a termination signal (SIGTERM from Kubernetes, Ctrl+C from
your terminal), it should:

1. Stop accepting new connections
2. Finish processing in-flight requests
3. Close database connections, flush logs
4. Exit cleanly

**What happens WITHOUT graceful shutdown?**
- In-flight requests get dropped (users see errors)
- Database transactions are left incomplete (data corruption)
- File writes are truncated (data loss)
- External services aren't notified (inconsistent state)

### Implementation

```typescript
import http from "http";

class GracefulServer {
  private server: http.Server;
  private connections = new Set<any>();
  private isShuttingDown = false;

  constructor(private readonly app: any) {
    this.server = http.createServer(app);
    this.trackConnections();
    this.handleSignals();
  }

  listen(port: number): void {
    this.server.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  }

  private trackConnections(): void {
    this.server.on("connection", (conn) => {
      this.connections.add(conn);
      conn.on("close", () => this.connections.delete(conn));
    });
  }

  private handleSignals(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

      // 1. Stop accepting new connections
      this.server.close(() => {
        console.log("HTTP server closed");
      });

      // 2. Set a deadline
      const deadline = setTimeout(() => {
        console.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
      }, 30_000); // 30 second deadline

      // 3. Close existing connections that are idle
      for (const conn of this.connections) {
        conn.end();
      }

      // 4. Clean up resources
      try {
        await this.cleanup();
      } catch (err) {
        console.error("Cleanup failed:", err);
      }

      clearTimeout(deadline);
      console.log("Graceful shutdown complete");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  private async cleanup(): Promise<void> {
    // Close database connections
    console.log("Closing database connections...");
    // await db.end();

    // Flush logs
    console.log("Flushing logs...");
    // await logger.flush();

    // Close external connections
    console.log("Closing external connections...");
    // await redis.quit();
  }
}

// Usage:
const server = new GracefulServer(app);
server.listen(3000);
```

### Health Check Endpoint for Graceful Shutdown

During shutdown, you want load balancers to stop sending traffic:

```typescript
let isReady = true;

app.get("/health", (req, res) => {
  if (isReady) {
    res.status(200).json({ status: "healthy" });
  } else {
    // Returning 503 tells the load balancer to stop sending requests
    res.status(503).json({ status: "shutting down" });
  }
});

process.on("SIGTERM", () => {
  isReady = false; // Health check immediately returns 503
  // Give the load balancer time to notice (5 seconds)
  setTimeout(() => {
    startGracefulShutdown();
  }, 5000);
});
```

---

## uncaughtException and unhandledRejection

These are your last line of defense. They catch errors that nothing else caught.

### unhandledRejection

Fires when a Promise is rejected and no `.catch()` or `try/catch` handles it.

```typescript
// This creates an unhandled rejection:
async function riskyOperation(): Promise<void> {
  throw new Error("Something broke");
}
riskyOperation(); // No await, no .catch() -- the rejection goes unhandled

// Catching it:
process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  console.error("Unhandled Rejection:", reason);
  console.error("Promise:", promise);

  // In production, this is almost always a bug.
  // Log it, alert on it, and consider whether to crash.

  // Node.js 15+ crashes by default on unhandled rejections.
  // Earlier versions just warned. The crash is the correct behavior.
});
```

### uncaughtException

Fires when a synchronous error is thrown and nothing catches it.

```typescript
process.on("uncaughtException", (error: Error, origin: string) => {
  console.error(`Uncaught Exception (${origin}):`, error);

  // IMPORTANT: After an uncaught exception, your process is in an
  // UNKNOWN STATE. Memory might be corrupted. Connections might be
  // half-open. Data might be inconsistent.

  // The ONLY safe thing to do is:
  // 1. Log the error
  // 2. Attempt to close connections
  // 3. Exit

  // DO NOT try to keep running. DO NOT try to handle the next request.

  try {
    // Attempt cleanup (best-effort)
    const timer = setTimeout(() => process.exit(1), 5000);
    // Unref so it doesn't keep the process alive if cleanup is fast
    timer.unref();

    // Close server, DB connections, etc.
    server.close(() => {
      process.exit(1);
    });
  } catch {
    process.exit(1);
  }
});
```

### What Would Happen If You Tried to Continue After uncaughtException?

```typescript
// DANGEROUS ANTI-PATTERN -- DO NOT DO THIS
process.on("uncaughtException", (error) => {
  console.error("Error:", error);
  // "Let's just keep going!" -- Famous last words.
});

// Imagine this scenario:
// 1. A request handler partially writes to the database
// 2. An uncaught exception fires mid-write
// 3. The database connection is in an unknown state
// 4. You "handle" it by logging and continuing
// 5. The next request uses the corrupted connection
// 6. Data is silently corrupted
// 7. You discover this 3 weeks later
// 8. You cry
```

After `uncaughtException`, the only safe action is to exit and let a process manager
(PM2, systemd, Kubernetes) restart your process fresh.

---

## A Complete Error Handling Strategy

Here's how all these pieces fit together in a real application:

```typescript
// 1. Result type for business logic (expected failures)
// 2. Custom error classes for framework boundaries (Express middleware)
// 3. uncaughtException/unhandledRejection for bugs
// 4. Graceful shutdown for clean exit

// --- Business logic layer (returns Results) ---
async function transferFunds(
  fromId: AccountId,
  toId: AccountId,
  amount: Cents
): Promise<Result<Transfer, "INSUFFICIENT_FUNDS" | "ACCOUNT_NOT_FOUND" | "DB_ERROR">> {
  const from = await getAccount(fromId);
  if (!from.ok) return from;

  const to = await getAccount(toId);
  if (!to.ok) return to;

  if (from.value.balance < amount) {
    return Err("INSUFFICIENT_FUNDS", "Source account has insufficient funds");
  }

  return tryCatchAsync(
    () => db.transferFunds(fromId, toId, amount),
    "DB_ERROR",
    "Failed to execute transfer"
  );
}

// --- API layer (translates Results to HTTP responses) ---
app.post("/transfers", async (req, res) => {
  const result = await transferFunds(
    AccountId(req.body.fromId),
    AccountId(req.body.toId),
    Cents(req.body.amount)
  );

  if (result.ok) {
    res.status(201).json(result.value);
    return;
  }

  // Map domain errors to HTTP status codes
  const statusMap: Record<string, number> = {
    INSUFFICIENT_FUNDS: 422,
    ACCOUNT_NOT_FOUND: 404,
    DB_ERROR: 500,
  };

  res.status(statusMap[result.error] ?? 500).json({
    error: result.error,
    message: result.error === "DB_ERROR" ? "Internal error" : result.message,
  });
});

// --- Global error middleware (catches programmer errors) ---
app.use((err: Error, req: any, res: any, next: any) => {
  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
    });
  } else {
    // Programmer error -- log it, return generic 500
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// --- Last resort ---
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
  // Throw to trigger uncaughtException handler
  throw reason;
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown();
});
```

---

## Exercises

### Exercise 1: Result Type Library

Build a complete Result type library with:
- `Ok<T>` and `Err<E>` constructors
- `map` -- transform the success value
- `mapErr` -- transform the error
- `flatMap` (also called `chain` or `andThen`) -- chain Result-returning functions
- `unwrapOr` -- get the value or a default
- `match` -- pattern match with handlers for both cases

Write tests that demonstrate each function.

### Exercise 2: Error Classification

Given these error scenarios, classify each as operational or programmer:
1. Database connection refused
2. `TypeError: Cannot read property 'name' of undefined`
3. User submits a form with missing required fields
4. `RangeError: Maximum call stack size exceeded`
5. External payment API returns HTTP 503
6. File not found when trying to load config at startup
7. Division by zero in a calculation
8. SSL certificate expired on external API

For each operational error, write the error handling code. For each programmer error,
describe how you'd fix the root cause.

### Exercise 3: Graceful Shutdown

Build a simple HTTP server that:
1. Accepts POST requests that simulate "work" (setTimeout for 5-10 seconds)
2. Tracks in-flight requests
3. On SIGTERM/SIGINT: stops accepting new requests, waits for in-flight to complete,
   logs how many requests were safely completed, then exits
4. Has a 15-second timeout -- force exit if in-flight requests don't complete

Test by sending several requests, then pressing Ctrl+C mid-processing.

### Exercise 4: Error Boundary Middleware

Write Express-style error handling middleware that:
1. Catches async errors from route handlers (hint: wrap handlers)
2. Maps `AppError` subclasses to appropriate HTTP responses
3. Logs programmer errors with full stack trace
4. Returns sanitized error responses (no stack traces to clients)
5. Includes a request ID for correlation between client error and server log

### Exercise 5: Composable Validation

Build a validation system using the Result type:

```typescript
const validateUser = compose(
  required("email"),
  isEmail("email"),
  required("password"),
  minLength("password", 8),
  required("name"),
  minLength("name", 2),
);

const result = validateUser(req.body);
// result: Result<ValidatedUser, ValidationError[]>
```

The system should collect ALL validation errors (not just the first one) and return
them in a structured format suitable for a JSON API response.
