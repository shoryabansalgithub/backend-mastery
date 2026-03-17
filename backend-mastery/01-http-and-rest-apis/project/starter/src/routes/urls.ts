/**
 * URL Routes
 *
 * Handles:
 * - POST /api/urls         -- Create a short URL
 * - GET  /api/urls         -- List all short URLs (paginated)
 * - GET  /api/urls/:code   -- Get details of a short URL
 * - DELETE /api/urls/:code -- Delete a short URL
 * - GET  /:code            -- Redirect to original URL (mounted on app, not this router)
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { ConflictError, NotFoundError } from "../middleware/errorHandler";
import {
  createUrl,
  getUrlByCode,
  listUrls,
  deleteUrl,
  shortCodeExists,
  recordClick,
} from "../storage";

const router = Router();

// ============ Zod Schemas ============

const createUrlBody = z.object({
  url: z.string().url(),
  customCode: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
});

const listUrlsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().default("-createdAt"),
  search: z.string().optional(),
});

const urlParamsSchema = z.object({
  code: z.string(),
});

// ============ Helpers ============

const SHORT_CODE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateShortCode(length = 7): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)];
  }
  return code;
}

function formatUrl(url: ReturnType<typeof getUrlByCode> & object) {
  return {
    id: url.id,
    shortCode: url.shortCode,
    shortUrl: `http://localhost:3000/${url.shortCode}`,
    originalUrl: url.originalUrl,
    createdAt: url.createdAt.toISOString(),
    clicks: url.clicks,
  };
}

// ============ Route Handlers ============

/**
 * POST /api/urls
 * Create a new short URL.
 */
router.post(
  "/",
  validate({ body: createUrlBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, customCode } = req.body as z.infer<typeof createUrlBody>;

      let shortCode = customCode;

      if (!shortCode) {
        // Generate a unique 7-character code
        let attempts = 0;
        do {
          shortCode = generateShortCode(7);
          attempts++;
          if (attempts > 10) {
            // Extremely unlikely, but guard against infinite loop
            shortCode = generateShortCode(10);
            break;
          }
        } while (shortCodeExists(shortCode));
      }

      const created = createUrl(shortCode, url);

      res.status(201).json({
        id: created.id,
        shortCode: created.shortCode,
        shortUrl: `http://localhost:3000/${created.shortCode}`,
        originalUrl: created.originalUrl,
        createdAt: created.createdAt.toISOString(),
        clicks: created.clicks,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/urls
 * List all short URLs with pagination.
 */
router.get(
  "/",
  validate({ query: listUrlsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit, sort, search } = req.query as unknown as z.infer<
        typeof listUrlsQuery
      >;

      const { urls, total } = listUrls({ page, limit, sort, search });

      const data = urls.map((u) => ({
        id: u.id,
        shortCode: u.shortCode,
        shortUrl: `http://localhost:3000/${u.shortCode}`,
        originalUrl: u.originalUrl,
        createdAt: u.createdAt.toISOString(),
        clicks: u.clicks,
      }));

      res.json({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/urls/:code
 * Get details of a specific short URL.
 */
router.get(
  "/:code",
  validate({ params: urlParamsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.params;
      const url = getUrlByCode(code);

      if (!url) {
        throw new NotFoundError("URL", code);
      }

      res.json({
        id: url.id,
        shortCode: url.shortCode,
        shortUrl: `http://localhost:3000/${url.shortCode}`,
        originalUrl: url.originalUrl,
        createdAt: url.createdAt.toISOString(),
        clicks: url.clicks,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/urls/:code
 * Delete a short URL and its analytics data.
 */
router.delete(
  "/:code",
  validate({ params: urlParamsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.params;
      const deleted = deleteUrl(code);

      if (!deleted) {
        throw new NotFoundError("URL", code);
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

export default router;

/**
 * Redirect handler -- mounted separately on the app (not under /api/urls).
 * GET /:code -> 302 redirect to original URL.
 */
export function redirectHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const { code } = req.params;
    const url = getUrlByCode(code);

    if (!url) {
      next(new NotFoundError("URL", code));
      return;
    }

    const referrer = (req.headers.referer as string) || "direct";
    const userAgent = (req.headers["user-agent"] as string) || "";

    recordClick(code, referrer, userAgent);

    res.redirect(302, url.originalUrl);
  } catch (err) {
    next(err);
  }
}
