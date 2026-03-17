// ============================================================
// AuthForge — Multi-Tenant Auth Service
// ============================================================

import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter } from './routes/auth';
import { orgsRouter } from './routes/orgs';
import { apiKeysRouter } from './routes/apiKeys';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Global Middleware ----

app.use(express.json());
app.use(cookieParser());

// TODO: Add rate limiting middleware for auth endpoints
// Hint: Track requests by IP using a Map with timestamps

// ---- Health Check ----

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Routes ----

app.use('/auth', authRouter);
app.use('/orgs', orgsRouter);

// API key routes are nested under orgs
// POST   /orgs/:orgId/api-keys
// GET    /orgs/:orgId/api-keys
// DELETE /orgs/:orgId/api-keys/:keyId
// These are mounted inside orgsRouter, which delegates to apiKeysRouter

// ---- Error Handler ----

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
);

// ---- Start Server ----

app.listen(PORT, () => {
  console.log(`AuthForge running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  POST   /auth/register');
  console.log('  POST   /auth/login');
  console.log('  POST   /auth/refresh');
  console.log('  POST   /auth/logout');
  console.log('  GET    /auth/google');
  console.log('  GET    /auth/google/callback');
  console.log('  POST   /orgs');
  console.log('  GET    /orgs');
  console.log('  GET    /orgs/:orgId');
  console.log('  POST   /orgs/:orgId/invite');
  console.log('  POST   /orgs/invitations/:token/accept');
  console.log('  PUT    /orgs/:orgId/members/:userId/role');
  console.log('  DELETE /orgs/:orgId/members/:userId');
  console.log('  POST   /orgs/:orgId/api-keys');
  console.log('  GET    /orgs/:orgId/api-keys');
  console.log('  DELETE /orgs/:orgId/api-keys/:keyId');
});

export { app };
