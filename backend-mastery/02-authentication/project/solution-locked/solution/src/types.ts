// ============================================================
// AuthForge Type Definitions
// ============================================================

// ---- Users ----

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash?: string;    // undefined for OAuth-only users
  googleId?: string;        // set if user logged in via Google
  createdAt: string;        // ISO 8601
  updatedAt: string;
}

// ---- Organizations ----

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdBy: string;        // userId of creator
  createdAt: string;
  updatedAt: string;
}

// ---- Roles & Permissions ----

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const ORG_ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
};

export type Permission =
  | 'org:manage'
  | 'org:invite'
  | 'org:remove_member'
  | 'members:read'
  | 'members:manage_roles'
  | 'apikeys:create'
  | 'apikeys:read'
  | 'apikeys:revoke'
  | 'data:read'
  | 'data:write'
  | 'data:delete';

export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: [
    'org:manage', 'org:invite', 'org:remove_member',
    'members:read', 'members:manage_roles',
    'apikeys:create', 'apikeys:read', 'apikeys:revoke',
    'data:read', 'data:write', 'data:delete',
  ],
  admin: [
    'org:invite', 'org:remove_member',
    'members:read',
    'apikeys:create', 'apikeys:read', 'apikeys:revoke',
    'data:read', 'data:write', 'data:delete',
  ],
  member: [
    'members:read',
    'data:read', 'data:write',
  ],
  viewer: [
    'members:read',
    'data:read',
  ],
};

// ---- Org Membership ----

export interface OrgMembership {
  userId: string;
  orgId: string;
  role: OrgRole;
  joinedAt: string;
}

// ---- Invitations ----

export interface OrgInvitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  token: string;            // hashed token stored; raw token sent to user
  expiresAt: string;
  acceptedAt?: string;
}

// ---- Tokens ----

export interface RefreshToken {
  tokenHash: string;
  userId: string;
  family: string;           // for rotation detection
  expiresAt: number;        // unix ms
  used: boolean;
}

export interface AccessTokenPayload {
  sub: string;              // userId
  email: string;
  name: string;
  iat: number;
  exp: number;
}

// ---- API Keys ----

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;           // first 8 chars for identification
  hashedKey: string;         // SHA-256 of the full key
  orgId: string;
  permissions: Permission[];
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

// ---- Request extensions ----

export interface AuthenticatedUser {
  userId: string;
  email: string;
  name: string;
}

export interface ApiKeyAuth {
  apiKey: ApiKey;
  orgId: string;
}
