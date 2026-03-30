// ============================================================
// Token Service — JWT and refresh token management
// ============================================================

import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AccessTokenPayload, RefreshToken } from '../types';
import {
  saveRefreshToken,
  findRefreshToken,
  deleteRefreshToken,
  deleteRefreshTokenFamily,
  deleteUserRefreshTokens,
} from '../storage';

// ---- Configuration ----

const ACCESS_TOKEN_SECRET =
  process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars!!';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- Access Tokens (JWT) ----

export function createAccessToken(user: {
  id: string;
  email: string;
  name: string;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
    },
    ACCESS_TOKEN_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRY,
      algorithm: 'HS256',
    }
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_TOKEN_SECRET, {
    algorithms: ['HS256'],
  }) as AccessTokenPayload;
}

// ---- Refresh Tokens ----

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function createRefreshToken(
  userId: string,
  family?: string
): string {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  const refreshToken: RefreshToken = {
    tokenHash,
    userId,
    family: family ?? randomBytes(16).toString('hex'),
    expiresAt: Date.now() + REFRESH_TOKEN_EXPIRY_MS,
    used: false,
  };

  saveRefreshToken(refreshToken);

  return rawToken;
}

export function rotateRefreshToken(rawToken: string): {
  newRawToken: string;
  userId: string;
} | null {
  const tokenHash = hashToken(rawToken);
  const stored = findRefreshToken(tokenHash);

  if (!stored) {
    return null;
  }

  // Check expiry
  if (Date.now() > stored.expiresAt) {
    deleteRefreshToken(tokenHash);
    return null;
  }

  // Check for reuse (possible theft)
  if (stored.used) {
    console.warn(
      `[SECURITY] Refresh token reuse detected for user ${stored.userId}, family ${stored.family}. ` +
      `Invalidating entire token family.`
    );
    deleteRefreshTokenFamily(stored.family);
    return null;
  }

  // Mark as used
  stored.used = true;

  // Create new token in the same family
  const newRawToken = createRefreshToken(stored.userId, stored.family);

  return { newRawToken, userId: stored.userId };
}

export function revokeRefreshToken(rawToken: string): void {
  const tokenHash = hashToken(rawToken);
  deleteRefreshToken(tokenHash);
}

export function revokeAllUserTokens(userId: string): void {
  deleteUserRefreshTokens(userId);
}
