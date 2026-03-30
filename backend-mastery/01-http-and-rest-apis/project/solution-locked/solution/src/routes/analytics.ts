import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { NotFoundError } from "../middleware/errorHandler";
import * as storage from "../storage";
import { ClickEvent, ClicksByDay, TopReferrer } from "../types";

const router = Router();

// ============ Zod Schemas ============

const analyticsParamsSchema = z.object({
  code: z.string().min(1, "Short code is required"),
});

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// ============ Helper Functions ============

/**
 * Aggregate click events into daily counts.
 * Returns an array sorted by date descending (most recent first).
 */
function aggregateByDay(events: ClickEvent[], days: number): ClicksByDay[] {
  const dayCounts = new Map<string, number>();

  // Initialize all days in the range (so days with 0 clicks still appear)
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    dayCounts.set(dateStr, 0);
  }

  // Count clicks per day
  for (const event of events) {
    const dateStr = event.timestamp.toISOString().split("T")[0];
    if (dayCounts.has(dateStr)) {
      dayCounts.set(dateStr, (dayCounts.get(dateStr) || 0) + 1);
    }
  }

  // Convert to sorted array
  return Array.from(dayCounts.entries())
    .map(([date, clicks]) => ({ date, clicks }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Aggregate click events by referrer.
 * Returns an array sorted by click count descending.
 */
function aggregateByReferrer(events: ClickEvent[]): TopReferrer[] {
  const referrerCounts = new Map<string, number>();

  for (const event of events) {
    const referrer = event.referrer;
    referrerCounts.set(referrer, (referrerCounts.get(referrer) || 0) + 1);
  }

  return Array.from(referrerCounts.entries())
    .map(([referrer, clicks]) => ({ referrer, clicks }))
    .sort((a, b) => b.clicks - a.clicks);
}

// ============ Route Handlers ============

/**
 * GET /api/analytics/:code
 * Get click analytics for a short URL.
 */
router.get(
  "/:code",
  validate({ params: analyticsParamsSchema, query: analyticsQuerySchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = (req as any).validatedParams as z.infer<
        typeof analyticsParamsSchema
      >;
      const { days } = (req as any).validatedQuery as z.infer<
        typeof analyticsQuerySchema
      >;

      // Verify the URL exists
      const url = storage.getUrlByCode(code);
      if (!url) {
        throw new NotFoundError("Short URL", code);
      }

      // Get click events for the requested time range
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0); // Start of day

      const events = storage.getClickEvents(code, since);

      // Aggregate analytics
      const clicksByDay = aggregateByDay(events, days);
      const topReferrers = aggregateByReferrer(events);

      // Get the 10 most recent clicks with formatted timestamps
      const recentClicks = events.slice(0, 10).map((event) => ({
        timestamp: event.timestamp.toISOString(),
        referrer: event.referrer,
        userAgent: event.userAgent,
      }));

      res.json({
        shortCode: code,
        originalUrl: url.originalUrl,
        totalClicks: url.clicks,
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
