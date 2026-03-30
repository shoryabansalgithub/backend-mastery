# Lesson 8: Token Lifecycle Management

## Why Token Lifecycle Matters

You've learned to create tokens and verify them. But in production, the
hard problems aren't creation and verification — they're everything in
between. When does a token become invalid? What happens when a user logs
out? How do you revoke access without a database lookup on every request?
What happens when a token is stolen but hasn't expired yet?

Token lifecycle management is where stateless auth gets complicated. This
lesson covers the complete lifecycle: issuance, usage, rotation, revocation,
and expiry — with the tradeoffs that come with each approach.

---

## The Token Lifecycle

```
  ┌─────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
  │ Issuance │────>│  Active  │────>│ Rotation │────>│ Expired/ │
  │          │     │  Usage   │     │          │     │ Revoked  │
  └─────────┘     └─────────┘     └──────────┘     └──────────┘
       │               │               │                 │
    Create          Validate        Replace          Invalidate
    Sign            Check exp       New tokens       Cleanup
    Deliver         Check revoke    Retire old       Audit log
```

Each phase has its own challenges and design decisions.

---

## Access Tokens vs Refresh Tokens: The Complete Picture

### Why Two Tokens?

A single long-lived token is convenient but dangerous. If stolen, the
attacker has access for the entire token lifetime.

A single short-lived token is secure but frustrating. Users have to re-login
every 15 minutes.

The two-token approach splits concerns:

```
Access Token:
  ├── Purpose: Prove identity on each API request
  ├── Format: JWT (self-contained, verifiable without DB)
  ├── Lifetime: 5-15 minutes
  ├── Storage: In memory (JavaScript variable)
  ├── Revokable: No (stateless)
  └── If stolen: Attacker has 15 minutes of access

Refresh Token:
  ├── Purpose: Obtain new access tokens
  ├── Format: Opaque random string (NOT a JWT)
  ├── Lifetime: 7-30 days
  ├── Storage: HttpOnly secure cookie
  ├── Revokable: Yes (tracked server-side)
  └── If stolen: Detectable via rotation
```

### The Math of Short Expiry

Why exactly 15 minutes for access tokens?

```
Scenario: Token is stolen at minute 0

With 24-hour tokens:
  Attacker has access: 0 to 1440 minutes
  Average exposure: 720 minutes (12 hours)

With 1-hour tokens:
  Attacker has access: 0 to 60 minutes
  Average exposure: 30 minutes

With 15-minute tokens:
  Attacker has access: 0 to 15 minutes
  Average exposure: 7.5 minutes

With 5-minute tokens:
  Attacker has access: 0 to 5 minutes
  Average exposure: 2.5 minutes
  But: more refresh requests, higher latency
```

15 minutes is the sweet spot for most applications: short enough to limit
damage, long enough to not annoy users or overload the refresh endpoint.

---

## Rotation Strategies

### Simple Rotation

Each time a refresh token is used, issue a new one and invalidate the old:

```typescript
import { randomBytes, createHash } from 'node:crypto';

interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  family: string;       // Links all tokens in a rotation chain
  createdAt: number;
  expiresAt: number;
  used: boolean;
  replacedBy?: string;  // Hash of the token that replaced this one
}

// In-memory store (use a database in production)
const refreshTokens = new Map<string, RefreshTokenRecord>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function issueRefreshToken(userId: string, family?: string): string {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  refreshTokens.set(tokenHash, {
    tokenHash,
    userId,
    family: family || randomBytes(16).toString('hex'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    used: false,
  });

  return token;
}

function rotateRefreshToken(
  oldToken: string
): { accessToken: string; refreshToken: string } | null {
  const oldHash = hashToken(oldToken);
  const record = refreshTokens.get(oldHash);

  if (!record) {
    return null; // Token doesn't exist
  }

  if (record.expiresAt < Date.now()) {
    refreshTokens.delete(oldHash);
    return null; // Token expired
  }

  if (record.used) {
    // TOKEN REUSE DETECTED — possible theft!
    // Invalidate the ENTIRE family
    invalidateTokenFamily(record.family);
    return null;
  }

  // Mark old token as used
  record.used = true;

  // Issue new tokens
  const newRefreshToken = issueRefreshToken(record.userId, record.family);
  record.replacedBy = hashToken(newRefreshToken);

  const accessToken = createAccessToken(record.userId);

  return { accessToken, refreshToken: newRefreshToken };
}

function invalidateTokenFamily(family: string): void {
  for (const [hash, record] of refreshTokens) {
    if (record.family === family) {
      refreshTokens.delete(hash);
    }
  }
  console.warn(`Token family ${family} invalidated — possible token theft`);
}
```

### Why Family-Based Invalidation Matters

Consider this scenario:

```
Timeline:
  t=0: User logs in, gets refresh token RT1
  t=1: Attacker steals RT1
  t=2: Attacker uses RT1 → gets RT2a (attacker's chain)
  t=3: User uses RT1 → REUSE DETECTED!
        → Entire family invalidated
        → RT2a (attacker's) is also invalidated
        → User must re-authenticate
```

Without family tracking, invaliding just RT1 would leave RT2a (the
attacker's token) valid. The family concept ensures that any token derived
from a compromised token is also invalidated.

```
Alternative timeline (user refreshes first):
  t=0: User logs in, gets RT1
  t=1: Attacker steals RT1
  t=2: User uses RT1 → gets RT2 (user's chain)
  t=3: Attacker uses RT1 → REUSE DETECTED!
        → Entire family invalidated
        → RT2 (user's) is also invalidated
        → User must re-authenticate
```

In both cases, the user has to re-login. This is the correct behavior:
we can't tell which party is legitimate, so we force both to
re-authenticate.

---

## Revocation Strategies

### The Fundamental Problem

JWTs are self-contained. Once issued, a JWT is valid until its `exp` claim
says otherwise. There's no built-in mechanism to say "this token is no
longer valid" because verification doesn't require a database lookup.

Scenarios requiring revocation:
1. User logs out
2. User changes password
3. Account is compromised
4. User's role changes
5. Admin revokes access
6. Account is deleted

### Strategy 1: Short Expiry (Accept the Window)

The simplest approach: don't revoke at all. Use very short access token
lifetimes and revoke only the refresh token.

```typescript
// Access token: 5 minutes
const accessToken = jwt.sign(
  { sub: userId, role },
  SECRET,
  { expiresIn: '5m' }
);

// On "logout", revoke the refresh token only
app.post('/auth/logout', (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (refreshToken) {
    const hash = hashToken(refreshToken);
    refreshTokens.delete(hash);
  }
  res.clearCookie('refreshToken');
  res.json({ message: 'Logged out' });
  // The access token is still valid for up to 5 minutes
  // but the user can't get a new one
});
```

**Tradeoff**: The access token remains valid for up to 5 minutes after
logout. For most applications, this is acceptable. For banking or
healthcare, it might not be.

### Strategy 2: Token Blocklist

Maintain a set of revoked token IDs:

```typescript
// Redis-based blocklist (production)
// In-memory version for illustration:
const blocklist = new Set<string>();

function revokeToken(jti: string, expiresAt: number): void {
  blocklist.add(jti);
  // Schedule cleanup when the token would have expired anyway
  const ttl = expiresAt - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    setTimeout(() => blocklist.delete(jti), ttl * 1000);
  }
}

function isRevoked(jti: string): boolean {
  return blocklist.has(jti);
}

// Modified verify middleware
function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, SECRET, {
      algorithms: ['HS256'],
    }) as { sub: string; role: string; jti: string; exp: number };

    // Check blocklist
    if (isRevoked(payload.jti)) {
      return res.status(401).json({ error: 'Token revoked' });
    }

    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Logout now truly revokes the access token
app.post('/auth/logout', authenticate, (req, res) => {
  revokeToken(req.user.jti, req.user.exp);
  // Also revoke refresh token...
  res.json({ message: 'Logged out' });
});
```

**Tradeoff**: You now have server-side state (the blocklist), which partially
defeats the purpose of stateless JWTs. But the blocklist is:
- Small (only unexpired revoked tokens)
- Simple (just a set of strings)
- Fast (O(1) lookup with Redis)
- Self-cleaning (entries expire with the token)

### Strategy 3: Token Version Stamping

Store a version counter per user. If the token's version doesn't match,
it's revoked:

```typescript
// User table includes a tokenVersion
interface User {
  id: string;
  email: string;
  tokenVersion: number;  // Starts at 0, incremented on revocation
}

// Include version in the JWT
function createAccessToken(user: User): string {
  return jwt.sign(
    { sub: user.id, role: user.role, v: user.tokenVersion },
    SECRET,
    { expiresIn: '15m' }
  );
}

// On verification, check version
async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  const payload = jwt.verify(token, SECRET) as { sub: string; v: number };

  const user = await getUserById(payload.sub);
  if (!user || user.tokenVersion !== payload.v) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  req.user = payload;
  next();
}

// Revoke ALL tokens for a user (password change, security incident)
async function revokeAllUserTokens(userId: string): Promise<void> {
  await incrementTokenVersion(userId);
  // All existing tokens have the old version → immediately invalid
}
```

**Tradeoff**: Requires a database lookup on every request (for the version
check), but it's a simple, single-field lookup — much lighter than full
session management.

### Strategy 4: Event-Based Revocation

For microservice architectures, broadcast revocation events:

```typescript
import { EventEmitter } from 'node:events';

// In production, this would be Redis Pub/Sub, NATS, or Kafka
const revocationBus = new EventEmitter();

// In-memory local cache of revoked tokens
const localRevocationCache = new Set<string>();

// Subscribe to revocation events from other services
revocationBus.on('token:revoked', (jti: string) => {
  localRevocationCache.add(jti);
});

// Publish revocation when a user logs out
function revokeToken(jti: string): void {
  localRevocationCache.add(jti);
  revocationBus.emit('token:revoked', jti);
}

// Each service checks its local cache — no network call needed
function isRevoked(jti: string): boolean {
  return localRevocationCache.has(jti);
}
```

### Comparison

| Strategy | DB Lookup per Request | Instant Revoke | Complexity |
|----------|----------------------|----------------|------------|
| Short expiry only | No | No (5-15 min delay) | Very low |
| Blocklist | Yes (Redis) | Yes | Medium |
| Version stamping | Yes (DB) | Yes (all tokens) | Medium |
| Event-based | No (local cache) | Near-instant | High |

For most applications: **short expiry + refresh token revocation** is
sufficient.

For high-security applications: add a **Redis-based blocklist**.

---

## Sliding Sessions

### The Concept

A sliding session extends the session's expiry each time the user is active.
Like a screen timeout that resets when you move the mouse.

```
Fixed session (30 minutes):
  Login at 10:00 → Session expires at 10:30
  Activity at 10:20 → Still expires at 10:30
  User is kicked out while actively using the app

Sliding session (30 minutes):
  Login at 10:00 → Session expires at 10:30
  Activity at 10:20 → Session extends to 10:50
  Activity at 10:40 → Session extends to 11:10
  User stays logged in as long as they're active
```

### Implementing Sliding Sessions with JWTs

JWTs have a fixed `exp` claim — you can't modify it after signing. But you
can implement sliding sessions with the refresh token:

```typescript
// Access token: 15 minutes (fixed)
// Refresh token: extends on use

app.post('/auth/refresh', (req, res) => {
  const oldRefreshToken = req.cookies.refreshToken;
  const result = rotateRefreshToken(oldRefreshToken);

  if (!result) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  // Issue fresh access token (full 15 minutes)
  const accessToken = createAccessToken(result.userId);

  // Issue fresh refresh token with EXTENDED expiry
  // This is the "sliding" part
  const newRefreshToken = issueRefreshToken(result.userId, result.family);
  // Each rotation gives another 30 days from NOW

  res.cookie('refreshToken', newRefreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken });
});
```

### Sliding Sessions with Server-Side Sessions

Much simpler with traditional sessions — just reset the expiry:

```typescript
// Session middleware with sliding window
app.use((req, res, next) => {
  if (req.session?.userId) {
    const TTL = 30 * 60 * 1000; // 30 minutes

    // Extend session on every request
    req.session.expiresAt = Date.now() + TTL;

    // Also refresh the cookie
    res.cookie('sid', req.sessionID, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: TTL,
    });
  }
  next();
});
```

### Absolute Timeout

Even with sliding sessions, you should have an absolute maximum session
duration. A session that sliding-extends forever is a security risk:

```typescript
interface Session {
  userId: string;
  createdAt: number;      // When the session was first created
  lastActivityAt: number; // When the user was last active
  expiresAt: number;      // Sliding expiry
}

const MAX_SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours absolute max
const SLIDING_WINDOW = 30 * 60 * 1000;             // 30 min sliding

function isSessionValid(session: Session): boolean {
  const now = Date.now();

  // Sliding expiry check
  if (now > session.expiresAt) return false;

  // Absolute duration check
  if (now - session.createdAt > MAX_SESSION_DURATION) return false;

  return true;
}

function refreshSession(session: Session): void {
  session.lastActivityAt = Date.now();
  session.expiresAt = Date.now() + SLIDING_WINDOW;
}
```

---

## Logout in Stateless Systems

### Why Logout Is Hard with JWTs

With server-side sessions, logout is trivial: delete the session from
the store. The session ID becomes meaningless.

With JWTs, "deleting" a token means nothing — it's self-contained. The
server has no record to delete. The token will remain valid until it
expires.

### The Practical Logout Flow

```typescript
// Client-side:
function logout() {
  // 1. Clear the access token from memory
  accessToken = null;

  // 2. Call the logout endpoint to revoke the refresh token
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include',  // Send refresh token cookie
  });

  // 3. Redirect to login page
  window.location.href = '/login';
}

// Server-side:
app.post('/auth/logout', (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (refreshToken) {
    // Revoke the refresh token
    const hash = hashToken(refreshToken);
    const record = refreshTokens.get(hash);

    if (record) {
      // Optional: invalidate entire token family
      invalidateTokenFamily(record.family);
    }
  }

  // Clear the cookie
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
  });

  res.json({ message: 'Logged out' });
});
```

### "Log Out Everywhere" (All Devices)

```typescript
app.post('/auth/logout-all', authenticate, async (req, res) => {
  const userId = req.user.userId;

  // Strategy 1: Delete all refresh tokens for this user
  for (const [hash, record] of refreshTokens) {
    if (record.userId === userId) {
      refreshTokens.delete(hash);
    }
  }

  // Strategy 2: If using token version stamping, just bump the version
  await incrementTokenVersion(userId);
  // All existing access tokens become invalid on next verification

  res.json({ message: 'Logged out from all devices' });
});
```

### Password Change = Forced Logout

When a user changes their password, all existing sessions should be
invalidated:

```typescript
app.post('/auth/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.userId;

  // Verify current password
  const user = await getUserById(userId);
  const isValid = await argon2.verify(user.passwordHash, currentPassword);
  if (!isValid) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }

  // Hash new password
  const newHash = await argon2.hash(newPassword);
  await updateUserPassword(userId, newHash);

  // CRITICAL: Invalidate all existing tokens
  await incrementTokenVersion(userId);

  // Delete all refresh tokens
  for (const [hash, record] of refreshTokens) {
    if (record.userId === userId) {
      refreshTokens.delete(hash);
    }
  }

  // Issue new tokens for the current session
  const accessToken = createAccessToken(userId);
  const refreshToken = issueRefreshToken(userId);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken, message: 'Password changed. All other sessions invalidated.' });
});
```

---

## Token Storage Security

### Where to Store What

```
┌──────────────────────────────────────────────────────────┐
│                    Storage Options                         │
├──────────────────┬───────────────────┬────────────────────┤
│ Storage          │ XSS Accessible?   │ CSRF Risk?         │
├──────────────────┼───────────────────┼────────────────────┤
│ localStorage     │ YES — game over   │ No                 │
│ sessionStorage   │ YES — game over   │ No                 │
│ Cookie (regular) │ YES               │ YES                │
│ Cookie (HttpOnly)│ NO                │ YES (mitigatable)  │
│ Memory (JS var)  │ Partially*        │ No                 │
│ Web Worker       │ NO                │ No                 │
├──────────────────┴───────────────────┴────────────────────┤
│ * XSS can still read it via the same script context,      │
│   but it won't survive page reloads                       │
└──────────────────────────────────────────────────────────┘
```

### The Recommended Pattern

```
Access Token  → In-memory JavaScript variable
                (or Web Worker for extra isolation)

Refresh Token → HttpOnly, Secure, SameSite cookie
                Path restricted to /auth/refresh
```

### Implementation: Token Manager Class

```typescript
// Client-side token management
class TokenManager {
  private accessToken: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  clearAccessToken(): void {
    this.accessToken = null;
  }

  // Refresh the access token using the HttpOnly cookie
  async refresh(): Promise<string | null> {
    // Prevent multiple simultaneous refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string | null> {
    try {
      const response = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'include',  // Send refresh cookie
      });

      if (!response.ok) {
        this.clearAccessToken();
        return null;
      }

      const { accessToken } = await response.json();
      this.setAccessToken(accessToken);
      return accessToken;
    } catch {
      this.clearAccessToken();
      return null;
    }
  }

  // Authenticated fetch with automatic token refresh
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    let token = this.getAccessToken();

    // If no token, try to refresh
    if (!token) {
      token = await this.refresh();
      if (!token) {
        throw new Error('Authentication required');
      }
    }

    // Make the request
    let response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    });

    // If 401, try to refresh and retry once
    if (response.status === 401) {
      token = await this.refresh();
      if (!token) {
        throw new Error('Authentication required');
      }

      response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
      });
    }

    return response;
  }
}

// Usage
const tokenManager = new TokenManager();

// After login
tokenManager.setAccessToken(loginResponse.accessToken);

// API calls — handles refresh automatically
const response = await tokenManager.fetch('/api/profile');
const profile = await response.json();
```

---

## Key Rotation

### Why Rotate Keys?

Signing keys should be rotated periodically:
1. **Limiting exposure**: If a key is compromised, only tokens signed with
   that key are affected
2. **Compliance**: Many standards (PCI-DSS, SOC2) require regular key
   rotation
3. **Best practice**: Keys that live forever are a growing liability

### Implementing Key Rotation

```typescript
interface SigningKey {
  id: string;       // Key ID (included in JWT header as 'kid')
  key: string;      // The actual secret or private key
  createdAt: number;
  retiredAt?: number;
  expiresAt: number; // When to stop accepting tokens signed with this key
}

class KeyManager {
  private keys: SigningKey[] = [];

  constructor() {
    // Initialize with a key
    this.rotateKey();
  }

  // Generate a new signing key
  rotateKey(): void {
    const newKey: SigningKey = {
      id: randomBytes(8).toString('hex'),
      key: randomBytes(32).toString('hex'),
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days
    };

    // Retire the current key (but keep it for verification)
    const currentKey = this.getCurrentKey();
    if (currentKey) {
      currentKey.retiredAt = Date.now();
    }

    this.keys.push(newKey);
    this.cleanupExpiredKeys();
  }

  // Get the active key for signing new tokens
  getCurrentKey(): SigningKey | undefined {
    return this.keys.find(k => !k.retiredAt);
  }

  // Get a key by ID for verification
  getKeyById(kid: string): SigningKey | undefined {
    return this.keys.find(k => k.id === kid && k.expiresAt > Date.now());
  }

  private cleanupExpiredKeys(): void {
    this.keys = this.keys.filter(k => k.expiresAt > Date.now());
  }

  // Sign a JWT with the current key
  sign(payload: object): string {
    const key = this.getCurrentKey();
    if (!key) throw new Error('No active signing key');

    return jwt.sign(payload, key.key, {
      algorithm: 'HS256',
      keyid: key.id,  // Include key ID in JWT header
      expiresIn: '15m',
    });
  }

  // Verify a JWT using the correct key
  verify(token: string): object {
    // Decode header to get the key ID
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new Error('Invalid token');
    }

    const kid = decoded.header.kid;
    if (!kid) {
      throw new Error('Token missing key ID');
    }

    const key = this.getKeyById(kid);
    if (!key) {
      throw new Error('Unknown or expired signing key');
    }

    return jwt.verify(token, key.key, {
      algorithms: ['HS256'],
    }) as object;
  }
}

// Usage
const keyManager = new KeyManager();

// Sign tokens
const token = keyManager.sign({ sub: 'user_42', role: 'admin' });

// Verify tokens (automatically uses the correct key)
const payload = keyManager.verify(token);

// Rotate keys (run periodically, e.g., every 30 days)
keyManager.rotateKey();
// Old tokens still verify (using old key)
// New tokens use the new key
```

### JWKS (JSON Web Key Set) for RS256

When using asymmetric keys, publish your public keys at a well-known
endpoint so other services can verify tokens:

```typescript
// Expose public keys at /.well-known/jwks.json
app.get('/.well-known/jwks.json', (req, res) => {
  const publicKeys = keyManager.getPublicKeys().map(key => ({
    kty: 'RSA',
    kid: key.id,
    use: 'sig',
    alg: 'RS256',
    n: key.modulus,   // RSA modulus
    e: key.exponent,  // RSA exponent
  }));

  res.json({ keys: publicKeys });
});

// Other services fetch this to verify tokens
async function getVerificationKey(kid: string): Promise<string> {
  const response = await fetch('https://auth.your-app.com/.well-known/jwks.json');
  const { keys } = await response.json();
  const key = keys.find((k: any) => k.kid === kid);
  if (!key) throw new Error('Unknown key');
  return jwkToPem(key);
}
```

---

## Token Lifecycle in Microservices

### The Challenge

In a microservice architecture, the auth service issues tokens, but every
other service needs to verify them. How do you handle token lifecycle
across services?

```
                     ┌─────────────┐
                     │  Auth Service │
                     │   (issues     │
                     │    tokens)    │
                     └──────┬──────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
       ┌──────┴──────┐           ┌────────┴────────┐
       │ API Gateway  │           │  Service A       │
       │ (verifies)   │           │  (verifies)      │
       └──────┬──────┘           └────────┬────────┘
              │                           │
       ┌──────┴──────┐           ┌────────┴────────┐
       │ Service B    │           │  Service C       │
       │ (verifies)   │           │  (verifies)      │
       └─────────────┘           └──────────────────┘
```

### Approach 1: Shared Secret (HS256)

All services share the same HMAC secret. Simple but has security concerns:
every service can both sign AND verify. A compromised service can forge
tokens.

### Approach 2: Asymmetric Keys (RS256)

Auth service has the private key. All other services have the public key.
A compromised service can verify but NOT forge tokens.

```typescript
// Auth service: signs with private key
const token = jwt.sign(payload, PRIVATE_KEY, { algorithm: 'RS256' });

// Any service: verifies with public key
const payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
// Even if Service B is compromised, it can't create fake tokens
```

### Approach 3: API Gateway Verification

The API gateway handles all token verification. Backend services receive
pre-verified requests with user info in headers:

```typescript
// API Gateway
app.use(async (req, res, next) => {
  const token = extractToken(req);
  try {
    const payload = jwt.verify(token, SECRET);

    // Forward user info to backend services
    req.headers['x-user-id'] = payload.sub;
    req.headers['x-user-role'] = payload.role;
    req.headers['x-auth-verified'] = 'true';

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Backend Service (trusts the gateway)
app.get('/api/data', (req, res) => {
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  // No token verification needed — gateway handled it
  // BUT: must ensure requests only come from the gateway
});
```

**Critical**: Backend services must verify that requests actually come from
the gateway (e.g., via mTLS, internal network restrictions, or a shared
hmac signature on the forwarded headers).

---

## Exercises

### Exercise 1: Complete Token Lifecycle

Implement a full token lifecycle system:
- Issue access + refresh tokens on login
- Verify access tokens on API requests
- Refresh access tokens with rotation
- Implement family-based reuse detection
- Handle logout (single device and all devices)
- Handle password change (forced logout)

### Exercise 2: Revocation Strategy Comparison

Implement three revocation strategies side by side:
1. Short expiry only (no blocklist)
2. In-memory blocklist
3. Token version stamping

For each, measure:
- Time to revoke a token
- Overhead per request
- Memory usage
- Behavior on "logout everywhere"

### Exercise 3: Sliding Session

Build a sliding session system with:
- 15-minute access token
- 30-minute sliding window on refresh token
- 24-hour absolute maximum session duration
- Activity tracking (update last active on each request)
- Idle timeout (logout if no activity for 30 minutes)

### Exercise 4: Key Rotation

Implement a key rotation system:
- Generate a new signing key
- Sign new tokens with the new key
- Verify old tokens with the old key
- Expire old keys after all tokens signed with them have expired
- Expose a JWKS endpoint

### Exercise 5: Client-Side Token Manager

Build a complete client-side token manager (TypeScript/browser):
- Store access token in memory
- Automatically refresh on 401
- Prevent multiple simultaneous refresh requests
- Handle logout
- Handle "token expired while the tab was in background"
- Queue requests during refresh and replay them

---

## Summary

| Concept | Purpose | Key Decision |
|---------|---------|-------------|
| Two-token system | Split security concerns | Access: stateless, short. Refresh: stateful, long |
| Token rotation | Detect theft | New refresh token on each use + family tracking |
| Revocation | Immediate invalidation | Blocklist (Redis) or version stamping |
| Sliding sessions | UX — keep active users in | Extend on activity, absolute max duration |
| Stateless logout | Terminate a JWT session | Clear client token + revoke refresh token |
| Key rotation | Limit key exposure | Sign with new, verify with both, expire old |
| JWKS | Distributed key management | Publish public keys at .well-known endpoint |

Next lesson: advanced auth systems — MFA, WebAuthn, passkeys, zero-trust,
and risk-based authentication.
