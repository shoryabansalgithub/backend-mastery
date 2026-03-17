# Project: Snip -- A URL Shortener with Analytics API

## Overview

Build a URL shortener API that creates short links, redirects visitors, and tracks
click analytics. This project exercises every concept from Module 1: HTTP methods,
REST design, middleware, validation, error handling, and rate limiting.

All storage is in-memory (no database -- that's Module 3). Focus on clean API
design and solid code architecture.

---

## Features

1. **Create short URLs** from long URLs, with optional custom short codes
2. **Redirect** short URLs to their original destinations (tracking each click)
3. **Analytics**: click counts, referrer tracking, time-series click data
4. **Rate limiting**: 10 creates per minute, 100 redirects per minute
5. **Input validation** with Zod on all endpoints
6. **Consistent error responses** following the patterns from Lesson 5

---

## API Endpoints

### URL Shortening

#### `POST /api/urls`

Create a new short URL.

**Request Body:**

```json
{
  "url": "https://example.com/very/long/path?with=params",
  "customCode": "my-link"
}
```

- `url` (required): The long URL to shorten. Must be a valid HTTP or HTTPS URL.
- `customCode` (optional): A custom short code (3-30 chars, alphanumeric and hyphens). If omitted, a random 7-character code is generated.

**Success Response: `201 Created`**

```json
{
  "id": "clx1a2b3c",
  "shortCode": "my-link",
  "shortUrl": "http://localhost:3000/my-link",
  "originalUrl": "https://example.com/very/long/path?with=params",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "clicks": 0
}
```

**Error Responses:**

- `400 Bad Request` -- Invalid URL format, invalid custom code format
- `409 Conflict` -- Custom code already taken
- `429 Too Many Requests` -- Rate limit exceeded (10 creates/minute)

---

#### `GET /api/urls`

List all shortened URLs (paginated).

**Query Parameters:**

- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20, max: 100): Items per page
- `sort` (optional, default: `-createdAt`): Sort field. Prefix with `-` for descending. Allowed: `createdAt`, `clicks`
- `search` (optional): Filter URLs where the original URL contains this string

**Success Response: `200 OK`**

```json
{
  "data": [
    {
      "id": "clx1a2b3c",
      "shortCode": "my-link",
      "shortUrl": "http://localhost:3000/my-link",
      "originalUrl": "https://example.com/very/long/path",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "clicks": 42
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

---

#### `GET /api/urls/:shortCode`

Get details of a specific short URL (without redirecting).

**Success Response: `200 OK`**

```json
{
  "id": "clx1a2b3c",
  "shortCode": "my-link",
  "shortUrl": "http://localhost:3000/my-link",
  "originalUrl": "https://example.com/very/long/path",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "clicks": 42
}
```

**Error Responses:**

- `404 Not Found` -- Short code doesn't exist

---

#### `DELETE /api/urls/:shortCode`

Delete a short URL and all its analytics data.

**Success Response: `204 No Content`**

**Error Responses:**

- `404 Not Found` -- Short code doesn't exist

---

### Redirects

#### `GET /:shortCode`

Redirect to the original URL. This is the public-facing endpoint that end users
visit.

**Success Response: `302 Found`**

Redirects to the original URL. Records a click event with:
- Timestamp
- Referrer (from `Referer` header)
- User-Agent

**Error Responses:**

- `404 Not Found` -- Short code doesn't exist (returns JSON error, not redirect)

---

### Analytics

#### `GET /api/analytics/:shortCode`

Get click analytics for a short URL.

**Query Parameters:**

- `days` (optional, default: 7): Number of days of history to include (1-90)

**Success Response: `200 OK`**

```json
{
  "shortCode": "my-link",
  "originalUrl": "https://example.com/very/long/path",
  "totalClicks": 42,
  "clicksByDay": [
    { "date": "2024-01-15", "clicks": 12 },
    { "date": "2024-01-14", "clicks": 8 },
    { "date": "2024-01-13", "clicks": 22 }
  ],
  "topReferrers": [
    { "referrer": "https://twitter.com", "clicks": 20 },
    { "referrer": "https://reddit.com", "clicks": 15 },
    { "referrer": "direct", "clicks": 7 }
  ],
  "recentClicks": [
    {
      "timestamp": "2024-01-15T10:30:00.000Z",
      "referrer": "https://twitter.com",
      "userAgent": "Mozilla/5.0..."
    }
  ]
}
```

**Error Responses:**

- `404 Not Found` -- Short code doesn't exist

---

## Implementation Requirements

### Architecture

```
src/
  index.ts              # Entry point, starts server
  routes/
    urls.ts             # URL CRUD endpoints + redirect
    analytics.ts        # Analytics endpoints
  middleware/
    validate.ts         # Zod validation middleware
    rateLimit.ts        # Rate limiting middleware
    errorHandler.ts     # Centralized error handler
  storage.ts            # In-memory data store
  types.ts              # TypeScript type definitions
  utils.ts              # Helper functions (solution only)
```

### Technical Requirements

1. Use Express with TypeScript
2. Validate all inputs with Zod (use the validation middleware pattern from Lesson 5)
3. Use proper HTTP status codes for every response
4. Implement rate limiting (in-memory, per-IP):
   - `POST /api/urls`: 10 requests per minute
   - `GET /:shortCode` (redirects): 100 requests per minute
5. Centralized error handling with custom error classes
6. Consistent error response format:
   ```json
   { "error": { "type": "ERROR_TYPE", "message": "Description", "details": [...] } }
   ```
7. Request logging for all endpoints
8. Proper `Content-Type` headers on all responses

### Things to Think About

- How do you generate unique short codes? What about collisions?
- Should `GET /api/urls/:shortCode` and `GET /:shortCode` (redirect) be different
  routes? Why?
- What should happen if someone creates a short URL for a URL that's already
  shortened? Deduplicate or allow multiple short codes for the same URL?
- How do you handle the `Referer` header being absent? (It's often stripped by
  browsers for privacy.)
- For analytics by day, how do you handle time zones?

---

## Getting Started

```bash
cd project/starter
npm install
npx tsx src/index.ts
```

The starter code has the file structure, route skeletons, and type definitions.
Fill in the `TODO` comments.

## Testing Your Solution

```bash
# Create a short URL
curl -X POST http://localhost:3000/api/urls \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/long-url"}'

# Create with custom code
curl -X POST http://localhost:3000/api/urls \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "customCode": "example"}'

# Test redirect (follow redirects with -L, or see headers with -v)
curl -v http://localhost:3000/example

# List all URLs
curl http://localhost:3000/api/urls

# Get URL details
curl http://localhost:3000/api/urls/example

# Get analytics
curl http://localhost:3000/api/analytics/example

# Delete a URL
curl -X DELETE http://localhost:3000/api/urls/example

# Test rate limiting (run this in a loop)
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/api/urls \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"https://example.com/$i\"}"
done
# First 10 should return 201, remaining should return 429

# Test validation
curl -X POST http://localhost:3000/api/urls \
  -H "Content-Type: application/json" \
  -d '{"url": "not-a-url"}'
# Should return 400 with validation error details
```
