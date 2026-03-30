import { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number;

  /** Maximum requests allowed per window */
  maxRequests: number;

  /** Custom function to extract client identifier (defaults to IP) */
  keyFn?: (req: Request) => string;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * In-memory rate limiting middleware.
 *
 * Uses a fixed-window algorithm: each client gets `maxRequests` within
 * a `windowMs` time period. The window resets after `windowMs` elapses.
 *
 * Sets standard rate limit headers:
 * - X-RateLimit-Limit: total allowed requests
 * - X-RateLimit-Remaining: remaining requests in current window
 * - X-RateLimit-Reset: Unix timestamp when the window resets
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyFn = (req: Request) => req.ip || req.socket.remoteAddress || "unknown",
  } = options;

  const store = new Map<string, RateLimitEntry>();

  // Periodically clean up expired entries to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetTime) {
        store.delete(key);
      }
    }
  }, windowMs);

  // Allow the interval to not keep the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();

    let entry = store.get(key);

    // Create new window if entry doesn't exist or has expired
    if (!entry || now > entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers on every response
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetTimestamp = Math.ceil(entry.resetTime / 1000);

    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetTimestamp));

    // Check if rate limit exceeded
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));

      res.status(429).json({
        error: {
          type: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
          retryAfter,
        },
      });
      return;
    }

    next();
  };
}
