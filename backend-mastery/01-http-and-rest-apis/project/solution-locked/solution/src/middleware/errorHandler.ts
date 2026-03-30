import { Request, Response, NextFunction } from "express";

/**
 * Base class for operational errors.
 * These are expected errors (bad input, not found, etc.) -- not bugs.
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
 * Centralized error-handling middleware.
 *
 * Express identifies error handlers by their 4-parameter signature.
 * This middleware catches all errors from route handlers and other middleware,
 * and sends a consistent JSON error response.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If headers are already sent, delegate to Express's default error handler.
  // This handles the edge case where an error occurs after a partial response.
  if (res.headersSent) {
    return next(err);
  }

  // Handle known operational errors
  if (err instanceof AppError) {
    const response: Record<string, unknown> = {
      error: {
        type: err.type,
        message: err.message,
      },
    };

    // Include validation details if present
    if (err instanceof ValidationError) {
      (response.error as Record<string, unknown>).details = err.details;
    }

    // Set Retry-After header for rate limit errors
    if (err instanceof RateLimitError) {
      res.setHeader("Retry-After", String(err.retryAfter));
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle JSON parse errors from express.json()
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      error: {
        type: "INVALID_JSON",
        message: "Request body contains invalid JSON",
      },
    });
    return;
  }

  // Unknown error -- this is a bug. Log full details but don't expose them.
  console.error("UNEXPECTED ERROR:", {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  res.status(500).json({
    error: {
      type: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
}
