# Lesson 1: Cryptography Basics for Backend Developers

## Why This Lesson Exists

Before we talk about passwords, tokens, or OAuth, we need to understand the
primitives that make all of those things work. Cryptography is the bedrock
of authentication. If you don't understand hashing, encryption, and signing,
you'll treat auth libraries as black boxes — and black boxes are where
security vulnerabilities hide.

**A critical disclaimer before we begin:**

You should almost never implement your own cryptographic algorithms in
production. The algorithms we discuss here have been designed, attacked,
broken, redesigned, and hardened over decades by mathematicians and
cryptographers. Your job as a backend developer is to **understand** these
primitives well enough to use them correctly — to pick the right tool, to
avoid the common mistakes, and to recognize when something smells wrong.

That said, we're going to get our hands dirty. We'll write code that uses
Node's `crypto` module directly, not because you should do this in
production, but because understanding what's happening underneath will make
you a dramatically better engineer.

---

## The Three Pillars of Cryptography

Every security mechanism you'll ever build rests on three operations:

1. **Hashing** — turning data into a fixed-size fingerprint (one-way)
2. **Encryption** — making data unreadable without a key (two-way)
3. **Signing** — proving data hasn't been tampered with and who wrote it

Let's build intuition for each one.

---

## Hashing: One-Way Functions

### The Analogy

Imagine you have a meat grinder. You put a steak in, and you get ground beef
out. Given the ground beef, can you reconstruct the original steak? No.
That's a hash function.

A hash function takes an input of any size and produces a fixed-size output.
The critical properties:

1. **Deterministic**: Same input always produces the same output
2. **One-way**: You cannot reverse the output to get the input
3. **Avalanche effect**: A tiny change in input produces a completely
   different output
4. **Collision resistance**: It's practically impossible to find two
   different inputs that produce the same output

### Why Hashing Matters for Auth

When a user creates a password, you don't store the password. You store
the hash. When they log in, you hash what they typed and compare hashes.
If someone steals your database, they get hashes — not passwords.

(We'll see in the next lesson why this alone isn't enough, but it's the
foundation.)

### SHA-256 in Practice

SHA-256 is part of the SHA-2 family, producing a 256-bit (32-byte) hash.
It's the workhorse of modern cryptography.

```typescript
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Let's see it in action
console.log(sha256('hello'));
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

console.log(sha256('hello '));  // Added a space
// 8ea455700a09ae34fdfad4b1719609e21f0e3e06b57a0849e40a2c1de0740a89

console.log(sha256('hello'));   // Same input again
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

Notice:
- Same input (`'hello'`) always produces the same hash
- Adding a single space completely changes the output (avalanche effect)
- The output is always 64 hex characters (256 bits)

### Hashing Larger Data

Hash functions work on data of any size:

```typescript
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// A short string
console.log(sha256('a').length);  // 64

// A huge string
console.log(sha256('a'.repeat(1_000_000)).length);  // Still 64

// An empty string
console.log(sha256('').length);  // Still 64
```

This fixed-size output property is what makes hashes useful as fingerprints.
You can hash a 10GB file and get a 32-byte fingerprint to verify integrity.

### Streaming Hashes

For large files, you don't want to load everything into memory:

```typescript
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

### Common Hash Algorithms

| Algorithm | Output Size | Status |
|-----------|-------------|--------|
| MD5       | 128 bits    | **BROKEN** — collisions found. Never use for security. |
| SHA-1     | 160 bits    | **DEPRECATED** — practical collision attacks exist. |
| SHA-256   | 256 bits    | Secure. Standard choice for general hashing. |
| SHA-384   | 384 bits    | Secure. Used when you need more bits. |
| SHA-512   | 512 bits    | Secure. Faster than SHA-256 on 64-bit systems. |
| SHA-3     | Variable    | Secure. Different design than SHA-2 (Keccak). |

**Thought experiment:** Why does it matter that MD5 has collisions? Imagine
you're verifying a software download. If an attacker can create a malicious
file with the same MD5 hash as the legitimate file, your integrity check
is worthless. The same logic applies to digital signatures and certificates.

### SHA-3 (Keccak): The Insurance Policy

SHA-3 was standardized by NIST in 2015 as a backup for SHA-2. It's not
that SHA-2 is broken — it's that SHA-3 uses a completely different internal
design (called the "sponge construction" based on the Keccak algorithm).

Why does this matter? If someone discovers a structural weakness in SHA-2's
Merkle-Damgård construction, SHA-3 wouldn't be affected because it works
differently. It's cryptographic biodiversity.

```typescript
import { createHash } from 'node:crypto';

// SHA-3 variants
const sha3_256 = createHash('sha3-256').update('hello').digest('hex');
const sha3_512 = createHash('sha3-512').update('hello').digest('hex');

console.log('SHA-3-256:', sha3_256);
// 3338be694f50c5f338814986cdf0686453a888b84f424d792af4b9202398f392

console.log('SHA-3-512:', sha3_512);
// 75d527c368f2efe848ecf6b073a36767800805e9eef2b1857d5f984f036eb6df...

// Compare with SHA-2
const sha2_256 = createHash('sha256').update('hello').digest('hex');
console.log('SHA-2-256:', sha2_256);
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
// Same input, completely different hash — different algorithms
```

Key differences from SHA-2:

| Property | SHA-2 | SHA-3 |
|---------|-------|-------|
| Internal structure | Merkle-Damgård | Sponge (Keccak) |
| Length extension attack | Vulnerable | **Immune** |
| Hardware performance | Faster (widely optimized) | Slower (newer) |
| Software performance | Fast | Comparable |
| Adoption | Ubiquitous | Growing |

The length extension vulnerability is worth understanding: with SHA-2,
if you know `SHA256(message)` and the length of `message`, you can compute
`SHA256(message || attacker_data)` without knowing `message`. This is why
HMAC exists (it prevents this attack). SHA-3 is immune to this by design.

**When to use SHA-3:** If your threat model requires defense-in-depth
against theoretical future breaks in SHA-2, or if you need immunity to
length extension attacks without using HMAC. For most applications,
SHA-256 remains the standard choice.

---

## Symmetric Encryption: One Key to Rule Them All

### The Analogy

Symmetric encryption is like a padlock where the same key locks and unlocks.
You and your friend both have a copy of the same key. You lock a box, send
it, and your friend unlocks it.

The problem: how do you give your friend the key in the first place? If
someone intercepts the key, they can read all your messages. This is called
the **key distribution problem**.

### AES: The Standard

AES (Advanced Encryption Standard) is the most widely used symmetric cipher.
It was selected by NIST in 2001 after a multi-year competition.

Key sizes: 128, 192, or 256 bits. AES-256 is standard for sensitive data.

```typescript
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

interface EncryptedData {
  iv: string;         // Initialization vector (random per encryption)
  tag: string;        // Authentication tag (GCM provides this)
  ciphertext: string; // The encrypted data
}

function encrypt(plaintext: string, key: Buffer): EncryptedData {
  // IV must be unique for every encryption with the same key
  // 12 bytes is the recommended size for GCM
  const iv = randomBytes(12);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext,
  };
}

function decrypt(data: EncryptedData, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(data.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));

  let plaintext = decipher.update(data.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

// Derive a 256-bit key from a password
const key = scryptSync('my-secret-password', 'salt-value', 32);

const encrypted = encrypt('Sensitive user data', key);
console.log('Encrypted:', encrypted);
// { iv: '...', tag: '...', ciphertext: '...' }

const decrypted = decrypt(encrypted, key);
console.log('Decrypted:', decrypted);
// 'Sensitive user data'
```

### Why GCM Mode Matters

AES is a block cipher — it encrypts 16 bytes at a time. "Modes" define
how to handle data larger than 16 bytes. There are many modes, but you
should almost always use **GCM** (Galois/Counter Mode):

- **ECB** (Electronic Codebook): Encrypts each block independently.
  Identical plaintext blocks produce identical ciphertext blocks. This
  is catastrophically bad — you can see patterns in the encrypted data.
  The famous "ECB penguin" example shows an encrypted image where the
  penguin shape is clearly visible.

- **CBC** (Cipher Block Chaining): Each block XORed with the previous
  ciphertext block. Better, but vulnerable to padding oracle attacks
  if not implemented carefully.

- **GCM** (Galois/Counter Mode): Counter mode encryption with built-in
  authentication. It tells you if the ciphertext has been tampered with.
  **Use this.**

### When to Use Symmetric Encryption

- Encrypting data at rest (database fields, files)
- Encrypting session data
- Any time both the encryptor and decryptor share a secret key
- Encrypting data in transit (TLS uses symmetric encryption for the
  actual data, after key exchange)

---

## Asymmetric Encryption: Two Keys, One Relationship

### The Analogy

Imagine a special mailbox. Anyone can drop a letter in through the slot
(encrypt with the public key), but only the person with the mailbox key
can open it and read the letters (decrypt with the private key).

The magic: the public key and private key are mathematically related, but
knowing the public key doesn't let you figure out the private key.

### RSA

RSA is the oldest widely-used asymmetric algorithm (1977). It's based on
the mathematical difficulty of factoring large prime numbers.

```typescript
import {
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
} from 'node:crypto';

// Generate a key pair (this is slow — do it once, store the keys)
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Anyone with the public key can encrypt
const encrypted = publicEncrypt(publicKey, Buffer.from('Secret message'));
console.log('Encrypted:', encrypted.toString('base64').slice(0, 40) + '...');

// Only the private key holder can decrypt
const decrypted = privateDecrypt(privateKey, encrypted);
console.log('Decrypted:', decrypted.toString('utf8'));
// 'Secret message'
```

### Ed25519: Modern and Fast

Ed25519 is an elliptic curve algorithm. It's faster and uses smaller keys
than RSA while providing equivalent security.

```typescript
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

console.log(publicKey);
// Much shorter than RSA keys
```

Ed25519 is primarily used for **signing** (not encryption). It's the
preferred algorithm for SSH keys, and it's what many modern JWT
implementations use (EdDSA).

### RSA vs Ed25519

| Property     | RSA-2048        | Ed25519          |
|-------------|-----------------|------------------|
| Key size    | 2048+ bits      | 256 bits         |
| Speed       | Slow            | Very fast        |
| Signature   | Large (~256 B)  | Small (64 B)     |
| Maturity    | 1977, very old  | 2011, newer      |
| Use case    | Encryption + signing | Signing only |

### When to Use Asymmetric Encryption

- When the sender and receiver can't share a secret key in advance
- TLS handshake (exchanging the symmetric key)
- Digital signatures (JWTs signed with RS256 or EdDSA)
- SSH authentication
- Email encryption (PGP/GPG)

---

## Digital Signatures

### The Analogy

A handwritten signature proves you wrote a document. A digital signature
does the same thing, but it's mathematically verifiable and impossible
to forge.

The process:
1. Hash the message to get a fixed-size digest
2. Encrypt the digest with your **private** key (this is the signature)
3. Anyone with your **public** key can decrypt the signature and compare
   it to their own hash of the message
4. If they match, the message is authentic and untampered

```typescript
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Sign a message
function signMessage(message: string, privKey: string): string {
  const signer = createSign('SHA256');
  signer.update(message);
  return signer.sign(privKey, 'base64');
}

// Verify a signature
function verifyMessage(
  message: string,
  signature: string,
  pubKey: string
): boolean {
  const verifier = createVerify('SHA256');
  verifier.update(message);
  return verifier.verify(pubKey, signature, 'base64');
}

const message = 'Transfer $100 to Alice';
const signature = signMessage(message, privateKey);

console.log(verifyMessage(message, signature, publicKey));
// true

// Tamper with the message
console.log(verifyMessage('Transfer $1000 to Alice', signature, publicKey));
// false — the signature doesn't match the tampered message
```

### Why Digital Signatures Matter for Auth

JWTs are digitally signed. When your server creates a JWT, it signs the
token with a secret (HMAC) or private key (RSA/EdDSA). When your server
receives a JWT back, it verifies the signature to ensure:

1. The token was created by your server (authenticity)
2. The token hasn't been modified (integrity)

---

## HMAC: Message Authentication Codes

### The Problem HMAC Solves

Digital signatures use asymmetric keys. But what if both parties share the
same secret key? You need a way to prove a message is authentic using a
**symmetric** key. That's HMAC.

HMAC = Hash-based Message Authentication Code

### How HMAC Works

HMAC takes a message and a secret key, and produces a fixed-size tag:

```
HMAC(key, message) = Hash((key XOR opad) || Hash((key XOR ipad) || message))
```

Don't worry about the formula. What matters:
- It uses a hash function internally (e.g., SHA-256)
- The output depends on both the message AND the key
- Without the key, you can't produce a valid HMAC
- Unlike a plain hash, an HMAC proves the sender knows the secret

### HMAC in Code

```typescript
import { createHmac } from 'node:crypto';

const SECRET = 'my-shared-secret-key';

function createMac(message: string): string {
  return createHmac('sha256', SECRET).update(message).digest('hex');
}

function verifyMac(message: string, mac: string): boolean {
  const expected = createMac(message);
  return expected === mac;
  // WARNING: This comparison is vulnerable to timing attacks.
  // We'll fix this in a moment.
}

const message = 'user_id=42&role=admin';
const mac = createMac(message);

console.log(verifyMac(message, mac));          // true
console.log(verifyMac(message + '!', mac));    // false
```

### Timing-Safe Comparison

The naive `===` comparison above is vulnerable to timing attacks. Here's why:

String comparison typically checks character by character and returns `false`
as soon as it finds a mismatch. An attacker can measure how long the
comparison takes. If comparing the first character takes 1ms and matching
it takes 1.1ms, the attacker knows the first character is correct and
can try the next one.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = 'my-shared-secret-key';

function createMac(message: string): Buffer {
  return createHmac('sha256', SECRET).update(message).digest();
}

function verifyMac(message: string, mac: Buffer): boolean {
  const expected = createMac(message);
  if (expected.length !== mac.length) return false;
  return timingSafeEqual(expected, mac);
}
```

`timingSafeEqual` takes the same amount of time regardless of where the
mismatch occurs. Always use it when comparing secrets, hashes, or MACs.

### Where HMAC Shows Up

- JWT signing with HS256 (HMAC + SHA-256)
- API request signing (AWS Signature v4)
- Webhook verification (GitHub, Stripe send HMAC signatures)
- Cookie signing

---

## The Great Confusion: Encoding vs Encryption vs Hashing

This trips up a staggering number of developers. Let's clear it up.

### Encoding

**Purpose:** Represent data in a different format for transport or storage.
**Security:** NONE. Anyone can decode it. It's not a security mechanism.

```typescript
// Base64 encoding
const encoded = Buffer.from('hello').toString('base64');
console.log(encoded);  // 'aGVsbG8='

const decoded = Buffer.from(encoded, 'base64').toString('utf8');
console.log(decoded);  // 'hello'
```

Base64 is NOT encryption. It's just a way to represent binary data as
ASCII text. If you see a JWT and think "it's encrypted because it looks
like random characters" — no. The header and payload are just Base64URL
encoded. Anyone can decode them.

```typescript
// "Decrypting" a JWT payload? No. Just decoding it.
const payload = 'eyJ1c2VyX2lkIjo0Miwicm9sZSI6ImFkbWluIn0';
console.log(Buffer.from(payload, 'base64url').toString('utf8'));
// {"user_id":42,"role":"admin"}
```

### Encryption

**Purpose:** Make data unreadable without a key.
**Security:** Strong — but reversible with the correct key.
**Key property:** Two-way. Encrypt and decrypt.

```typescript
// Symmetric: same key encrypts and decrypts
// encrypt(key, 'hello') -> 'a7f3b2...'
// decrypt(key, 'a7f3b2...') -> 'hello'
```

### Hashing

**Purpose:** Create a fixed-size fingerprint of data.
**Security:** One-way. Cannot recover the original data.
**Key property:** Irreversible. No "unhash" function exists.

```typescript
// hash('hello') -> '2cf24dba...'
// unhash('2cf24dba...') -> ??? (impossible)
```

### The Cheat Sheet

| Property     | Encoding      | Encryption     | Hashing        |
|-------------|---------------|----------------|----------------|
| Reversible? | Yes (no key)  | Yes (with key) | No             |
| Needs a key?| No            | Yes            | No (HMAC does) |
| Purpose     | Format data   | Hide data      | Fingerprint    |
| Example     | Base64, URL   | AES, RSA       | SHA-256, bcrypt|
| Security?   | None          | Confidentiality| Integrity      |

### Bad Code: The Confusion in Action

```typescript
// BAD: "encrypting" a password with Base64
function "encryptPassword"(password: string): string {
  return Buffer.from(password).toString('base64');
}
// This is encoding, not encryption. Anyone can reverse it.

// BAD: Using encryption for passwords
function encryptPassword(password: string, key: Buffer): string {
  // Even if you use real AES encryption, this is wrong.
  // If someone gets the key, they get ALL passwords.
  // Passwords should be HASHED, not encrypted.
}

// CORRECT: Hashing passwords (simplified — we'll do this properly next lesson)
import { createHash } from 'node:crypto';
function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}
// One-way. No key to steal. But SHA-256 alone isn't enough for passwords
// (we'll see why next lesson).
```

---

## Putting It All Together: A Mental Model

Think of building a secure auth system like building a house:

- **Hashing** is the foundation. Password storage, data integrity checks.
- **Symmetric encryption** is the walls. Protecting data at rest, session
  encryption.
- **Asymmetric encryption** is the locks and keys. Key exchange, digital
  signatures, TLS.
- **HMAC** is the tamper-evident seal. Verifying that messages haven't been
  modified.
- **Encoding** is the paint. It changes how things look, but provides no
  structural security.

Every auth mechanism we build in this module uses combinations of these
primitives:

- **Password storage**: Hashing (specialized: bcrypt/argon2)
- **JWT tokens**: Base64URL encoding + HMAC or RSA signing
- **Session cookies**: Symmetric encryption + HMAC signing
- **OAuth tokens**: Asymmetric signing + HTTPS (TLS)
- **API keys**: Random generation + hashing for storage

---

## Why Cryptography Fails in Implementation, Not Theory

The algorithms themselves are solid. SHA-256 hasn't been broken. AES hasn't
been broken. RSA with proper key sizes hasn't been broken. What breaks is
how developers USE these algorithms.

Here are the most common implementation failures, ranked by how often they
cause real-world breaches:

### 1. Using Crypto for the Wrong Purpose

```typescript
// WRONG: Encrypting passwords (should be hashing)
const encryptedPassword = encrypt(password, key);
// If the key leaks, ALL passwords are exposed instantly

// WRONG: Hashing data you need to retrieve (should be encrypting)
const hashedCreditCard = sha256(creditCard);
// One-way — you can never get the credit card back

// WRONG: Using encoding for security (not cryptographic at all)
const "secured" = Buffer.from(password).toString('base64');
// Anyone can decode this
```

### 2. Rolling Your Own Crypto

```typescript
// WRONG: Custom "encryption" algorithm
function myEncrypt(text: string, key: string): string {
  return text.split('').map((char, i) =>
    String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length))
  ).join('');
}
// This is a simple XOR cipher. It's trivially breakable.
```

### 3. Reusing IVs/Nonces

```typescript
// WRONG: Hardcoded IV
const iv = Buffer.from('1234567890123456');
// Reusing an IV with the same key in AES-GCM is catastrophic.
// It allows an attacker to recover the encryption key.

// RIGHT: Random IV for every encryption
const iv = randomBytes(12);
```

### 4. Weak Keys and Secrets

```typescript
// WRONG: Predictable keys
const key = 'secret';                      // Dictionary-attackable
const key = 'my-app-key-2024';             // Guessable
const key = sha256('my-password');          // Password-derived without KDF

// RIGHT: Cryptographically random keys
const key = randomBytes(32);               // 256 bits of entropy
const key = scryptSync(password, salt, 32); // Proper KDF for password-derived keys
```

### 5. Comparing Secrets with === (Timing Attacks)

```typescript
// WRONG: Early-exit comparison
if (userToken === storedToken) { /* ... */ }
// Leaks information about which bytes match

// RIGHT: Constant-time comparison
if (timingSafeEqual(Buffer.from(userToken), Buffer.from(storedToken))) { /* ... */ }
```

### 6. Not Validating Cryptographic Output

```typescript
// WRONG: Not checking the authentication tag in AES-GCM
try {
  const plaintext = decrypt(ciphertext, key);
  // If the tag verification fails, this data may have been tampered with
  // but some implementations silently return garbage
} catch (err) {
  // This error is CRITICAL — it means tampering was detected
  // But developers often swallow it
}
```

The lesson: **understand the primitive, understand its guarantees and
limitations, and use it exactly as designed.** Cryptography is not a
black box you can creatively adapt.

---

## Randomness: The Unsung Hero

All of cryptography depends on good random numbers. If your random number
generator is predictable, everything built on top of it is broken.

```typescript
import { randomBytes, randomUUID, randomInt } from 'node:crypto';

// Generate cryptographically secure random bytes
const bytes = randomBytes(32);
console.log(bytes.toString('hex'));  // 64 hex characters of randomness

// Generate a random UUID (v4)
const id = randomUUID();
console.log(id);  // e.g., 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

// Generate a random integer in a range
const num = randomInt(1, 100);
console.log(num);  // Random number between 1 and 99
```

**Never use `Math.random()` for anything security-related.** It uses a
PRNG (pseudorandom number generator) that is predictable if you know the
seed. Node's `crypto.randomBytes` uses the operating system's CSPRNG
(cryptographically secure PRNG), which gathers entropy from hardware
events.

### CSPRNG vs PRNG: The Critical Difference

| Property | PRNG (Math.random) | CSPRNG (crypto.randomBytes) |
|----------|-------------------|-----------------------------|
| Seed | Single value (often time-based) | OS entropy pool (hardware events, interrupts) |
| Predictable? | Yes — if seed is known | No — computationally infeasible |
| Output quality | Statistically random | Cryptographically random |
| Speed | Very fast | Slightly slower |
| Use case | Games, simulations | Tokens, keys, salts, IVs |
| Recovery | Given enough output, can recover internal state | Cannot recover internal state |

The danger isn't that `Math.random()` looks non-random — it does look
random in statistical tests. The danger is that its internal state can be
recovered. V8's `Math.random` uses the xorshift128+ algorithm. Given
enough output values, an attacker can reconstruct the internal state and
predict ALL future values.

```typescript
// PRNG: Predictable if you know the state
// V8 uses xorshift128+ — an attacker can reverse-engineer the state
// from as few as ~64 observed outputs of Math.random()

// BAD: Generating a session token
const token = Math.random().toString(36).substring(2);
// Predictable! An attacker can guess future values.

// BAD: Generating a reset code
const resetCode = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
// An attacker who observes other random values from your app
// can predict this code.

// GOOD: Generating a session token
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('hex');
// 64 hex characters of cryptographic randomness

// GOOD: Generating a reset code
import { randomInt } from 'node:crypto';
const resetCode = randomInt(0, 1000000).toString().padStart(6, '0');
// Cryptographically random — cannot be predicted
```

**Where does a CSPRNG get its entropy?** The operating system collects
"entropy" from hardware events: keyboard timing, mouse movements, disk
I/O timing, interrupt timing, and dedicated hardware random number
generators (RDRAND on Intel CPUs). This entropy is mixed into a pool,
and the CSPRNG uses this pool to generate unpredictable output. On Linux,
this is `/dev/urandom`. On Windows, it's `BCryptGenRandom`.

---

## Key Derivation Functions (KDFs)

Sometimes you need to derive a cryptographic key from a password or other
low-entropy source. You can't just hash it — passwords are too short and
predictable. KDFs add computational cost to slow down brute-force attacks.

```typescript
import { scryptSync, randomBytes } from 'node:crypto';

// Derive a 256-bit key from a password
const salt = randomBytes(16);
const key = scryptSync('user-password', salt, 32, {
  N: 16384,   // CPU/memory cost parameter
  r: 8,       // Block size
  p: 1,       // Parallelism
});

console.log(key.toString('hex'));
// This key can now be used for AES encryption
```

`scrypt` is deliberately slow. It uses a lot of memory, making it
expensive to run on GPUs (which attackers use for brute-force attacks).
We'll see this concept again with bcrypt and argon2 in the next lesson.

---

## Exercises

### Exercise 1: Hash Explorer

Write a function that takes a string and returns an object with the hash
produced by MD5, SHA-1, SHA-256, and SHA-512. Compare the output lengths.
Then hash two strings that differ by a single character and observe the
avalanche effect.

```typescript
function multiHash(input: string): Record<string, string> {
  // Your implementation
}

// Test:
// console.log(multiHash('hello'));
// console.log(multiHash('hellp'));  // One character different
```

### Exercise 2: Encrypt-Decrypt Round Trip

Write `encrypt` and `decrypt` functions using AES-256-GCM. Verify that
encrypting the same plaintext twice with the same key produces different
ciphertexts (because the IV is random). Then verify that decrypting with
the wrong key throws an error.

### Exercise 3: HMAC Webhook Verifier

Simulate a webhook verification system. Write a function `signPayload`
that takes a JSON payload and a secret, and returns an HMAC-SHA256
signature. Write a function `verifyWebhook` that takes a payload, a
signature, and a secret, and returns whether the signature is valid.
Use `timingSafeEqual` for comparison.

```typescript
function signPayload(payload: object, secret: string): string {
  // Your implementation
}

function verifyWebhook(
  payload: object,
  signature: string,
  secret: string
): boolean {
  // Your implementation — use timingSafeEqual!
}
```

### Exercise 4: Digital Signature Verification

Generate an RSA key pair. Sign a message with the private key. Verify
the signature with the public key. Then modify the message by one
character and verify again — it should fail.

### Exercise 5: Encoding Detective

You receive this string from a colleague who says it's "encrypted":

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ
```

Decode it and explain what it actually is. Is it encrypted? Is it
secure? What's missing that would make it secure?

---

## Summary

| Concept | What It Does | Key Property | Auth Use Case |
|---------|-------------|--------------|---------------|
| SHA-256 | Hashes data | One-way, fixed output | Data integrity |
| AES-GCM | Encrypts data | Two-way with key | Encrypting stored data |
| RSA/Ed25519 | Asymmetric crypto | Key pair | Signatures, key exchange |
| HMAC | Authenticates messages | Requires shared secret | JWT signing, webhooks |
| Encoding | Changes format | No security | Data transport (Base64) |

Next lesson, we'll use these primitives to solve a real problem: how to
store passwords so that even a database breach doesn't expose them.
