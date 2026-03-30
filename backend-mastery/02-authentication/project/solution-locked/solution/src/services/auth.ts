// ============================================================
// Auth Service — Password hashing and credential verification
// ============================================================

import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../types';
import { findUserByEmail, saveUser } from '../storage';

// ---- Password Validation ----

interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (password.length > 128) {
    errors.push('Password must be at most 128 characters');
  }

  // Check for all-same-character passwords
  if (/^(.)\1+$/.test(password)) {
    errors.push('Password cannot be all the same character');
  }

  // Check for extremely common passwords
  const commonPasswords = [
    'password', '12345678', 'qwerty123', 'letmein01',
    'admin123', 'welcome1', 'password1', 'changeme',
  ];
  if (commonPasswords.includes(password.toLowerCase())) {
    errors.push('This password is too common');
  }

  return { valid: errors.length === 0, errors };
}

// ---- Password Hashing ----

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,  // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return argon2.verify(hash, password);
}

// ---- User Registration ----

export async function registerUser(
  email: string,
  password: string,
  name: string
): Promise<User> {
  // Check if email is already taken
  const existing = findUserByEmail(email);
  if (existing) {
    const error = new Error('Email already registered');
    (error as any).status = 409;
    throw error;
  }

  // Validate password strength
  const validation = validatePassword(password);
  if (!validation.valid) {
    const error = new Error(validation.errors.join('; '));
    (error as any).status = 400;
    throw error;
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const now = new Date().toISOString();
  const user: User = {
    id: `usr_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    email: email.toLowerCase().trim(),
    name: name.trim(),
    passwordHash,
    createdAt: now,
    updatedAt: now,
  };

  saveUser(user);

  // Return user without passwordHash
  const { passwordHash: _, ...safeUser } = user;
  return safeUser as User;
}

// ---- Login ----

export async function loginUser(
  email: string,
  password: string
): Promise<User> {
  const user = findUserByEmail(email.toLowerCase().trim());

  if (!user) {
    // Still hash to prevent timing attacks that reveal email existence
    await hashPassword(password);
    throw new Error('Invalid credentials');
  }

  if (!user.passwordHash) {
    // OAuth-only user — can't log in with password
    await hashPassword(password);
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  return user;
}
