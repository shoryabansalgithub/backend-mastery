/**
 * Centralized Error Handler
 *
 * This middleware catches all errors thrown by route handlers and other
 * middleware, and sends a consistent JSON error response.
 */

import { Request, Response, NextFunction } from "express";

/**
 * Base class for operational errors (expected errors like validation failures,
 * not-found, etc.).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly type: string;

  constructor(message: string, statusCode: number, type: string) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    const msg = identifier
      ? `${resource} '${identifier}' not found`
      : `${resource} not found`;
    super(msg, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class ValidationError extends AppError {
  public readonly details: Array<{ source?: string; field: string; message: string }>;

  constructor(details: Array<{ source?: string; field: string; message: string }>) {
    super("Request validation failed", 400, "VALIDATION_ERROR");
    this.details = details;
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Too many requests", 429, "RATE_LIMIT_EXCEEDED");
    this.retryAfter = retryAfter;
  }
}

/**
 * Express error-handling middleware (4 parameters).
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If headers already sent, delegate to Express default handler
  if (res.headersSent) {
    next(err);
    return;
  }

  // Handle known AppError subclasses
  if (err instanceof RateLimitError) {
    res.set("Retry-After", String(Math.ceil(err.retryAfter / 1000)));
    res.status(err.statusCode).json({
      error: {
        type: err.type,
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(err.statusCode).json({
      error: {
        type: err.type,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        type: err.type,
        message: err.message,
      },
    });
    return;
  }

  // Unknown / unexpected error — log and return generic 500
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  res.status(500).json({
    error: {
      type: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
}
