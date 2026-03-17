// ============================================================
// API Key Routes — Create, List, Revoke
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireOrgPermission } from '../middleware/authorize';

// TODO: Import crypto functions (randomBytes, createHash)
// TODO: Import storage functions
// TODO: Import Permission type

export const apiKeysRouter = Router({ mergeParams: true });

// ---- Validation Schemas ----

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(z.string()).min(1, 'At least one permission required'),
});

// ---- POST /orgs/:orgId/api-keys ----

apiKeysRouter.post(
  '/',
  requireOrgPermission('apikeys:create'),
  async (req: Request, res: Response) => {
    // TODO: Create a new API key
    // 1. Validate request body
    // 2. Validate that all requested permissions are valid Permission values
    // 3. Generate a random 32-byte key
    // 4. Format as: sk_<hex>
    // 5. Create a prefix from the first 8 chars after 'sk_'
    // 6. Hash the full key with SHA-256
    // 7. Store the ApiKey with the hash (not the raw key)
    // 8. Return { apiKey (without hash), rawKey }
    //    The rawKey is only shown ONCE
    res.status(501).json({ error: 'POST /orgs/:orgId/api-keys not implemented' });
  }
);

// ---- GET /orgs/:orgId/api-keys ----

apiKeysRouter.get(
  '/',
  requireOrgPermission('apikeys:read'),
  (req: Request, res: Response) => {
    // TODO: List API keys for the organization
    // 1. Get all non-revoked API keys for this org
    // 2. Return them WITHOUT the hashedKey field
    // 3. Include: id, name, prefix, permissions, createdBy, createdAt, lastUsedAt
    res.status(501).json({ error: 'GET /orgs/:orgId/api-keys not implemented' });
  }
);

// ---- DELETE /orgs/:orgId/api-keys/:keyId ----

apiKeysRouter.delete(
  '/:keyId',
  requireOrgPermission('apikeys:revoke'),
  (req: Request, res: Response) => {
    // TODO: Revoke an API key
    // 1. Find the API key by ID
    // 2. Verify it belongs to this org
    // 3. Check it's not already revoked
    // 4. Mark as revoked (set revokedAt)
    // 5. Return { message: 'API key revoked' }
    res.status(501).json({ error: 'DELETE /orgs/:orgId/api-keys/:keyId not implemented' });
  }
);
