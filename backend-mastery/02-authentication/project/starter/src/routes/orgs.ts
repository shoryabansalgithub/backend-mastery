// ============================================================
// Organization Routes — CRUD, Invitations, Member Management
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { requireOrgPermission, requireOrgMembership } from '../middleware/authorize';
import { apiKeysRouter } from './apiKeys';

// TODO: Import storage functions
// TODO: Import types (OrgRole, ORG_ROLE_HIERARCHY)

export const orgsRouter = Router();

// All org routes require authentication
orgsRouter.use(authenticate);

// Mount API key routes
orgsRouter.use('/:orgId/api-keys', apiKeysRouter);

// ---- Validation Schemas ----

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});

const changeRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

// ---- POST /orgs ----

orgsRouter.post('/', async (req: Request, res: Response) => {
  // TODO: Create a new organization
  // 1. Validate request body
  // 2. Check slug is unique
  // 3. Create the organization
  // 4. Create an 'owner' membership for the authenticated user
  // 5. Return { org, membership }
  res.status(501).json({ error: 'POST /orgs not implemented' });
});

// ---- GET /orgs ----

orgsRouter.get('/', (req: Request, res: Response) => {
  // TODO: List organizations the user belongs to
  // 1. Get all memberships for the authenticated user
  // 2. For each membership, get the org details
  // 3. Return { organizations: [...] } with role included
  res.status(501).json({ error: 'GET /orgs not implemented' });
});

// ---- GET /orgs/:orgId ----

orgsRouter.get('/:orgId', requireOrgMembership, (req: Request, res: Response) => {
  // TODO: Get organization details with member list
  // 1. Get the org by ID
  // 2. Get all members of the org
  // 3. For each member, include user info (name, email, role)
  // 4. Return { org, members }
  res.status(501).json({ error: 'GET /orgs/:orgId not implemented' });
});

// ---- POST /orgs/:orgId/invite ----

orgsRouter.post(
  '/:orgId/invite',
  requireOrgPermission('org:invite'),
  async (req: Request, res: Response) => {
    // TODO: Invite a user to the organization
    // 1. Validate request body
    // 2. Check that the inviter's role is higher than the invited role
    //    (prevent privilege escalation)
    // 3. Check if the user is already a member
    // 4. Generate a random invitation token
    // 5. Hash the token for storage
    // 6. Save the invitation
    // 7. Return { invitation } (include raw token for testing;
    //    in production, you'd send it via email)
    res.status(501).json({ error: 'POST /orgs/:orgId/invite not implemented' });
  }
);

// ---- POST /orgs/invitations/:token/accept ----

orgsRouter.post('/invitations/:token/accept', async (req: Request, res: Response) => {
  // TODO: Accept an invitation
  // 1. Hash the token from params
  // 2. Find the invitation by hashed token
  // 3. Check it's not expired
  // 4. Check it's not already accepted
  // 5. Check the authenticated user's email matches the invitation email
  // 6. Create the membership
  // 7. Mark invitation as accepted
  // 8. Return { membership }
  res.status(501).json({ error: 'POST /orgs/invitations/:token/accept not implemented' });
});

// ---- PUT /orgs/:orgId/members/:userId/role ----

orgsRouter.put(
  '/:orgId/members/:userId/role',
  requireOrgPermission('members:manage_roles'),
  (req: Request, res: Response) => {
    // TODO: Change a member's role
    // 1. Validate request body
    // 2. Cannot change your own role
    // 3. Cannot change the owner's role
    // 4. The new role must be lower than the requester's role
    //    (prevent privilege escalation)
    // 5. Update the membership
    // 6. Return { membership }
    res.status(501).json({ error: 'PUT /orgs/:orgId/members/:userId/role not implemented' });
  }
);

// ---- DELETE /orgs/:orgId/members/:userId ----

orgsRouter.delete(
  '/:orgId/members/:userId',
  requireOrgPermission('org:remove_member'),
  (req: Request, res: Response) => {
    // TODO: Remove a member from the organization
    // 1. Cannot remove the owner
    // 2. Cannot remove yourself (use a different endpoint for leaving)
    // 3. The target's role must be lower than the requester's role
    // 4. Remove the membership
    // 5. Return { message: 'Member removed' }
    res.status(501).json({ error: 'DELETE /orgs/:orgId/members/:userId not implemented' });
  }
);
