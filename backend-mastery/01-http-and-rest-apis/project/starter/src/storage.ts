/**
 * In-Memory Storage for Snip URL Shortener
 *
 * This module manages all data storage using Maps (no database).
 * It exposes functions for CRUD operations on URLs and click events.
 */

import { ShortenedUrl, ClickEvent } from "./types";
import { ConflictError } from "./middleware/errorHandler";

// In-memory stores
export const urls = new Map<string, ShortenedUrl>();
export const clickEvents: ClickEvent[] = [];

/**
 * Create a new shortened URL in the store.
 * Throws ConflictError if the shortCode already exists.
 */
export function createUrl(
  shortCode: string,
  originalUrl: string
): ShortenedUrl {
  if (urls.has(shortCode)) {
    throw new ConflictError(`Short code '${shortCode}' is already in use`);
  }

  const url: ShortenedUrl = {
    id: crypto.randomUUID(),
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
 * Returns undefined if not found.
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
  const { page, limit, sort, search } = options;

  // Start with all URLs as array
  let all = Array.from(urls.values());

  // Filter by search (originalUrl or shortCode)
  if (search) {
    const lower = search.toLowerCase();
    all = all.filter(
      (u) =>
        u.originalUrl.toLowerCase().includes(lower) ||
        u.shortCode.toLowerCase().includes(lower)
    );
  }

  // Sort
  const descending = sort.startsWith("-");
  const field = descending ? sort.slice(1) : sort;

  all.sort((a, b) => {
    let aVal: number;
    let bVal: number;

    if (field === "clicks") {
      aVal = a.clicks;
      bVal = b.clicks;
    } else {
      // Default: createdAt
      aVal = a.createdAt.getTime();
      bVal = b.createdAt.getTime();
    }

    return descending ? bVal - aVal : aVal - bVal;
  });

  const total = all.length;

  // Paginate
  const start = (page - 1) * limit;
  const sliced = all.slice(start, start + limit);

  return { urls: sliced, total };
}

/**
 * Delete a shortened URL and all its click events.
 * Returns true if deleted, false if not found.
 */
export function deleteUrl(shortCode: string): boolean {
  if (!urls.has(shortCode)) {
    return false;
  }

  urls.delete(shortCode);

  // Remove all associated click events
  const toRemove: number[] = [];
  for (let i = 0; i < clickEvents.length; i++) {
    if (clickEvents[i].shortCode === shortCode) {
      toRemove.push(i);
    }
  }
  // Remove in reverse order to preserve indices
  for (let i = toRemove.length - 1; i >= 0; i--) {
    clickEvents.splice(toRemove[i], 1);
  }

  return true;
}

/**
 * Check if a short code already exists.
 */
export function shortCodeExists(shortCode: string): boolean {
  return urls.has(shortCode);
}

/**
 * Record a click event for a short URL.
 * Also increments the click counter on the URL.
 */
export function recordClick(
  shortCode: string,
  referrer: string,
  userAgent: string
): void {
  const event: ClickEvent = {
    timestamp: new Date(),
    shortCode,
    referrer,
    userAgent,
  };

  clickEvents.push(event);

  const url = urls.get(shortCode);
  if (url) {
    url.clicks += 1;
  }
}

/**
 * Get all click events for a short code within a date range.
 * Returns events sorted by timestamp descending (newest first).
 */
export function getClickEvents(
  shortCode: string,
  since: Date
): ClickEvent[] {
  return clickEvents
    .filter(
      (e) => e.shortCode === shortCode && e.timestamp >= since
    )
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
