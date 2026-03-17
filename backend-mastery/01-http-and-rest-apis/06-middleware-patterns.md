# Lesson 6: Middleware Patterns

## What You'll Learn

In Lesson 3, you learned what middleware is. In this lesson, you'll build a toolkit
of production-quality middleware patterns: logging, CORS, rate limiting, request
tracing, compression, and security headers. For each one, you'll understand the
*why* before the *how*.

---

## Request Logging

### Why Log Requests?

When something goes wrong in production, logs are your only window into what
happened. Without request logs, you're debugging blind -- "a user said the app is
slow" becomes an unsolvable mystery.

### Morgan: The Standard Choice

Morgan is Express's most popular logging middleware. It logs one line per request:

```typescript
import morgan from "morgan";

// Predefined formats
app.use(morgan("dev"));       // Colored, concise -- for development
app.use(morgan("combined"));  // Apache-style -- for production
app.use(morgan("tiny"));      // Minimal
```

`dev` format output:
```
GET /api/users 200 12.345 ms - 234
POST /api/users 201 3.456 ms - 56
GET /api/users/999 404 0.789 ms - 42
```

`combined` format output (for log aggregation tools):
```
::1 - - [15/Jan/2024:10:30:00 +0000] "GET /api/users HTTP/1.1" 200 234 "-" "curl/8.1.2"
```

### Custom Log Format

```typescript
app.use(
  morgan((tokens, req, res) => {
    return [
      new Date().toISOString(),
      tokens.method(req, res),
      tokens.url(req, res),
      tokens.status(req, res),
      tokens["response-time"](req, res),
      "ms",
      "-",
      tokens.res(req, res, "content-length"),
      "bytes",
    ].join(" ");
  })
);
```

Output:
```
2024-01-15T10:30:00.000Z GET /api/users 200 12.345 ms - 234 bytes
```

### Building a Custom Logger

Morgan is great for simple logging, but sometimes you need more structure
(JSON logs for log aggregation services like Datadog or ELK):

```typescript
// middleware/requestLogger.ts
import { Request, Response, NextFunction } from "express";

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = process.hrtime.bigint();
  const requestId = req.headers["x-request-id"] as string || crypto.randomUUID();

  // Log when the response finishes
  res.on("finish", () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;

    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      contentLength: res.getHeader("content-length"),
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    };

    // Use JSON for structured logging
    if (res.statusCode >= 500) {
      console.error(JSON.stringify(logEntry));
    } else if (res.statusCode >= 400) {
      console.warn(JSON.stringify(logEntry));
    } else {
      console.log(JSON.stringify(logEntry));
    }
  });

  next();
}
```

Output:
```json
{"timestamp":"2024-01-15T10:30:00.000Z","requestId":"abc-123","method":"GET","url":"/api/users","statusCode":200,"durationMs":12.34,"contentLength":"234","userAgent":"curl/8.1.2","ip":"::1"}
```

Structured JSON logs let log aggregation tools parse and search your logs
automatically. "Show me all requests slower than 1 second" becomes a simple query.

---

## CORS from First Principles

### The Problem CORS Solves

You're building a frontend at `http://localhost:5173` (Vite dev server) that calls
your API at `http://localhost:3000`. You write `fetch("/api/users")` and get:

```
Access to fetch at 'http://localhost:3000/api/users' from origin
'http://localhost:5173' has been blocked by CORS policy.
```

What happened? The browser blocked your request. Not the server -- the **browser**.

### Why the Browser Blocks It

The Same-Origin Policy is a browser security mechanism. It prevents a malicious
website from reading data from a different website while you're logged in.

Imagine you're logged into your bank at `bank.com`. You visit `evil.com`. Without
the Same-Origin Policy, `evil.com`'s JavaScript could fetch `bank.com/api/balance`
using your browser's cookies -- and your bank would happily respond because the
cookies are sent automatically. `evil.com` now has your balance.

The Same-Origin Policy prevents this: `evil.com` can't read responses from
`bank.com` unless `bank.com` explicitly allows it.

### What "Origin" Means

An origin is `protocol + host + port`. These are all different origins:

```
http://localhost:3000   (different port)
http://localhost:5173   (different port)
https://myapp.com       (different protocol)
https://api.myapp.com   (different host)
```

### How CORS Works

CORS (Cross-Origin Resource Sharing) is the mechanism for the server to say "I allow
requests from these origins."

**Simple requests** (GET, POST with simple content types) go directly to the server.
The browser checks the response's `Access-Control-Allow-Origin` header. If the
requesting origin isn't listed, the browser hides the response from JavaScript.

**Preflight requests** happen for "non-simple" requests (custom headers, PUT/PATCH/
DELETE, JSON content type). The browser sends an OPTIONS request first to ask
permission:

```
OPTIONS /api/users HTTP/1.1
Origin: http://localhost:5173
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Content-Type, Authorization
```

The server responds:

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

The browser sees the permission and proceeds with the actual request.

### Building CORS Middleware from Scratch

```typescript
// middleware/cors.ts
import { Request, Response, NextFunction } from "express";

interface CorsOptions {
  allowedOrigins: string[] | "*";
  allowedMethods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export function cors(options: CorsOptions) {
  const {
    allowedOrigins,
    allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders = ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders = [],
    credentials = false,
    maxAge = 86400,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // Determine if this origin is allowed
    let allowOrigin: string | null = null;

    if (allowedOrigins === "*") {
      allowOrigin = "*";
    } else if (origin && allowedOrigins.includes(origin)) {
      allowOrigin = origin;
    }

    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);

      if (credentials) {
        // Can't use * with credentials -- must echo the specific origin
        if (allowOrigin === "*") {
          throw new Error("Cannot use wildcard origin with credentials");
        }
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }

      if (exposedHeaders.length > 0) {
        res.setHeader("Access-Control-Expose-Headers", exposedHeaders.join(", "));
      }
    }

    // Handle preflight
    if (req.method === "OPTIONS") {
      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Methods", allowedMethods.join(", "));
        res.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        res.setHeader("Access-Control-Max-Age", String(maxAge));
      }
      res.status(204).end();
      return;
    }

    next();
  };
}
```

### Usage

```typescript
// Development: allow your frontend dev server
app.use(
  cors({
    allowedOrigins: ["http://localhost:5173"],
    credentials: true,
  })
);

// Production: allow your domain
app.use(
  cors({
    allowedOrigins: ["https://myapp.com", "https://www.myapp.com"],
    credentials: true,
  })
);

// Public API: allow everyone
app.use(
  cors({
    allowedOrigins: "*",
  })
);
```

### Or Use the `cors` Package

```typescript
import cors from "cors";

app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
```

The `cors` package handles edge cases (Vary header, etc.) that our simple version
skips. Use it in production. But now you understand what it does.

---

## Rate Limiting

### Why Rate Limit?

Without rate limiting, a single client can:
- DDoS your server (intentionally or accidentally)
- Scrape your entire database through the API
- Brute-force passwords
- Run up your cloud bill

Rate limiting says: "You can make X requests per Y time period. After that, wait."

### Simple In-Memory Rate Limiter

```typescript
// middleware/rateLimit.ts
import { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyFn?: (req: Request) => string; // How to identify the client
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyFn = (req) => req.ip || "unknown",
  } = options;

  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetTime) {
        store.delete(key);
      }
    }
  }, windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();

    let entry = store.get(key);

    // No entry or expired -- create new window
    if (!entry || now > entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers (standard convention)
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetTime / 1000));

    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", resetSeconds);
      res.status(429).json({
        error: {
          type: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
          retryAfter: resetSeconds,
        },
      });
      return;
    }

    next();
  };
}
```

### Usage

```typescript
// Global: 100 requests per minute
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 100,
  })
);

// Stricter for auth endpoints: 5 per minute
app.use(
  "/api/auth/login",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 5,
  })
);

// Per-user rate limiting (if authenticated)
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 200,
    keyFn: (req) => (req as any).userId || req.ip || "unknown",
  })
);
```

### Limitations of In-Memory Rate Limiting

Our implementation stores counters in a Map in process memory. This breaks when:

1. **Multiple server instances:** Each server has its own Map. A client gets
   `maxRequests * numberOfServers` total requests.
2. **Server restarts:** The Map is wiped. Rate limits reset.

In production, use Redis-backed rate limiting (`express-rate-limit` with
`rate-limit-redis`). We'll cover Redis in Module 7.

---

## Request ID and Tracing

### Why Request IDs?

When a user reports "I got an error at 2:15 PM," you need to find that specific
request in your logs. With thousands of requests per second, searching by timestamp
isn't enough. A unique request ID lets you trace one request through your entire
system.

```typescript
// middleware/requestId.ts
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Use existing ID (from load balancer, API gateway) or generate one
  const id = (req.headers["x-request-id"] as string) || randomUUID();

  // Attach to request for use in handlers and other middleware
  (req as any).requestId = id;

  // Include in response headers so clients can reference it
  res.setHeader("X-Request-Id", id);

  next();
}
```

### Using Request IDs

```typescript
app.use(requestId);

app.get("/api/users", async (req, res) => {
  const rid = (req as any).requestId;

  console.log(`[${rid}] Fetching users...`);
  const users = await getUsers();
  console.log(`[${rid}] Found ${users.length} users`);

  res.json(users);
});
```

Now when debugging, you can filter logs by request ID to see everything that
happened during one specific request.

### Distributed Tracing

In microservice architectures, one client request triggers calls to multiple
services. Pass the request ID in the headers of internal calls:

```
Client -> API Gateway (X-Request-Id: abc-123)
  -> User Service (X-Request-Id: abc-123)
  -> Auth Service (X-Request-Id: abc-123)
  -> Notification Service (X-Request-Id: abc-123)
```

Every service logs with the same request ID. You can trace one client request across
your entire system.

---

## Compression

### Why Compress?

JSON API responses are highly compressible. A 100KB JSON response might compress to
15KB with gzip. Less data = faster transfers = better user experience = lower
bandwidth costs.

### How It Works

1. Client sends `Accept-Encoding: gzip, deflate, br` (I accept these formats)
2. Server compresses the response body
3. Server sends `Content-Encoding: gzip` (I used this format)
4. Client decompresses automatically

```typescript
import compression from "compression";

app.use(compression({
  // Only compress responses larger than 1KB
  threshold: 1024,

  // Compression level (1-9). Higher = smaller but slower.
  level: 6, // Good balance

  // Only compress these content types
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) {
      return false;
    }
    return compression.filter(req, res);
  },
}));
```

### When NOT to Compress

- **Small responses (< 1KB):** Compression overhead exceeds savings
- **Already compressed formats:** Images (JPEG, PNG), videos, zip files
- **Streaming responses:** Compression adds latency because it buffers data
- **Behind a reverse proxy that compresses:** Don't double-compress. If Nginx handles
  compression, skip it in Node.js.

In production, compression is typically handled by Nginx or a CDN, not by your
Node.js process. Node.js is single-threaded -- spending CPU cycles on compression
means fewer cycles for handling requests.

---

## Security Headers with Helmet

### The Problem

Browsers have many security features that are off by default and must be enabled
via HTTP headers. Without them, your app is vulnerable to:

- Cross-site scripting (XSS)
- Clickjacking (embedding your site in an iframe)
- MIME type sniffing attacks
- Information leakage (server version in headers)

### Helmet: One Middleware, Many Headers

```typescript
import helmet from "helmet";

app.use(helmet());
```

This single line sets about 15 security headers. The most important ones:

| Header | What It Does |
|--------|-------------|
| `X-Content-Type-Options: nosniff` | Prevents browsers from guessing MIME types |
| `X-Frame-Options: SAMEORIGIN` | Prevents your site from being embedded in iframes |
| `Strict-Transport-Security` | Forces HTTPS for future visits |
| `X-XSS-Protection: 0` | Disables buggy browser XSS filter (CSP is better) |
| `Content-Security-Policy` | Controls which resources the browser can load |
| `Referrer-Policy: no-referrer` | Controls how much referrer info is sent |

### Customizing Helmet

```typescript
app.use(
  helmet({
    // Customize Content Security Policy for your needs
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Needed for some frontends
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    // Disable HSTS in development (it's permanent and hard to undo)
    hsts: process.env.NODE_ENV === "production",
  })
);
```

For API-only servers (no HTML), you can simplify:

```typescript
app.use(
  helmet({
    contentSecurityPolicy: false, // Not relevant for JSON APIs
    crossOriginEmbedderPolicy: false, // Can interfere with API clients
  })
);
```

---

## Building Your Own Middleware: Patterns and Best Practices

### Pattern 1: Configuration Factory

The best middleware takes options:

```typescript
interface Options {
  excludePaths?: string[];
  onError?: (error: Error) => void;
}

export function myMiddleware(options: Options = {}) {
  // One-time setup (runs when middleware is registered)
  const excludeSet = new Set(options.excludePaths || []);

  // The actual middleware function (runs per-request)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (excludeSet.has(req.path)) {
      return next(); // Skip this middleware for excluded paths
    }

    // Do work...
    next();
  };
}

// Usage
app.use(myMiddleware({ excludePaths: ["/health", "/metrics"] }));
```

### Pattern 2: Before/After Hook

Some middleware needs to act both before AND after the handler:

```typescript
export function timing() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // BEFORE: runs before the handler
    const start = process.hrtime.bigint();

    // Hook into the response finish event
    res.on("finish", () => {
      // AFTER: runs after the response is sent
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
      res.setHeader("X-Response-Time", `${duration.toFixed(2)}ms`);
    });

    // Note: We set the header in the finish event, but it's too late to
    // actually send it (headers are already sent). To send a timing header,
    // you need to use the "close" event or intercept res.end(). This is a
    // common gotcha.

    next();
  };
}
```

To actually include the timing header in the response, intercept `res.end`:

```typescript
export function responseTime() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    const originalEnd = res.end.bind(res);

    // Override res.end to add the header before sending
    (res as any).end = function (...args: any[]) {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (!res.headersSent) {
        res.setHeader("X-Response-Time", `${duration.toFixed(2)}ms`);
      }
      return originalEnd(...args);
    };

    next();
  };
}
```

### Pattern 3: Conditional Middleware

Apply middleware only to certain requests:

```typescript
export function unless(
  paths: string[],
  middleware: (req: Request, res: Response, next: NextFunction) => void
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (paths.includes(req.path)) {
      return next(); // Skip middleware for these paths
    }
    middleware(req, res, next);
  };
}

// Usage: apply auth to everything EXCEPT health check and login
app.use(unless(["/health", "/api/auth/login"], authMiddleware));
```

### Pattern 4: Data Enrichment

Add computed data to the request for downstream handlers:

```typescript
export function enrichRequest() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Parse and validate pagination from any request
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    (req as any).pagination = { page, limit, offset };

    next();
  };
}

// In handlers:
app.get("/api/users", enrichRequest(), (req, res) => {
  const { limit, offset } = (req as any).pagination;
  // Use directly -- already validated
});
```

---

## Putting It All Together

Here's a production-ready middleware stack for an Express API:

```typescript
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { cors } from "./middleware/cors";
import { requestId } from "./middleware/requestId";
import { rateLimit } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// 1. Security headers (first -- applies to all responses, even errors)
app.use(helmet({ contentSecurityPolicy: false }));

// 2. Request ID (early -- used by everything else)
app.use(requestId);

// 3. CORS (before body parsing -- preflight requests have no body)
app.use(cors({ allowedOrigins: ["http://localhost:5173"] }));

// 4. Compression (before routes -- compresses all responses)
app.use(compression({ threshold: 1024 }));

// 5. Request logging
app.use(requestLogger);

// 6. Body parsing
app.use(express.json({ limit: "1mb" }));

// 7. Global rate limiting
app.use(rateLimit({ windowMs: 60_000, maxRequests: 100 }));

// 8. Health check (before auth -- must be accessible without auth)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 9. Routes
app.use("/api/users", usersRouter);
app.use("/api/posts", postsRouter);

// 10. 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: { type: "NOT_FOUND", message: `Cannot ${req.method} ${req.url}` },
  });
});

// 11. Error handler (MUST be last)
app.use(errorHandler);

export default app;
```

The order matters. Security headers go first so they're applied even to error
responses. The error handler goes last so it catches errors from everything above.

---

## Key Takeaways

1. **Logging** is your window into production. Use structured JSON logs with request
   IDs for searchability.
2. **CORS** is a browser security mechanism, not a server one. The server sets
   headers that tell the browser what's allowed.
3. **Rate limiting** protects against abuse. Use IP-based for anonymous endpoints,
   user-based for authenticated ones. In production, use Redis.
4. **Request IDs** enable tracing one request through your entire system.
5. **Compression** reduces bandwidth but costs CPU. In production, let Nginx or a
   CDN handle it.
6. **Security headers** (via Helmet) enable browser security features. Use them for
   every server, even API-only ones.
7. **Middleware order matters.** Security first, error handler last.

---

## Exercises

### Exercise 1: Build a Full Logging Middleware

Build a request logger that outputs structured JSON with these fields:

- `timestamp`, `requestId`, `method`, `url`, `statusCode`, `durationMs`
- `contentLength` (of the response)
- `userAgent`, `ip`
- `error` (if the response was 4xx or 5xx, include the error message)

Log at different levels: `info` for 2xx, `warn` for 4xx, `error` for 5xx.

Test by making requests that produce each status code category.

### Exercise 2: CORS Tester

Build a small HTML page served at `http://localhost:8080` that makes fetch requests
to your API at `http://localhost:3000`. Test these scenarios:

1. Simple GET request -- should work with basic CORS
2. POST with JSON body -- requires preflight. Verify the OPTIONS request happens.
3. Request with custom `Authorization` header -- requires that header in
   `Access-Control-Allow-Headers`
4. Tighten CORS to only allow `http://localhost:8080` and verify that requests from
   other origins are blocked

### Exercise 3: Sliding Window Rate Limiter

Our rate limiter uses a fixed window: if the window is 1 minute and you make 99
requests at 0:59, you can make 100 more at 1:00 (the window reset). That's 199
requests in 2 seconds.

Implement a **sliding window** rate limiter that spreads the limit evenly. Track
individual request timestamps and count how many fall within the trailing window.

Compare the behavior of both approaches with a burst of requests at the window
boundary.

### Exercise 4: Middleware Composition

Write a function `compose()` that takes an array of middleware functions and returns
a single middleware function:

```typescript
const combined = compose([
  requestId,
  requestLogger,
  rateLimit({ windowMs: 60_000, maxRequests: 100 }),
]);

app.use(combined);
```

This should work identically to calling `app.use()` three times. Handle the case
where a middleware sends a response (short-circuits the chain) or calls `next(error)`.

### Exercise 5: API Key Authentication Middleware

Build a middleware that:

1. Checks for an `X-API-Key` header
2. Looks up the key in a Map of valid keys (each key has a `name`, `permissions`
   array, and `rateLimit`)
3. Attaches the API key info to the request
4. Applies a per-key rate limit (different keys can have different limits)
5. Returns 401 for missing keys, 403 for keys without the required permission
6. Logs key usage (which key, which endpoint, when)

Test with multiple API keys that have different permissions and rate limits.
