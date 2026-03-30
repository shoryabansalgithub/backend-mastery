# Lesson 9: Advanced Auth Systems

## Beyond Passwords

Passwords are the weakest link in authentication. Even with argon2, breach
checking, and rate limiting, passwords suffer from fundamental problems:

1. **Phishing**: Users can be tricked into entering passwords on fake sites
2. **Credential reuse**: Most users reuse passwords across sites
3. **Social engineering**: Humans are the weakest link
4. **Keyloggers/malware**: Passwords can be captured during entry
5. **Memorability vs security**: Strong passwords are hard to remember

This lesson covers the advanced systems that layer on top of — or replace —
passwords entirely.

---

## Multi-Factor Authentication (MFA)

### The Three Factors

Authentication factors fall into three categories:

```
1. Something you KNOW    → Password, PIN, security questions
2. Something you HAVE    → Phone, hardware key, authenticator app
3. Something you ARE     → Fingerprint, face, iris scan
```

MFA requires two or more factors from **different categories**. Two
passwords is not MFA (both are "something you know"). A password plus a
TOTP code IS MFA (know + have).

### TOTP: Time-Based One-Time Passwords

TOTP is the most common second factor. It's what Google Authenticator,
Authy, and 1Password generate — those 6-digit codes that change every
30 seconds.

#### How TOTP Works

```
1. During setup:
   - Server generates a random secret (20 bytes)
   - Server shares the secret with the user's authenticator app
     (usually via QR code)
   - Both sides now have the same secret

2. During login:
   - User enters their password (factor 1)
   - User opens their authenticator app
   - The app computes: HMAC-SHA1(secret, floor(time / 30))
   - Takes 6 digits from the hash
   - User enters the 6 digits (factor 2)
   - Server does the same computation
   - If they match → authenticated
```

The key insight: both the server and the app independently compute the
same code from the shared secret and the current time. No network
connection needed for the authenticator app.

#### Implementing TOTP

```typescript
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Generate a base32-encoded secret for the user
function generateTOTPSecret(): string {
  const buffer = randomBytes(20);
  return base32Encode(buffer);
}

// Base32 encoding (RFC 4648)
function base32Encode(buffer: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 31];
  }

  return result;
}

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of encoded.toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

// Generate a TOTP code for the current time
function generateTOTP(secret: string, timeStep: number = 30): string {
  const key = base32Decode(secret);
  const time = Math.floor(Date.now() / 1000 / timeStep);

  // Convert time to 8-byte big-endian buffer
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  // HMAC-SHA1
  const hmac = createHmac('sha1', key).update(timeBuffer).digest();

  // Dynamic truncation (RFC 6238 / RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;

  return code.toString().padStart(6, '0');
}

// Verify a TOTP code with clock drift tolerance
function verifyTOTP(
  secret: string,
  userCode: string,
  windowSize: number = 1  // Allow 1 step before/after
): boolean {
  for (let i = -windowSize; i <= windowSize; i++) {
    const time = Math.floor(Date.now() / 1000 / 30) + i;

    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(time));

    const key = base32Decode(secret);
    const hmac = createHmac('sha1', key).update(timeBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1_000_000;

    const expected = code.toString().padStart(6, '0');

    // Timing-safe comparison
    if (
      expected.length === userCode.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(userCode))
    ) {
      return true;
    }
  }

  return false;
}
```

#### TOTP Setup Flow

```typescript
// Step 1: User enables MFA — generate secret and show QR code
app.post('/auth/mfa/setup', authenticate, async (req, res) => {
  const userId = req.user.userId;
  const secret = generateTOTPSecret();

  // Store the secret temporarily (not yet confirmed)
  await storePendingMFASecret(userId, secret);

  // Generate OTPAUTH URI for QR code
  const user = await getUserById(userId);
  const otpauthUrl = `otpauth://totp/YourApp:${user.email}?` +
    `secret=${secret}&issuer=YourApp&algorithm=SHA1&digits=6&period=30`;

  res.json({
    secret,         // For manual entry
    otpauthUrl,     // For QR code generation
    // Client generates QR code from otpauthUrl
  });
});

// Step 2: User scans QR code and enters a verification code
app.post('/auth/mfa/verify-setup', authenticate, async (req, res) => {
  const { code } = req.body;
  const userId = req.user.userId;

  const secret = await getPendingMFASecret(userId);
  if (!secret) {
    return res.status(400).json({ error: 'No pending MFA setup' });
  }

  if (!verifyTOTP(secret, code)) {
    return res.status(400).json({ error: 'Invalid code. Try again.' });
  }

  // MFA is now verified — save it permanently
  await enableMFA(userId, secret);
  await deletePendingMFASecret(userId);

  // Generate recovery codes
  const recoveryCodes = generateRecoveryCodes();
  await storeRecoveryCodes(userId, recoveryCodes);

  res.json({
    message: 'MFA enabled successfully',
    recoveryCodes, // Show ONCE — user must save these
  });
});

// Generate one-time recovery codes
function generateRecoveryCodes(count: number = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(4).toString('hex').toUpperCase().match(/.{4}/g)!.join('-')
    // e.g., "A1B2-C3D4"
  );
}
```

#### Login with MFA

```typescript
app.post('/auth/login', async (req, res) => {
  const { email, password, mfaCode } = req.body;

  // Step 1: Verify password
  const user = await verifyCredentials(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Step 2: Check if MFA is enabled
  if (user.mfaEnabled) {
    if (!mfaCode) {
      // Return a partial auth response — client must prompt for MFA
      return res.status(200).json({
        requiresMFA: true,
        mfaToken: createMFAToken(user.id), // Short-lived token for MFA step
      });
    }

    // Try TOTP code first
    const secret = await getMFASecret(user.id);
    let mfaValid = verifyTOTP(secret, mfaCode);

    // If TOTP fails, try recovery codes
    if (!mfaValid) {
      mfaValid = await verifyAndConsumeRecoveryCode(user.id, mfaCode);
    }

    if (!mfaValid) {
      return res.status(401).json({ error: 'Invalid MFA code' });
    }
  }

  // Step 3: Issue tokens
  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = issueRefreshToken(user.id);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken });
});

// MFA token — allows the user to complete the MFA step without
// re-entering their password
function createMFAToken(userId: string): string {
  return jwt.sign(
    { sub: userId, purpose: 'mfa' },
    MFA_SECRET,
    { expiresIn: '5m' }
  );
}

// Second endpoint for MFA step (alternative to inline MFA)
app.post('/auth/mfa/verify', async (req, res) => {
  const { mfaToken, code } = req.body;

  try {
    const payload = jwt.verify(mfaToken, MFA_SECRET, {
      algorithms: ['HS256'],
    }) as { sub: string; purpose: string };

    if (payload.purpose !== 'mfa') {
      return res.status(401).json({ error: 'Invalid MFA token' });
    }

    const secret = await getMFASecret(payload.sub);
    if (!verifyTOTP(secret, code)) {
      return res.status(401).json({ error: 'Invalid MFA code' });
    }

    // Issue full tokens
    const user = await getUserById(payload.sub);
    const accessToken = createAccessToken(user.id, user.role);
    const refreshToken = issueRefreshToken(user.id);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired MFA token' });
  }
});
```

### TOTP Limitations

1. **Phishable**: A phishing site can relay the TOTP code in real-time
2. **Shared secret**: The server stores the secret — if breached, all MFA is compromised
3. **Clock drift**: Server and device clocks must be roughly synchronized
4. **User friction**: Users lose their phone or delete the authenticator app

---

## WebAuthn / Passkeys

### Why WebAuthn Exists

WebAuthn (Web Authentication API) solves the problems that TOTP doesn't:

| Property | TOTP | WebAuthn |
|----------|------|---------|
| Phishing resistant | No | **Yes** — browser verifies the domain |
| Server stores secret | Yes | **No** — only public key |
| User friction | High (6 digits) | **Low** (fingerprint/face) |
| Device bound | No (codes transferable) | **Yes** (keys in hardware) |

### How WebAuthn Works

WebAuthn uses public key cryptography. Instead of a shared secret, each
credential has a key pair:

```
Registration:
  1. Server sends a challenge (random bytes)
  2. Browser asks the authenticator (fingerprint/face/security key)
  3. Authenticator creates a new key pair
  4. Authenticator signs the challenge with the private key
  5. Browser sends the public key + signed challenge to the server
  6. Server stores the public key (not secret — safe to store)

Authentication:
  1. Server sends a challenge
  2. Browser asks the authenticator
  3. Authenticator signs the challenge with the private key
  4. Browser sends the signed challenge to the server
  5. Server verifies the signature with the stored public key
```

The private key NEVER leaves the authenticator device.

### WebAuthn Registration

```typescript
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

const RP_NAME = 'Your App';
const RP_ID = 'your-app.com';
const ORIGIN = 'https://your-app.com';

// Step 1: Generate registration options
app.post('/auth/webauthn/register/options', authenticate, async (req, res) => {
  const userId = req.user.userId;
  const user = await getUserById(userId);

  // Get existing credentials (to prevent re-registration)
  const existingCredentials = await getWebAuthnCredentials(userId);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: userId,
    userName: user.email,
    userDisplayName: user.name,
    // Exclude existing credentials to prevent duplicates
    excludeCredentials: existingCredentials.map(cred => ({
      id: cred.credentialId,
      type: 'public-key',
      transports: cred.transports,
    })),
    authenticatorSelection: {
      // Prefer platform authenticators (fingerprint, face)
      authenticatorAttachment: 'platform',
      // Require user verification (biometric/PIN)
      userVerification: 'required',
      // Require the authenticator to store the credential
      residentKey: 'required',
    },
  });

  // Store the challenge for verification
  await storeChallenge(userId, options.challenge);

  res.json(options);
});

// Step 2: Verify registration response
app.post('/auth/webauthn/register/verify', authenticate, async (req, res) => {
  const userId = req.user.userId;
  const response: RegistrationResponseJSON = req.body;

  const expectedChallenge = await getChallenge(userId);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'No pending challenge' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    const { credentialPublicKey, credentialID, counter } =
      verification.registrationInfo;

    // Store the credential
    await storeWebAuthnCredential({
      userId,
      credentialId: Buffer.from(credentialID).toString('base64url'),
      publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter,
      transports: response.response.transports,
      createdAt: Date.now(),
    });

    res.json({ message: 'Passkey registered successfully' });
  } catch (err) {
    return res.status(400).json({ error: `Registration failed: ${err}` });
  } finally {
    await deleteChallenge(userId);
  }
});
```

### WebAuthn Authentication

```typescript
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';

// Step 1: Generate authentication options
app.post('/auth/webauthn/login/options', async (req, res) => {
  const { email } = req.body;

  // Get user's credentials (if they exist)
  const user = await findUserByEmail(email);
  const credentials = user ? await getWebAuthnCredentials(user.id) : [];

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: credentials.map(cred => ({
      id: cred.credentialId,
      type: 'public-key',
      transports: cred.transports,
    })),
    userVerification: 'required',
  });

  // Store challenge (keyed by a temporary session)
  const challengeId = randomBytes(16).toString('hex');
  await storeChallenge(challengeId, options.challenge);

  res.json({ ...options, challengeId });
});

// Step 2: Verify authentication response
app.post('/auth/webauthn/login/verify', async (req, res) => {
  const { challengeId, ...response } = req.body as
    AuthenticationResponseJSON & { challengeId: string };

  const expectedChallenge = await getChallenge(challengeId);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired' });
  }

  // Find the credential
  const credentialId = response.id;
  const credential = await findWebAuthnCredentialById(credentialId);

  if (!credential) {
    return res.status(401).json({ error: 'Unknown credential' });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialPublicKey: Buffer.from(credential.publicKey, 'base64url'),
        credentialID: Buffer.from(credential.credentialId, 'base64url'),
        counter: credential.counter,
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    // Update counter (for clone detection)
    await updateCredentialCounter(
      credential.credentialId,
      verification.authenticationInfo.newCounter
    );

    // Issue tokens
    const user = await getUserById(credential.userId);
    const accessToken = createAccessToken(user.id, user.role);
    const refreshToken = issueRefreshToken(user.id);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken });
  } catch (err) {
    return res.status(401).json({ error: `Verification failed: ${err}` });
  } finally {
    await deleteChallenge(challengeId);
  }
});
```

### Passkeys: The Future of Auth

Passkeys are WebAuthn credentials that sync across devices. Apple, Google,
and Microsoft have all implemented passkey support in their operating
systems.

```
Traditional WebAuthn:
  Key pair bound to a SINGLE device
  Lost phone = lost access
  Need to register each device separately

Passkeys:
  Key pair synced via cloud (iCloud Keychain, Google Password Manager)
  Available on all your devices
  Seamless cross-device authentication
```

### Counter-Based Clone Detection

WebAuthn authenticators maintain a counter that increments on each use.
If the counter in the authentication response is less than or equal to
the stored counter, it means the credential was cloned:

```typescript
async function verifyCounter(
  credentialId: string,
  newCounter: number
): boolean {
  const stored = await getStoredCounter(credentialId);

  if (newCounter <= stored) {
    // CLONE DETECTED — the credential has been duplicated
    console.error(`Credential clone detected: ${credentialId}`);
    // Disable the credential and alert the user
    await disableCredential(credentialId);
    await notifyUser(credentialId, 'possible_clone');
    return false;
  }

  await updateStoredCounter(credentialId, newCounter);
  return true;
}
```

---

## Zero-Trust Architecture

### The Old Model: Trust the Network

```
Traditional ("castle and moat"):
  ┌─────────────────────────────────────┐
  │            Trusted Network           │
  │  ┌──────┐  ┌──────┐  ┌──────┐      │
  │  │Svc A │──│Svc B │──│Svc C │      │
  │  └──────┘  └──────┘  └──────┘      │
  │                                      │
  │  Everything inside is trusted.       │
  │  Firewall protects the boundary.     │
  └─────────────────────────────────────┘
```

This model assumes that anything inside the network is safe. Once VPNs,
remote work, and cloud services entered the picture, the perimeter
dissolved. An attacker who gets past the firewall has unrestricted
access to everything.

### The Zero-Trust Model

```
Zero Trust:
  ┌──────┐    authenticated    ┌──────┐
  │Svc A │─── + authorized ──→│Svc B │
  └──────┘    + encrypted      └──────┘

  Every request is verified.
  No implicit trust based on network location.
  Access is granted per-request, not per-network.
```

### Zero-Trust Principles for Backend Developers

**1. Never trust, always verify**

Even service-to-service calls within your network must be authenticated:

```typescript
// BAD — trusting because it's "internal"
app.get('/internal/user/:id', (req, res) => {
  // No auth check — assumes only internal services call this
  const user = await getUserById(req.params.id);
  res.json(user);
});

// GOOD — verify every request
app.get('/internal/user/:id', authenticateServiceToken, (req, res) => {
  // Service must present a valid service token
  const user = await getUserById(req.params.id);
  res.json(user);
});
```

**2. Least privilege**

Each service gets the minimum permissions it needs:

```typescript
// Service A only needs read access to users
const serviceAToken = jwt.sign({
  sub: 'service-a',
  permissions: ['users:read'],
}, SERVICE_SECRET);

// Service B needs read and write
const serviceBToken = jwt.sign({
  sub: 'service-b',
  permissions: ['users:read', 'users:write', 'orders:read'],
}, SERVICE_SECRET);
```

**3. Mutual TLS (mTLS)**

Both the client AND server present certificates. This authenticates both
parties at the transport level:

```typescript
import https from 'node:https';
import fs from 'node:fs';

// Server verifies client certificate
const server = https.createServer({
  key: fs.readFileSync('server-key.pem'),
  cert: fs.readFileSync('server-cert.pem'),
  ca: fs.readFileSync('ca-cert.pem'),       // CA that signed client certs
  requestCert: true,                         // Require client certificates
  rejectUnauthorized: true,                  // Reject invalid certs
}, app);

// Client presents its certificate
const agent = new https.Agent({
  key: fs.readFileSync('client-key.pem'),
  cert: fs.readFileSync('client-cert.pem'),
  ca: fs.readFileSync('ca-cert.pem'),
});

// Service-to-service call with mTLS
const response = await fetch('https://service-b.internal/api/data', {
  agent,
  headers: { 'Authorization': `Bearer ${serviceToken}` },
});
```

**4. Encrypt everything in transit**

```
External traffic:  HTTPS (TLS 1.3)
Internal traffic:  mTLS or service mesh (Istio, Linkerd)
Database calls:    TLS-encrypted connections
Queue messages:    Encrypted payloads
```

---

## Device-Based Authentication

### Device Fingerprinting

Track which devices a user typically logs in from. Flag logins from
unknown devices:

```typescript
import { createHash } from 'node:crypto';

interface DeviceFingerprint {
  userAgent: string;
  acceptLanguage: string;
  screenResolution?: string;
  timezone?: string;
  platform?: string;
}

function generateDeviceId(fingerprint: DeviceFingerprint): string {
  const data = JSON.stringify({
    ua: fingerprint.userAgent,
    lang: fingerprint.acceptLanguage,
    screen: fingerprint.screenResolution,
    tz: fingerprint.timezone,
    platform: fingerprint.platform,
  });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

interface KnownDevice {
  deviceId: string;
  userId: string;
  lastSeen: number;
  firstSeen: number;
  trusted: boolean;
  name?: string;  // "Chrome on MacBook Pro"
}

async function checkDevice(
  userId: string,
  fingerprint: DeviceFingerprint
): Promise<{ known: boolean; device: KnownDevice }> {
  const deviceId = generateDeviceId(fingerprint);
  const existing = await getKnownDevice(userId, deviceId);

  if (existing) {
    existing.lastSeen = Date.now();
    await updateDevice(existing);
    return { known: true, device: existing };
  }

  const newDevice: KnownDevice = {
    deviceId,
    userId,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    trusted: false,
    name: parseDeviceName(fingerprint.userAgent),
  };

  await storeDevice(newDevice);
  return { known: false, device: newDevice };
}
```

### Login with Device Check

```typescript
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await verifyCredentials(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check device
  const fingerprint: DeviceFingerprint = {
    userAgent: req.headers['user-agent'] || '',
    acceptLanguage: req.headers['accept-language'] || '',
    timezone: req.body.timezone,
    screenResolution: req.body.screenResolution,
    platform: req.body.platform,
  };

  const deviceCheck = await checkDevice(user.id, fingerprint);

  if (!deviceCheck.known) {
    // New device — require additional verification
    if (user.mfaEnabled) {
      return res.json({
        requiresMFA: true,
        mfaToken: createMFAToken(user.id),
        reason: 'new_device',
      });
    }

    // No MFA — send email notification
    await sendNewDeviceEmail(user.email, fingerprint);
    // Could also require email verification for new devices
  }

  // Issue tokens
  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = issueRefreshToken(user.id);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken });
});
```

### Trusted Device Management

```typescript
// List user's known devices
app.get('/auth/devices', authenticate, async (req, res) => {
  const devices = await getKnownDevices(req.user.userId);
  res.json({
    devices: devices.map(d => ({
      id: d.deviceId,
      name: d.name,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      trusted: d.trusted,
      current: d.deviceId === req.deviceId,
    })),
  });
});

// Remove a device (force logout on that device)
app.delete('/auth/devices/:deviceId', authenticate, async (req, res) => {
  await removeDevice(req.user.userId, req.params.deviceId);
  // Also revoke all refresh tokens associated with this device
  await revokeDeviceTokens(req.user.userId, req.params.deviceId);
  res.json({ message: 'Device removed' });
});

// Trust a device (skip MFA for this device)
app.post('/auth/devices/:deviceId/trust', authenticate, async (req, res) => {
  await trustDevice(req.user.userId, req.params.deviceId);
  res.json({ message: 'Device trusted' });
});
```

---

## Risk-Based Authentication

### The Concept

Instead of applying the same security for every login attempt, assess the
risk level and adjust requirements dynamically.

```
Low risk (normal behavior):
  → Password only
  → No additional steps

Medium risk (slightly unusual):
  → Password + email confirmation
  → Or password + TOTP

High risk (very unusual):
  → Password + MFA + CAPTCHA
  → Or temporary account lock + notification

Critical risk (looks like an attack):
  → Block the attempt
  → Lock the account temporarily
  → Alert the security team
```

### Risk Scoring

```typescript
interface RiskSignal {
  name: string;
  score: number;  // 0 (safe) to 1 (dangerous)
  weight: number; // How much this signal matters
}

interface LoginContext {
  ip: string;
  email: string;
  userAgent: string;
  timestamp: number;
  geoLocation?: { country: string; city: string; lat: number; lng: number };
  deviceFingerprint?: DeviceFingerprint;
}

function assessRisk(context: LoginContext, user: User): {
  score: number;
  signals: RiskSignal[];
  level: 'low' | 'medium' | 'high' | 'critical';
} {
  const signals: RiskSignal[] = [];

  // Signal 1: Unknown IP
  const knownIPs = getKnownIPs(user.id);
  if (!knownIPs.includes(context.ip)) {
    signals.push({ name: 'unknown_ip', score: 0.3, weight: 1.0 });
  }

  // Signal 2: Unknown device
  if (context.deviceFingerprint) {
    const deviceId = generateDeviceId(context.deviceFingerprint);
    const knownDevice = getKnownDevice(user.id, deviceId);
    if (!knownDevice) {
      signals.push({ name: 'unknown_device', score: 0.4, weight: 1.5 });
    }
  }

  // Signal 3: Unusual time
  const hour = new Date(context.timestamp).getHours();
  const usualHours = getUserActiveHours(user.id);
  if (!usualHours.includes(hour)) {
    signals.push({ name: 'unusual_time', score: 0.2, weight: 0.5 });
  }

  // Signal 4: Impossible travel
  const lastLogin = getLastLogin(user.id);
  if (lastLogin && context.geoLocation) {
    const distance = calculateDistance(lastLogin.geoLocation, context.geoLocation);
    const timeDiff = (context.timestamp - lastLogin.timestamp) / 3600_000; // hours
    const speedKmh = distance / timeDiff;

    if (speedKmh > 900) {
      // Faster than a commercial airplane — probably impossible
      signals.push({ name: 'impossible_travel', score: 0.9, weight: 2.0 });
    }
  }

  // Signal 5: Recent failed attempts
  const recentFailures = getRecentFailedAttempts(context.email, 900_000); // 15 min
  if (recentFailures > 3) {
    signals.push({
      name: 'recent_failures',
      score: Math.min(recentFailures * 0.15, 0.8),
      weight: 1.5,
    });
  }

  // Signal 6: Known malicious IP (threat intelligence)
  if (isKnownMaliciousIP(context.ip)) {
    signals.push({ name: 'malicious_ip', score: 1.0, weight: 3.0 });
  }

  // Signal 7: TOR exit node
  if (isTorExitNode(context.ip)) {
    signals.push({ name: 'tor_exit_node', score: 0.6, weight: 1.0 });
  }

  // Calculate weighted risk score
  let totalWeight = 0;
  let weightedScore = 0;

  for (const signal of signals) {
    weightedScore += signal.score * signal.weight;
    totalWeight += signal.weight;
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

  const level = score < 0.2 ? 'low'
    : score < 0.5 ? 'medium'
    : score < 0.8 ? 'high'
    : 'critical';

  return { score, signals, level };
}
```

### Adaptive Authentication Flow

```typescript
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await findUserByEmail(email);
  if (!user) {
    // Don't reveal whether the email exists
    await argon2.hash(password); // Constant time
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Assess risk BEFORE verifying password
  const context: LoginContext = {
    ip: req.ip,
    email,
    userAgent: req.headers['user-agent'] || '',
    timestamp: Date.now(),
    geoLocation: await getGeoFromIP(req.ip),
    deviceFingerprint: req.body.deviceFingerprint,
  };

  const risk = assessRisk(context, user);

  // Log the risk assessment
  await logRiskAssessment(email, risk);

  // Block critical risk
  if (risk.level === 'critical') {
    await lockAccount(user.id, 'suspicious_activity');
    await notifySecurityTeam(user.id, risk);
    return res.status(403).json({
      error: 'Account temporarily locked. Contact support.',
    });
  }

  // Verify password
  const passwordValid = await argon2.verify(user.passwordHash, password);
  if (!passwordValid) {
    recordFailedAttempt(email, context);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Apply risk-based step-up authentication
  if (risk.level === 'high') {
    return res.json({
      requiresMFA: true,
      requiresCaptcha: true,
      mfaToken: createMFAToken(user.id),
      riskLevel: 'high',
    });
  }

  if (risk.level === 'medium') {
    if (user.mfaEnabled) {
      return res.json({
        requiresMFA: true,
        mfaToken: createMFAToken(user.id),
        riskLevel: 'medium',
      });
    }
    // Send notification about unusual login
    await sendUnusualLoginEmail(user.email, context);
  }

  // Low risk — proceed normally
  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = issueRefreshToken(user.id);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken });
});
```

---

## Exercises

### Exercise 1: TOTP Implementation

Implement TOTP from scratch:
1. Generate a secret and produce a QR code URL
2. Write `generateTOTP(secret)` and `verifyTOTP(secret, code)`
3. Test clock drift tolerance (window 0, 1, 2)
4. Generate recovery codes
5. Verify a code, then ensure it can't be reused (replay protection)

### Exercise 2: WebAuthn Flow

Using `@simplewebauthn/server`:
1. Implement registration (generate options → verify response)
2. Implement authentication (generate options → verify response)
3. Support multiple credentials per user
4. Implement credential deletion
5. Test counter-based clone detection

### Exercise 3: Risk Engine

Build a risk scoring engine that considers:
1. Unknown IP address (weight: 1.0)
2. Unknown device (weight: 1.5)
3. Unusual login time (weight: 0.5)
4. Recent failed attempts (weight: 1.5)
5. Impossible travel (weight: 2.0)

Test with scenarios:
- Familiar device, familiar IP → low risk
- New device, familiar IP → medium risk
- New device, new IP, unusual time → high risk
- Impossible travel + new device → critical risk

### Exercise 4: Device Management System

Build a complete device management system:
1. Track all devices a user has logged in from
2. Allow users to view their active sessions/devices
3. Allow users to revoke access to specific devices
4. Send email notifications for new device logins
5. Implement "trust this device" to skip MFA

### Exercise 5: Step-Up Authentication

Implement step-up authentication for sensitive operations:
1. Normal operations: standard JWT authentication
2. Changing email/password: require MFA or re-enter password
3. Financial operations: require MFA + recent authentication
4. Admin operations: require elevated session (time-limited)
5. Track which operations require which auth level

---

## Summary

| System | Protects Against | Type | UX Impact |
|--------|-----------------|------|-----------|
| TOTP MFA | Password theft | Something you have | Medium |
| WebAuthn | Phishing + theft | Something you have/are | Low |
| Passkeys | All password attacks | Something you have/are | Very low |
| Device tracking | Credential stuffing | Behavioral | None |
| Risk-based auth | Targeted attacks | Adaptive | Variable |
| Zero-trust | Lateral movement | Architectural | None |

Next lesson: making all of this observable — monitoring, audit logs,
anomaly detection, and security dashboarding.
