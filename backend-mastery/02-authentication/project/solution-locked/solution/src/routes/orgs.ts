// ============================================================
// Organization Routes — CRUD, Invitations, Member Management
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'node:crypto';
import { authenticate } from '../middleware/authenticate';
import {
  requireOrgPermission,
  requireOrgMembership,
} from '../middleware/authorize';
import { apiKeysRouter } from './apiKeys';
import {
  OrgRole,
  ORG_ROLE_HIERARCHY,
  Organization,
  OrgMembership,
  OrgInvitation,
} from '../types';
import {
  saveOrganization,
  findOrgById,
  findOrgBySlug,
  saveMembership,
  findMembership,
  findUserMemberships,
  findOrgMembers,
  updateMembershipRole,
  removeMembership,
  saveInvitation,
  findInvitationByToken,
  findUserById,
  findUserByEmail,
} from '../storage';

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
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must contain only lowercase letters, numbers, and hyphens'
    ),
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
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, slug } = parsed.data;

  // Check slug uniqueness
  if (findOrgBySlug(slug)) {
    res.status(409).json({ error: 'Organization slug already taken' });
    return;
  }

  const now = new Date().toISOString();
  const org: Organization = {
    id: `org_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    name,
    slug,
    createdBy: req.user!.userId,
    createdAt: now,
    updatedAt: now,
  };

  saveOrganization(org);

  // Creator becomes the owner
  const membership: OrgMembership = {
    userId: req.user!.userId,
    orgId: org.id,
    role: 'owner',
    joinedAt: now,
  };

  saveMembership(membership);

  res.status(201).json({ org, membership });
});

// ---- GET /orgs ----

orgsRouter.get('/', (req: Request, res: Response) => {
  const userMemberships = findUserMemberships(req.user!.userId);

  const organizations = userMemberships
    .map((m) => {
      const org = findOrgById(m.orgId);
      if (!org) return null;
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: m.role,
        createdAt: org.createdAt,
      };
    })
    .filter(Boolean);

  res.json({ organizations });
});

// ---- GET /orgs/:orgId ----

orgsRouter.get(
  '/:orgId',
  requireOrgMembership,
  (req: Request, res: Response) => {
    const org = findOrgById(req.params.orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    const orgMembers = findOrgMembers(req.params.orgId);
    const members = orgMembers
      .map((m) => {
        const user = findUserById(m.userId);
        if (!user) return null;
        return {
          userId: m.userId,
          name: user.name,
          email: user.email,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      })
      .filter(Boolean);

    res.json({ org, members });
  }
);

// ---- POST /orgs/:orgId/invite ----

orgsRouter.post(
  '/:orgId/invite',
  requireOrgPermission('org:invite'),
  async (req: Request, res: Response) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, role } = parsed.data;
    const orgId = req.params.orgId;

    // Get inviter's membership to check role hierarchy
    const inviterMembership = findMembership(req.user!.userId, orgId);
    if (!inviterMembership) {
      res.status(403).json({ error: 'You are not a member of this organization' });
      return;
    }

    // Prevent privilege escalation
    const inviterLevel = ORG_ROLE_HIERARCHY[inviterMembership.role];
    const invitedLevel = ORG_ROLE_HIERARCHY[role as OrgRole];

    if (invitedLevel >= inviterLevel) {
      res.status(403).json({
        error: 'Cannot invite someone with a role equal to or higher than yours',
      });
      return;
    }

    // Check if user is already a member
    const existingUser = findUserByEmail(email.toLowerCase());
    if (existingUser && findMembership(existingUser.id, orgId)) {
      res.status(409).json({ error: 'User is already a member of this organization' });
      return;
    }

    // Generate invitation token
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const invitation: OrgInvitation = {
      id: `inv_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      orgId,
      email: email.toLowerCase(),
      role: role as OrgRole,
      invitedBy: req.user!.userId,
      token: tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    saveInvitation(invitation);

    res.status(201).json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        orgId: invitation.orgId,
        expiresAt: invitation.expiresAt,
        // Include raw token for testing (in production, send via email)
        token: rawToken,
      },
    });
  }
);

// ---- POST /orgs/invitations/:token/accept ----

orgsRouter.post(
  '/invitations/:token/accept',
  async (req: Request, res: Response) => {
    const rawToken = req.params.token;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const invitation = findInvitationByToken(tokenHash);

    if (!invitation) {
      res.status(404).json({ error: 'Invitation not found' });
      return;
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      res.status(410).json({ error: 'Invitation has expired' });
      return;
    }

    if (invitation.acceptedAt) {
      res.status(409).json({ error: 'Invitation has already been accepted' });
      return;
    }

    // Verify the authenticated user's email matches the invitation
    if (req.user!.email !== invitation.email) {
      res.status(403).json({
        error: 'This invitation was sent to a different email address',
      });
      return;
    }

    // Check if already a member
    if (findMembership(req.user!.userId, invitation.orgId)) {
      res.status(409).json({ error: 'You are already a member of this organization' });
      return;
    }

    // Create membership
    const membership: OrgMembership = {
      userId: req.user!.userId,
      orgId: invitation.orgId,
      role: invitation.role,
      joinedAt: new Date().toISOString(),
    };

    saveMembership(membership);

    // Mark invitation as accepted
    invitation.acceptedAt = new Date().toISOString();

    res.json({ membership });
  }
);

// ---- PUT /orgs/:orgId/members/:userId/role ----

orgsRouter.put(
  '/:orgId/members/:userId/role',
  requireOrgPermission('members:manage_roles'),
  (req: Request, res: Response) => {
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { role: newRole } = parsed.data;
    const { orgId, userId: targetUserId } = req.params;

    // Cannot change your own role
    if (targetUserId === req.user!.userId) {
      res.status(403).json({ error: 'Cannot change your own role' });
      return;
    }

    // Get target's membership
    const targetMembership = findMembership(targetUserId, orgId);
    if (!targetMembership) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // Cannot change the owner's role
    if (targetMembership.role === 'owner') {
      res.status(403).json({ error: "Cannot change the owner's role" });
      return;
    }

    // Get requester's membership for hierarchy check
    const requesterMembership = findMembership(req.user!.userId, orgId);
    if (!requesterMembership) {
      res.status(403).json({ error: 'Not a member' });
      return;
    }

    // New role must be lower than requester's role
    const requesterLevel = ORG_ROLE_HIERARCHY[requesterMembership.role];
    const newRoleLevel = ORG_ROLE_HIERARCHY[newRole as OrgRole];

    if (newRoleLevel >= requesterLevel) {
      res.status(403).json({
        error: 'Cannot assign a role equal to or higher than yours',
      });
      return;
    }

    // Update
    const updated = updateMembershipRole(targetUserId, orgId, newRole as OrgRole);
    if (!updated) {
      res.status(500).json({ error: 'Failed to update role' });
      return;
    }

    res.json({ membership: updated });
  }
);

// ---- DELETE /orgs/:orgId/members/:userId ----

orgsRouter.delete(
  '/:orgId/members/:userId',
  requireOrgPermission('org:remove_member'),
  (req: Request, res: Response) => {
    const { orgId, userId: targetUserId } = req.params;

    // Cannot remove yourself
    if (targetUserId === req.user!.userId) {
      res.status(403).json({
        error: 'Cannot remove yourself. Use the leave endpoint instead.',
      });
      return;
    }

    // Get target's membership
    const targetMembership = findMembership(targetUserId, orgId);
    if (!targetMembership) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // Cannot remove the owner
    if (targetMembership.role === 'owner') {
      res.status(403).json({ error: 'Cannot remove the owner' });
      return;
    }

    // Requester's role must be higher than target's role
    const requesterMembership = findMembership(req.user!.userId, orgId);
    if (!requesterMembership) {
      res.status(403).json({ error: 'Not a member' });
      return;
    }

    const requesterLevel = ORG_ROLE_HIERARCHY[requesterMembership.role];
    const targetLevel = ORG_ROLE_HIERARCHY[targetMembership.role];

    if (targetLevel >= requesterLevel) {
      res.status(403).json({
        error: 'Cannot remove a member with a role equal to or higher than yours',
      });
      return;
    }

    removeMembership(targetUserId, orgId);

    res.json({ message: 'Member removed' });
  }
);
