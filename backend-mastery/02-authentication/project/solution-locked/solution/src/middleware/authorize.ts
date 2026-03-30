// ============================================================
// Authorization Middleware
// ============================================================

import { Request, Response, NextFunction } from 'express';
import {
  Permission,
  OrgRole,
  ROLE_PERMISSIONS,
  ORG_ROLE_HIERARCHY,
} from '../types';
import { findMembership } from '../storage';

/**
 * Check if a role has a specific permission.
 */
export function roleHasPermission(
  role: OrgRole,
  permission: Permission
): boolean {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.includes(permission);
}

/**
 * Middleware factory: requires the authenticated user to have a specific
 * permission within the organization specified by req.params.orgId.
 */
export function requireOrgPermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const orgId = req.params.orgId;

    if (!orgId) {
      res.status(400).json({ error: 'Organization ID required' });
      return;
    }

    // Handle API key auth
    if (req.apiKeyAuth) {
      if (req.apiKeyAuth.orgId !== orgId) {
        // API key belongs to a different org — return 404 to avoid leaking info
        res.status(404).json({ error: 'Organization not found' });
        return;
      }

      if (!req.apiKeyAuth.apiKey.permissions.includes(permission)) {
        res.status(403).json({
          error: 'API key does not have the required permission',
          required: permission,
        });
        return;
      }

      next();
      return;
    }

    // Handle JWT auth
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const membership = findMembership(req.user.userId, orgId);

    if (!membership) {
      // Use 404 instead of 403 to avoid leaking org existence
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    if (!roleHasPermission(membership.role, permission)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: permission,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware: requires the user to be a member of the org (any role).
 */
export function requireOrgMembership(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.params.orgId;

  if (!orgId) {
    res.status(400).json({ error: 'Organization ID required' });
    return;
  }

  // API key auth — check org match
  if (req.apiKeyAuth) {
    if (req.apiKeyAuth.orgId !== orgId) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    next();
    return;
  }

  // JWT auth
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const membership = findMembership(req.user.userId, orgId);

  if (!membership) {
    res.status(404).json({ error: 'Organization not found' });
    return;
  }

  next();
}
