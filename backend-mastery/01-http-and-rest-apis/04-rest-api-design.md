# Lesson 4: REST API Design

## What You'll Learn

REST is the most common API architecture on the web, but it's also the most
misunderstood. Most "REST APIs" aren't actually RESTful -- they're just HTTP APIs
with JSON. In this lesson, you'll learn REST from its original constraints, then
build practical design skills for real-world APIs including pagination, filtering,
versioning, and resource modeling.

---

## What REST Actually Is (and Isn't)

REST stands for **Representational State Transfer**. It was defined by Roy Fielding
in his 2000 PhD dissertation. It's not a standard, not a protocol, not a library --
it's an **architectural style** with a set of constraints.

Most developers think REST means "use HTTP methods and JSON." That's like saying
"architecture" means "has a roof." Let's look at the actual constraints.

---

## The Six REST Constraints

### 1. Client-Server

The client and server are separate. The client doesn't know how the server stores
data. The server doesn't know how the client displays data. They communicate through
a uniform interface.

**Why:** Independence. The frontend team and backend team can evolve their systems
independently. You can replace your React frontend with a mobile app without
changing the API.

### 2. Stateless

Each request contains ALL the information the server needs to process it. The server
doesn't store any client context between requests. No sessions on the server (at
least in pure REST).

**Why:** Scalability. If the server doesn't remember clients, any server can handle
any request. You can add more servers behind a load balancer trivially.

**Implication:** Authentication tokens must be sent with every request. The server
can't say "oh, I remember you from your last request."

### 3. Cacheable

Responses must declare themselves as cacheable or non-cacheable. If cacheable,
clients and intermediaries (CDNs, proxies) can reuse the response for equivalent
future requests.

**Why:** Performance. A response that says "this won't change for 1 hour" saves
the server from processing the same request repeatedly.

```
Cache-Control: max-age=3600     # Cache for 1 hour
Cache-Control: no-cache         # Always revalidate
Cache-Control: no-store         # Never cache (sensitive data)
```

### 4. Uniform Interface

This is the big one. REST defines a consistent, standardized way to interact with
resources. Four sub-constraints:

- **Identification of resources:** Each resource has a unique URL
  (`/users/42`, `/posts/7`)
- **Manipulation through representations:** When you GET a user, you get a
  *representation* (JSON, XML) of the user, not the actual database row
- **Self-descriptive messages:** Each message contains enough information to process
  it (`Content-Type` tells you how to parse the body)
- **HATEOAS:** Hypermedia as the Engine of Application State (more on this below)

### 5. Layered System

The client can't tell whether it's connected directly to the server or to an
intermediary (load balancer, CDN, API gateway). Each layer only knows about the
layer it's directly communicating with.

**Why:** You can add caching, load balancing, security layers, and monitoring
without changing the client or server code.

### 6. Code on Demand (Optional)

The server can send executable code to the client (JavaScript). This is the only
optional constraint and is rarely discussed in API contexts.

---

## Resource-Oriented Design

REST is about **resources**, not actions. This is the most practical design principle.

### Bad: Action-Oriented (RPC-Style)

```
POST /createUser
POST /getUser
POST /updateUser
POST /deleteUser
POST /getUserPosts
POST /searchUsers
```

Every operation is a different URL with POST. This is RPC (Remote Procedure Call),
not REST. It ignores HTTP methods entirely.

### Good: Resource-Oriented

```
POST   /users          # Create a user
GET    /users/42       # Get user 42
PATCH  /users/42       # Update user 42
DELETE /users/42       # Delete user 42
GET    /users/42/posts # Get user 42's posts
GET    /users?name=Ada # Search users
```

The URL identifies the resource. The HTTP method identifies the action. This is
the REST way.

### Naming Conventions

| Convention | Example | Rule |
|-----------|---------|------|
| Use nouns, not verbs | `/users` not `/getUsers` | The method IS the verb |
| Use plurals | `/users` not `/user` | Collections are plural |
| Use kebab-case | `/user-profiles` not `/userProfiles` | URLs are case-insensitive in practice |
| Nest for relationships | `/users/42/posts` | Shows ownership |
| Limit nesting to 2 levels | `/users/42/posts` not `/users/42/posts/7/comments/3/likes` | Deep nesting is hard to maintain |

### When Nesting Gets Too Deep

Instead of:
```
GET /users/42/posts/7/comments/3
```

Use top-level resources with query params:
```
GET /comments/3
GET /comments?postId=7
```

The question is: "Can a comment exist independently of its post?" If yes, it
deserves its own top-level endpoint.

---

## HTTP Methods to CRUD Mapping

| Method | CRUD | SQL Analog | Typical Use |
|--------|------|-----------|-------------|
| POST | Create | INSERT | Create new resource |
| GET | Read | SELECT | Retrieve resource(s) |
| PUT | Update (full) | UPDATE (all columns) | Replace entire resource |
| PATCH | Update (partial) | UPDATE (some columns) | Modify specific fields |
| DELETE | Delete | DELETE | Remove resource |

### PUT vs PATCH: A Subtle but Important Difference

**PUT replaces the entire resource.** If a user has `{name, email, age}` and you
PUT `{name: "Ada"}`, the result is `{name: "Ada"}` -- email and age are gone.

**PATCH updates only the fields you send.** If you PATCH `{name: "Ada"}`, the
result is `{name: "Ada", email: <unchanged>, age: <unchanged>}`.

In practice, PATCH is what most APIs want. PUT is useful for idempotent full
replacements (config objects, settings).

### Thought Experiment

You're designing a thermostat API. The thermostat has settings:
`{temperature: 72, mode: "cool", fanSpeed: "auto"}`.

Should "change the temperature to 68" be PUT or PATCH? PATCH -- you only want to
change temperature, not reset mode and fanSpeed to null. Should "upload a complete
new configuration" be PUT? Yes -- you're replacing the entire settings object.

---

## Pagination: Cursor vs Offset

When a collection has thousands of items, you can't return them all at once. You
need pagination. There are two main approaches.

### Offset-Based Pagination

```
GET /posts?page=3&limit=20
```

Means: "Skip the first 40 posts, return the next 20."

```json
{
  "data": [...],
  "pagination": {
    "page": 3,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**Pros:**
- Simple to understand
- Clients can jump to any page
- Easy to implement: `SELECT * FROM posts LIMIT 20 OFFSET 40`

**Cons:**
- **Inconsistent results when data changes.** If a post is deleted while the client
  is on page 2, page 3 will skip an item or show a duplicate.
- **Slow for large offsets.** `OFFSET 10000` means the database has to read and
  discard 10,000 rows. This gets worse linearly.

### Cursor-Based Pagination

```
GET /posts?limit=20&after=eyJpZCI6NDJ9
```

The `after` parameter is an opaque cursor (usually a base64-encoded ID or timestamp)
pointing to the last item the client saw.

```json
{
  "data": [...],
  "pagination": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJpZCI6NjJ9"
  }
}
```

**Pros:**
- **Consistent results.** Insertions/deletions don't cause skips or duplicates.
- **Efficient.** `WHERE id > 42 LIMIT 20` uses an index, regardless of how deep
  you are in the dataset.

**Cons:**
- Can't jump to an arbitrary page
- Slightly more complex to implement

### When to Use Which

| Use Offset When | Use Cursor When |
|-----------------|-----------------|
| Small datasets (< 10K items) | Large or growing datasets |
| Users need "go to page N" | Infinite scroll / "load more" |
| Data doesn't change often | Data changes frequently |
| Admin dashboards | Social feeds, timelines |

### Implementation Example

```typescript
// Cursor-based pagination
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

function decodeCursor(cursor: string): { id: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
}

// In your route handler:
app.get("/posts", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const after = req.query.after as string | undefined;

  let posts = getAllPosts(); // Sorted by ID ascending

  if (after) {
    const { id } = decodeCursor(after);
    const startIndex = posts.findIndex((p) => p.id === id);
    posts = posts.slice(startIndex + 1);
  }

  const hasMore = posts.length > limit;
  const page = posts.slice(0, limit);
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1].id) : null;

  res.json({
    data: page,
    pagination: { limit, hasMore, nextCursor },
  });
});
```

---

## Filtering and Sorting

### Filtering

Use query parameters that match field names:

```
GET /users?role=admin           # Exact match
GET /users?age_gte=18           # Greater than or equal
GET /users?name_like=Ada        # Partial match
GET /users?status=active,pending # Multiple values (OR)
```

Common filter operators:

| Suffix | Meaning | Example |
|--------|---------|---------|
| (none) | Exact match | `?status=active` |
| `_gte` | Greater than or equal | `?age_gte=18` |
| `_lte` | Less than or equal | `?price_lte=100` |
| `_gt` | Greater than | `?date_gt=2024-01-01` |
| `_lt` | Less than | `?date_lt=2024-12-31` |
| `_like` | Contains (case-insensitive) | `?name_like=ada` |
| `_ne` | Not equal | `?status_ne=deleted` |

### Sorting

```
GET /users?sort=name            # Ascending by name
GET /users?sort=-createdAt      # Descending by createdAt (prefix with -)
GET /users?sort=-createdAt,name # Multiple: descending createdAt, then ascending name
```

### Field Selection (Sparse Fieldsets)

When resources are large, let clients request only the fields they need:

```
GET /users?fields=id,name,email
```

This reduces bandwidth and is especially valuable for mobile clients.

### Combined Example

```
GET /products?category=electronics&price_lte=500&sort=-rating&fields=id,name,price,rating&limit=10
```

Translation: "Give me the top 10 highest-rated electronics under $500, and I only
need the id, name, price, and rating fields."

---

## HATEOAS: The Most Ignored REST Constraint

HATEOAS (Hypermedia As The Engine Of Application State) says that API responses
should include links to related actions and resources. The client discovers what it
can do from the response, rather than hardcoding URLs.

### What HATEOAS Looks Like

```json
{
  "id": 42,
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "_links": {
    "self": { "href": "/api/users/42" },
    "posts": { "href": "/api/users/42/posts" },
    "update": { "href": "/api/users/42", "method": "PATCH" },
    "delete": { "href": "/api/users/42", "method": "DELETE" }
  }
}
```

A paginated collection:

```json
{
  "data": [...],
  "_links": {
    "self": { "href": "/api/users?page=2" },
    "first": { "href": "/api/users?page=1" },
    "prev": { "href": "/api/users?page=1" },
    "next": { "href": "/api/users?page=3" },
    "last": { "href": "/api/users?page=10" }
  }
}
```

### Why Most APIs Skip It

1. **Frontend developers ignore the links.** They hardcode API URLs in the client
   anyway.
2. **Adds complexity and payload size** for little practical benefit in most apps.
3. **No standard format.** HAL, JSON:API, and Siren all do it differently.
4. **The "browser for APIs" vision hasn't materialized.** HATEOAS assumes generic
   clients that discover capabilities at runtime. Real clients are purpose-built.

### Should You Use It?

For internal APIs consumed by your own frontend: probably not. The overhead isn't
worth it. For public APIs consumed by third parties: consider it for pagination links
and key relationships. GitHub's API is a good example -- it includes pagination links
but doesn't go full HATEOAS.

Pragmatic compromise: always include `self` links and pagination links. Skip the rest
unless you have a compelling reason.

---

## API Versioning

APIs evolve. Fields get added, renamed, removed. Endpoints change behavior. How do
you evolve without breaking existing clients?

### Strategy 1: URL Path Versioning

```
GET /api/v1/users
GET /api/v2/users
```

**Pros:** Obvious, easy to route, easy to test.
**Cons:** URL changes for every version; hard to share code between versions.

### Strategy 2: Header Versioning

```
GET /api/users
Accept: application/vnd.myapp.v2+json
```

Or a custom header:
```
GET /api/users
X-API-Version: 2
```

**Pros:** Clean URLs, explicit versioning.
**Cons:** Harder to test (can't just change the URL in a browser).

### Strategy 3: Query Parameter

```
GET /api/users?version=2
```

**Pros:** Easy to test, visible.
**Cons:** Pollutes query string; unclear default behavior.

### Strategy 4: No Explicit Versioning (Additive Changes Only)

Never remove or rename fields. Only add new ones. Old clients ignore fields they
don't know about; new clients use the new fields.

**Pros:** Simplest for clients. No version negotiation.
**Cons:** API accumulates cruft over time. Breaking changes become impossible.

### My Recommendation

Use **URL path versioning** (`/v1/`) for major, breaking changes. Use **additive
changes** for minor evolution. This is what most successful APIs do (Stripe, GitHub,
Twilio).

When you must create v2:
1. Keep v1 running alongside v2
2. Announce a deprecation timeline (6-12 months minimum)
3. Log v1 usage to track who still depends on it
4. Add deprecation headers: `Sunset: Sat, 01 Jan 2026 00:00:00 GMT`

---

## Real-World API Design Examples

### Example 1: Blog Platform

```
# Posts
GET    /api/v1/posts                    # List posts (paginated)
POST   /api/v1/posts                    # Create post
GET    /api/v1/posts/:id                # Get post
PATCH  /api/v1/posts/:id                # Update post
DELETE /api/v1/posts/:id                # Delete post

# Post comments (nested -- tight relationship)
GET    /api/v1/posts/:id/comments       # List comments on post
POST   /api/v1/posts/:id/comments       # Add comment to post

# Tags (independent resource)
GET    /api/v1/tags                     # List all tags
GET    /api/v1/tags/:slug/posts         # List posts with tag

# Filtering and search
GET    /api/v1/posts?author=42&status=published&sort=-publishedAt
GET    /api/v1/posts?search=typescript&limit=10
```

### Example 2: E-Commerce

```
# Products
GET    /api/v1/products                 # List (with ?category, ?price_lte, etc.)
GET    /api/v1/products/:id             # Get product

# Cart (singular resource -- there's only one cart per user)
GET    /api/v1/cart                     # Get current user's cart
POST   /api/v1/cart/items               # Add item to cart
PATCH  /api/v1/cart/items/:id           # Update item quantity
DELETE /api/v1/cart/items/:id           # Remove item

# Orders
POST   /api/v1/orders                   # Create order (from cart)
GET    /api/v1/orders                   # List user's orders
GET    /api/v1/orders/:id               # Get order details

# Note: "checkout" is an action, not a resource. Two approaches:
POST   /api/v1/orders                   # Option A: creating an order IS checkout
POST   /api/v1/cart/checkout            # Option B: explicit action endpoint
```

### Example 3: Task Management

```
# Workspaces
GET    /api/v1/workspaces
POST   /api/v1/workspaces
GET    /api/v1/workspaces/:id

# Projects (scoped to workspace)
GET    /api/v1/workspaces/:wid/projects
POST   /api/v1/workspaces/:wid/projects
GET    /api/v1/projects/:id              # Top-level for direct access

# Tasks
GET    /api/v1/projects/:pid/tasks       # Tasks in a project
POST   /api/v1/projects/:pid/tasks       # Create task
GET    /api/v1/tasks/:id                 # Direct access
PATCH  /api/v1/tasks/:id                 # Update
DELETE /api/v1/tasks/:id                 # Delete

# Batch operations (sometimes you need action endpoints)
POST   /api/v1/tasks/batch-update        # Update multiple tasks at once
POST   /api/v1/tasks/batch-delete        # Delete multiple tasks
```

Notice the pattern: creation is scoped (POST to the parent), but reading/updating
is direct (GET/PATCH/DELETE on the resource itself). This avoids deep nesting while
maintaining clear ownership.

---

## Common API Design Mistakes

### Mistake 1: Verbs in URLs

```
# Bad
POST /api/createUser
GET  /api/getUser/42
POST /api/deleteUser/42

# Good
POST   /api/users
GET    /api/users/42
DELETE /api/users/42
```

### Mistake 2: Inconsistent Naming

```
# Bad -- mixed naming styles
GET /api/users
GET /api/blog-posts
GET /api/productCategories
GET /api/Order

# Good -- consistent plural kebab-case
GET /api/users
GET /api/blog-posts
GET /api/product-categories
GET /api/orders
```

### Mistake 3: Using 200 for Everything

```
# Bad -- how does the client detect errors programmatically?
HTTP/1.1 200 OK
{"success": false, "error": "User not found"}

# Good -- status code tells the story
HTTP/1.1 404 Not Found
{"error": {"type": "NOT_FOUND", "message": "User 42 not found"}}
```

### Mistake 4: Exposing Internal IDs Unnecessarily

```
# Bad -- leaks database auto-increment, lets attackers enumerate
GET /api/users/1
GET /api/users/2
GET /api/users/3

# Better -- use UUIDs or non-sequential IDs
GET /api/users/a1b2c3d4
GET /api/users/x7y8z9w0
```

### Mistake 5: No Envelope for Collections

```
# Bad -- can't add metadata without breaking the schema
[{...}, {...}, {...}]

# Good -- extensible
{
  "data": [{...}, {...}, {...}],
  "pagination": { "total": 100, "page": 1 }
}
```

If you return a bare array, adding pagination later is a breaking change (the
response type changes from array to object).

---

## Key Takeaways

1. REST is an architectural style with six constraints. Most "REST APIs" only follow
   some of them, and that's OK -- be intentional about which constraints you adopt.
2. Design around resources (nouns), not actions (verbs). Let HTTP methods be the
   verbs.
3. Use cursor-based pagination for large, frequently-changing datasets. Use offset
   for small, stable ones.
4. Filter with query parameters. Sort with a `sort` parameter. Select fields with
   a `fields` parameter.
5. HATEOAS is theoretically elegant but pragmatically overweight for most APIs. Use
   it selectively (pagination links, self links).
6. Version your API with URL paths for breaking changes and additive changes for
   non-breaking evolution.
7. Consistency matters more than perfection. Pick conventions and stick to them
   across your entire API.

---

## Exercises

### Exercise 1: Design a Library API

You're building an API for a public library system. Design the endpoints for:

- Books (search by title, author, ISBN; filter by genre, availability)
- Members (register, update profile)
- Loans (check out a book, return a book, view loan history)
- Reservations (reserve a book that's currently checked out)

For each endpoint, specify: HTTP method, URL, request body (if any), and response
format. Consider: what's the relationship between loans and books? Should returning
a book be `DELETE /loans/:id` or `POST /loans/:id/return`?

### Exercise 2: Pagination Implementation

Build a paginated `GET /items` endpoint that supports both cursor-based and
offset-based pagination (controlled by the client):

```
GET /items?page=2&limit=10           # Offset-based
GET /items?after=abc123&limit=10     # Cursor-based
```

Populate 100 items in memory and test both modes. Verify that offset-based
pagination shows inconsistent results when items are deleted mid-pagination, while
cursor-based doesn't.

### Exercise 3: Filtering Engine

Build a generic filtering function that takes query parameters and filters an
in-memory array of objects:

```typescript
const filtered = applyFilters(products, {
  category: "electronics",       // exact match
  price_gte: "10",              // >= 10
  price_lte: "500",             // <= 500
  name_like: "phone",           // contains "phone"
  status_ne: "discontinued",    // != "discontinued"
});
```

Make it generic enough to work with any object shape.

### Exercise 4: API Design Review

Here's a badly designed API. Identify all the problems and redesign it:

```
POST /api/getAllUsers              # Returns all users
POST /api/createNewUser            # Creates a user
GET  /api/user?id=42              # Gets a user
POST /api/updateUser              # Updates a user (id in body)
GET  /api/removeUser/42           # Deletes a user
POST /api/user/42/addPost         # Creates a post
GET  /api/Posts                   # Lists posts
```

### Exercise 5: Version Migration Plan

You have an existing v1 API:

```
GET /api/v1/users/:id
Response: { id, firstName, lastName, email, age }
```

For v2, you need to:
- Combine `firstName` and `lastName` into a single `name` field
- Remove `age` (privacy concerns)
- Add `avatarUrl`

Design the v2 endpoint and write a migration plan: how will you communicate the
change, how long will v1 live, and how will your code handle both versions without
duplication?
