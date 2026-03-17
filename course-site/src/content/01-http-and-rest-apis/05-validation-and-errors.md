# Lesson 5: Validation and Error Handling

## What You'll Learn

Your API is only as trustworthy as its boundary. In this lesson, you'll learn why
input validation is non-negotiable, how to use Zod for schema validation, how to
build validation middleware, and how to design a consistent error response format
that helps clients recover from errors.

---

## Why Validate at the Boundary?

Your server is a fortress. The HTTP endpoint is the gate. Everything that comes
through that gate is untrusted by default -- it could come from a buggy client, a
malicious attacker, or a developer who misread your docs.

### Thought Experiment

You run a bank. A customer walks in and says "Transfer $500 from account 12345 to
account 67890." Do you:

A) Immediately make the transfer
B) Verify the customer's identity, check that account 12345 exists and belongs to
   them, verify account 67890 exists, check sufficient balance, validate the amount
   is positive and reasonable

Obviously B. But many APIs do the equivalent of A -- they trust `req.body` blindly
and pass it straight to the database.

### What Happens Without Validation

```typescript
// Dangerously trusting req.body
app.post("/users", async (req, res) => {
  const user = await db.users.create(req.body);
  res.json(user);
});
```

What could go wrong?

1. **Missing fields:** `req.body` is `{}`. Database throws a constraint violation
   with an ugly error message that leaks your schema.
2. **Wrong types:** `req.body.age` is `"not a number"`. Database throws a type error.
3. **Injection:** `req.body.name` is `"; DROP TABLE users; --"`. SQL injection.
4. **Oversized data:** `req.body.bio` is a 10MB string. Memory exhaustion.
5. **Extra fields:** `req.body.isAdmin` is `true`. Mass assignment vulnerability.
6. **Invalid format:** `req.body.email` is `"not-an-email"`. Data corruption.

Validation catches all of these at the boundary, before they reach your business
logic or database.

### The Boundary Principle

**Validate at the boundary. Trust within the boundary.**

Once data passes validation, your business logic can trust it. No defensive `if`
checks scattered through your service layer. No `typeof` guards in your database
queries. Validate once at the edge, then work with typed, known-good data.

---

## Zod: Schema Definition and Validation

Zod is a TypeScript-first schema validation library. It lets you define the shape
of your data, validate inputs against that shape, and get fully typed results.

### Why Zod?

- **TypeScript integration:** Zod schemas produce TypeScript types. Define once,
  get validation AND types.
- **Composable:** Build complex schemas from simple ones.
- **Detailed errors:** Tells you exactly which field failed and why.
- **Transforms:** Validate AND transform data in one step.
- **Zero dependencies:** Small, self-contained.

### Basic Schemas

```typescript
import { z } from "zod";

// Primitives
const nameSchema = z.string().min(1).max(100);
const ageSchema = z.number().int().min(0).max(150);
const emailSchema = z.string().email();
const isActiveSchema = z.boolean();

// Objects
const createUserSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email format"),
  age: z.number().int().min(13, "Must be at least 13").optional(),
  role: z.enum(["user", "admin", "moderator"]).default("user"),
});

// The TypeScript type is inferred automatically
type CreateUserInput = z.infer<typeof createUserSchema>;
// {
//   name: string;
//   email: string;
//   age?: number | undefined;
//   role: "user" | "admin" | "moderator";
// }
```

### Parsing vs Safe Parsing

```typescript
// .parse() -- throws ZodError on failure
try {
  const user = createUserSchema.parse(req.body);
  // user is fully typed: CreateUserInput
} catch (err) {
  if (err instanceof z.ZodError) {
    console.log(err.errors);
    // [
    //   { path: ["name"], message: "Name is required", code: "too_small" },
    //   { path: ["email"], message: "Invalid email format", code: "invalid_string" }
    // ]
  }
}

// .safeParse() -- returns a result object, never throws
const result = createUserSchema.safeParse(req.body);

if (!result.success) {
  console.log(result.error.errors); // Same error array
} else {
  const user = result.data; // Fully typed
}
```

Prefer `.safeParse()` in request handlers -- it gives you control over how to
respond to validation errors without try/catch.

### Transforms

Zod can validate AND transform data in one step:

```typescript
const createPostSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .transform((s) => s.trim()), // Trim whitespace

  slug: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.toLowerCase().replace(/\s+/g, "-") : undefined
    ),

  tags: z
    .string()
    .transform((s) => s.split(",").map((t) => t.trim())) // "a,b,c" -> ["a","b","c"]
    .pipe(z.array(z.string().min(1)).max(10)),            // Then validate the array

  publishAt: z
    .string()
    .datetime()
    .transform((s) => new Date(s)), // String -> Date object
});
```

### Refinements (Custom Validation)

When built-in validators aren't enough:

```typescript
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((s) => /[A-Z]/.test(s), "Must contain an uppercase letter")
  .refine((s) => /[a-z]/.test(s), "Must contain a lowercase letter")
  .refine((s) => /[0-9]/.test(s), "Must contain a number");

const dateRangeSchema = z
  .object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  })
  .refine((data) => new Date(data.endDate) > new Date(data.startDate), {
    message: "endDate must be after startDate",
    path: ["endDate"], // Which field to attach the error to
  });
```

### Stripping Unknown Fields

By default, Zod passes through unknown fields. Use `.strict()` or `.strip()`:

```typescript
const schema = z.object({ name: z.string() });

// Default: unknown fields are passed through
schema.parse({ name: "Ada", isAdmin: true });
// { name: "Ada", isAdmin: true }  <-- isAdmin leaked through!

// .strict(): unknown fields cause an error
schema.strict().parse({ name: "Ada", isAdmin: true });
// Throws: Unrecognized key(s) in object: 'isAdmin'

// .strip(): unknown fields are silently removed (RECOMMENDED)
schema.strip().parse({ name: "Ada", isAdmin: true });
// { name: "Ada" }  <-- isAdmin stripped out
```

**Always use `.strip()` on request body schemas.** This prevents mass assignment
attacks where a client sends `isAdmin: true` and your code blindly passes it to
the database.

---

## Building a Validation Middleware

Let's build a reusable Express middleware that validates request data with Zod:

```typescript
// middleware/validate.ts
import { Request, Response, NextFunction } from "express";
import { z, ZodError, ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{
      source: "body" | "query" | "params";
      field: string;
      message: string;
    }> = [];

    // Validate body
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: "body",
            field: issue.path.join("."),
            message: issue.message,
          });
        }
      } else {
        req.body = result.data; // Replace with validated + transformed data
      }
    }

    // Validate query parameters
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: "query",
            field: issue.path.join("."),
            message: issue.message,
          });
        }
      } else {
        (req as any).validatedQuery = result.data;
      }
    }

    // Validate URL parameters
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: "params",
            field: issue.path.join("."),
            message: issue.message,
          });
        }
      } else {
        (req as any).validatedParams = result.data;
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: {
          type: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: errors,
        },
      });
      return;
    }

    next();
  };
}
```

### Using the Middleware

```typescript
import { validate } from "./middleware/validate";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email(),
  role: z.enum(["user", "admin"]).default("user"),
}).strip(); // Remove unknown fields

const getUserParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "ID must be numeric").transform(Number),
});

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(["user", "admin"]).optional(),
});

// Routes with validation
app.post(
  "/api/users",
  validate({ body: createUserSchema }),
  (req, res) => {
    // req.body is now validated and typed!
    const { name, email, role } = req.body;
    // Safe to use directly -- no additional checking needed
    res.status(201).json({ id: 1, name, email, role });
  }
);

app.get(
  "/api/users/:id",
  validate({ params: getUserParamsSchema }),
  (req, res) => {
    const { id } = (req as any).validatedParams; // id is already a number
    res.json({ id, name: "Ada" });
  }
);

app.get(
  "/api/users",
  validate({ query: listUsersQuerySchema }),
  (req, res) => {
    const { page, limit, role } = (req as any).validatedQuery;
    res.json({ page, limit, role, users: [] });
  }
);
```

### Error Response Example

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"","email":"bad"}'
```

```json
{
  "error": {
    "type": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "source": "body",
        "field": "name",
        "message": "String must contain at least 1 character(s)"
      },
      {
        "source": "body",
        "field": "email",
        "message": "Invalid email"
      }
    ]
  }
}
```

The client knows exactly what went wrong and which fields to fix. That's a good API.

---

## Consistent Error Response Format: RFC 7807

RFC 7807 defines "Problem Details for HTTP APIs" -- a standard format for error
responses. You don't have to follow it exactly, but it's a good foundation.

### The Standard Format

```json
{
  "type": "https://api.myapp.com/errors/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "The request body contains invalid fields",
  "instance": "/api/users",
  "errors": [
    { "field": "email", "message": "Invalid email format" }
  ]
}
```

| Field | Purpose |
|-------|---------|
| `type` | A URI identifying the error type (can be a docs link) |
| `title` | Short, human-readable summary |
| `status` | HTTP status code (duplicated for convenience) |
| `detail` | Human-readable explanation specific to this occurrence |
| `instance` | The URI of the specific request that caused the error |

### Practical Simplification

The full RFC 7807 format is verbose. Here's a pragmatic version that works well:

```json
{
  "error": {
    "type": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [...]
  }
}
```

Rules for your error format:

1. **Always wrap in an `error` object.** This distinguishes error responses from
   success responses at a glance.
2. **Include a machine-readable `type`.** Clients can switch on this, not on the
   message text.
3. **Include a human-readable `message`.** For developers debugging in logs.
4. **Include `details` when relevant.** Validation errors, conflict info, etc.
5. **Never include stack traces in production.** That's a security leak.

---

## Error Classes and Centralized Error Handler

### Defining Error Classes

```typescript
// errors.ts
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly type: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    type: string,
    isOperational = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  public readonly details: Array<{ field: string; message: string }>;

  constructor(details: Array<{ field: string; message: string }>) {
    super("Request validation failed", 400, "VALIDATION_ERROR");
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    const message = id
      ? `${resource} with id '${id}' not found`
      : `${resource} not found`;
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to perform this action") {
    super(message, 403, "FORBIDDEN");
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Too many requests", 429, "RATE_LIMIT_EXCEEDED");
    this.retryAfter = retryAfter;
  }
}
```

### Why `isOperational`?

Operational errors are expected: invalid input, missing resources, rate limits.
These are part of normal API operation.

Non-operational errors are bugs: null pointer exceptions, database connection
failures, out-of-memory. These indicate something is broken and might need the
process to restart.

The error handler treats them differently: operational errors get a clean response;
non-operational errors log a full stack trace and return a generic message.

### The Centralized Error Handler

```typescript
// middleware/errorHandler.ts
import { Request, Response, NextFunction } from "express";
import { AppError, RateLimitError } from "../errors";

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Already sent a response? Let Express's default handler deal with it.
  if (res.headersSent) {
    return next(err);
  }

  // Known operational error
  if (err instanceof AppError) {
    const response: Record<string, unknown> = {
      error: {
        type: err.type,
        message: err.message,
      },
    };

    // Add details for validation errors
    if ("details" in err) {
      (response.error as Record<string, unknown>).details = (err as any).details;
    }

    // Add Retry-After header for rate limit errors
    if (err instanceof RateLimitError) {
      res.setHeader("Retry-After", err.retryAfter);
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Unknown/unexpected error -- this is a bug
  console.error("UNEXPECTED ERROR:", {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    body: req.body,
    timestamp: new Date().toISOString(),
  });

  res.status(500).json({
    error: {
      type: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
}
```

### Using It

```typescript
import { NotFoundError, ConflictError } from "./errors";

app.get("/users/:id", asyncHandler(async (req, res) => {
  const user = await userService.findById(req.params.id);

  if (!user) {
    throw new NotFoundError("User", req.params.id);
  }

  res.json(user);
}));

app.post("/users", asyncHandler(async (req, res) => {
  const existing = await userService.findByEmail(req.body.email);

  if (existing) {
    throw new ConflictError(`A user with email '${req.body.email}' already exists`);
  }

  const user = await userService.create(req.body);
  res.status(201).json(user);
}));
```

The handler throws. The error middleware catches. The client gets a consistent,
structured error response. No error-handling logic in the route handlers.

---

## Logging Errors vs Exposing Errors

### What to Log (Server-Side)

Log everything you need to debug:

```typescript
console.error("UNEXPECTED ERROR:", {
  message: err.message,
  stack: err.stack,
  url: req.originalUrl,
  method: req.method,
  body: req.body,
  headers: {
    "user-agent": req.headers["user-agent"],
    "x-request-id": req.headers["x-request-id"],
  },
  userId: (req as any).userId, // If authenticated
  timestamp: new Date().toISOString(),
});
```

### What to Expose (Client-Side)

Expose only what the client needs to fix the problem:

```json
{
  "error": {
    "type": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

Never expose:
- Stack traces (reveals file paths, line numbers, dependencies)
- Database error messages (reveals schema, table names)
- Environment variables (reveals configuration)
- Internal service names (reveals architecture)

### Bad Code: Leaking Internal Details

```typescript
// DANGEROUS: Exposes internal details
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({
    error: err.message,   // "ECONNREFUSED 127.0.0.1:5432" -- leaks DB host
    stack: err.stack,     // Full file paths and line numbers
  });
});
```

### The Exception: Development Mode

In development, it's useful to see full errors in the response. Use environment
detection:

```typescript
const isDev = process.env.NODE_ENV !== "production";

if (!(err instanceof AppError)) {
  const response: Record<string, unknown> = {
    error: {
      type: "INTERNAL_ERROR",
      message: isDev ? err.message : "An unexpected error occurred",
    },
  };

  if (isDev) {
    response.stack = err.stack;
  }

  res.status(500).json(response);
}
```

---

## Key Takeaways

1. **Validate at the boundary, trust within.** All external input is untrusted.
   Validate it at the API edge, then work with clean data.
2. **Zod gives you validation AND TypeScript types** from a single schema definition.
   Use `.strip()` to remove unknown fields.
3. **Build a validation middleware** that validates body, query, and params in one
   pass and returns structured errors.
4. **Use a consistent error format** across all endpoints. Include `type` (machine-
   readable), `message` (human-readable), and `details` (when applicable).
5. **Create error classes** for known error types. Throw them from handlers; catch
   them centrally.
6. **Separate operational errors from bugs.** Operational errors get clean responses;
   bugs get logged with full context and return generic messages.
7. **Never expose internal details** in production error responses.

---

## Exercises

### Exercise 1: Build a User Registration Schema

Create a Zod schema for user registration with these rules:

- `username`: 3-30 characters, alphanumeric and underscores only, trimmed, lowercased
- `email`: valid email, trimmed, lowercased
- `password`: 8-128 characters, must contain uppercase, lowercase, and a number
- `confirmPassword`: must match `password` (use `.refine()`)
- `dateOfBirth`: ISO date string, must be at least 13 years ago
- `bio`: optional, max 500 characters, trimmed

Write tests that verify: valid input passes, each invalid field produces the correct
error message, and unknown fields are stripped.

### Exercise 2: Nested Object Validation

Create a schema for a shipping address that validates:

```typescript
{
  recipient: { firstName: string, lastName: string },
  address: {
    line1: string,
    line2?: string,
    city: string,
    state: string (2-letter code),
    zipCode: string (5 digits or 5+4 format),
    country: "US" | "CA"
  },
  phone: string (valid phone format)
}
```

Test with various invalid inputs and verify the error paths are correct
(e.g., `address.zipCode`).

### Exercise 3: Extend the Error Handler

Add these features to the centralized error handler:

1. Detect Zod errors (thrown by `.parse()`) and format them like validation errors
2. Detect JSON syntax errors (from `express.json()`) and return a clear 400 message
3. Add a request ID to every error response
4. In development mode, include a `debug` field with the full error details

### Exercise 4: API Error Documentation

Using the error classes from this lesson, build an endpoint `GET /api/errors` that
returns documentation of all possible error types your API can return, including
their status codes, type strings, and example response bodies. This serves as a
reference for API consumers.

### Exercise 5: Input Sanitization Pipeline

Build a Zod schema that not only validates but also sanitizes a blog post:

- `title`: trim, collapse multiple spaces, capitalize first letter
- `body`: trim, remove HTML tags (for a plain-text API)
- `tags`: split comma-separated string, trim each, lowercase, deduplicate, max 5

Write a middleware that applies this schema and verify that the sanitized output
is what you expect for messy inputs like:

```json
{
  "title": "  hello    WORLD  ",
  "body": "This is <b>bold</b> and <script>evil()</script>",
  "tags": " JavaScript , typescript,  JAVASCRIPT, node , express, react"
}
```

Expected output:
```json
{
  "title": "Hello world",
  "body": "This is bold and evil()",
  "tags": ["javascript", "typescript", "node", "express", "react"]
}
```
