/**
 * Snip URL Shortener -- Entry Point
 *
 * This file sets up the Express application with all middleware and routes.
 * Run with: npx tsx src/index.ts
 */

import express from "express";
import urlsRouter, { redirectHandler } from "./routes/urls";
import analyticsRouter from "./routes/analytics";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimit } from "./middleware/rateLimit";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ============ Global Middleware ============

// Parse JSON request bodies
app.use(express.json({ limit: "100kb" }));

// Request logging middleware
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ============ Health Check ============
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============ API Routes ============

// Rate limit URL API: 10 requests per minute
app.use("/api/urls", rateLimit({ windowMs: 60000, maxRequests: 10 }), urlsRouter);

app.use("/api/analytics", analyticsRouter);

// ============ Redirect Route ============

// Rate limit redirects: 100 per minute
// Must come AFTER /api routes to avoid catching /api/... as a short code
app.get("/:code", rateLimit({ windowMs: 60000, maxRequests: 100 }), redirectHandler);

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

// ============ Start Server ============
const server = app.listen(PORT, () => {
  console.log(`Snip URL Shortener running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
