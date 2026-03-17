// ============================================================
// Auth Service — Password hashing and credential verification
// ============================================================

import { User } from '../types';
import { findUserByEmail, saveUser } from '../storage';

// TODO: Import argon2

// ---- Password Validation ----

interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidation {
  // TODO: Implement password validation
  // - Minimum 8 characters
  // - Maximum 128 characters
  // - No all-same-character passwords (e.g., 'aaaaaaaa')
  //
  // Return { valid: true, errors: [] } if valid,
  // or { valid: false, errors: ['...'] } with reasons if invalid
  throw new Error('Not implemented');
}

// ---- Password Hashing ----

export async function hashPassword(password: string): Promise<string> {
  // TODO: Hash the password with argon2id
  // Use these options:
  //   type: argon2.argon2id
  //   memoryCost: 65536 (64 MB)
  //   timeCost: 3
  //   parallelism: 4
  throw new Error('Not implemented');
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  // TODO: Verify a password against an argon2 hash
  throw new Error('Not implemented');
}

// ---- User Registration ----

export async function registerUser(
  email: string,
  password: string,
  name: string
): Promise<User> {
  // TODO: Implement user registration
  // 1. Check if email is already registered (throw if so)
  // 2. Validate password strength
  // 3. Hash password with argon2
  // 4. Create user object with a unique ID
  // 5. Save user to storage
  // 6. Return the user (WITHOUT passwordHash)
  throw new Error('Not implemented');
}

// ---- Login ----

export async function loginUser(
  email: string,
  password: string
): Promise<User> {
  // TODO: Implement login
  // 1. Find user by email
  // 2. If user not found, still hash the password (timing attack prevention)
  //    then throw 'Invalid credentials'
  // 3. If user has no passwordHash (OAuth-only user), throw 'Invalid credentials'
  // 4. Verify password against stored hash
  // 5. If invalid, throw 'Invalid credentials'
  // 6. Return the user
  throw new Error('Not implemented');
}
