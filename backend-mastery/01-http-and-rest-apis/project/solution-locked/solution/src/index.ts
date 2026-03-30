/**
 * Snip URL Shortener -- Entry Point
 *
 * This is the complete solution for the Module 1 project.
 * It demonstrates every concept from the module:
 *
 * - Express server setup (Lesson 2-3)
 * - REST API design (Lesson 4)
 * - Zod validation (Lesson 5)
 * - Centralized error handling (Lesson 5)
 * - Rate limiting, CORS, logging (Lesson 6)
 */

import express, { Request, Response, NextFunction } from "express";
import urlsRouter, { redirectHandler } from "./routes/urls";
import analyticsRouter from "./routes/analytics";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimit } from "./middleware/rateLimit";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ============ Global Middleware ============

// Parse JSON request bodies (with size limit to prevent abuse)
app.use(express.json({ limit: "100kb" }));

// Simple request logging middleware
// (In production, you'd use a structured logger like pino or winston)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();

  // Attach request ID for use in handlers and error logging
  (req as any).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const duration = Date.now() - start;
    const logLine = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;

    if (res.statusCode >= 500) {
      console.error(logLine);
    } else if (res.statusCode >= 400) {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }
  });

  next();
});

// ============ Health Check ============

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============ API Routes ============

// URL creation: 10 requests per minute per IP
app.use(
  "/api/urls",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 10,
  }),
  urlsRouter
);

// Analytics: no special rate limit (uses the redirect rate limit for reads)
app.use("/api/analytics", analyticsRouter);

// ============ Redirect Route ============

// Redirects: 100 requests per minute per IP
// IMPORTANT: This must come AFTER /api routes to avoid
// matching /api/... as a short code.
app.get(
  "/:code",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 100,
  }),
  redirectHandler
);

// ============ 404 Handler ============

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: {
      type: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.url}`,
    },
  });
});

// ============ Error Handler (must be last) ============

app.use(errorHandler);

// ============ Start Server ============

const server = app.listen(PORT, () => {
  console.log(`\nSnip URL Shortener running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`\nEndpoints:`);
  console.log(`  POST   /api/urls          - Create a short URL`);
  console.log(`  GET    /api/urls          - List all short URLs`);
  console.log(`  GET    /api/urls/:code    - Get short URL details`);
  console.log(`  DELETE /api/urls/:code    - Delete a short URL`);
  console.log(`  GET    /api/analytics/:code - Get click analytics`);
  console.log(`  GET    /:code            - Redirect to original URL`);
  console.log();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Force shutdown after 10 seconds if connections don't close
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
});

process.on("SIGINT", () => {
  console.log("\nSIGINT received, shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
