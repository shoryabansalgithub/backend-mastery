/** A shortened URL record */
export interface ShortenedUrl {
  id: string;
  shortCode: string;
  originalUrl: string;
  createdAt: Date;
  clicks: number;
}

/** A single click event */
export interface ClickEvent {
  timestamp: Date;
  shortCode: string;
  referrer: string;
  userAgent: string;
}

/** Aggregated clicks by day */
export interface ClicksByDay {
  date: string;
  clicks: number;
}

/** Aggregated clicks by referrer */
export interface TopReferrer {
  referrer: string;
  clicks: number;
}

/** Full analytics response */
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
