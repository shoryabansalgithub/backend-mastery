// ============================================================
// Authentication Middleware
//
// Verifies JWT access tokens and API keys.
// Attaches user info to the request object.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedUser, ApiKeyAuth } from '../types';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      apiKeyAuth?: ApiKeyAuth;
    }
  }
}

// TODO: Import verifyAccessToken from services/token
// TODO: Import findApiKeyByHash, updateApiKeyLastUsed from storage

/**
 * Middleware that requires JWT authentication.
 * Extracts the token from the Authorization header (Bearer scheme).
 * On success, sets req.user with { userId, email, name }.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // TODO: Implement JWT authentication
  // 1. Get the Authorization header
  // 2. Check it starts with 'Bearer '
  // 3. Extract the token
  // 4. Verify the token using verifyAccessToken()
  // 5. Set req.user = { userId: payload.sub, email: payload.email, name: payload.name }
  // 6. Call next()
  //
  // Error handling:
  // - Missing header: 401 { error: 'Authorization header required' }
  // - Invalid format: 401 { error: 'Invalid authorization format. Use: Bearer <token>' }
  // - Expired token: 401 { error: 'Token expired' }
  // - Invalid token: 401 { error: 'Invalid token' }
  res.status(501).json({ error: 'authenticate middleware not implemented' });
}

/**
 * Middleware that accepts either JWT auth OR API key auth.
 * Checks Authorization header first, then X-API-Key header.
 */
export function authenticateAny(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // TODO: Implement flexible authentication
  // 1. If Authorization header exists, try JWT auth
  // 2. If X-API-Key header exists, try API key auth:
  //    a. Hash the key with SHA-256
  //    b. Look up in storage
  //    c. Check it's not revoked
  //    d. Update lastUsedAt
  //    e. Set req.apiKeyAuth = { apiKey, orgId: apiKey.orgId }
  // 3. If neither header exists, return 401
  res.status(501).json({ error: 'authenticateAny middleware not implemented' });
}
