// ============================================================
// Authentication Middleware
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AuthenticatedUser, ApiKeyAuth } from '../types';
import { verifyAccessToken } from '../services/token';
import { findApiKeyByHash, updateApiKeyLastUsed } from '../storage';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      apiKeyAuth?: ApiKeyAuth;
    }
  }
}

/**
 * Middleware that requires JWT authentication.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Invalid authorization format. Use: Bearer <token>',
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);

    req.user = {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
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

/**
 * Middleware that accepts either JWT auth OR API key auth.
 */
export function authenticateAny(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Try JWT first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  // Try API key
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  if (apiKeyHeader) {
    const hash = createHash('sha256').update(apiKeyHeader).digest('hex');
    const apiKey = findApiKeyByHash(hash);

    if (!apiKey) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    if (apiKey.revokedAt) {
      res.status(401).json({ error: 'API key has been revoked' });
      return;
    }

    updateApiKeyLastUsed(hash);

    req.apiKeyAuth = {
      apiKey,
      orgId: apiKey.orgId,
    };

    next();
    return;
  }

  res.status(401).json({
    error: 'Authentication required. Provide a Bearer token or X-API-Key header.',
  });
}
