/**
 * Rate Limiting Middleware
 *
 * Limits the number of requests a client can make within a time window.
 * Uses IP address as the client identifier.
 */

import { Request, Response, NextFunction } from "express";
import { RateLimitError } from "./errorHandler";

interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number;

  /** Maximum number of requests allowed in the window */
  maxRequests: number;

  /** Optional: custom function to extract the client identifier */
  keyFn?: (req: Request) => string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number; // Unix timestamp in ms
}

/**
 * Returns a middleware that enforces rate limiting.
 *
 * - Tracks request counts per client (identified by IP or keyFn result)
 * - Sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers
 * - Returns 429 with Retry-After header when limit is exceeded
 * - Cleans up expired entries every 5 minutes
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyFn } = options;
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Prevent the interval from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn
      ? keyFn(req)
      : (req.ip ?? req.socket.remoteAddress ?? "unknown");

    const now = Date.now();
    let entry = store.get(key);

    // Create or reset entry if window has expired
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, maxRequests - entry.count);
    const resetSec = Math.ceil(entry.resetAt / 1000);

    res.set("X-RateLimit-Limit", String(maxRequests));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(resetSec));

    if (entry.count > maxRequests) {
      const retryAfterMs = entry.resetAt - now;
      next(new RateLimitError(retryAfterMs));
      return;
    }

    next();
  };
}
