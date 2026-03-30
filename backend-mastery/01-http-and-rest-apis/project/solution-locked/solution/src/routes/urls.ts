import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { NotFoundError, ConflictError } from "../middleware/errorHandler";
import * as storage from "../storage";
import { generateShortCode, formatUrlResponse, getBaseUrl } from "../utils";

const router = Router();

// ============ Zod Schemas ============

const createUrlBodySchema = z
  .object({
    url: z
      .string({ required_error: "url is required" })
      .url("Must be a valid URL")
      .refine(
        (url) => url.startsWith("http://") || url.startsWith("https://"),
        "URL must use http or https protocol"
      ),
    customCode: z
      .string()
      .min(3, "Custom code must be at least 3 characters")
      .max(30, "Custom code must be at most 30 characters")
      .regex(
        /^[a-zA-Z0-9-]+$/,
        "Custom code can only contain letters, numbers, and hyphens"
      )
      .optional(),
  })
  .strip();

const listUrlsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .string()
    .refine(
      (s) => ["createdAt", "-createdAt", "clicks", "-clicks"].includes(s),
      "sort must be one of: createdAt, -createdAt, clicks, -clicks"
    )
    .default("-createdAt"),
  search: z.string().optional(),
});

const urlParamsSchema = z.object({
  code: z.string().min(1, "Short code is required"),
});

// ============ Route Handlers ============

/**
 * POST /api/urls
 * Create a new short URL.
 */
router.post(
  "/",
  validate({ body: createUrlBodySchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, customCode } = req.body as z.infer<typeof createUrlBodySchema>;

      // Generate or use provided short code
      let shortCode: string;
      if (customCode) {
        shortCode = customCode;
      } else {
        // Generate a random code, retrying on collision (extremely unlikely)
        let attempts = 0;
        do {
          shortCode = generateShortCode();
          attempts++;
          if (attempts > 10) {
            throw new Error("Failed to generate unique short code");
          }
        } while (storage.shortCodeExists(shortCode));
      }

      // Attempt to create
      const created = storage.createUrl(shortCode, url);

      if (!created) {
        throw new ConflictError(
          `Short code '${shortCode}' is already taken`
        );
      }

      const baseUrl = getBaseUrl(req);
      res.status(201).json(formatUrlResponse(created, baseUrl));
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
  validate({ query: listUrlsQuerySchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit, sort, search } = (req as any).validatedQuery as z.infer<
        typeof listUrlsQuerySchema
      >;

      const { urls, total } = storage.listUrls({ page, limit, sort, search });

      const baseUrl = getBaseUrl(req);
      const data = urls.map((url) => formatUrlResponse(url, baseUrl));

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
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = (req as any).validatedParams as z.infer<typeof urlParamsSchema>;
      const url = storage.getUrlByCode(code);

      if (!url) {
        throw new NotFoundError("Short URL", code);
      }

      const baseUrl = getBaseUrl(req);
      res.json(formatUrlResponse(url, baseUrl));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/urls/:code
 * Delete a short URL and all its analytics data.
 */
router.delete(
  "/:code",
  validate({ params: urlParamsSchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = (req as any).validatedParams as z.infer<typeof urlParamsSchema>;
      const deleted = storage.deleteUrl(code);

      if (!deleted) {
        throw new NotFoundError("Short URL", code);
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;

/**
 * Redirect handler for GET /:code
 *
 * This is mounted separately on the app (not under /api/urls) because
 * the redirect endpoint has a different URL pattern and different rate limits.
 */
export function redirectHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const shortCode = req.params.code;

    const url = storage.getUrlByCode(shortCode);
    if (!url) {
      throw new NotFoundError("Short URL", shortCode);
    }

    // Record the click with referrer and user-agent
    const referrer = req.get("referer") || req.get("referrer") || "direct";
    const userAgent = req.get("user-agent") || "unknown";
    storage.recordClick(shortCode, referrer, userAgent);

    // 302 Found -- temporary redirect (so browsers don't permanently cache it)
    res.redirect(302, url.originalUrl);
  } catch (err) {
    next(err);
  }
}
