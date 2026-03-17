/**
 * Analytics Routes
 *
 * Handles:
 * - GET /api/analytics/:code -- Get click analytics for a short URL
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { NotFoundError } from "../middleware/errorHandler";
import { getUrlByCode, getClickEvents } from "../storage";

const router = Router();

// ============ Zod Schemas ============

const analyticsParamsSchema = z.object({
  code: z.string(),
});

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// ============ Route Handlers ============

/**
 * GET /api/analytics/:code
 * Get click analytics for a short URL.
 */
router.get(
  "/:code",
  validate({ params: analyticsParamsSchema, query: analyticsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.params;
      const { days } = req.query as unknown as z.infer<typeof analyticsQuerySchema>;

      const url = getUrlByCode(code);
      if (!url) {
        throw new NotFoundError("URL", code);
      }

      const since = new Date(Date.now() - days * 86400000);
      const events = getClickEvents(code, since);

      // Aggregate: clicks by day (YYYY-MM-DD), sorted by date desc
      const dayMap = new Map<string, number>();
      for (const event of events) {
        const dateStr = event.timestamp.toISOString().slice(0, 10);
        dayMap.set(dateStr, (dayMap.get(dateStr) ?? 0) + 1);
      }
      const clicksByDay = Array.from(dayMap.entries())
        .map(([date, clicks]) => ({ date, clicks }))
        .sort((a, b) => b.date.localeCompare(a.date));

      // Aggregate: top referrers (top 10)
      const referrerMap = new Map<string, number>();
      for (const event of events) {
        referrerMap.set(event.referrer, (referrerMap.get(event.referrer) ?? 0) + 1);
      }
      const topReferrers = Array.from(referrerMap.entries())
        .map(([referrer, clicks]) => ({ referrer, clicks }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 10);

      // Recent clicks: last 20 (events already sorted newest first)
      const recentClicks = events.slice(0, 20).map((e) => ({
        timestamp: e.timestamp.toISOString(),
        referrer: e.referrer,
        userAgent: e.userAgent,
      }));

      res.json({
        shortCode: url.shortCode,
        originalUrl: url.originalUrl,
        totalClicks: events.length,
        clicksByDay,
        topReferrers,
        recentClicks,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
