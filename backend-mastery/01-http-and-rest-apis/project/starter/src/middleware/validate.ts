/**
 * Zod Validation Middleware
 *
 * This middleware validates request body, query params, and URL params
 * against Zod schemas. On failure, it returns a 400 response with
 * structured error details.
 */

import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Returns a middleware that validates req.body, req.query, and/or req.params
 * against the provided Zod schemas.
 *
 * On success: replaces req.body/query/params with the parsed (transformed) data,
 * then calls next().
 *
 * On failure: responds with 400 and a structured error listing all validation issues.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ source?: string; field: string; message: string }> = [];

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
        req.body = result.data;
      }
    }

    // Validate query
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
        // Replace req.query with parsed data (cast needed as Express types are readonly)
        req.query = result.data as typeof req.query;
      }
    }

    // Validate params
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
        req.params = result.data as typeof req.params;
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
