/**
 * Core type definitions for the Snip URL Shortener.
 *
 * These types define the shape of your data. The storage layer and route
 * handlers should use these types consistently.
 */

/** A shortened URL record */
export interface ShortenedUrl {
  /** Unique identifier for internal use */
  id: string;

  /** The short code (e.g., "my-link") */
  shortCode: string;

  /** The original long URL */
  originalUrl: string;

  /** When the short URL was created */
  createdAt: Date;

  /** Total number of clicks */
  clicks: number;
}

/** A single click event */
export interface ClickEvent {
  /** When the click happened */
  timestamp: Date;

  /** The short code that was clicked */
  shortCode: string;

  /** Where the click came from (Referer header), or "direct" if absent */
  referrer: string;

  /** The visitor's User-Agent string */
  userAgent: string;
}

/** Aggregated clicks by day */
export interface ClicksByDay {
  /** Date string in YYYY-MM-DD format */
  date: string;

  /** Number of clicks on that day */
  clicks: number;
}

/** Aggregated clicks by referrer */
export interface TopReferrer {
  /** The referrer domain or "direct" */
  referrer: string;

  /** Number of clicks from this referrer */
  clicks: number;
}

/** Full analytics response for a short URL */
export interface AnalyticsResponse {
  shortCode: string;
  originalUrl: string;
  totalClicks: number;
  clicksByDay: ClicksByDay[];
  topReferrers: TopReferrer[];
  recentClicks: Array<{
    timestamp: string;
    referrer: string;
    userAgent: string;
  }>;
}

/** Standard error response format */
export interface ErrorResponse {
  error: {
    type: string;
    message: string;
    details?: Array<{
      source?: string;
      field: string;
      message: string;
    }>;
  };
}

/** Pagination metadata */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
