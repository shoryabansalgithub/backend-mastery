// ============================================================
// Auth Routes — Registration, Login, Token Refresh, OAuth
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/authenticate';
import { registerUser, loginUser } from '../services/auth';
import {
  createAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../services/token';
import { findUserById, findUserByGoogleId, findUserByEmail, saveUser, updateUser } from '../storage';
import { User } from '../types';

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

// ---- Rate Limiting ----

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;  // 1 minute
const RATE_LIMIT_MAX = 10;                // 10 requests per minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

function rateLimitMiddleware(req: Request, res: Response, next: Function): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: RATE_LIMIT_WINDOW_MS / 1000,
    });
    return;
  }
  next();
}

// ---- Cookie Helper ----

function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

// ---- POST /auth/register ----

authRouter.post('/register', rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    // Validate
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, name } = parsed.data;

    // Register
    const user = await registerUser(email, password, name);

    // Create tokens
    const accessToken = createAccessToken({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    const refreshToken = createRefreshToken(user.id);

    // Set cookie
    setRefreshTokenCookie(res, refreshToken);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
      accessToken,
    });
  } catch (err: any) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ---- POST /auth/login ----

authRouter.post('/login', rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    // Validate
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password } = parsed.data;

    // Login
    const user = await loginUser(email, password);

    // Create tokens
    const accessToken = createAccessToken({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    const refreshToken = createRefreshToken(user.id);

    // Set cookie
    setRefreshTokenCookie(res, refreshToken);

    res.json({ accessToken });
  } catch (err: any) {
    if (err.message === 'Invalid credentials') {
      res.status(401).json({ error: 'Invalid credentials' });
    } else {
      res.status(500).json({ error: 'Login failed' });
    }
  }
});

// ---- POST /auth/refresh ----

authRouter.post('/refresh', (req: Request, res: Response) => {
  const oldRefreshToken = req.cookies?.refreshToken;

  if (!oldRefreshToken) {
    res.status(401).json({ error: 'Refresh token required' });
    return;
  }

  const result = rotateRefreshToken(oldRefreshToken);

  if (!result) {
    res.clearCookie('refreshToken', { path: '/auth/refresh' });
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }

  const user = findUserById(result.userId);
  if (!user) {
    res.clearCookie('refreshToken', { path: '/auth/refresh' });
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const accessToken = createAccessToken({
    id: user.id,
    email: user.email,
    name: user.name,
  });

  setRefreshTokenCookie(res, result.newRawToken);

  res.json({ accessToken });
});

// ---- POST /auth/logout ----

authRouter.post('/logout', authenticate, (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }

  res.clearCookie('refreshToken', { path: '/auth/refresh' });
  res.json({ message: 'Logged out successfully' });
});

// ---- Google OAuth ----

// Configurable OAuth endpoints (for testing with mock servers)
const GOOGLE_AUTH_URL =
  process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL =
  process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL =
  process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'mock-client-id';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'mock-client-secret';
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

// Store pending OAuth flows (state -> { verifier })
const pendingOAuth = new Map<string, { verifier: string; expiresAt: number }>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingOAuth) {
    if (now > value.expiresAt) {
      pendingOAuth.delete(key);
    }
  }
}, 60_000);

// ---- GET /auth/google ----

authRouter.get('/google', (req: Request, res: Response) => {
  // Generate PKCE
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // Generate state (CSRF protection)
  const state = randomBytes(16).toString('hex');

  // Store with 10-minute expiry
  pendingOAuth.set(state, {
    verifier,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

// ---- GET /auth/google/callback ----

authRouter.get('/google/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).json({ error: `OAuth error: ${error}` });
    return;
  }

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state parameter' });
    return;
  }

  // Verify state
  const pending = pendingOAuth.get(state);
  if (!pending) {
    res.status(400).json({ error: 'Invalid or expired state parameter' });
    return;
  }

  if (Date.now() > pending.expiresAt) {
    pendingOAuth.delete(state);
    res.status(400).json({ error: 'OAuth flow expired' });
    return;
  }

  const { verifier } = pending;
  pendingOAuth.delete(state);

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      res.status(400).json({ error: `Token exchange failed: ${errText}` });
      return;
    }

    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
    };

    // Get user info
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      res.status(400).json({ error: 'Failed to get user info from Google' });
      return;
    }

    const googleUser = (await userInfoResponse.json()) as {
      id: string;
      email: string;
      verified_email?: boolean;
      name: string;
      picture?: string;
    };

    // Find or create user
    let user: User | undefined;

    // Try by Google ID first
    user = findUserByGoogleId(googleUser.id);

    if (!user) {
      // Try by email
      user = findUserByEmail(googleUser.email);

      if (user) {
        // Link Google account to existing user
        updateUser(user.id, { googleId: googleUser.id });
        user.googleId = googleUser.id;
      } else {
        // Create new user
        const now = new Date().toISOString();
        user = {
          id: `usr_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
          email: googleUser.email.toLowerCase(),
          name: googleUser.name,
          googleId: googleUser.id,
          createdAt: now,
          updatedAt: now,
        };
        saveUser(user);
      }
    }

    // Create our own tokens
    const accessToken = createAccessToken({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    const refreshToken = createRefreshToken(user.id);

    setRefreshTokenCookie(res, refreshToken);

    // Return JSON with tokens (in production, you might redirect to frontend)
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
      accessToken,
    });
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: 'OAuth authentication failed' });
  }
});
