import { ShortenedUrl, ClickEvent } from "./types";
import { generateId } from "./utils";

// ============ Data Stores ============

/** URLs keyed by shortCode for O(1) lookups */
const urls = new Map<string, ShortenedUrl>();

/** Click events stored as an array (in production, this would be a DB table) */
const clickEvents: ClickEvent[] = [];

// ============ URL Operations ============

/**
 * Create a new shortened URL.
 * Returns the created URL, or null if the shortCode already exists.
 */
export function createUrl(
  shortCode: string,
  originalUrl: string
): ShortenedUrl | null {
  if (urls.has(shortCode)) {
    return null;
  }

  const url: ShortenedUrl = {
    id: generateId(),
    shortCode,
    originalUrl,
    createdAt: new Date(),
    clicks: 0,
  };

  urls.set(shortCode, url);
  return url;
}

/**
 * Get a shortened URL by its short code.
 */
export function getUrlByCode(shortCode: string): ShortenedUrl | undefined {
  return urls.get(shortCode);
}

/**
 * List all shortened URLs with pagination, sorting, and optional search.
 */
export function listUrls(options: {
  page: number;
  limit: number;
  sort: string;
  search?: string;
}): { urls: ShortenedUrl[]; total: number } {
  let result = Array.from(urls.values());

  // Filter by search term
  if (options.search) {
    const searchLower = options.search.toLowerCase();
    result = result.filter((url) =>
      url.originalUrl.toLowerCase().includes(searchLower)
    );
  }

  // Sort
  const descending = options.sort.startsWith("-");
  const sortField = descending ? options.sort.slice(1) : options.sort;

  result.sort((a, b) => {
    let comparison = 0;

    if (sortField === "createdAt") {
      comparison = a.createdAt.getTime() - b.createdAt.getTime();
    } else if (sortField === "clicks") {
      comparison = a.clicks - b.clicks;
    }

    return descending ? -comparison : comparison;
  });

  const total = result.length;

  // Paginate
  const offset = (options.page - 1) * options.limit;
  result = result.slice(offset, offset + options.limit);

  return { urls: result, total };
}

/**
 * Delete a shortened URL and all its click events.
 */
export function deleteUrl(shortCode: string): boolean {
  if (!urls.has(shortCode)) {
    return false;
  }

  urls.delete(shortCode);

  // Remove associated click events
  // Iterate backwards to safely splice while iterating
  for (let i = clickEvents.length - 1; i >= 0; i--) {
    if (clickEvents[i].shortCode === shortCode) {
      clickEvents.splice(i, 1);
    }
  }

  return true;
}

/**
 * Check if a short code already exists.
 */
export function shortCodeExists(shortCode: string): boolean {
  return urls.has(shortCode);
}

// ============ Click Event Operations ============

/**
 * Record a click event and increment the URL's click counter.
 */
export function recordClick(
  shortCode: string,
  referrer: string,
  userAgent: string
): void {
  const url = urls.get(shortCode);
  if (!url) return;

  url.clicks++;

  clickEvents.push({
    timestamp: new Date(),
    shortCode,
    referrer: referrer || "direct",
    userAgent: userAgent || "unknown",
  });
}

/**
 * Get click events for a short code since a given date.
 */
export function getClickEvents(
  shortCode: string,
  since: Date
): ClickEvent[] {
  return clickEvents
    .filter(
      (event) =>
        event.shortCode === shortCode &&
        event.timestamp >= since
    )
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
