# Project: AuthForge — Multi-Tenant Auth Service

## Overview

Build a complete authentication and authorization service from scratch. This
project ties together everything from Module 2: password hashing, JWTs,
OAuth, RBAC, API keys, and multi-tenancy.

AuthForge is a REST API that provides:
- User registration and login with argon2 password hashing
- JWT access tokens + refresh token rotation
- Google OAuth2 login (Authorization Code + PKCE)
- Multi-tenant organizations with role-based access control
- API key management for machine-to-machine access
- Rate limiting on auth endpoints

All data is stored in-memory (no database required). The focus is on auth
logic, not persistence.

---

## Getting Started

```bash
cd starter
npm install
npm run dev
```

The server starts on `http://localhost:3000`.

---

## API Endpoints

### Authentication

#### POST /auth/register

Register a new user with email and password.

**Request:**
```json
{
  "email": "alice@example.com",
  "password": "my-secure-password-123",
  "name": "Alice Smith"
}
```

**Response (201):**
```json
{
  "user": {
    "id": "usr_a1b2c3d4",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "createdAt": "2025-01-15T10:30:00.000Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "Set as HttpOnly cookie"
}
```

**Errors:**
- `400` — Invalid email, weak password, or email already registered
- `429` — Rate limited

---

#### POST /auth/login

Log in with email and password.

**Request:**
```json
{
  "email": "alice@example.com",
  "password": "my-secure-password-123"
}
```

**Response (200):**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "Set as HttpOnly cookie"
}
```

**Errors:**
- `401` — Invalid credentials
- `429` — Rate limited

---

#### POST /auth/refresh

Refresh the access token using the refresh token cookie.

**Request:** No body. The refresh token is read from the `refreshToken` cookie.

**Response (200):**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**
- `401` — Missing, invalid, or expired refresh token

---

#### POST /auth/logout

Log out and invalidate the refresh token.

**Request:** No body. Requires `Authorization: Bearer <accessToken>` header.

**Response (200):**
```json
{
  "message": "Logged out successfully"
}
```

---

#### GET /auth/google

Redirect to Google OAuth consent screen. Initiates the Authorization Code
flow with PKCE.

**Response:** 302 redirect to Google.

---

#### GET /auth/google/callback

Handle the OAuth callback from Google. Exchanges the authorization code for
tokens, finds or creates a user, and returns JWT tokens.

**Query Parameters:**
- `code` — Authorization code from Google
- `state` — CSRF token for verification

**Response:** 302 redirect to frontend with access token, or JSON response
with tokens.

---

### Organizations

All org endpoints require `Authorization: Bearer <accessToken>`.

#### POST /orgs

Create a new organization. The creator becomes the owner.

**Request:**
```json
{
  "name": "Acme Corp",
  "slug": "acme-corp"
}
```

**Response (201):**
```json
{
  "org": {
    "id": "org_x1y2z3",
    "name": "Acme Corp",
    "slug": "acme-corp",
    "createdAt": "2025-01-15T10:30:00.000Z"
  },
  "membership": {
    "userId": "usr_a1b2c3d4",
    "orgId": "org_x1y2z3",
    "role": "owner"
  }
}
```

---

#### GET /orgs

List all organizations the authenticated user belongs to.

**Response (200):**
```json
{
  "organizations": [
    {
      "id": "org_x1y2z3",
      "name": "Acme Corp",
      "slug": "acme-corp",
      "role": "owner"
    }
  ]
}
```

---

#### GET /orgs/:orgId

Get organization details. Requires membership.

**Response (200):**
```json
{
  "org": {
    "id": "org_x1y2z3",
    "name": "Acme Corp",
    "slug": "acme-corp",
    "createdAt": "2025-01-15T10:30:00.000Z"
  },
  "members": [
    {
      "userId": "usr_a1b2c3d4",
      "name": "Alice Smith",
      "email": "alice@example.com",
      "role": "owner"
    }
  ]
}
```

---

#### POST /orgs/:orgId/invite

Invite a user to the organization. Requires `admin` or `owner` role.

**Request:**
```json
{
  "email": "bob@example.com",
  "role": "member"
}
```

**Response (201):**
```json
{
  "invitation": {
    "id": "inv_m1n2o3",
    "email": "bob@example.com",
    "role": "member",
    "orgId": "org_x1y2z3",
    "expiresAt": "2025-01-22T10:30:00.000Z"
  }
}
```

---

#### POST /orgs/invitations/:token/accept

Accept an organization invitation. Requires authentication.

**Response (200):**
```json
{
  "membership": {
    "userId": "usr_b2c3d4e5",
    "orgId": "org_x1y2z3",
    "role": "member"
  }
}
```

---

#### PUT /orgs/:orgId/members/:userId/role

Change a member's role. Requires `owner` role. Cannot change own role.
Cannot set a role higher than your own.

**Request:**
```json
{
  "role": "admin"
}
```

**Response (200):**
```json
{
  "membership": {
    "userId": "usr_b2c3d4e5",
    "orgId": "org_x1y2z3",
    "role": "admin"
  }
}
```

---

#### DELETE /orgs/:orgId/members/:userId

Remove a member from the organization. Requires `admin` or `owner` role.
Cannot remove the owner. Cannot remove yourself (use leave instead).

**Response (200):**
```json
{
  "message": "Member removed"
}
```

---

### API Keys

All API key endpoints require org membership and appropriate permissions.

#### POST /orgs/:orgId/api-keys

Create a new API key. Requires `admin` or `owner` role.

**Request:**
```json
{
  "name": "CI/CD Pipeline",
  "permissions": ["posts:read", "posts:create"]
}
```

**Response (201):**
```json
{
  "apiKey": {
    "id": "key_p1q2r3",
    "name": "CI/CD Pipeline",
    "prefix": "sk_a1b2c3d4",
    "permissions": ["posts:read", "posts:create"],
    "createdAt": "2025-01-15T10:30:00.000Z"
  },
  "rawKey": "sk_a1b2c3d4e5f6g7h8i9j0..."
}
```

**Important:** The `rawKey` is only returned once. Store it securely.

---

#### GET /orgs/:orgId/api-keys

List API keys for the organization. Requires `admin` or `owner` role.

**Response (200):**
```json
{
  "apiKeys": [
    {
      "id": "key_p1q2r3",
      "name": "CI/CD Pipeline",
      "prefix": "sk_a1b2c3d4",
      "permissions": ["posts:read", "posts:create"],
      "createdBy": "usr_a1b2c3d4",
      "createdAt": "2025-01-15T10:30:00.000Z",
      "lastUsedAt": null
    }
  ]
}
```

---

#### DELETE /orgs/:orgId/api-keys/:keyId

Revoke an API key. Requires `admin` or `owner` role.

**Response (200):**
```json
{
  "message": "API key revoked"
}
```

---

### Protected Resource (Example)

#### GET /orgs/:orgId/data

Example protected endpoint. Accepts both JWT auth and API key auth.

**With JWT:**
```
Authorization: Bearer eyJhbGciOi...
```

**With API Key:**
```
X-API-Key: sk_a1b2c3d4e5f6g7h8...
```

**Response (200):**
```json
{
  "message": "Authenticated!",
  "authMethod": "jwt",
  "userId": "usr_a1b2c3d4",
  "orgId": "org_x1y2z3"
}
```

---

## Implementation Checklist

- [ ] User registration with argon2 password hashing
- [ ] Password validation (min length, breach check optional)
- [ ] Login with email/password
- [ ] JWT access token creation and verification
- [ ] Refresh token creation, storage, and rotation
- [ ] Refresh endpoint with token rotation
- [ ] Logout (revoke refresh token)
- [ ] Google OAuth2 flow (Authorization Code + PKCE)
- [ ] Organization CRUD
- [ ] Org invitation flow
- [ ] Org-scoped RBAC (owner, admin, member, viewer)
- [ ] Role management with escalation prevention
- [ ] API key generation with hashed storage
- [ ] API key authentication middleware
- [ ] API key revocation
- [ ] Rate limiting on auth endpoints
- [ ] Proper error responses (401 vs 403 vs 404)
- [ ] Timing-safe comparisons where needed

---

## Architecture Notes

```
src/
  index.ts            — App setup, middleware, route mounting
  types.ts            — All TypeScript interfaces and types
  storage.ts          — In-memory data store
  routes/
    auth.ts           — Register, login, refresh, logout, OAuth
    orgs.ts           — Organization CRUD, invitations, member management
    apiKeys.ts        — API key CRUD
  middleware/
    authenticate.ts   — JWT verification middleware
    authorize.ts      — RBAC permission checking middleware
  services/
    auth.ts           — Password hashing, credential verification
    token.ts          — JWT creation/verification, refresh token management
```

The `storage.ts` module provides a simple in-memory store. In a real
application, you'd replace this with a database. The interface is designed
to make that migration straightforward.
