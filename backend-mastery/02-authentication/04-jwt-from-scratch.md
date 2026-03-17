# Lesson 4: JWT from Scratch

## Why Build a JWT by Hand?

JWTs (JSON Web Tokens) are everywhere. Login to any modern web app, and
there's probably a JWT involved. Most developers use a library like
`jsonwebtoken` and never look inside.

That's fine for writing code. It's terrible for understanding security.

In this lesson, we'll build a JWT from nothing — literally constructing
each byte. By the end, you'll know exactly what a JWT is, how it's signed,
how it's verified, and where things go wrong. Then we'll use the library.

---

## What Is a JWT?

A JWT is three Base64URL-encoded JSON strings separated by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
│                                     │ │                            │ │                                           │
└─────── Header ──────────────────────┘ └─────── Payload ────────────┘ └─────────── Signature ──────────────────────┘
```

That's it. It's not encrypted. It's not magic. It's three JSON objects
encoded in Base64URL, with a cryptographic signature to prevent tampering.

Let's build each piece.

---

## Part 1: Base64URL Encoding

### Why Base64URL, Not Base64?

Standard Base64 uses `+`, `/`, and `=`. These characters have special
meaning in URLs and HTTP headers. Base64URL replaces them:

```
Standard Base64: + / =
Base64URL:       - _ (no padding)
```

### Building Base64URL from Scratch

```typescript
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')     // Replace + with -
    .replace(/\//g, '_')     // Replace / with _
    .replace(/=+$/, '');     // Remove trailing =
}

function base64urlDecode(input: string): string {
  // Add back padding
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  return Buffer.from(padded, 'base64').toString('utf8');
}

// Test
console.log(base64url('{"alg":"HS256","typ":"JWT"}'));
// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9

console.log(base64urlDecode('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
// {"alg":"HS256","typ":"JWT"}
```

---

## Part 2: The Header

The header is a JSON object that describes the token:

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

- `alg`: The signing algorithm. HS256 = HMAC with SHA-256.
- `typ`: The token type. Always "JWT".

```typescript
const header = {
  alg: 'HS256' as const,
  typ: 'JWT' as const,
};

const encodedHeader = base64url(JSON.stringify(header));
console.log(encodedHeader);
// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
```

That's the first segment of our JWT. Nothing secret here — anyone can
decode it.

---

## Part 3: The Payload (Claims)

The payload contains the actual data — called "claims" in JWT terminology.

```json
{
  "sub": "user_42",
  "name": "Alice",
  "role": "admin",
  "iat": 1616239022,
  "exp": 1616242622
}
```

### Registered Claims (Standard)

These are predefined by the JWT spec (RFC 7519):

| Claim | Full Name | Purpose |
|-------|-----------|---------|
| `iss` | Issuer | Who created the token |
| `sub` | Subject | Who the token is about (usually user ID) |
| `aud` | Audience | Who the token is intended for |
| `exp` | Expiration | When the token expires (Unix timestamp) |
| `nbf` | Not Before | When the token becomes valid |
| `iat` | Issued At | When the token was created |
| `jti` | JWT ID | Unique identifier for the token |

### Custom Claims

You can add any data you want:

```json
{
  "sub": "user_42",
  "role": "admin",
  "orgId": "org_7",
  "permissions": ["read", "write", "delete"]
}
```

**But be careful.** The payload is NOT encrypted. Anyone with the token can
decode it and read these values. Never put secrets (passwords, API keys,
credit card numbers) in a JWT payload.

### Encoding the Payload

```typescript
const payload = {
  sub: 'user_42',
  name: 'Alice',
  role: 'admin',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
};

const encodedPayload = base64url(JSON.stringify(payload));
console.log(encodedPayload);
// eyJzdWIiOiJ1c2VyXzQyIiwibmFtZSI6IkFsaWNlIiwicm9sZSI6ImFkbWluIiw...
```

---

## Part 4: The Signature

This is the security. Without the signature, anyone could create a token
with `"role": "admin"` and your server would blindly trust it.

### HMAC-SHA256 Signing by Hand

The signature is computed over the header and payload:

```
HMAC-SHA256(
  secret,
  base64url(header) + "." + base64url(payload)
)
```

```typescript
import { createHmac } from 'node:crypto';

const SECRET = 'my-super-secret-key-at-least-32-bytes-long!!';

function sign(header: string, payload: string, secret: string): string {
  const data = `${header}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(data)
    .digest();
  return base64url(signature);
}

const signature = sign(encodedHeader, encodedPayload, SECRET);
console.log(signature);
// Something like: SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

### Assembling the Complete JWT

```typescript
const jwt = `${encodedHeader}.${encodedPayload}.${signature}`;
console.log(jwt);
// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzQyIiw...SflKxw...
```

That's a JWT. Three parts, dot-separated. You just built one from scratch.

---

## Part 5: Complete Implementation

Let's wrap this into a clean module:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

// ---- Encoding ----

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input: string): Buffer {
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  return Buffer.from(padded, 'base64');
}

// ---- Types ----

interface JWTHeader {
  alg: 'HS256';
  typ: 'JWT';
}

interface JWTPayload {
  sub?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [key: string]: unknown;
}

// ---- Create ----

function createJWT(payload: JWTPayload, secret: string): string {
  const header: JWTHeader = { alg: 'HS256', typ: 'JWT' };

  // Automatically set iat if not provided
  if (!payload.iat) {
    payload.iat = Math.floor(Date.now() / 1000);
  }

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));

  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signatureBytes = createHmac('sha256', secret)
    .update(signatureInput)
    .digest();
  const encodedSignature = base64url(signatureBytes);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

// ---- Verify ----

interface VerifyOptions {
  issuer?: string;
  audience?: string;
  clockToleranceSeconds?: number;
}

function verifyJWT(
  token: string,
  secret: string,
  options: VerifyOptions = {}
): JWTPayload {
  // Step 1: Split the token
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format: expected 3 parts');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  // Step 2: Verify the header
  let header: JWTHeader;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'));
  } catch {
    throw new Error('Invalid token: malformed header');
  }

  if (header.alg !== 'HS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // Step 3: Verify the signature
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest();
  const actualSignature = base64urlDecode(encodedSignature);

  if (expectedSignature.length !== actualSignature.length) {
    throw new Error('Invalid signature');
  }

  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    throw new Error('Invalid signature');
  }

  // Step 4: Parse the payload
  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'));
  } catch {
    throw new Error('Invalid token: malformed payload');
  }

  // Step 5: Check expiration
  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;

  if (payload.exp !== undefined && now > payload.exp + tolerance) {
    throw new Error('Token expired');
  }

  // Step 6: Check "not before"
  if (payload.nbf !== undefined && now < payload.nbf - tolerance) {
    throw new Error('Token not yet valid');
  }

  // Step 7: Check issuer
  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error(`Invalid issuer: expected ${options.issuer}`);
  }

  // Step 8: Check audience
  if (options.audience && payload.aud !== options.audience) {
    throw new Error(`Invalid audience: expected ${options.audience}`);
  }

  return payload;
}

// ---- Decode (no verification) ----

function decodeJWT(token: string): { header: JWTHeader; payload: JWTPayload } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  return {
    header: JSON.parse(base64urlDecode(parts[0]).toString('utf8')),
    payload: JSON.parse(base64urlDecode(parts[1]).toString('utf8')),
  };
}

// ---- Usage ----

const SECRET = 'this-key-should-be-at-least-256-bits-long!!';

// Create a token
const token = createJWT(
  {
    sub: 'user_42',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  },
  SECRET
);

console.log('Token:', token);

// Verify the token
const payload = verifyJWT(token, SECRET);
console.log('Payload:', payload);

// Decode without verification (for debugging only!)
const decoded = decodeJWT(token);
console.log('Decoded:', decoded);
```

---

## RS256 vs HS256

We've been using HS256 (HMAC + SHA-256), which is **symmetric** — the same
secret signs and verifies.

RS256 (RSA + SHA-256) is **asymmetric** — a private key signs, and a
public key verifies.

### When to Use Which

**HS256 (symmetric):**
- Single service signs and verifies
- The secret never needs to be shared
- Faster
- Simpler

**RS256 (asymmetric):**
- One service signs, many services verify
- Verifiers only need the public key (which is, well, public)
- Microservice architectures: auth service has private key, all other
  services have public key
- Slower, but verification can be distributed securely

### RS256 Implementation

```typescript
import {
  generateKeyPairSync,
  createSign,
  createVerify,
} from 'node:crypto';

// Generate RSA keys (do this once, store the keys)
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function createJWTRS256(payload: JWTPayload, privKey: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };

  if (!payload.iat) {
    payload.iat = Math.floor(Date.now() / 1000);
  }

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(privKey);

  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
}

function verifyJWTRS256(token: string, pubKey: string): JWTPayload {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64urlDecode(encodedSignature);

  const verifier = createVerify('SHA256');
  verifier.update(signatureInput);

  if (!verifier.verify(pubKey, signature)) {
    throw new Error('Invalid signature');
  }

  const payload = JSON.parse(
    base64urlDecode(encodedPayload).toString('utf8')
  );

  // Check exp, nbf, etc. (same as HS256)
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) {
    throw new Error('Token expired');
  }

  return payload;
}

// Auth service creates tokens with private key
const token = createJWTRS256(
  { sub: 'user_42', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
  privateKey
);

// Any service can verify with the public key
const payload = verifyJWTRS256(token, publicKey);
console.log(payload);
```

### Algorithm Comparison

| Property | HS256 | RS256 | EdDSA (Ed25519) |
|----------|-------|-------|-----------------|
| Type | Symmetric | Asymmetric | Asymmetric |
| Key | Shared secret | RSA key pair | Ed25519 key pair |
| Sign speed | Fast | Slow | Fast |
| Verify speed | Fast | Moderate | Very fast |
| Signature size | 32 bytes | 256 bytes | 64 bytes |
| Best for | Single service | Distributed | Modern distributed |

---

## Refresh Tokens: Why and How

### The Problem

JWTs can't be revoked. If you set a 24-hour expiry, a stolen token is valid
for 24 hours. If you set a 5-minute expiry, users have to log in every
5 minutes.

### The Solution: Two Tokens

```
Access Token:
  - JWT (stateless, verifiable)
  - Short-lived: 5-15 minutes
  - Used for API requests
  - Stored in memory (JavaScript variable)

Refresh Token:
  - Opaque random string (NOT a JWT)
  - Long-lived: 7-30 days
  - Used only to get new access tokens
  - Stored in HttpOnly cookie
  - Tracked server-side (revocable)
```

### The Flow

```
Login:
  Client → POST /auth/login { email, password }
  Server → { accessToken: "eyJ..." }
           Set-Cookie: refreshToken=abc123; HttpOnly; Secure

API Request:
  Client → GET /api/data
           Authorization: Bearer eyJ...
  Server → Verify JWT (no DB lookup)
  Server → { data: [...] }

Token Expired:
  Client → GET /api/data
           Authorization: Bearer eyJ... (expired)
  Server → 401 Token Expired

Refresh:
  Client → POST /auth/refresh
           Cookie: refreshToken=abc123
  Server → Lookup refresh token in DB
  Server → Valid? Generate new access token AND new refresh token
  Server → { accessToken: "eyJ..." }
           Set-Cookie: refreshToken=def456; HttpOnly; Secure
  Server → Delete old refresh token abc123 from DB
```

### Refresh Token Rotation

Notice that we issue a **new** refresh token on every refresh and delete
the old one. This is called **rotation**, and it's a critical security
measure.

Why? If an attacker steals a refresh token and uses it, the legitimate
user's next refresh attempt will fail (because the token was already
rotated). This is a signal that the token was compromised, and you can
invalidate the entire refresh token family.

```typescript
import { randomBytes } from 'node:crypto';

interface StoredRefreshToken {
  tokenHash: string;     // Hash of the token (never store raw)
  userId: string;
  family: string;        // Groups all tokens in a rotation chain
  expiresAt: number;
  used: boolean;         // Has this token been used to refresh?
}

// In-memory store (use a database in production)
const refreshTokenStore = new Map<string, StoredRefreshToken>();

function createRefreshToken(userId: string, family?: string): string {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  refreshTokenStore.set(tokenHash, {
    tokenHash,
    userId,
    family: family ?? randomBytes(16).toString('hex'),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    used: false,
  });

  return token;
}

function rotateRefreshToken(
  oldToken: string
): { newToken: string; userId: string } | null {
  const oldTokenHash = createHash('sha256').update(oldToken).digest('hex');
  const stored = refreshTokenStore.get(oldTokenHash);

  if (!stored) return null;
  if (stored.expiresAt < Date.now()) return null;

  if (stored.used) {
    // THIS TOKEN WAS ALREADY USED — possible theft!
    // Invalidate the entire token family
    console.warn(`Refresh token reuse detected for user ${stored.userId}`);
    for (const [hash, token] of refreshTokenStore) {
      if (token.family === stored.family) {
        refreshTokenStore.delete(hash);
      }
    }
    return null;
  }

  // Mark old token as used
  stored.used = true;

  // Create new token in the same family
  const newToken = createRefreshToken(stored.userId, stored.family);

  return { newToken, userId: stored.userId };
}
```

### Why Refresh Tokens Should NOT Be JWTs

Refresh tokens should be opaque random strings, not JWTs. Why?

1. **They need to be revocable** — which requires server-side storage.
   If you're storing them anyway, there's no benefit to self-contained
   data.

2. **They should be one-time use** — which requires tracking usage
   server-side.

3. **They shouldn't carry claims** — the access token carries claims.
   The refresh token's only job is to prove identity for token renewal.

---

## The Complete Access + Refresh Token Flow

```typescript
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ACCESS_SECRET = 'access-token-secret-at-least-32-bytes!!';
const ACCESS_EXPIRY = 15 * 60; // 15 minutes in seconds

// ---- Access Tokens (JWT) ----

function createAccessToken(userId: string, role: string): string {
  return createJWT(
    {
      sub: userId,
      role,
      exp: Math.floor(Date.now() / 1000) + ACCESS_EXPIRY,
    },
    ACCESS_SECRET
  );
}

function verifyAccessToken(token: string): JWTPayload {
  return verifyJWT(token, ACCESS_SECRET);
}

// ---- API Endpoint: Login ----

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  // Verify credentials
  const user = await verifyCredentials(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Create tokens
  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = createRefreshToken(user.id);

  // Send refresh token as HttpOnly cookie
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',  // Only sent to the refresh endpoint
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });

  // Send access token in response body
  res.json({ accessToken });
});

// ---- API Endpoint: Refresh ----

app.post('/auth/refresh', (req, res) => {
  const oldRefreshToken = req.cookies?.refreshToken;
  if (!oldRefreshToken) {
    return res.status(401).json({ error: 'No refresh token' });
  }

  const result = rotateRefreshToken(oldRefreshToken);
  if (!result) {
    res.clearCookie('refreshToken');
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  // Get user info for new access token
  const user = getUserById(result.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const accessToken = createAccessToken(user.id, user.role);

  res.cookie('refreshToken', result.newToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken });
});

// ---- API Endpoint: Logout ----

app.post('/auth/logout', (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }
  res.clearCookie('refreshToken');
  res.json({ message: 'Logged out' });
});

// ---- Middleware: Authenticate ----

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
}
```

---

## Common JWT Mistakes

### Mistake 1: Storing JWTs in localStorage

```typescript
// BAD
localStorage.setItem('token', jwt);
// Any XSS vulnerability exposes the token
```

**Fix:** Store access tokens in memory (JavaScript variable). Use HttpOnly
cookies for refresh tokens.

### Mistake 2: No Expiration

```typescript
// BAD
const token = createJWT({ sub: 'user_42' }, secret);
// This token is valid FOREVER
```

**Fix:** Always set `exp`. Keep access tokens short (5-15 minutes).

### Mistake 3: Sensitive Data in Payload

```typescript
// BAD
const token = createJWT({
  sub: 'user_42',
  email: 'alice@example.com',
  ssn: '123-45-6789',        // NEVER
  creditCard: '4111...',      // NEVER
}, secret);
```

**Fix:** Only include what's needed for authorization (user ID, role). The
payload is not encrypted.

### Mistake 4: Using `alg: "none"`

The JWT spec allows `alg: "none"`, which means no signature. Some libraries
accept this by default.

```typescript
// An attacker sends this token:
// Header: { "alg": "none", "typ": "JWT" }
// Payload: { "sub": "user_42", "role": "admin" }
// Signature: (empty)

// If your library accepts alg: none, the attacker is now admin
```

**Fix:** Always validate the algorithm. Never accept `none`. Libraries
like `jsonwebtoken` require you to specify allowed algorithms.

### Mistake 5: Weak Signing Secret

```typescript
// BAD
const secret = 'secret';
// Attackers can brute-force short secrets
```

**Fix:** Use a cryptographically random secret of at least 256 bits (32
bytes):

```typescript
import { randomBytes } from 'node:crypto';
const secret = randomBytes(32).toString('hex');
// 64-character hex string = 256 bits of entropy
```

### Mistake 6: Not Verifying on Every Request

```typescript
// BAD — just decoding without verifying
function getUser(token: string) {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString()
  );
  return payload; // ANYONE could have created this token
}
```

**Fix:** Always verify the signature before trusting the payload.

### Mistake 7: Confusing Encoding with Encryption

```typescript
// A developer thinks: "The JWT looks encrypted, so the data is safe"
// WRONG. Base64URL is encoding, not encryption.

// Anyone can read a JWT payload:
const payload = token.split('.')[1];
console.log(JSON.parse(Buffer.from(payload, 'base64url').toString()));
// { sub: "user_42", role: "admin", ... }
```

---

## Using the jsonwebtoken Library

Now that you understand the internals, here's how to use the standard
library properly:

```typescript
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET!;

// ---- Sign ----

function createToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    SECRET,
    {
      expiresIn: '15m',
      issuer: 'my-app',
      audience: 'my-app-api',
    }
  );
}

// ---- Verify ----

interface TokenPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, SECRET, {
    issuer: 'my-app',
    audience: 'my-app-api',
    algorithms: ['HS256'],  // IMPORTANT: restrict allowed algorithms
  }) as TokenPayload;
}

// ---- Decode (for debugging — no verification!) ----

function decodeToken(token: string) {
  return jwt.decode(token, { complete: true });
  // Returns { header, payload, signature }
}
```

### RS256 with jsonwebtoken

```typescript
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';

const PRIVATE_KEY = readFileSync('./private.pem', 'utf8');
const PUBLIC_KEY = readFileSync('./public.pem', 'utf8');

// Sign with private key
function createToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    PRIVATE_KEY,
    {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: 'auth-service',
    }
  );
}

// Verify with public key (any service can do this)
function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, PUBLIC_KEY, {
    algorithms: ['RS256'],
    issuer: 'auth-service',
  }) as TokenPayload;
}
```

---

## JWTs in Express: Complete Middleware

```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    role: string;
  };
}

function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Extract the token
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
    return;
  }

  const token = authHeader.slice(7);

  // 2. Verify the token
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
      issuer: 'my-app',
    }) as { sub: string; role: string };

    // 3. Attach user info to the request
    (req as AuthenticatedRequest).user = {
      userId: payload.sub,
      role: payload.role,
    };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
    } else if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
    } else {
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
}

// Usage
app.get('/api/profile', authenticate, (req: Request, res: Response) => {
  const { userId, role } = (req as AuthenticatedRequest).user;
  res.json({ userId, role });
});
```

---

## Exercises

### Exercise 1: JWT Builder

Using only Node's `crypto` module (no libraries), implement:
- `createJWT(payload, secret)` — creates an HS256 JWT
- `verifyJWT(token, secret)` — verifies and returns the payload
- `decodeJWT(token)` — decodes without verification

Test with:
```typescript
const token = createJWT({ sub: '123', admin: true, exp: /* now + 1h */ }, 'secret');
console.log(verifyJWT(token, 'secret'));       // { sub: '123', admin: true, ... }
console.log(verifyJWT(token, 'wrong-secret')); // throws Error
```

### Exercise 2: Token Expiry Tester

Create a JWT that expires in 2 seconds. Verify it immediately (should
succeed). Wait 3 seconds, verify again (should fail with "Token expired").
Add a `clockToleranceSeconds` parameter to your verify function that allows
a grace period.

### Exercise 3: Refresh Token System

Implement a complete refresh token system:
- Login returns access token + refresh token
- `/refresh` endpoint accepts a refresh token and returns new tokens
- Implement rotation: each refresh token can only be used once
- Implement family invalidation: if a used token is reused, invalidate
  all tokens in that family
- Write tests that verify the reuse detection works

### Exercise 4: Algorithm Confusion

Research the "algorithm confusion" attack. Then:
1. Generate an RS256 key pair
2. Create a token signed with the private key using RS256
3. Show how an attacker could exploit a vulnerable library by treating
   the public key as an HMAC secret
4. Write a `verifyJWT` function that is NOT vulnerable (by enforcing
   the expected algorithm)

### Exercise 5: JWT Debugger

Build a CLI tool that:
- Takes a JWT as a command-line argument
- Pretty-prints the header and payload (decoded)
- Shows the expiration time in human-readable format
- Shows whether the token is expired
- If a secret is provided via `--secret`, verifies the signature and
  reports whether it's valid

```bash
$ npx ts-node jwt-debug.ts eyJhbG... --secret mysecret

Header:
  alg: HS256
  typ: JWT

Payload:
  sub: user_42
  role: admin
  iat: 2024-01-15 10:30:00 UTC
  exp: 2024-01-15 10:45:00 UTC (expired 2 hours ago)

Signature: VALID
```

---

## Summary

| Concept | Purpose |
|---------|---------|
| JWT structure | header.payload.signature (Base64URL encoded) |
| HS256 | Symmetric signing (HMAC + SHA-256) |
| RS256 | Asymmetric signing (RSA + SHA-256) |
| Access token | Short-lived JWT for API authentication |
| Refresh token | Long-lived opaque token for renewal |
| Token rotation | New refresh token on each use |
| Family tracking | Detect and respond to token theft |

Next lesson: OAuth2 and OpenID Connect — letting users log in with Google,
GitHub, and other providers.
