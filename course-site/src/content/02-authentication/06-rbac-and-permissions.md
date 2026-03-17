# Lesson 6: RBAC and Permissions

## Authentication vs Authorization

These two words look similar but solve completely different problems:

**Authentication** (AuthN): "Who are you?"
- Verifying identity
- Login, passwords, tokens, OAuth

**Authorization** (AuthZ): "What can you do?"
- Verifying permissions
- Can this user delete this post? Can they access this organization?

You can be authenticated (proven your identity) but not authorized
(not allowed to do a specific thing). A junior employee at a bank is
authenticated when they badge into the building, but they're not
authorized to open the vault.

This lesson is entirely about the second problem.

---

## The Simplest Authorization: Boolean

```typescript
// The most primitive authorization
function canAccess(user: User): boolean {
  return user.isAdmin;
}
```

This breaks down immediately:
- What if you need admins, moderators, and regular users?
- What if admins can manage users but not billing?
- What if a user is an admin in one organization but not another?

We need a structured approach.

---

## Role-Based Access Control (RBAC)

### The Concept

Instead of giving permissions directly to users, you:
1. Define **roles** (admin, editor, viewer)
2. Assign **permissions** to roles (admin can delete, editor can write)
3. Assign **roles** to users (Alice is an admin)

```
User ──has──> Role ──has──> Permission

Alice ──has──> admin ──has──> create, read, update, delete
Bob   ──has──> editor ──has──> create, read, update
Carol ──has──> viewer ──has──> read
```

### Why Roles (Not Direct Permissions)?

**Without roles** — if you have 1000 users and 50 permissions:
- You maintain 1000 x 50 = 50,000 user-permission relationships
- Adding a new permission means updating potentially all 1000 users

**With roles** — if you have 5 roles:
- You maintain 5 x 50 = 250 role-permission relationships
- You maintain 1000 user-role assignments
- Adding a new permission means updating at most 5 roles

Roles are an abstraction layer that makes permission management tractable.

### Defining Roles and Permissions in TypeScript

```typescript
// ---- Permissions ----
// Use a resource:action naming convention

const PERMISSIONS = {
  // User management
  'users:create': 'Create new users',
  'users:read': 'View user profiles',
  'users:update': 'Edit user profiles',
  'users:delete': 'Delete users',

  // Content management
  'posts:create': 'Create posts',
  'posts:read': 'Read posts',
  'posts:update': 'Edit posts',
  'posts:delete': 'Delete posts',

  // Billing
  'billing:read': 'View billing info',
  'billing:manage': 'Manage billing and subscriptions',

  // Organization
  'org:manage': 'Manage organization settings',
  'org:invite': 'Invite members to organization',
} as const;

type Permission = keyof typeof PERMISSIONS;

// ---- Roles ----

interface RoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
}

const ROLES: Record<string, RoleDefinition> = {
  owner: {
    name: 'Owner',
    description: 'Full access to everything',
    permissions: [
      'users:create', 'users:read', 'users:update', 'users:delete',
      'posts:create', 'posts:read', 'posts:update', 'posts:delete',
      'billing:read', 'billing:manage',
      'org:manage', 'org:invite',
    ],
  },
  admin: {
    name: 'Admin',
    description: 'Manage users and content, no billing',
    permissions: [
      'users:create', 'users:read', 'users:update', 'users:delete',
      'posts:create', 'posts:read', 'posts:update', 'posts:delete',
      'org:invite',
    ],
  },
  editor: {
    name: 'Editor',
    description: 'Create and edit content',
    permissions: [
      'posts:create', 'posts:read', 'posts:update',
      'users:read',
    ],
  },
  viewer: {
    name: 'Viewer',
    description: 'Read-only access',
    permissions: [
      'posts:read',
      'users:read',
    ],
  },
};
```

### Permission Checking

```typescript
function hasPermission(userRole: string, permission: Permission): boolean {
  const role = ROLES[userRole];
  if (!role) return false;
  return role.permissions.includes(permission);
}

// Usage
console.log(hasPermission('admin', 'posts:delete'));    // true
console.log(hasPermission('viewer', 'posts:delete'));   // false
console.log(hasPermission('editor', 'billing:manage')); // false
```

---

## Role Hierarchies

Sometimes roles form a natural hierarchy: an owner can do everything an
admin can, an admin can do everything an editor can, etc.

### Flat Roles (Explicit)

Each role lists all its permissions explicitly. This is what we did above.
It's simple and clear but has duplication.

### Hierarchical Roles (Inheritance)

```typescript
interface HierarchicalRole {
  name: string;
  inherits?: string;       // Parent role
  permissions: Permission[]; // Additional permissions beyond inherited
}

const HIERARCHICAL_ROLES: Record<string, HierarchicalRole> = {
  viewer: {
    name: 'Viewer',
    permissions: ['posts:read', 'users:read'],
  },
  editor: {
    name: 'Editor',
    inherits: 'viewer',
    permissions: ['posts:create', 'posts:update'],
  },
  admin: {
    name: 'Admin',
    inherits: 'editor',
    permissions: [
      'users:create', 'users:update', 'users:delete',
      'posts:delete', 'org:invite',
    ],
  },
  owner: {
    name: 'Owner',
    inherits: 'admin',
    permissions: ['billing:read', 'billing:manage', 'org:manage'],
  },
};

function getEffectivePermissions(roleName: string): Set<Permission> {
  const role = HIERARCHICAL_ROLES[roleName];
  if (!role) return new Set();

  const permissions = new Set<Permission>(role.permissions);

  if (role.inherits) {
    const inherited = getEffectivePermissions(role.inherits);
    for (const perm of inherited) {
      permissions.add(perm);
    }
  }

  return permissions;
}

// Usage
const adminPerms = getEffectivePermissions('admin');
console.log(adminPerms);
// Set { 'users:create', 'users:update', 'users:delete', 'posts:delete',
//        'org:invite', 'posts:create', 'posts:update', 'posts:read',
//        'users:read' }
```

**Trade-off:** Hierarchical roles are DRY but harder to reason about.
When debugging "why does this user have this permission?" you need to
walk the hierarchy. For most applications, flat explicit roles are
preferable.

---

## Middleware-Based Auth Guards

### The Pattern

```typescript
import { Request, Response, NextFunction } from 'express';

// Middleware factory: takes a required permission, returns middleware
function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!hasPermission(user.role, permission)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: permission,
      });
    }

    next();
  };
}

// Usage on routes
app.get('/api/posts', requirePermission('posts:read'), getPosts);
app.post('/api/posts', requirePermission('posts:create'), createPost);
app.put('/api/posts/:id', requirePermission('posts:update'), updatePost);
app.delete('/api/posts/:id', requirePermission('posts:delete'), deletePost);

app.get('/api/users', requirePermission('users:read'), getUsers);
app.delete('/api/users/:id', requirePermission('users:delete'), deleteUser);
```

### Multiple Permissions

Sometimes an action requires multiple permissions:

```typescript
function requireAllPermissions(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const missing = permissions.filter(
      (p) => !hasPermission(user.role, p)
    );

    if (missing.length > 0) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        missing,
      });
    }

    next();
  };
}

function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hasAny = permissions.some((p) => hasPermission(user.role, p));

    if (!hasAny) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: `one of: ${permissions.join(', ')}`,
      });
    }

    next();
  };
}
```

---

## Resource-Level Permissions

So far, our permissions are global: "can this user delete ANY post?"
But often you need resource-level checks: "can this user delete THIS
specific post?"

### The Problem

```typescript
// Global permission: can this user delete posts?
app.delete('/api/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  // But should a user be able to delete SOMEONE ELSE'S post?
  // An editor should be able to delete their own posts
  // but not other editors' posts.
});
```

### Ownership-Based Access

```typescript
interface Post {
  id: string;
  authorId: string;
  title: string;
  content: string;
}

async function canModifyPost(
  userId: string,
  userRole: string,
  postId: string
): Promise<boolean> {
  // Admins and owners can modify any post
  if (hasPermission(userRole, 'posts:delete')) {
    return true;
  }

  // Other users can only modify their own posts
  const post = await getPostById(postId);
  if (!post) return false;

  return post.authorId === userId;
}

// Middleware for resource-level checks
function requirePostOwnership(action: 'update' | 'delete') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    const postId = req.params.id;

    const allowed = await canModifyPost(user.userId, user.role, postId);
    if (!allowed) {
      return res.status(403).json({
        error: `You don't have permission to ${action} this post`,
      });
    }

    next();
  };
}

app.put('/api/posts/:id', requirePostOwnership('update'), updatePost);
app.delete('/api/posts/:id', requirePostOwnership('delete'), deletePost);
```

### Policy-Based Approach

For complex permission logic, a policy pattern keeps things organized:

```typescript
type PolicyAction = 'create' | 'read' | 'update' | 'delete';

interface PolicyContext {
  user: { id: string; role: string };
  resource?: any;
}

type PolicyCheck = (
  action: PolicyAction,
  context: PolicyContext
) => boolean | Promise<boolean>;

// ---- Post Policy ----
const postPolicy: PolicyCheck = (action, { user, resource: post }) => {
  switch (action) {
    case 'create':
      return hasPermission(user.role, 'posts:create');

    case 'read':
      return hasPermission(user.role, 'posts:read');

    case 'update':
      // Admins can update any post, others only their own
      if (hasPermission(user.role, 'posts:update')) return true;
      return post?.authorId === user.id;

    case 'delete':
      // Only admins can delete
      return hasPermission(user.role, 'posts:delete');

    default:
      return false;
  }
};

// ---- Usage ----
app.put('/api/posts/:id', async (req, res) => {
  const user = (req as any).user;
  const post = await getPostById(req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const allowed = await postPolicy('update', { user, resource: post });
  if (!allowed) {
    return res.status(403).json({ error: 'Not allowed to update this post' });
  }

  // Proceed with update...
});
```

---

## Multi-Tenancy: Org-Scoped Roles

In a multi-tenant application (like Slack, GitHub, or Notion), users can
belong to multiple organizations with different roles in each.

### The Data Model

```typescript
interface User {
  id: string;
  email: string;
  name: string;
}

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface OrgMembership {
  userId: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  joinedAt: number;
}

// Alice is an owner of Org A, but just a member of Org B
const memberships: OrgMembership[] = [
  { userId: 'alice', orgId: 'org-a', role: 'owner', joinedAt: 123 },
  { userId: 'alice', orgId: 'org-b', role: 'member', joinedAt: 456 },
];
```

### Org-Scoped Permission Checking

```typescript
function hasOrgPermission(
  userId: string,
  orgId: string,
  permission: Permission
): boolean {
  const membership = getMembership(userId, orgId);
  if (!membership) return false;

  return hasPermission(membership.role, permission);
}

// Middleware: require org-level permission
function requireOrgPermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    const orgId = req.params.orgId || req.headers['x-org-id'] as string;

    if (!orgId) {
      return res.status(400).json({ error: 'Organization ID required' });
    }

    if (!hasOrgPermission(user.userId, orgId, permission)) {
      return res.status(403).json({
        error: 'Insufficient permissions in this organization',
      });
    }

    next();
  };
}

// Routes
app.get(
  '/api/orgs/:orgId/members',
  authenticate,
  requireOrgPermission('users:read'),
  getOrgMembers
);

app.post(
  '/api/orgs/:orgId/invite',
  authenticate,
  requireOrgPermission('org:invite'),
  inviteMember
);

app.put(
  '/api/orgs/:orgId/settings',
  authenticate,
  requireOrgPermission('org:manage'),
  updateOrgSettings
);
```

### Invitation Flow

```typescript
interface OrgInvitation {
  id: string;
  orgId: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  invitedBy: string;
  token: string;
  expiresAt: number;
  acceptedAt?: number;
}

async function inviteToOrg(
  orgId: string,
  invitedByUserId: string,
  email: string,
  role: 'admin' | 'member' | 'viewer'
): Promise<OrgInvitation> {
  // Check that inviter has permission
  const inviterMembership = getMembership(invitedByUserId, orgId);
  if (!inviterMembership) {
    throw new Error('You are not a member of this organization');
  }

  // Prevent privilege escalation: you can't invite someone
  // with a higher role than your own
  const roleHierarchy = { owner: 4, admin: 3, member: 2, viewer: 1 };
  if (roleHierarchy[role] >= roleHierarchy[inviterMembership.role]) {
    throw new Error('Cannot invite someone with a role equal to or higher than yours');
  }

  const invitation: OrgInvitation = {
    id: crypto.randomUUID(),
    orgId,
    email,
    role,
    invitedBy: invitedByUserId,
    token: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };

  // Store invitation and send email...
  return invitation;
}

async function acceptInvitation(
  token: string,
  userId: string
): Promise<OrgMembership> {
  const invitation = getInvitationByToken(token);

  if (!invitation) throw new Error('Invalid invitation');
  if (invitation.expiresAt < Date.now()) throw new Error('Invitation expired');
  if (invitation.acceptedAt) throw new Error('Invitation already accepted');

  // Create membership
  const membership: OrgMembership = {
    userId,
    orgId: invitation.orgId,
    role: invitation.role,
    joinedAt: Date.now(),
  };

  // Mark invitation as accepted
  invitation.acceptedAt = Date.now();

  return membership;
}
```

---

## API Key Authentication

For machine-to-machine communication, API keys are common. They're like
long-lived passwords for services.

### Generating API Keys

```typescript
import { randomBytes, createHash } from 'node:crypto';

interface ApiKey {
  id: string;
  name: string;               // Human-readable name
  prefix: string;             // First 8 chars (for identification)
  hashedKey: string;          // SHA-256 hash (stored)
  orgId: string;              // Scoped to an organization
  permissions: Permission[];  // What can this key do?
  createdBy: string;          // Who created it
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
}

function generateApiKey(): { key: string; prefix: string; hash: string } {
  // Generate a random 32-byte key
  const rawKey = randomBytes(32).toString('hex');

  // Format: prefix_rest (e.g., "sk_a1b2c3d4_...")
  const prefix = `sk_${rawKey.slice(0, 8)}`;
  const key = `sk_${rawKey}`;

  // Hash for storage (never store the raw key)
  const hash = createHash('sha256').update(key).digest('hex');

  return { key, prefix, hash };
}

async function createApiKey(
  name: string,
  orgId: string,
  permissions: Permission[],
  createdBy: string
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  const { key, prefix, hash } = generateApiKey();

  const apiKey: ApiKey = {
    id: crypto.randomUUID(),
    name,
    prefix,
    hashedKey: hash,
    orgId,
    permissions,
    createdBy,
    createdAt: Date.now(),
  };

  // Store apiKey in database...
  // Return the raw key ONCE — it can never be retrieved again
  return { apiKey, rawKey: key };
}
```

### Verifying API Keys

```typescript
async function verifyApiKey(
  rawKey: string
): Promise<ApiKey | null> {
  const hash = createHash('sha256').update(rawKey).digest('hex');
  const apiKey = await findApiKeyByHash(hash);

  if (!apiKey) return null;

  if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
    return null;
  }

  // Update last used timestamp
  apiKey.lastUsedAt = Date.now();

  return apiKey;
}

// Middleware
function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKeyHeader = req.headers['x-api-key'] as string;
  if (!apiKeyHeader) {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  const apiKey = await verifyApiKey(apiKeyHeader);
  if (!apiKey) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  (req as any).apiKey = apiKey;
  (req as any).orgId = apiKey.orgId;
  next();
}

// Permission check for API keys
function requireApiKeyPermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = (req as any).apiKey as ApiKey;

    if (!apiKey.permissions.includes(permission)) {
      return res.status(403).json({
        error: 'API key does not have the required permission',
        required: permission,
      });
    }

    next();
  };
}
```

### API Key Best Practices

1. **Hash before storing**: Just like passwords, API keys should be hashed
   (SHA-256 is fine here — they're high-entropy, so no need for bcrypt).

2. **Show the key only once**: After creation, the raw key is returned to
   the user and never stored. They must save it themselves.

3. **Use prefixes**: A prefix like `sk_a1b2c3d4` lets you identify which
   key is being used without exposing the full key (useful for logs and
   admin panels).

4. **Scope permissions**: Each key should have only the permissions it needs.

5. **Support rotation**: Users should be able to create a new key and
   revoke the old one without downtime.

6. **Rate limit**: API keys should have per-key rate limits.

7. **Audit log**: Track every API key usage (who, when, what endpoint).

---

## Best Practices for Permission Design

### 1. Principle of Least Privilege

Give users and API keys the minimum permissions needed. Start with nothing
and add what's required.

### 2. Fail Closed

If you can't determine permissions (error querying the database, missing
role configuration), deny access. Never default to allowing.

```typescript
function hasPermission(userRole: string, permission: Permission): boolean {
  const role = ROLES[userRole];
  if (!role) return false;  // Unknown role → deny
  return role.permissions.includes(permission);
}
```

### 3. Separate Authentication from Authorization

```typescript
// BAD — mixing auth and authz
app.delete('/api/posts/:id', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const user = verifyToken(token);
  if (user.role !== 'admin') return res.status(403).json({ error: 'Not admin' });

  // Delete post...
});

// GOOD — separate middleware
app.delete(
  '/api/posts/:id',
  authenticate,                        // WHO are you?
  requirePermission('posts:delete'),   // CAN you do this?
  deletePost                           // DO it
);
```

### 4. Use 401 vs 403 Correctly

- **401 Unauthorized**: "I don't know who you are. Please authenticate."
  (Should really be called "Unauthenticated.")
- **403 Forbidden**: "I know who you are, but you're not allowed to do this."
  (The user IS authenticated, but NOT authorized.)

### 5. Don't Leak Information

```typescript
// BAD — tells the attacker the resource exists
res.status(403).json({ error: 'You cannot access this organization' });

// GOOD — reveals nothing about existence
res.status(404).json({ error: 'Not found' });
```

If a user isn't a member of an organization, return 404, not 403. A 403
tells an attacker that the organization exists. This is especially important
for private resources.

### 6. Audit Everything

Log every permission check, especially denials:

```typescript
function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!hasPermission(user.role, permission)) {
      console.log(JSON.stringify({
        event: 'permission_denied',
        userId: user.userId,
        role: user.role,
        permission,
        path: req.path,
        method: req.method,
        ip: req.ip,
        timestamp: new Date().toISOString(),
      }));

      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}
```

---

## Exercises

### Exercise 1: RBAC System

Implement a complete RBAC system:
- Define at least 4 roles with different permission sets
- Write `hasPermission(role, permission)` with both flat and hierarchical
  role support
- Write Express middleware: `requirePermission`, `requireAllPermissions`,
  `requireAnyPermission`
- Write tests for each role verifying they have exactly the right
  permissions

### Exercise 2: Multi-Tenant Permissions

Build a multi-tenant permission system where:
- Users can belong to multiple organizations
- Each user has a different role per organization
- Write `hasOrgPermission(userId, orgId, permission)`
- Write middleware that extracts the org ID from the route params
- Test: User is admin in Org A (can delete posts) but viewer in Org B
  (cannot delete posts)

### Exercise 3: API Key Manager

Build a complete API key management system:
- `POST /api-keys` — create a new key (returns raw key once)
- `GET /api-keys` — list keys (showing only prefix, name, permissions)
- `DELETE /api-keys/:id` — revoke a key
- Middleware that authenticates requests via `X-API-Key` header
- Scoped permissions per key
- Write tests verifying that a revoked key is rejected

### Exercise 4: Resource-Level Authorization

Implement an authorization system for a blog platform where:
- Viewers can read any published post
- Authors can create posts and edit/delete their own
- Editors can edit any post but not delete
- Admins can do everything
- Write policy functions: `canReadPost`, `canUpdatePost`, `canDeletePost`
- Each function takes the user and the post and returns boolean
- Handle edge cases: what about draft posts? (only the author and admins)

### Exercise 5: Privilege Escalation Prevention

Write tests that verify your system prevents privilege escalation:
- A member cannot change their own role to admin
- A member cannot invite someone as an admin
- An admin cannot grant themselves owner privileges
- An admin cannot demote an owner
- A removed member cannot access organization resources

For each scenario, write a test that attempts the escalation and verifies
it fails with the correct error.

---

## Summary

| Concept | Purpose |
|---------|---------|
| RBAC | Assign permissions to roles, roles to users |
| Flat roles | Each role explicitly lists all permissions |
| Hierarchical roles | Roles inherit from parent roles |
| Auth middleware | Enforce permissions at the route level |
| Resource permissions | Check ownership/membership for specific resources |
| Multi-tenancy | Org-scoped roles (user has different role per org) |
| API keys | Machine-to-machine auth with scoped permissions |
| Least privilege | Grant minimum necessary permissions |

You now have all the pieces to build a complete auth system. The project
for this module puts it all together: password auth, JWTs, OAuth, RBAC,
multi-tenancy, and API keys in one service.
