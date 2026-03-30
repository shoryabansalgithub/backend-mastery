import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Returns a middleware that validates request data against Zod schemas.
 *
 * Validates body, query, and params independently, collecting all errors
 * before responding. On success, replaces the request data with the parsed
 * (and potentially transformed) result.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{
      source: "body" | "query" | "params";
      field: string;
      message: string;
    }> = [];

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
        req.body = result.data;
      }
    }

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
        // Store validated query on the request for type-safe access
        (req as any).validatedQuery = result.data;
      }
    }

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
