# Lesson 2: Password Hashing

## Why Passwords Are the Hardest Simple Problem

Storing passwords seems trivial. User types password, you save it, they
type it again later, you check if it matches. What could go wrong?

Everything.

Password storage is one of the most frequently botched aspects of backend
development. The consequences are severe: millions of real people have had
their lives disrupted because developers stored passwords incorrectly.

---

## Why You NEVER Store Plaintext Passwords

### Real Breaches

- **RockYou (2009)**: 32 million passwords stored in plaintext in a SQL
  database. Breached. Every single password exposed instantly.

- **Adobe (2013)**: 153 million user records. Passwords were encrypted (not
  hashed) with 3DES in ECB mode, without salting. Same passwords produced
  the same ciphertext. Attackers used the password hints (also stored) to
  crack the encryption at scale.

- **LinkedIn (2012)**: 6.5 million password hashes leaked. They used SHA-1
  with no salt. Within hours, millions were cracked.

- **Equifax (2017)**: Among many failures, admin credentials were stored
  in plaintext in configuration files.

### The Threat Model

Assume your database WILL be compromised. This isn't paranoia — it's
engineering. Databases get breached through:

- SQL injection
- Stolen backup tapes
- Compromised admin credentials
- Insider threats
- Misconfigured cloud storage (S3 buckets, etc.)

Your job: ensure that when (not if) the database leaks, the attacker
gets as little useful information as possible.

---

## Why SHA-256 Alone Is Terrible for Passwords

"But we learned hashing in the last lesson! SHA-256 is one-way, right?"

Yes, but there's a critical problem: **speed**.

SHA-256 was designed to be fast. Very fast. A modern GPU can compute
billions of SHA-256 hashes per second.

### The Attack: Brute Force

```
Attacker has: sha256("???") = "5e884898da280471..."
Attacker tries:
  sha256("aaaaaa") = "ed968e84..." ← no match
  sha256("aaaaab") = "19fc517..." ← no match
  sha256("aaaaac") = "7b2e9f1..." ← no match
  ...billions per second on a GPU...
  sha256("password") = "5e884898da280471..." ← MATCH!
```

At billions of hashes per second, every password under 8 characters can
be cracked in minutes.

### The Attack: Rainbow Tables

A rainbow table is a precomputed lookup table:

```
sha256("password")  → "5e884898da28047..."
sha256("123456")    → "8d969eef6ecad3c..."
sha256("qwerty")    → "65e84be33532fb7..."
...millions of common passwords...
```

An attacker downloads a rainbow table (they're freely available), looks up
your hash, and instantly gets the password. No computation needed.

### The Attack: Dictionary Attack

Attackers don't try random strings. They use dictionaries of:
- Common passwords (password, 123456, qwerty, etc.)
- Previous breach data (billions of real passwords are available)
- Common patterns (Summer2024!, Password1!, etc.)
- Variations (p@ssw0rd, P4$$word, etc.)

### Demonstration: How Fast SHA-256 Cracks

```typescript
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Simulate an attacker who stole this hash from your database
const stolenHash = sha256('monkey123');

// Dictionary attack
const dictionary = [
  'password', '123456', 'monkey123', 'letmein',
  'qwerty', 'dragon', 'master', 'abc123',
];

console.time('crack');
for (const guess of dictionary) {
  if (sha256(guess) === stolenHash) {
    console.log(`Cracked! Password is: ${guess}`);
    break;
  }
}
console.timeEnd('crack');
// crack: 0.123ms — instant
```

---

## Salt: The First Defense

### What Is a Salt?

A salt is a random value generated uniquely for each password. You prepend
(or append) it to the password before hashing:

```
hash(salt + password) = stored_hash
```

Each user gets their own random salt. The salt is stored alongside the hash
(it's not secret).

### Why Salt Works

**Without salt:**
```
User Alice: sha256("password") = "5e884898..."
User Bob:   sha256("password") = "5e884898..."
// Same hash! Attacker cracks one, gets both.
// Rainbow tables work against ALL users at once.
```

**With salt:**
```
User Alice: sha256("a1b2c3d4" + "password") = "7f2e91c3..."
User Bob:   sha256("e5f6g7h8" + "password") = "b4d8a2f1..."
// Different hashes even though passwords are identical.
// Rainbow tables are useless — they'd need a separate table
// for every possible salt value.
```

### Salt Implementation (Still Not Enough)

```typescript
import { createHash, randomBytes } from 'node:crypto';

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  return { salt, hash };
}

function verifyPassword(
  password: string,
  salt: string,
  hash: string
): boolean {
  const computed = createHash('sha256').update(salt + password).digest('hex');
  return computed === hash;
}
```

This is better, but still not enough. Why? **SHA-256 is still too fast.**

Salt prevents rainbow tables and prevents identical passwords from having
the same hash. But an attacker with your database can still brute-force
each password individually at billions of hashes per second.

We need a hash function that is **deliberately slow**.

---

## bcrypt: Slow by Design

### The Key Insight

What if we made the hash function take 100ms instead of 1 nanosecond?

For a legitimate user logging in, 100ms is imperceptible. For an attacker
trying billions of passwords, it's game over.

### How bcrypt Works

bcrypt is based on the Blowfish cipher's key schedule — specifically, the
most expensive part of setting up the cipher.

The algorithm (simplified):

1. Take the password and salt
2. Initialize the Blowfish cipher state using the key schedule
3. **Repeat step 2 many times** (2^cost iterations)
4. Encrypt a fixed string ("OrpheanBeholderScryDoubt") with the resulting
   state
5. Encode the output with the salt and cost factor

The `cost` parameter (also called "rounds" or "work factor") determines how
many times the key schedule repeats:

```
cost =  4: 2^4  =        16 iterations (~1ms)
cost = 10: 2^10 =     1,024 iterations (~100ms)    ← default
cost = 12: 2^12 =     4,096 iterations (~300ms)
cost = 14: 2^14 =    16,384 iterations (~1 second)
cost = 16: 2^16 =    65,536 iterations (~4 seconds)
```

### bcrypt Output Format

A bcrypt hash looks like:

```
$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
 │  │  │                                                      │
 │  │  └── 22-char salt (Base64)                               │
 │  └──── cost factor (10 = 2^10 iterations)                   │
 └────── algorithm version (2b)                                 │
                                           31-char hash (Base64)┘
```

The salt is embedded in the output. You don't need to store it separately.

### bcrypt in TypeScript

```typescript
import bcrypt from 'bcrypt';

async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Usage
async function demo() {
  const hash = await hashPassword('my-secure-password');
  console.log(hash);
  // $2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy

  const isValid = await verifyPassword('my-secure-password', hash);
  console.log(isValid);  // true

  const isWrong = await verifyPassword('wrong-password', hash);
  console.log(isWrong);  // false
}
```

### bcrypt Limitations

1. **72-byte limit**: bcrypt truncates passwords at 72 bytes. A 100-character
   password and the first 72 characters of that password produce the same
   hash. Workaround: pre-hash with SHA-256.

2. **CPU-bound only**: bcrypt is computationally expensive but doesn't
   require much memory. Modern GPUs can parallelize bcrypt attacks because
   GPU cores have enough memory for each instance.

---

## argon2: The Modern Choice

### Why argon2 Exists

Argon2 won the Password Hashing Competition in 2015. It was designed to be
**memory-hard** — meaning it requires a lot of RAM to compute, not just CPU
cycles.

Why does this matter? GPUs have thousands of cores but limited memory per
core. If each hash computation requires 64MB of RAM, a GPU with 1000 cores
would need 64GB just for the hashing — making GPU-based attacks impractical.

### argon2 Variants

- **argon2d**: Maximizes resistance to GPU attacks. Data-dependent memory
  access (can be vulnerable to side-channel attacks).
- **argon2i**: Maximizes resistance to side-channel attacks. Data-independent
  memory access.
- **argon2id**: Hybrid of both. **Use this one.** It's the recommended
  variant.

### argon2 Parameters

```typescript
{
  type: argon2.argon2id,  // Algorithm variant
  memoryCost: 65536,      // Memory in KiB (64 MB)
  timeCost: 3,            // Number of iterations
  parallelism: 4,         // Number of threads
}
```

How to choose:
1. Set `parallelism` to the number of CPU cores you can dedicate
2. Set `memoryCost` as high as your server can afford (64MB is a good start)
3. Adjust `timeCost` until hashing takes ~200-500ms on your hardware
4. Re-benchmark when you upgrade servers

### argon2 in TypeScript

```typescript
import argon2 from 'argon2';

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,     // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return argon2.verify(hash, password);
}

// Usage
async function demo() {
  const hash = await hashPassword('my-secure-password');
  console.log(hash);
  // $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$...

  const isValid = await verifyPassword('my-secure-password', hash);
  console.log(isValid);  // true
}
```

### argon2 Output Format

```
$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+daw
 │        │    │             │  │            │
 │        │    │             │  │            └── hash (Base64)
 │        │    │             │  └── salt (Base64)
 │        │    │             └── parallelism
 │        │    └── memory cost (KiB), time cost
 │        └── version
 └── algorithm variant
```

Like bcrypt, everything needed for verification is embedded in the output
string.

---

## bcrypt vs argon2: Which Should You Use?

| Property | bcrypt | argon2id |
|----------|--------|----------|
| Age | 1999 | 2015 |
| Memory-hard | No | Yes |
| GPU resistance | Moderate | High |
| Max password | 72 bytes | Unlimited |
| OWASP recommended | Yes (fallback) | Yes (primary) |
| Ecosystem support | Excellent | Very good |

**Use argon2id** for new projects. Use bcrypt if argon2 isn't available
or if you're maintaining a legacy system.

---

## Timing Attacks on Password Comparison

We touched on this in the previous lesson, but it's so important for
password verification that it bears repeating.

### The Bad Code

```typescript
// NEVER DO THIS
function verifyPassword(input: string, storedHash: string): boolean {
  const inputHash = hashSomehow(input);
  return inputHash === storedHash;  // Timing attack vulnerability!
}
```

The `===` operator compares strings byte by byte and returns `false` at
the first mismatch. An attacker can measure response times:

- If the first byte matches: slightly longer response
- If the first two bytes match: even longer response
- And so on...

Over thousands of requests, the attacker can reconstruct the hash one
byte at a time.

### The Fix

```typescript
import { timingSafeEqual } from 'node:crypto';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```

**Good news:** bcrypt and argon2 libraries handle this internally. Their
`compare` and `verify` functions use timing-safe comparison. But you
need to know about this for when you're comparing tokens, API keys,
or other secrets directly.

---

## Password Policies That Actually Work

### The Old (Bad) Way

You've seen these rules:
- Must be at least 8 characters
- Must contain uppercase, lowercase, number, and special character
- Must change every 90 days
- Cannot reuse last 12 passwords

These policies were based on a 2003 NIST document. The author, Bill Burr,
later admitted they were largely wrong. These rules lead to:

- `P@ssw0rd!` — meets all requirements, terrible password
- Users writing passwords on sticky notes
- Users incrementing a number: `Summer2024!`, `Summer2025!`
- Frustration and help desk tickets

### The Modern (Good) Way (NIST SP 800-63B)

1. **Minimum 8 characters**, recommend 15+. No arbitrary maximum (but cap
   at something reasonable like 128 to prevent DoS).

2. **No complexity requirements.** Let users choose passphrases:
   `correct horse battery staple` is far stronger than `P@ssw0rd!`

3. **Check against breached password lists.** If the user's chosen password
   appears in known breach data, reject it. The Have I Been Pwned API
   provides this service.

4. **No forced rotation** unless there's evidence of compromise. Forced
   rotation causes weaker passwords.

5. **Allow paste in password fields.** This enables password managers, which
   are the single best thing users can do for password security.

### Implementing a Password Validator

```typescript
import { createHash } from 'node:crypto';

interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (password.length > 128) {
    errors.push('Password must be at most 128 characters');
  }

  // Check for common patterns
  const commonPatterns = [
    /^(.)\1+$/,           // All same character: 'aaaaaaaa'
    /^(012|123|234|345|456|567|678|789)/,  // Sequential numbers
    /^(abc|bcd|cde|def)/i, // Sequential letters
  ];

  for (const pattern of commonPatterns) {
    if (pattern.test(password)) {
      errors.push('Password contains a predictable pattern');
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// For breach checking, you'd query the HIBP API:
async function isPasswordBreached(password: string): Promise<boolean> {
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  // k-Anonymity: only send the first 5 chars of the hash
  const response = await fetch(
    `https://api.pwnedpasswords.com/range/${prefix}`
  );
  const text = await response.text();

  // Check if our suffix appears in the results
  return text.split('\n').some((line) => line.startsWith(suffix));
}
```

---

## The Complete Password Flow

Putting it all together:

```typescript
import argon2 from 'argon2';
import { timingSafeEqual, createHash } from 'node:crypto';

// ----- Registration -----
async function registerUser(
  email: string,
  password: string
): Promise<{ id: string; email: string; passwordHash: string }> {
  // 1. Validate password strength
  const validation = validatePassword(password);
  if (!validation.valid) {
    throw new Error(`Invalid password: ${validation.errors.join(', ')}`);
  }

  // 2. Check if password appears in breach databases
  const breached = await isPasswordBreached(password);
  if (breached) {
    throw new Error(
      'This password has appeared in a data breach. Please choose another.'
    );
  }

  // 3. Hash with argon2id
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  // 4. Store user (email + hash, NEVER the plaintext password)
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
  };

  // Save to database...
  return user;
}

// ----- Login -----
async function loginUser(
  email: string,
  password: string
): Promise<boolean> {
  // 1. Find user by email
  const user = await findUserByEmail(email);

  if (!user) {
    // IMPORTANT: Still hash the password to prevent timing attacks
    // that reveal whether an email exists in the system.
    await argon2.hash(password);
    return false;
  }

  // 2. Verify password (argon2.verify uses timing-safe comparison)
  const valid = await argon2.verify(user.passwordHash, password);
  return valid;
}
```

Notice the subtle security detail in the login function: if the user
doesn't exist, we **still** hash the password. Why? If we return
immediately for non-existent users but take 200ms for existing users
(because of the hash verification), an attacker can time responses to
enumerate which email addresses are registered.

---

## Exercises

### Exercise 1: bcrypt Cost Factor Benchmark

Write a script that benchmarks bcrypt hashing at cost factors 8 through 16.
Print the time taken for each. At what cost factor does hashing take about
250ms on your machine? That's a good starting point.

```typescript
import bcrypt from 'bcrypt';

async function benchmark() {
  const password = 'test-password-123';
  for (let cost = 8; cost <= 16; cost++) {
    const start = performance.now();
    await bcrypt.hash(password, cost);
    const elapsed = performance.now() - start;
    console.log(`Cost ${cost}: ${elapsed.toFixed(1)}ms`);
  }
}
```

### Exercise 2: Salt Visualization

Hash the password "hello" with SHA-256 using 5 different random salts.
Print all 5 results. Then hash it 5 times without a salt. What do you
observe? Write a paragraph explaining why salts matter.

### Exercise 3: Timing Attack Detector

Write two string comparison functions:
1. `unsafeCompare(a, b)` — uses `===`
2. `safeCompare(a, b)` — uses `timingSafeEqual`

Generate two 1000-character hex strings that share the same first 500
characters but differ after that. Run each comparison 100,000 times and
measure the average time. Do you see a timing difference? (Note: modern
CPUs make this hard to observe directly, but the principle matters at scale.)

### Exercise 4: Password Strength Estimator

Write a function `estimateCrackTime(password, hashesPerSecond)` that
estimates how long it would take to brute-force a password given a hash
rate. Consider:
- Character set size (lowercase only? mixed case? numbers? symbols?)
- Password length
- Output the time in human-readable format (seconds, hours, days, years)

Test it with:
- `"abc"` at 10 billion hashes/second (GPU SHA-256)
- `"correcthorsebatterystaple"` at 10 billion hashes/second
- `"P@ssw0rd"` at 10 billion hashes/second

### Exercise 5: Migration Script

You've inherited a database that stores passwords as plain SHA-256 hashes
(no salt). Write a migration strategy:

1. Write a function `migratePasswordOnLogin` that, when a user logs in
   with a correct password, re-hashes it using argon2 and updates the
   stored hash.
2. Write a function `verifyMaybeOldHash` that can verify against both
   the old SHA-256 format and the new argon2 format (detecting which
   format based on the hash prefix).
3. Explain in comments: how do you handle users who never log in?

---

## Summary

| Approach | Security Level | Why |
|----------|---------------|-----|
| Plaintext | None | Instant exposure on breach |
| Base64 "encryption" | None | Encoding, not encryption |
| SHA-256 (no salt) | Very low | Rainbow tables + GPU brute force |
| SHA-256 + salt | Low | GPU brute force (billions/sec) |
| bcrypt | High | Deliberately slow, cost adjustable |
| argon2id | Highest | Memory-hard, GPU-resistant |

**Always use argon2id for new projects. bcrypt is an acceptable fallback.**

Next lesson: once a user is authenticated, how do you keep them "logged in"?
Sessions vs tokens.
