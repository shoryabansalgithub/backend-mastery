# Lesson 5: OAuth 2.0 and OpenID Connect

## The Problem OAuth Solves

Imagine you build a photo printing service. Users want to print photos
from their Google Drive. One approach:

```
"Give us your Google username and password, and we'll log in for you."
```

This is catastrophically bad:
- You now have the user's Google password
- You have full access to their entire Google account
- The user can't revoke your access without changing their password
- If your server is breached, every user's Google credentials are exposed

OAuth solves this by enabling **delegated access**: the user grants your
app specific, limited access to their data on another service — without
ever sharing their password.

**A critical distinction:** OAuth 2.0 is an **authorization** protocol.
It answers "what can this app do?" not "who is this user?" For
authentication (identity), we need OpenID Connect, which is built on top
of OAuth 2.0. We'll cover both.

---

## OAuth 2.0 Roles

Every OAuth flow involves four parties:

```
Resource Owner     = The user (owns the data)
Client             = Your application (wants access)
Authorization Server = Google's auth server (grants access)
Resource Server    = Google Drive API (has the data)
```

In many setups, the Authorization Server and Resource Server are run by
the same provider (e.g., Google runs both).

---

## OAuth 2.0 Grant Types

OAuth 2.0 defines several flows ("grant types") for different situations:

| Grant Type | Use Case |
|-----------|----------|
| Authorization Code | Web apps with a backend server |
| Authorization Code + PKCE | SPAs, mobile apps, public clients |
| Client Credentials | Machine-to-machine (no user involved) |
| Device Code | Smart TVs, CLI tools (devices without browsers) |
| ~~Implicit~~ | **Deprecated.** Was for SPAs. Use Auth Code + PKCE instead. |
| ~~Password~~ | **Deprecated.** Was for trusted first-party apps. Don't use. |

We'll focus on the three that matter.

---

## Authorization Code Flow (Step by Step)

This is the most common flow. Your web application has a backend server
that can securely store secrets.

### The Flow

```
  User           Your App (Client)           Google (Auth Server)
   │                   │                            │
   │─ Click "Login     │                            │
   │  with Google" ───>│                            │
   │                   │                            │
   │                   │── Redirect user to ───────>│
   │                   │   Google's auth URL         │
   │                   │   (with client_id, scope,   │
   │                   │    redirect_uri, state)     │
   │                   │                            │
   │<──────────────────┼── Google shows login page ─│
   │                   │                            │
   │── Enter credentials ─────────────────────────>│
   │   & grant consent │                            │
   │                   │                            │
   │<──────────────────┼── Redirect to redirect_uri │
   │   with ?code=abc  │   with authorization code  │
   │   &state=xyz      │                            │
   │                   │                            │
   │── Follow redirect>│                            │
   │                   │                            │
   │                   │── POST /token ────────────>│
   │                   │   { code, client_secret,   │
   │                   │     redirect_uri }          │
   │                   │                            │
   │                   │<── { access_token,  ────────│
   │                   │     refresh_token,          │
   │                   │     id_token }              │
   │                   │                            │
   │                   │── GET /userinfo ──────────>│
   │                   │   Authorization: Bearer ... │
   │                   │                            │
   │                   │<── { name, email, ... } ───│
   │                   │                            │
   │<── Logged in! ────│                            │
```

### Step-by-Step Breakdown

**Step 1: Redirect to Authorization Server**

```
GET https://accounts.google.com/o/oauth2/v2/auth?
  response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=https://your-app.com/auth/callback
  &scope=openid email profile
  &state=random_csrf_token
  &access_type=offline
```

Parameters:
- `response_type=code`: We want an authorization code
- `client_id`: Your app's ID (registered with Google)
- `redirect_uri`: Where Google sends the user back
- `scope`: What access you're requesting
- `state`: CSRF protection (random value you verify on callback)
- `access_type=offline`: Request a refresh token too

**Step 2: User Authenticates and Consents**

Google shows a login screen. The user enters their credentials (with
Google, not with your app). Then Google shows a consent screen:

```
"Your App wants to:
  - See your email address
  - See your basic profile info
 [Allow]  [Deny]"
```

**Step 3: Authorization Code Callback**

User clicks Allow. Google redirects to your callback URL:

```
GET https://your-app.com/auth/callback?
  code=4/0AX4XfWg...
  &state=random_csrf_token
```

The `code` is a short-lived authorization code (typically expires in
10 minutes, usable only once).

**Step 4: Exchange Code for Tokens**

Your backend server exchanges the code for tokens:

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=4/0AX4XfWg...
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
&redirect_uri=https://your-app.com/auth/callback
```

Response:
```json
{
  "access_token": "ya29.a0AfH6SM...",
  "refresh_token": "1//0eXy7...",
  "id_token": "eyJhbGciOiJSUz...",
  "token_type": "Bearer",
  "expires_in": 3599,
  "scope": "openid email profile"
}
```

**Step 5: Use the Access Token**

```
GET https://www.googleapis.com/oauth2/v2/userinfo
Authorization: Bearer ya29.a0AfH6SM...
```

Response:
```json
{
  "id": "118234567890",
  "email": "alice@gmail.com",
  "verified_email": true,
  "name": "Alice Smith",
  "picture": "https://lh3.googleusercontent.com/..."
}
```

---

## PKCE: Protecting Public Clients

### The Problem with Public Clients

SPAs and mobile apps can't keep a `client_secret` secret. The code runs
on the user's device — any secret in the code can be extracted. Without
a secret, an attacker who intercepts the authorization code can exchange
it for tokens.

### PKCE (Proof Key for Code Exchange)

PKCE (pronounced "pixie") adds a challenge-response mechanism:

```
1. Client generates a random `code_verifier` (43-128 characters)
2. Client computes `code_challenge = BASE64URL(SHA256(code_verifier))`
3. Client sends `code_challenge` in the authorization request
4. On callback, client sends the original `code_verifier` in the token request
5. Server verifies: SHA256(code_verifier) matches the stored code_challenge
```

An attacker who intercepts the authorization code doesn't have the
`code_verifier`, so they can't exchange it.

```typescript
import { randomBytes, createHash } from 'node:crypto';

function generatePKCE(): { verifier: string; challenge: string } {
  // Generate a random code verifier (43-128 chars, URL-safe)
  const verifier = randomBytes(32)
    .toString('base64url')
    .slice(0, 43);

  // Compute the challenge
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return { verifier, challenge };
}

const pkce = generatePKCE();
console.log(pkce);
// {
//   verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
//   challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
// }
```

### PKCE Flow

```
  Authorization Request:
    code_challenge=E9Melhoa2...
    code_challenge_method=S256

  Token Request:
    code=authorization_code
    code_verifier=dBjftJeZ4...

  Server verifies:
    SHA256("dBjftJeZ4...") === "E9Melhoa2..." ✓
```

**Best practice:** Use PKCE for ALL clients, even those with a client
secret. It adds defense in depth.

---

## Client Credentials Flow

For machine-to-machine communication where no user is involved.

```
  Your Backend                  Auth Server
       │                            │
       │── POST /token ────────────>│
       │   grant_type=client_creds  │
       │   client_id=xxx            │
       │   client_secret=yyy        │
       │                            │
       │<── { access_token } ────────│
       │                            │
       │── GET /api/resource ──────>│
       │   Authorization: Bearer ... │
```

```typescript
async function getServiceToken(): Promise<string> {
  const response = await fetch('https://auth.example.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SERVICE_CLIENT_ID!,
      client_secret: process.env.SERVICE_CLIENT_SECRET!,
      scope: 'read:orders',
    }),
  });

  const data = await response.json();
  return data.access_token;
}
```

---

## OpenID Connect: Adding Identity to OAuth 2.0

### OAuth Isn't Authentication

OAuth 2.0 gives you an access token to call APIs. But who is the user?
The access token doesn't tell you. Different providers have different
userinfo endpoints. There's no standard.

OpenID Connect (OIDC) adds a standardized **identity layer** on top of
OAuth 2.0.

### What OIDC Adds

1. **ID Token**: A JWT that contains user identity information
2. **UserInfo Endpoint**: A standard endpoint to get user profile data
3. **Standard Scopes**: `openid`, `profile`, `email`, `address`, `phone`
4. **Discovery**: A standard `.well-known/openid-configuration` endpoint

### ID Token

The ID token is a JWT signed by the authorization server:

```json
{
  "iss": "https://accounts.google.com",
  "sub": "118234567890",
  "aud": "YOUR_CLIENT_ID",
  "exp": 1616242622,
  "iat": 1616239022,
  "email": "alice@gmail.com",
  "email_verified": true,
  "name": "Alice Smith",
  "picture": "https://lh3.googleusercontent.com/..."
}
```

The key claims:
- `iss`: Who issued this token (Google)
- `sub`: The user's unique ID at the provider
- `aud`: Your client ID (the token is for YOU)
- `email`: The user's email (if `email` scope was requested)

### ID Token vs Access Token

```
ID Token:
  - Tells you WHO the user is
  - A JWT you can verify and read
  - For YOUR application to consume
  - Never send to third-party APIs

Access Token:
  - Tells you WHAT the user allowed
  - Opaque (you don't look inside it)
  - For calling the PROVIDER'S APIs
  - Send to resource servers
```

### OIDC Discovery

Every OIDC provider publishes a configuration at a well-known URL:

```
GET https://accounts.google.com/.well-known/openid-configuration
```

This returns endpoints, supported scopes, algorithms, and more. Your
app can auto-configure itself by reading this document.

---

## Implementing "Login with Google" from Scratch

No Passport.js. No auth libraries. Just HTTP requests.

```typescript
import express from 'express';
import { randomBytes, createHash } from 'node:crypto';

const app = express();

// Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

// Temporary store for state and PKCE (use sessions in production)
const pendingAuth = new Map<string, { verifier: string }>();

// ---- Step 1: Redirect to Google ----

app.get('/auth/google', (req, res) => {
  // Generate PKCE
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // Generate state for CSRF protection
  const state = randomBytes(16).toString('hex');
  pendingAuth.set(state, { verifier });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ---- Step 2: Handle Callback ----

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  // Check for errors
  if (error) {
    return res.status(400).json({ error: `OAuth error: ${error}` });
  }

  // Verify state (CSRF protection)
  if (!state || !pendingAuth.has(state)) {
    return res.status(400).json({ error: 'Invalid state parameter' });
  }

  const { verifier } = pendingAuth.get(state)!;
  pendingAuth.delete(state);

  // ---- Step 3: Exchange code for tokens ----

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    return res.status(400).json({ error: `Token exchange failed: ${err}` });
  }

  const tokens = await tokenResponse.json() as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };

  // ---- Step 4: Verify and decode the ID token ----

  // In production, you'd verify the JWT signature using Google's public keys
  // from https://www.googleapis.com/oauth2/v3/certs
  // For simplicity, we'll decode and use the userinfo endpoint instead.

  // ---- Step 5: Get user info ----

  const userInfoResponse = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }
  );

  const userInfo = await userInfoResponse.json() as {
    id: string;
    email: string;
    verified_email: boolean;
    name: string;
    picture: string;
  };

  // ---- Step 6: Find or create user in your database ----

  let user = await findUserByGoogleId(userInfo.id);

  if (!user) {
    user = await createUser({
      googleId: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
    });
  }

  // ---- Step 7: Create your own session/token ----

  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = createRefreshToken(user.id);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  // Redirect to frontend with access token
  // In a real app, you might use a short-lived code or
  // redirect to a page that receives the token
  res.redirect(`/auth/success?token=${accessToken}`);
});
```

### Verifying the ID Token Properly

In production, you should verify the ID token's signature:

```typescript
import jwt from 'jsonwebtoken';

// Google's OIDC configuration
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Cache Google's public keys
let googleKeys: Record<string, string> = {};
let keysLastFetched = 0;

async function getGooglePublicKey(kid: string): Promise<string> {
  // Refresh keys every hour
  if (Date.now() - keysLastFetched > 3600_000) {
    const response = await fetch(GOOGLE_CERTS_URL);
    const data = await response.json() as { keys: Array<{ kid: string; n: string; e: string }> };

    // Convert JWK to PEM (simplified — use a library in production)
    googleKeys = {};
    for (const key of data.keys) {
      googleKeys[key.kid] = jwkToPem(key);
    }
    keysLastFetched = Date.now();
  }

  return googleKeys[kid];
}

async function verifyGoogleIdToken(idToken: string): Promise<{
  sub: string;
  email: string;
  name: string;
}> {
  // Decode header to get the key ID
  const header = JSON.parse(
    Buffer.from(idToken.split('.')[0], 'base64url').toString()
  );

  const publicKey = await getGooglePublicKey(header.kid);

  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    audience: GOOGLE_CLIENT_ID,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  }) as { sub: string; email: string; name: string };

  return payload;
}
```

---

## Security Considerations

### 1. The State Parameter (CSRF Protection)

Without the `state` parameter, an attacker can perform a CSRF attack:

```
1. Attacker initiates OAuth flow, gets an authorization code
2. Attacker tricks victim into visiting:
   https://your-app.com/auth/callback?code=ATTACKERS_CODE
3. Your app exchanges the code and links the ATTACKER's account
   to the VICTIM's session
4. The attacker now has access to the victim's account
```

The `state` parameter prevents this: your app generates a random state,
stores it server-side (or in a signed cookie), and verifies it on callback.

### 2. PKCE (Code Interception Protection)

Without PKCE, an attacker on the network or on the device can intercept
the authorization code during the redirect. PKCE ensures only the original
client (which has the code_verifier) can exchange the code.

### 3. Redirect URI Validation

If the authorization server doesn't strictly validate redirect URIs, an
attacker can register:

```
redirect_uri=https://evil.com/steal
```

And the authorization code (or tokens in the implicit flow) gets sent to
the attacker. Always register exact redirect URIs — no wildcards.

### 4. Token Storage

- Store access tokens from the provider securely (encrypted at rest)
- Never expose provider tokens to the frontend
- Use your own session/token system after OAuth login

### 5. Scope Minimization

Request only the scopes you need. Don't request `https://www.googleapis.com/auth/drive`
if you only need the user's email. Users are more likely to consent to
minimal scopes, and your liability is reduced.

---

## Common OAuth Mistakes

### Mistake 1: Using the Implicit Flow

```
// BAD — tokens in URL fragment
https://your-app.com/callback#access_token=ya29...
```

The implicit flow returns tokens directly in the URL. They can be leaked
through browser history, referrer headers, and proxy logs. Always use the
Authorization Code flow (with PKCE for public clients).

### Mistake 2: Not Verifying the ID Token

```typescript
// BAD — trusting the ID token without verification
const payload = JSON.parse(
  Buffer.from(idToken.split('.')[1], 'base64url').toString()
);
// An attacker could forge this token!
```

Always verify the signature using the provider's public keys.

### Mistake 3: Using the Access Token for Authentication

```typescript
// BAD — the access token doesn't tell you WHO the user is
// It only tells you what they're AUTHORIZED to do
const token = oauth_response.access_token;
// This is for calling Google APIs, not for identifying the user
```

Use the ID token for authentication. Use the access token for API calls.

### Mistake 4: Storing Provider Secrets in Frontend Code

```javascript
// BAD — anyone can read this
const GOOGLE_CLIENT_SECRET = 'GOCSPX-abc123...';
```

The client secret must only live on your backend server. SPAs use PKCE
instead of a client secret.

---

## Building a Reusable OAuth Client

```typescript
interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

class OAuthClient {
  constructor(private config: OAuthConfig) {}

  getAuthorizationUrl(state: string, pkceChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: pkceChallenge,
      code_challenge_method: 'S256',
    });

    return `${this.config.authorizationUrl}?${params}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string
  ): Promise<{ accessToken: string; idToken?: string; refreshToken?: string }> {
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = await response.json() as Record<string, string>;
    return {
      accessToken: data.access_token,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
    };
  }

  async getUserInfo(
    accessToken: string
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`UserInfo request failed: ${response.status}`);
    }

    return response.json();
  }
}

// ---- Preconfigured clients ----

const googleOAuth = new OAuthClient({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: 'http://localhost:3000/auth/google/callback',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scopes: ['openid', 'email', 'profile'],
});

const githubOAuth = new OAuthClient({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  redirectUri: 'http://localhost:3000/auth/github/callback',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userInfoUrl: 'https://api.github.com/user',
  scopes: ['read:user', 'user:email'],
});
```

---

## Exercises

### Exercise 1: PKCE Implementation

Implement a complete PKCE flow:
1. Generate `code_verifier` and `code_challenge`
2. Build the authorization URL with the challenge
3. On callback, build the token request with the verifier
4. Verify that `SHA256(verifier) === challenge`

Write unit tests that verify:
- Different verifiers produce different challenges
- The challenge is deterministic for a given verifier
- The verifier meets the spec requirements (43-128 URL-safe characters)

### Exercise 2: Mock OAuth Server

Build a mock OAuth authorization server that implements:
- `GET /authorize` — returns an authorization code (after "consent")
- `POST /token` — exchanges code for tokens (validates PKCE)
- `GET /userinfo` — returns mock user data given a valid access token

Use this mock server to test your OAuth client without needing real Google
credentials. This is invaluable for development and CI/CD.

### Exercise 3: Multi-Provider Login

Extend the `OAuthClient` class to support both Google and GitHub login.
Users who log in with different providers but the same email address should
be linked to the same account. Handle edge cases:
- User signs up with Google, later tries to log in with GitHub
- User has different emails on Google and GitHub
- Provider doesn't return a verified email

### Exercise 4: State Parameter Security

Demonstrate why the state parameter matters:
1. Build a simple OAuth callback handler WITHOUT state verification
2. Show how an attacker could exploit this (describe the CSRF attack)
3. Add state verification and show the attack fails
4. Compare storing state in: server-side session, signed cookie,
   encrypted state parameter

### Exercise 5: Token Refresh

When a user logs in via OAuth, you often receive a `refresh_token` from
the provider. Implement a system that:
1. Stores the provider's refresh token securely (encrypted)
2. When the provider's access token expires, uses the refresh token
   to get a new one
3. If the refresh fails, marks the user as needing to re-authenticate
4. Provides an API for other parts of your app to get a valid access
   token for calling the provider's APIs

---

## Summary

| Concept | Purpose |
|---------|---------|
| OAuth 2.0 | Delegated authorization (what can an app do?) |
| OpenID Connect | Authentication on top of OAuth (who is this user?) |
| Authorization Code | Server-side exchange of code for tokens |
| PKCE | Protects public clients from code interception |
| Client Credentials | Machine-to-machine authentication |
| ID Token | JWT with user identity (OIDC) |
| Access Token | Token for calling provider APIs (OAuth) |
| State parameter | CSRF protection for OAuth flows |

Next lesson: once we know WHO the user is, we need to control WHAT they
can do. That's authorization — roles, permissions, and access control.
