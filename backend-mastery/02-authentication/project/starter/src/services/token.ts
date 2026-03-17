// ============================================================
// Token Service — JWT and refresh token management
// ============================================================

import { AccessTokenPayload, RefreshToken } from '../types';

// TODO: Import crypto, jsonwebtoken, and storage functions

// ---- Configuration ----

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars!!';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- Access Tokens (JWT) ----

export function createAccessToken(user: {
  id: string;
  email: string;
  name: string;
}): string {
  // TODO: Create a JWT with:
  //   sub: user.id
  //   email: user.email
  //   name: user.name
  //   expiresIn: ACCESS_TOKEN_EXPIRY
  //   algorithm: 'HS256'
  throw new Error('Not implemented');
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // TODO: Verify and decode the JWT
  // - Use the ACCESS_TOKEN_SECRET
  // - Restrict to algorithms: ['HS256']
  // - Return the decoded payload
  // - Let errors propagate (TokenExpiredError, JsonWebTokenError)
  throw new Error('Not implemented');
}

// ---- Refresh Tokens ----

export function createRefreshToken(
  userId: string,
  family?: string
): string {
  // TODO: Create a refresh token
  // 1. Generate 32 random bytes as hex (this is the raw token)
  // 2. Hash the raw token with SHA-256 (store the hash, not the raw token)
  // 3. Create a RefreshToken object:
  //    - tokenHash: the hash
  //    - userId
  //    - family: provided family or generate new random one
  //    - expiresAt: now + REFRESH_TOKEN_EXPIRY_MS
  //    - used: false
  // 4. Save to storage
  // 5. Return the RAW token (NOT the hash)
  throw new Error('Not implemented');
}

export function rotateRefreshToken(rawToken: string): {
  newRawToken: string;
  userId: string;
} | null {
  // TODO: Implement refresh token rotation
  // 1. Hash the raw token to find it in storage
  // 2. If not found, return null
  // 3. If expired, delete it and return null
  // 4. If already used (token reuse!):
  //    - This indicates possible theft
  //    - Delete the ENTIRE family of tokens
  //    - Log a warning
  //    - Return null
  // 5. Mark the old token as used
  // 6. Create a new refresh token in the same family
  // 7. Return { newRawToken, userId }
  throw new Error('Not implemented');
}

export function revokeRefreshToken(rawToken: string): void {
  // TODO: Delete the refresh token from storage
  // Hash the raw token, then delete by hash
  throw new Error('Not implemented');
}

export function revokeAllUserTokens(userId: string): void {
  // TODO: Delete all refresh tokens for a user
  throw new Error('Not implemented');
}
