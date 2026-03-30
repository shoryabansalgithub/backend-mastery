import { randomBytes } from "crypto";

/**
 * Generate a random short code.
 *
 * Uses crypto.randomBytes for unpredictable codes, then encodes as
 * base64url and takes the first `length` characters. This gives us
 * a URL-safe alphanumeric string.
 *
 * With 7 characters from a 64-character alphabet, we get 64^7 = ~4.4 billion
 * possible codes. Collision probability is negligible for in-memory use.
 */
export function generateShortCode(length: number = 7): string {
  return randomBytes(length)
    .toString("base64url")
    .substring(0, length);
}

/**
 * Generate a unique ID for internal use.
 * Combines a timestamp prefix with random bytes for sortability.
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(4).toString("hex");
  return `${timestamp}-${random}`;
}

/**
 * Format a ShortenedUrl for API responses.
 * Converts Date to ISO string and adds the full short URL.
 */
export function formatUrlResponse(
  url: { id: string; shortCode: string; originalUrl: string; createdAt: Date; clicks: number },
  baseUrl: string
): Record<string, unknown> {
  return {
    id: url.id,
    shortCode: url.shortCode,
    shortUrl: `${baseUrl}/${url.shortCode}`,
    originalUrl: url.originalUrl,
    createdAt: url.createdAt.toISOString(),
    clicks: url.clicks,
  };
}

/**
 * Get the base URL from an Express request.
 * In production, you'd use a configured base URL instead.
 */
export function getBaseUrl(req: { protocol: string; get: (name: string) => string | undefined }): string {
  const host = req.get("host") || "localhost:3000";
  return `${req.protocol}://${host}`;
}
