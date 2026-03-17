// ============================================================
// Auth Routes — Registration, Login, Token Refresh, OAuth
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';

// TODO: Import auth service functions (registerUser, loginUser)
// TODO: Import token service functions (createAccessToken, createRefreshToken, etc.)

export const authRouter = Router();

// ---- Validation Schemas ----

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  name: z.string().min(1, 'Name is required').max(100),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// ---- POST /auth/register ----

authRouter.post('/register', async (req: Request, res: Response) => {
  // TODO: Implement registration
  // 1. Validate request body with registerSchema
  // 2. Call registerUser(email, password, name)
  // 3. Create access token and refresh token
  // 4. Set refresh token as HttpOnly cookie
  // 5. Return { user, accessToken }
  //
  // Error handling:
  // - Validation error: 400 with error details
  // - Email taken: 409 { error: 'Email already registered' }
  // - Password too weak: 400 with validation errors
  res.status(501).json({ error: 'POST /auth/register not implemented' });
});

// ---- POST /auth/login ----

authRouter.post('/login', async (req: Request, res: Response) => {
  // TODO: Implement login
  // 1. Validate request body with loginSchema
  // 2. Call loginUser(email, password)
  // 3. Create access token and refresh token
  // 4. Set refresh token as HttpOnly cookie
  // 5. Return { accessToken }
  //
  // Error handling:
  // - Validation error: 400
  // - Invalid credentials: 401 { error: 'Invalid credentials' }
  res.status(501).json({ error: 'POST /auth/login not implemented' });
});

// ---- POST /auth/refresh ----

authRouter.post('/refresh', (req: Request, res: Response) => {
  // TODO: Implement token refresh
  // 1. Get refresh token from cookies (req.cookies.refreshToken)
  // 2. Call rotateRefreshToken(oldToken)
  // 3. If null, clear cookie and return 401
  // 4. Look up the user by ID from the rotation result
  // 5. Create new access token
  // 6. Set new refresh token cookie
  // 7. Return { accessToken }
  res.status(501).json({ error: 'POST /auth/refresh not implemented' });
});

// ---- POST /auth/logout ----

authRouter.post('/logout', authenticate, (req: Request, res: Response) => {
  // TODO: Implement logout
  // 1. Get refresh token from cookies
  // 2. If present, revoke it
  // 3. Clear the cookie
  // 4. Return { message: 'Logged out successfully' }
  res.status(501).json({ error: 'POST /auth/logout not implemented' });
});

// ---- GET /auth/google ----

authRouter.get('/google', (req: Request, res: Response) => {
  // TODO: Implement Google OAuth redirect
  // 1. Generate PKCE code_verifier and code_challenge
  // 2. Generate random state parameter
  // 3. Store { verifier, state } temporarily (use a Map)
  // 4. Build the Google authorization URL with:
  //    - client_id, redirect_uri, response_type=code
  //    - scope: openid email profile
  //    - state, code_challenge, code_challenge_method=S256
  // 5. Redirect the user to Google
  //
  // For testing without real Google credentials, you can use
  // configurable auth/token URLs that point to a mock server.
  res.status(501).json({ error: 'GET /auth/google not implemented' });
});

// ---- GET /auth/google/callback ----

authRouter.get('/google/callback', async (req: Request, res: Response) => {
  // TODO: Implement Google OAuth callback
  // 1. Extract code and state from query params
  // 2. Verify state matches stored state
  // 3. Exchange code for tokens with Google's token endpoint
  // 4. Get user info from Google's userinfo endpoint
  // 5. Find or create user in your database
  //    - If user exists with this googleId, use that user
  //    - If user exists with this email, link the Google account
  //    - Otherwise, create a new user
  // 6. Create your own access + refresh tokens
  // 7. Return tokens (or redirect to frontend)
  res.status(501).json({ error: 'GET /auth/google/callback not implemented' });
});
