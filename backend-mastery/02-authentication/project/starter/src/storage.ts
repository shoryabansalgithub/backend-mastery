// ============================================================
// In-Memory Storage
//
// In a real application, you'd replace this with a database.
// The interface is designed to make that migration simple:
// each method corresponds to a query you'd write.
// ============================================================

import {
  User,
  Organization,
  OrgMembership,
  OrgInvitation,
  RefreshToken,
  ApiKey,
} from './types';

// ---- Data stores ----

const users = new Map<string, User>();
const usersByEmail = new Map<string, User>();
const usersByGoogleId = new Map<string, User>();

const organizations = new Map<string, Organization>();
const orgsBySlug = new Map<string, Organization>();

const memberships: OrgMembership[] = [];
const invitations = new Map<string, OrgInvitation>();

const refreshTokens = new Map<string, RefreshToken>();

const apiKeys = new Map<string, ApiKey>();
const apiKeysByHash = new Map<string, ApiKey>();

// ---- Users ----

export function saveUser(user: User): void {
  users.set(user.id, user);
  usersByEmail.set(user.email.toLowerCase(), user);
  if (user.googleId) {
    usersByGoogleId.set(user.googleId, user);
  }
}

export function findUserById(id: string): User | undefined {
  return users.get(id);
}

export function findUserByEmail(email: string): User | undefined {
  return usersByEmail.get(email.toLowerCase());
}

export function findUserByGoogleId(googleId: string): User | undefined {
  return usersByGoogleId.get(googleId);
}

export function updateUser(id: string, updates: Partial<User>): User | undefined {
  const user = users.get(id);
  if (!user) return undefined;
  const updated = { ...user, ...updates, updatedAt: new Date().toISOString() };
  users.set(id, updated);
  usersByEmail.set(updated.email.toLowerCase(), updated);
  if (updated.googleId) {
    usersByGoogleId.set(updated.googleId, updated);
  }
  return updated;
}

// ---- Organizations ----

export function saveOrganization(org: Organization): void {
  organizations.set(org.id, org);
  orgsBySlug.set(org.slug, org);
}

export function findOrgById(id: string): Organization | undefined {
  return organizations.get(id);
}

export function findOrgBySlug(slug: string): Organization | undefined {
  return orgsBySlug.get(slug);
}

// ---- Memberships ----

export function saveMembership(membership: OrgMembership): void {
  memberships.push(membership);
}

export function findMembership(
  userId: string,
  orgId: string
): OrgMembership | undefined {
  return memberships.find((m) => m.userId === userId && m.orgId === orgId);
}

export function findUserMemberships(userId: string): OrgMembership[] {
  return memberships.filter((m) => m.userId === userId);
}

export function findOrgMembers(orgId: string): OrgMembership[] {
  return memberships.filter((m) => m.orgId === orgId);
}

export function updateMembershipRole(
  userId: string,
  orgId: string,
  role: OrgMembership['role']
): OrgMembership | undefined {
  const membership = memberships.find(
    (m) => m.userId === userId && m.orgId === orgId
  );
  if (!membership) return undefined;
  membership.role = role;
  return membership;
}

export function removeMembership(userId: string, orgId: string): boolean {
  const index = memberships.findIndex(
    (m) => m.userId === userId && m.orgId === orgId
  );
  if (index === -1) return false;
  memberships.splice(index, 1);
  return true;
}

// ---- Invitations ----

export function saveInvitation(invitation: OrgInvitation): void {
  invitations.set(invitation.id, invitation);
}

export function findInvitationByToken(tokenHash: string): OrgInvitation | undefined {
  for (const inv of invitations.values()) {
    if (inv.token === tokenHash) return inv;
  }
  return undefined;
}

export function findOrgInvitations(orgId: string): OrgInvitation[] {
  return Array.from(invitations.values()).filter((i) => i.orgId === orgId);
}

// ---- Refresh Tokens ----

export function saveRefreshToken(token: RefreshToken): void {
  refreshTokens.set(token.tokenHash, token);
}

export function findRefreshToken(tokenHash: string): RefreshToken | undefined {
  return refreshTokens.get(tokenHash);
}

export function deleteRefreshToken(tokenHash: string): void {
  refreshTokens.delete(tokenHash);
}

export function deleteRefreshTokenFamily(family: string): void {
  for (const [hash, token] of refreshTokens) {
    if (token.family === family) {
      refreshTokens.delete(hash);
    }
  }
}

export function deleteUserRefreshTokens(userId: string): void {
  for (const [hash, token] of refreshTokens) {
    if (token.userId === userId) {
      refreshTokens.delete(hash);
    }
  }
}

// ---- API Keys ----

export function saveApiKey(key: ApiKey): void {
  apiKeys.set(key.id, key);
  apiKeysByHash.set(key.hashedKey, key);
}

export function findApiKeyById(id: string): ApiKey | undefined {
  return apiKeys.get(id);
}

export function findApiKeyByHash(hash: string): ApiKey | undefined {
  return apiKeysByHash.get(hash);
}

export function findOrgApiKeys(orgId: string): ApiKey[] {
  return Array.from(apiKeys.values()).filter(
    (k) => k.orgId === orgId && !k.revokedAt
  );
}

export function revokeApiKey(id: string): ApiKey | undefined {
  const key = apiKeys.get(id);
  if (!key) return undefined;
  key.revokedAt = new Date().toISOString();
  return key;
}

export function updateApiKeyLastUsed(hash: string): void {
  const key = apiKeysByHash.get(hash);
  if (key) {
    key.lastUsedAt = new Date().toISOString();
  }
}
