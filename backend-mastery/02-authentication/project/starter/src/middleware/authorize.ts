// ============================================================
// Authorization Middleware
//
// RBAC permission checking for org-scoped resources.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { Permission, OrgRole, ROLE_PERMISSIONS, ORG_ROLE_HIERARCHY } from '../types';

// TODO: Import findMembership from storage

/**
 * Check if a role has a specific permission.
 */
export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  // TODO: Implement permission check
  // Look up the role in ROLE_PERMISSIONS and check if the permission is included
  throw new Error('Not implemented');
}

/**
 * Middleware factory: requires the authenticated user to have a specific
 * permission within the organization specified by req.params.orgId.
 *
 * Must be used AFTER the authenticate middleware.
 */
export function requireOrgPermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // TODO: Implement org-scoped permission check
    //
    // 1. Get the user from req.user (set by authenticate middleware)
    //    - If no user, check req.apiKeyAuth for API key auth
    //    - For API keys, check if the permission is in apiKey.permissions
    //
    // 2. Get the orgId from req.params.orgId
    //    - If no orgId, return 400 { error: 'Organization ID required' }
    //
    // 3. For JWT auth: look up the user's membership in this org
    //    - If no membership, return 404 { error: 'Organization not found' }
    //      (Use 404, not 403, to avoid leaking org existence)
    //    - Check if their role has the required permission
    //    - If not, return 403 { error: 'Insufficient permissions' }
    //
    // 4. For API key auth: check if the key has the required permission
    //    - Also verify the API key belongs to this org
    //
    // 5. Call next()
    res.status(501).json({ error: 'requireOrgPermission not implemented' });
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
  // TODO: Implement membership check
  // Similar to requireOrgPermission but just checks membership exists
  res.status(501).json({ error: 'requireOrgMembership not implemented' });
}
