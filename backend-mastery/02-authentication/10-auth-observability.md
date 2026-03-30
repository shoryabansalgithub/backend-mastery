# Lesson 10: Auth Observability

## Why Auth Needs Special Monitoring

Your application might have observability — request latency dashboards,
error rate alerts, CPU monitoring. But authentication deserves its own
dedicated observability because:

1. **Auth is a high-value target.** Attackers don't care about your
   feature flags endpoint. They care about `/login` and `/auth/token`.

2. **Auth failures look normal.** A user mistyping their password looks
   identical to an attacker guessing passwords — unless you track patterns.

3. **Auth incidents are time-sensitive.** A compromised account does more
   damage every minute it goes undetected.

4. **Compliance requires it.** SOC2, HIPAA, PCI-DSS, and GDPR all require
   audit logs of authentication events.

This lesson covers what to log, how to detect anomalies, how to alert on
suspicious activity, and how to build an audit trail that actually helps
during a security incident.

---

## Login Attempt Tracking

### What to Track

Every authentication event should be logged with enough context to
reconstruct what happened during a security investigation.

```typescript
interface AuthEvent {
  // Identity
  eventId: string;          // Unique event identifier
  eventType: AuthEventType; // What happened
  timestamp: number;        // When it happened

  // Actor
  userId?: string;          // Who (if known after auth)
  email?: string;           // Claimed identity (always known)
  ip: string;               // Where from
  userAgent: string;        // What client

  // Context
  deviceFingerprint?: string; // Device identifier
  geoLocation?: {
    country: string;
    city: string;
    lat: number;
    lng: number;
  };

  // Result
  success: boolean;         // Did it succeed?
  failureReason?: string;   // Why it failed (if it failed)
  riskScore?: number;       // Risk assessment result
  riskLevel?: string;       // Risk level

  // Additional data
  mfaUsed?: boolean;        // Was MFA involved?
  mfaMethod?: string;       // TOTP, WebAuthn, recovery code
  authMethod: string;       // password, oauth, api_key, webauthn
  sessionId?: string;       // New session created
  metadata?: Record<string, unknown>; // Additional context
}

type AuthEventType =
  | 'login_attempt'
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'token_refresh'
  | 'token_revoked'
  | 'password_change'
  | 'password_reset_request'
  | 'password_reset_complete'
  | 'mfa_setup'
  | 'mfa_verify'
  | 'mfa_disable'
  | 'account_locked'
  | 'account_unlocked'
  | 'api_key_created'
  | 'api_key_revoked'
  | 'api_key_used'
  | 'role_changed'
  | 'permission_denied'
  | 'session_expired'
  | 'suspicious_activity';
```

### The Auth Logger

```typescript
import { randomUUID } from 'node:crypto';

class AuthLogger {
  private events: AuthEvent[] = [];
  // In production, this writes to a database, log aggregation service
  // (e.g., Elasticsearch, Datadog, CloudWatch), or event stream (Kafka)

  log(event: Omit<AuthEvent, 'eventId' | 'timestamp'>): void {
    const fullEvent: AuthEvent = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      ...event,
    };

    this.events.push(fullEvent);

    // Also log to stdout for log aggregation
    console.log(JSON.stringify({
      level: event.success ? 'info' : 'warn',
      type: 'auth_event',
      ...fullEvent,
    }));

    // Trigger real-time alerts for high-severity events
    if (this.shouldAlert(fullEvent)) {
      this.triggerAlert(fullEvent);
    }
  }

  private shouldAlert(event: AuthEvent): boolean {
    // Alert on account lockouts
    if (event.eventType === 'account_locked') return true;

    // Alert on critical risk logins
    if (event.riskLevel === 'critical') return true;

    // Alert on admin role changes
    if (event.eventType === 'role_changed' && event.metadata?.newRole === 'owner') {
      return true;
    }

    // Alert on MFA disable
    if (event.eventType === 'mfa_disable') return true;

    return false;
  }

  private triggerAlert(event: AuthEvent): void {
    // In production: PagerDuty, Slack webhook, email
    console.error(`🚨 AUTH ALERT: ${event.eventType} — ${JSON.stringify(event)}`);
  }

  // Query methods for analysis and audit
  getEventsForUser(userId: string, since?: number): AuthEvent[] {
    return this.events.filter(e =>
      e.userId === userId &&
      (!since || e.timestamp >= since)
    );
  }

  getFailedLoginsByIP(ip: string, windowMs: number = 3600_000): AuthEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.events.filter(e =>
      e.ip === ip &&
      e.eventType === 'login_failure' &&
      e.timestamp >= cutoff
    );
  }

  getFailedLoginsByEmail(email: string, windowMs: number = 3600_000): AuthEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.events.filter(e =>
      e.email === email &&
      e.eventType === 'login_failure' &&
      e.timestamp >= cutoff
    );
  }
}

const authLogger = new AuthLogger();
```

### Instrumenting Login

```typescript
app.post('/login', async (req, res) => {
  const { email, password, mfaCode } = req.body;
  const startTime = Date.now();

  const baseEvent = {
    email,
    ip: req.ip,
    userAgent: req.headers['user-agent'] || '',
    authMethod: 'password' as const,
  };

  // Rate limit check
  const rateLimitResult = rateLimiter.check(req.ip, email);
  if (!rateLimitResult.allowed) {
    authLogger.log({
      ...baseEvent,
      eventType: 'login_failure',
      success: false,
      failureReason: 'rate_limited',
    });
    return res.status(429).json({ error: 'Too many attempts' });
  }

  // Verify credentials
  const user = await verifyCredentials(email, password);
  if (!user) {
    authLogger.log({
      ...baseEvent,
      eventType: 'login_failure',
      success: false,
      failureReason: 'invalid_credentials',
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // MFA check (if enabled)
  if (user.mfaEnabled && mfaCode) {
    const mfaValid = verifyTOTP(user.mfaSecret, mfaCode);
    if (!mfaValid) {
      authLogger.log({
        ...baseEvent,
        eventType: 'login_failure',
        userId: user.id,
        success: false,
        failureReason: 'invalid_mfa',
        mfaUsed: true,
        mfaMethod: 'totp',
      });
      return res.status(401).json({ error: 'Invalid MFA code' });
    }
  }

  // Success
  const accessToken = createAccessToken(user.id, user.role);
  const refreshToken = issueRefreshToken(user.id);

  authLogger.log({
    ...baseEvent,
    eventType: 'login_success',
    userId: user.id,
    success: true,
    mfaUsed: user.mfaEnabled,
    mfaMethod: user.mfaEnabled ? 'totp' : undefined,
    metadata: {
      durationMs: Date.now() - startTime,
    },
  });

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
  });

  res.json({ accessToken });
});
```

### What NOT to Log

Never log sensitive data:

```typescript
// BAD
authLogger.log({
  ...baseEvent,
  metadata: {
    password: req.body.password,      // NEVER log passwords
    mfaSecret: user.mfaSecret,        // NEVER log MFA secrets
    accessToken: accessToken,          // NEVER log tokens
    refreshToken: refreshToken,        // NEVER log tokens
    creditCard: user.creditCard,       // NEVER log financial data
  },
});

// GOOD
authLogger.log({
  ...baseEvent,
  metadata: {
    passwordLength: req.body.password.length,  // OK — length only
    mfaUsed: true,                              // OK — boolean
    tokenType: 'access',                        // OK — type only
  },
});
```

---

## Anomaly Detection

### Statistical Baselines

Build a profile of "normal" for each user and for the system as a whole:

```typescript
interface UserBaseline {
  userId: string;
  // Typical login patterns
  usualLoginHours: number[];       // Hours of day (0-23)
  usualLoginDays: number[];        // Days of week (0-6)
  usualIPs: string[];              // Known IP addresses
  usualDevices: string[];          // Known device fingerprints
  usualCountries: string[];        // Known countries
  averageLoginFrequency: number;   // Average logins per day
  // Updated periodically
  lastUpdated: number;
}

class BaselineBuilder {
  // Build from historical login data
  static build(
    userId: string,
    events: AuthEvent[],
    windowDays: number = 30
  ): UserBaseline {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const recentEvents = events.filter(e =>
      e.userId === userId &&
      e.eventType === 'login_success' &&
      e.timestamp >= cutoff
    );

    const hours = recentEvents.map(e => new Date(e.timestamp).getHours());
    const days = recentEvents.map(e => new Date(e.timestamp).getDay());
    const ips = [...new Set(recentEvents.map(e => e.ip))];
    const devices = [...new Set(
      recentEvents.map(e => e.deviceFingerprint).filter(Boolean) as string[]
    )];
    const countries = [...new Set(
      recentEvents.map(e => e.geoLocation?.country).filter(Boolean) as string[]
    )];

    return {
      userId,
      usualLoginHours: [...new Set(hours)],
      usualLoginDays: [...new Set(days)],
      usualIPs: ips,
      usualDevices: devices,
      usualCountries: countries,
      averageLoginFrequency: recentEvents.length / windowDays,
      lastUpdated: Date.now(),
    };
  }
}
```

### Anomaly Detection Rules

```typescript
interface Anomaly {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: Record<string, unknown>;
}

class AnomalyDetector {
  detectLoginAnomalies(
    event: AuthEvent,
    baseline: UserBaseline
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    // 1. Unusual hour
    const hour = new Date(event.timestamp).getHours();
    if (!baseline.usualLoginHours.includes(hour)) {
      anomalies.push({
        type: 'unusual_time',
        severity: 'low',
        description: `Login at ${hour}:00, usual hours: ${baseline.usualLoginHours.join(',')}`,
        evidence: { hour, usualHours: baseline.usualLoginHours },
      });
    }

    // 2. Unknown IP
    if (!baseline.usualIPs.includes(event.ip)) {
      anomalies.push({
        type: 'unknown_ip',
        severity: 'medium',
        description: `Login from unknown IP: ${event.ip}`,
        evidence: { ip: event.ip, knownIPCount: baseline.usualIPs.length },
      });
    }

    // 3. Unknown country
    if (
      event.geoLocation &&
      !baseline.usualCountries.includes(event.geoLocation.country)
    ) {
      anomalies.push({
        type: 'unknown_country',
        severity: 'high',
        description: `Login from ${event.geoLocation.country}, not seen before`,
        evidence: {
          country: event.geoLocation.country,
          usualCountries: baseline.usualCountries,
        },
      });
    }

    // 4. Unknown device
    if (
      event.deviceFingerprint &&
      !baseline.usualDevices.includes(event.deviceFingerprint)
    ) {
      anomalies.push({
        type: 'unknown_device',
        severity: 'medium',
        description: 'Login from an unrecognized device',
        evidence: { deviceFingerprint: event.deviceFingerprint },
      });
    }

    // 5. Abnormal login frequency
    const recentLogins = authLogger.getEventsForUser(
      event.userId!,
      Date.now() - 24 * 60 * 60 * 1000
    ).filter(e => e.eventType === 'login_success');

    if (recentLogins.length > baseline.averageLoginFrequency * 5) {
      anomalies.push({
        type: 'abnormal_frequency',
        severity: 'high',
        description: `${recentLogins.length} logins today, average is ${baseline.averageLoginFrequency.toFixed(1)}`,
        evidence: {
          todayCount: recentLogins.length,
          averagePerDay: baseline.averageLoginFrequency,
        },
      });
    }

    return anomalies;
  }

  // System-wide anomalies (not tied to one user)
  detectSystemAnomalies(windowMs: number = 300_000): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const cutoff = Date.now() - windowMs;

    // Get all recent events
    const recentFailures = authLogger.events.filter(e =>
      e.eventType === 'login_failure' &&
      e.timestamp >= cutoff
    );

    // 1. Spike in login failures
    // (could indicate a credential stuffing attack)
    if (recentFailures.length > 100) {
      anomalies.push({
        type: 'login_failure_spike',
        severity: 'high',
        description: `${recentFailures.length} login failures in the last 5 minutes`,
        evidence: {
          failureCount: recentFailures.length,
          uniqueEmails: new Set(recentFailures.map(e => e.email)).size,
          uniqueIPs: new Set(recentFailures.map(e => e.ip)).size,
        },
      });
    }

    // 2. Many unique emails from one IP (credential stuffing pattern)
    const ipEmailCounts = new Map<string, Set<string>>();
    for (const event of recentFailures) {
      if (!ipEmailCounts.has(event.ip)) {
        ipEmailCounts.set(event.ip, new Set());
      }
      if (event.email) {
        ipEmailCounts.get(event.ip)!.add(event.email);
      }
    }

    for (const [ip, emails] of ipEmailCounts) {
      if (emails.size > 20) {
        anomalies.push({
          type: 'credential_stuffing_suspected',
          severity: 'critical',
          description: `IP ${ip} attempted ${emails.size} different accounts`,
          evidence: { ip, uniqueEmailCount: emails.size },
        });
      }
    }

    // 3. One email targeted from many IPs (distributed brute force)
    const emailIPCounts = new Map<string, Set<string>>();
    for (const event of recentFailures) {
      if (!event.email) continue;
      if (!emailIPCounts.has(event.email)) {
        emailIPCounts.set(event.email, new Set());
      }
      emailIPCounts.get(event.email)!.add(event.ip);
    }

    for (const [email, ips] of emailIPCounts) {
      if (ips.size > 10) {
        anomalies.push({
          type: 'distributed_brute_force',
          severity: 'high',
          description: `${email} targeted from ${ips.size} different IPs`,
          evidence: { email, uniqueIPCount: ips.size },
        });
      }
    }

    return anomalies;
  }
}
```

### Impossible Travel Detection

One of the most effective anomaly detectors. If a user logs in from
New York at 10:00 AM and from Tokyo at 10:15 AM, something is wrong.

```typescript
function detectImpossibleTravel(
  currentEvent: AuthEvent,
  previousEvent: AuthEvent
): Anomaly | null {
  if (!currentEvent.geoLocation || !previousEvent.geoLocation) {
    return null;
  }

  const distance = haversineDistance(
    previousEvent.geoLocation.lat,
    previousEvent.geoLocation.lng,
    currentEvent.geoLocation.lat,
    currentEvent.geoLocation.lng
  );

  const timeHours = Math.abs(
    currentEvent.timestamp - previousEvent.timestamp
  ) / 3_600_000;

  if (timeHours === 0) return null;

  const speedKmh = distance / timeHours;
  const MAX_REASONABLE_SPEED = 1000; // km/h (accounts for fast planes)

  if (speedKmh > MAX_REASONABLE_SPEED) {
    return {
      type: 'impossible_travel',
      severity: 'critical',
      description: `Traveled ${distance.toFixed(0)}km in ${(timeHours * 60).toFixed(0)} minutes (${speedKmh.toFixed(0)} km/h)`,
      evidence: {
        from: previousEvent.geoLocation,
        to: currentEvent.geoLocation,
        distanceKm: distance,
        timeMinutes: timeHours * 60,
        speedKmh,
      },
    };
  }

  return null;
}

// Haversine formula for distance between two points on Earth
function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
```

---

## Suspicious Activity Alerts

### Alert Tiers

```typescript
interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  type: string;
  message: string;
  userId?: string;
  timestamp: number;
  acknowledged: boolean;
  acknowledgedBy?: string;
  evidence: Record<string, unknown>;
}

class AlertManager {
  private alerts: Alert[] = [];
  private webhooks: string[] = []; // Slack, PagerDuty URLs

  async createAlert(
    severity: Alert['severity'],
    type: string,
    message: string,
    evidence: Record<string, unknown>,
    userId?: string
  ): Promise<void> {
    const alert: Alert = {
      id: randomUUID(),
      severity,
      type,
      message,
      userId,
      timestamp: Date.now(),
      acknowledged: false,
      evidence,
    };

    this.alerts.push(alert);

    // Route based on severity
    switch (severity) {
      case 'info':
        // Log only — no notification
        console.log(`[INFO ALERT] ${message}`);
        break;

      case 'warning':
        // Send to monitoring channel
        await this.notifyChannel('warning', alert);
        break;

      case 'critical':
        // Page the on-call engineer
        await this.notifyChannel('critical', alert);
        await this.pageOnCall(alert);
        break;
    }
  }

  private async notifyChannel(
    channel: string,
    alert: Alert
  ): Promise<void> {
    // Slack webhook example
    for (const webhookUrl of this.webhooks) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🚨 *${alert.severity.toUpperCase()}* — ${alert.type}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*${alert.severity.toUpperCase()}*: ${alert.message}\n` +
                    `*Time*: ${new Date(alert.timestamp).toISOString()}\n` +
                    `*User*: ${alert.userId || 'N/A'}\n` +
                    `*Evidence*: \`${JSON.stringify(alert.evidence)}\``,
                },
              },
            ],
          }),
        });
      } catch (err) {
        console.error(`Failed to send alert to webhook: ${err}`);
      }
    }
  }

  private async pageOnCall(alert: Alert): Promise<void> {
    // PagerDuty, OpsGenie, etc.
    console.error(`🔔 PAGING ON-CALL: ${alert.message}`);
  }

  // Get unacknowledged alerts
  getActiveAlerts(): Alert[] {
    return this.alerts.filter(a => !a.acknowledged);
  }

  // Acknowledge an alert
  acknowledge(alertId: string, acknowledgedBy: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedBy = acknowledgedBy;
    }
  }
}

const alertManager = new AlertManager();
```

### Alert Rules

```typescript
// Run every minute (or triggered by events)
class AlertRules {
  private lastCheck = Date.now();

  async evaluate(): Promise<void> {
    const now = Date.now();
    const windowMs = now - this.lastCheck;
    this.lastCheck = now;

    // Rule 1: Too many failed logins system-wide
    const systemFailures = authLogger.events.filter(e =>
      e.eventType === 'login_failure' &&
      e.timestamp >= now - 300_000
    );

    if (systemFailures.length > 200) {
      await alertManager.createAlert(
        'critical',
        'mass_login_failure',
        `${systemFailures.length} login failures in the last 5 minutes — possible attack`,
        {
          failureCount: systemFailures.length,
          uniqueIPs: new Set(systemFailures.map(e => e.ip)).size,
          uniqueEmails: new Set(systemFailures.map(e => e.email)).size,
        }
      );
    }

    // Rule 2: Account lockouts
    const lockouts = authLogger.events.filter(e =>
      e.eventType === 'account_locked' &&
      e.timestamp >= now - windowMs
    );

    for (const lockout of lockouts) {
      await alertManager.createAlert(
        'warning',
        'account_locked',
        `Account locked: ${lockout.email}`,
        { email: lockout.email, ip: lockout.ip },
        lockout.userId
      );
    }

    // Rule 3: MFA disabled (could be a compromised account)
    const mfaDisabled = authLogger.events.filter(e =>
      e.eventType === 'mfa_disable' &&
      e.timestamp >= now - windowMs
    );

    for (const event of mfaDisabled) {
      await alertManager.createAlert(
        'warning',
        'mfa_disabled',
        `MFA disabled for user ${event.userId}`,
        { userId: event.userId, ip: event.ip },
        event.userId
      );
    }

    // Rule 4: Privilege escalation
    const roleChanges = authLogger.events.filter(e =>
      e.eventType === 'role_changed' &&
      e.timestamp >= now - windowMs &&
      (e.metadata?.newRole === 'admin' || e.metadata?.newRole === 'owner')
    );

    for (const event of roleChanges) {
      await alertManager.createAlert(
        'warning',
        'privilege_escalation',
        `User ${event.metadata?.targetUserId} promoted to ${event.metadata?.newRole}`,
        event.metadata || {},
        event.userId
      );
    }

    // Rule 5: Impossible travel
    // (Run against recent successful logins)
    const recentSuccesses = authLogger.events.filter(e =>
      e.eventType === 'login_success' &&
      e.timestamp >= now - windowMs
    );

    for (const event of recentSuccesses) {
      if (!event.userId) continue;

      const previousLogins = authLogger.getEventsForUser(
        event.userId,
        now - 24 * 60 * 60 * 1000
      ).filter(e =>
        e.eventType === 'login_success' &&
        e.timestamp < event.timestamp
      );

      if (previousLogins.length > 0) {
        const lastLogin = previousLogins[previousLogins.length - 1];
        const anomaly = detectImpossibleTravel(event, lastLogin);

        if (anomaly) {
          await alertManager.createAlert(
            'critical',
            'impossible_travel',
            anomaly.description,
            anomaly.evidence,
            event.userId
          );
        }
      }
    }
  }
}

// Run alert evaluation periodically
const alertRules = new AlertRules();
setInterval(() => alertRules.evaluate(), 60_000); // Every minute
```

---

## Audit Logs

### Why Audit Logs Are Different from Application Logs

Application logs are for debugging. Audit logs are for compliance,
forensics, and accountability.

```
Application log:
  "User 42 logged in"
  → Useful for debugging
  → Can be rotated/deleted
  → Format can change

Audit log:
  "User 42 (alice@example.com) authenticated via password+TOTP
   from IP 203.0.113.45 (US, New York) at 2025-01-15T10:30:00Z
   using Chrome 120 on macOS. Session ID: sess_abc123.
   Risk score: 0.15 (low)."
  → Required for compliance
  → Immutable (append-only)
  → Retained for years
  → Structured, queryable
```

### Audit Log Implementation

```typescript
interface AuditEntry {
  id: string;
  timestamp: string;        // ISO 8601
  actor: {
    type: 'user' | 'service' | 'system';
    id: string;
    email?: string;
    ip?: string;
  };
  action: string;            // machine-readable action name
  resource: {
    type: string;            // user, organization, api_key, session
    id: string;
  };
  result: 'success' | 'failure' | 'denied';
  reason?: string;           // Why it failed / was denied
  changes?: {
    field: string;
    from: unknown;
    to: unknown;
  }[];
  context: {
    userAgent?: string;
    geoLocation?: string;
    sessionId?: string;
    requestId?: string;
  };
}

class AuditLog {
  // In production: append-only database table, write-once storage,
  // or a service like AWS CloudTrail
  private entries: AuditEntry[] = [];

  append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.entries.push(fullEntry);

    // Write to immutable storage
    this.persist(fullEntry);
  }

  private persist(entry: AuditEntry): void {
    // In production, write to:
    // 1. Append-only database table (with write-only permissions)
    // 2. Object storage (S3 with object lock)
    // 3. Dedicated audit service
    // 4. Compliance-grade logging (Splunk, Sumo Logic)

    // For development, structured JSON output
    console.log(JSON.stringify({
      _type: 'audit',
      ...entry,
    }));
  }

  // Query audit log
  query(filters: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    startDate?: string;
    endDate?: string;
    result?: string;
  }): AuditEntry[] {
    return this.entries.filter(entry => {
      if (filters.actorId && entry.actor.id !== filters.actorId) return false;
      if (filters.action && entry.action !== filters.action) return false;
      if (filters.resourceType && entry.resource.type !== filters.resourceType) return false;
      if (filters.resourceId && entry.resource.id !== filters.resourceId) return false;
      if (filters.result && entry.result !== filters.result) return false;
      if (filters.startDate && entry.timestamp < filters.startDate) return false;
      if (filters.endDate && entry.timestamp > filters.endDate) return false;
      return true;
    });
  }
}

const auditLog = new AuditLog();
```

### Instrumenting Auth Actions

```typescript
// Login audit
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await verifyCredentials(email, password);

  if (!user) {
    auditLog.append({
      actor: { type: 'user', id: 'unknown', email, ip: req.ip },
      action: 'auth.login',
      resource: { type: 'session', id: 'none' },
      result: 'failure',
      reason: 'invalid_credentials',
      context: {
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      },
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sessionId = randomUUID();
  auditLog.append({
    actor: { type: 'user', id: user.id, email: user.email, ip: req.ip },
    action: 'auth.login',
    resource: { type: 'session', id: sessionId },
    result: 'success',
    context: {
      userAgent: req.headers['user-agent'],
      sessionId,
      requestId: req.id,
    },
  });

  // ... issue tokens
});

// Role change audit
app.put('/orgs/:orgId/members/:userId/role', authenticate, async (req, res) => {
  const { role: newRole } = req.body;
  const targetUserId = req.params.userId;
  const currentRole = await getMemberRole(targetUserId, req.params.orgId);

  auditLog.append({
    actor: { type: 'user', id: req.user.userId, email: req.user.email, ip: req.ip },
    action: 'org.member.role_change',
    resource: { type: 'user', id: targetUserId },
    result: 'success',
    changes: [
      { field: 'role', from: currentRole, to: newRole },
    ],
    context: {
      userAgent: req.headers['user-agent'],
      sessionId: req.sessionId,
      requestId: req.id,
    },
  });

  // ... update role
});

// Permission denied audit
function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hasPermission(req.user.role, permission)) {
      auditLog.append({
        actor: {
          type: 'user',
          id: req.user.userId,
          email: req.user.email,
          ip: req.ip,
        },
        action: `access.${permission}`,
        resource: { type: 'endpoint', id: `${req.method} ${req.path}` },
        result: 'denied',
        reason: `missing_permission: ${permission}`,
        context: {
          userAgent: req.headers['user-agent'],
          sessionId: req.sessionId,
          requestId: req.id,
        },
      });

      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}
```

### Audit Log Immutability

Audit logs must be tamper-proof. If an attacker gains access, they
shouldn't be able to delete evidence of their intrusion.

```typescript
// Hash-chained audit log (simplified blockchain concept)
class ImmutableAuditLog {
  private entries: (AuditEntry & { hash: string; prevHash: string })[] = [];

  private computeHash(entry: AuditEntry, prevHash: string): string {
    const data = JSON.stringify({ ...entry, prevHash });
    return createHash('sha256').update(data).digest('hex');
  }

  append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1].hash
      : '0'.repeat(64);

    const hash = this.computeHash(fullEntry, prevHash);

    this.entries.push({ ...fullEntry, hash, prevHash });
  }

  // Verify the entire chain is intact
  verifyIntegrity(): { valid: boolean; brokenAt?: number } {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const expectedPrevHash = i > 0
        ? this.entries[i - 1].hash
        : '0'.repeat(64);

      // Check chain link
      if (entry.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAt: i };
      }

      // Verify entry hash
      const { hash, prevHash, ...entryData } = entry;
      const expectedHash = this.computeHash(entryData as AuditEntry, prevHash);
      if (hash !== expectedHash) {
        return { valid: false, brokenAt: i };
      }
    }

    return { valid: true };
  }
}
```

### Compliance Requirements

Different regulations require different retention periods and access
patterns:

```
SOC 2:
  - Log all authentication events
  - Log all access to customer data
  - Retain for at least 1 year
  - Regular review of access logs

HIPAA:
  - Log all access to protected health information (PHI)
  - Log user authentication and authorization events
  - Retain for at least 6 years
  - Audit controls must be documented

PCI-DSS:
  - Log all access to cardholder data
  - Log all authentication events
  - Log all actions by privileged users
  - Retain for at least 1 year (3 months immediately available)
  - Daily log review

GDPR:
  - Log processing of personal data
  - Must be able to provide access/deletion records
  - Data minimization applies to logs too
  - Consider not logging personal data in audit trails
```

---

## Security Dashboard Metrics

### Key Metrics to Track

```typescript
interface AuthMetrics {
  // Real-time (last 5 minutes)
  loginAttemptsPerMinute: number;
  loginSuccessRate: number;
  loginFailureRate: number;
  averageLoginLatencyMs: number;
  activeSessionCount: number;

  // Hourly
  uniqueUsersAuthenticated: number;
  uniqueIPsAttempting: number;
  mfaadoptionRate: number;
  accountLockouts: number;

  // Daily
  newUserRegistrations: number;
  passwordResets: number;
  mfaEnrolments: number;
  mfaDisablements: number;
  apiKeyCreations: number;
  apiKeyRevocations: number;

  // Security-specific
  suspiciousLoginRate: number;
  impossibleTravelEvents: number;
  credentialStuffingAttempts: number;
  blockedIPs: number;
}

class MetricsCollector {
  private events: AuthEvent[] = [];

  recordEvent(event: AuthEvent): void {
    this.events.push(event);
  }

  getMetrics(): AuthMetrics {
    const now = Date.now();
    const fiveMinutesAgo = now - 300_000;
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    const recent = this.events.filter(e => e.timestamp >= fiveMinutesAgo);
    const hourly = this.events.filter(e => e.timestamp >= oneHourAgo);
    const daily = this.events.filter(e => e.timestamp >= oneDayAgo);

    const recentLogins = recent.filter(e =>
      e.eventType === 'login_attempt' || e.eventType === 'login_success' || e.eventType === 'login_failure'
    );
    const recentSuccesses = recent.filter(e => e.eventType === 'login_success');
    const recentFailures = recent.filter(e => e.eventType === 'login_failure');

    return {
      // Real-time
      loginAttemptsPerMinute: recentLogins.length / 5,
      loginSuccessRate: recentLogins.length > 0
        ? recentSuccesses.length / recentLogins.length
        : 0,
      loginFailureRate: recentLogins.length > 0
        ? recentFailures.length / recentLogins.length
        : 0,
      averageLoginLatencyMs: this.averageLatency(recentSuccesses),
      activeSessionCount: this.countActiveSessions(),

      // Hourly
      uniqueUsersAuthenticated: new Set(
        hourly.filter(e => e.eventType === 'login_success').map(e => e.userId)
      ).size,
      uniqueIPsAttempting: new Set(hourly.map(e => e.ip)).size,
      mfaadoptionRate: this.calculateMFARate(hourly),
      accountLockouts: hourly.filter(e => e.eventType === 'account_locked').length,

      // Daily
      newUserRegistrations: daily.filter(e =>
        e.eventType === 'login_success' && e.metadata?.isNewUser
      ).length,
      passwordResets: daily.filter(e =>
        e.eventType === 'password_reset_complete'
      ).length,
      mfaEnrolments: daily.filter(e => e.eventType === 'mfa_setup').length,
      mfaDisablements: daily.filter(e => e.eventType === 'mfa_disable').length,
      apiKeyCreations: daily.filter(e => e.eventType === 'api_key_created').length,
      apiKeyRevocations: daily.filter(e => e.eventType === 'api_key_revoked').length,

      // Security
      suspiciousLoginRate: this.calculateSuspiciousRate(hourly),
      impossibleTravelEvents: hourly.filter(e =>
        e.metadata?.anomaly === 'impossible_travel'
      ).length,
      credentialStuffingAttempts: this.detectStuffingAttempts(hourly),
      blockedIPs: this.countBlockedIPs(),
    };
  }

  private averageLatency(events: AuthEvent[]): number {
    const latencies = events
      .map(e => e.metadata?.durationMs as number)
      .filter(Boolean);
    if (latencies.length === 0) return 0;
    return latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
  }

  private calculateMFARate(events: AuthEvent[]): number {
    const logins = events.filter(e => e.eventType === 'login_success');
    if (logins.length === 0) return 0;
    const withMFA = logins.filter(e => e.mfaUsed);
    return withMFA.length / logins.length;
  }

  private calculateSuspiciousRate(events: AuthEvent[]): number {
    const logins = events.filter(e =>
      e.eventType === 'login_success' || e.eventType === 'login_failure'
    );
    if (logins.length === 0) return 0;
    const suspicious = logins.filter(e =>
      e.riskLevel === 'high' || e.riskLevel === 'critical'
    );
    return suspicious.length / logins.length;
  }

  private detectStuffingAttempts(events: AuthEvent[]): number {
    // Count IPs that attempted more than 20 unique emails
    const ipEmails = new Map<string, Set<string>>();
    for (const event of events.filter(e => e.eventType === 'login_failure')) {
      if (!ipEmails.has(event.ip)) ipEmails.set(event.ip, new Set());
      if (event.email) ipEmails.get(event.ip)!.add(event.email);
    }
    return [...ipEmails.values()].filter(emails => emails.size > 20).length;
  }

  private countActiveSessions(): number {
    // Implementation depends on session store
    return 0;
  }

  private countBlockedIPs(): number {
    // Implementation depends on rate limiter
    return 0;
  }
}
```

### Exposing Metrics

```typescript
// Metrics endpoint (protected — admin/internal only)
app.get('/admin/auth/metrics', authenticate, requirePermission('admin:metrics'), (req, res) => {
  const metrics = metricsCollector.getMetrics();
  res.json(metrics);
});

// Prometheus-style metrics endpoint (for scraping)
app.get('/metrics', (req, res) => {
  const metrics = metricsCollector.getMetrics();

  const prometheus = [
    `# HELP auth_login_attempts_total Total login attempts`,
    `# TYPE auth_login_attempts_total counter`,
    `auth_login_attempts_per_minute ${metrics.loginAttemptsPerMinute}`,
    ``,
    `# HELP auth_login_success_rate Login success rate`,
    `# TYPE auth_login_success_rate gauge`,
    `auth_login_success_rate ${metrics.loginSuccessRate}`,
    ``,
    `# HELP auth_login_failure_rate Login failure rate`,
    `# TYPE auth_login_failure_rate gauge`,
    `auth_login_failure_rate ${metrics.loginFailureRate}`,
    ``,
    `# HELP auth_login_latency_ms Average login latency in milliseconds`,
    `# TYPE auth_login_latency_ms gauge`,
    `auth_login_latency_ms ${metrics.averageLoginLatencyMs}`,
    ``,
    `# HELP auth_active_sessions Current active session count`,
    `# TYPE auth_active_sessions gauge`,
    `auth_active_sessions ${metrics.activeSessionCount}`,
    ``,
    `# HELP auth_account_lockouts_total Account lockouts in the last hour`,
    `# TYPE auth_account_lockouts_total counter`,
    `auth_account_lockouts_total ${metrics.accountLockouts}`,
    ``,
    `# HELP auth_suspicious_rate Rate of suspicious login attempts`,
    `# TYPE auth_suspicious_rate gauge`,
    `auth_suspicious_rate ${metrics.suspiciousLoginRate}`,
    ``,
    `# HELP auth_mfa_adoption MFA adoption rate`,
    `# TYPE auth_mfa_adoption gauge`,
    `auth_mfa_adoption ${metrics.mfaadoptionRate}`,
  ].join('\n');

  res.set('Content-Type', 'text/plain');
  res.send(prometheus);
});
```

---

## Incident Response: Using Observability During a Breach

### The Scenario

You receive an alert: 500 login failures from a single IP in 2 minutes.

### Step 1: Assess

```typescript
// What happened?
const events = auditLog.query({
  startDate: twoMinutesAgo,
  action: 'auth.login',
  result: 'failure',
});

// How many unique accounts were targeted?
const targetedAccounts = new Set(events.map(e => e.actor.email));
console.log(`${events.length} failures across ${targetedAccounts.size} accounts`);

// Is this credential stuffing (many accounts) or brute force (one account)?
if (targetedAccounts.size > 50) {
  console.log('CREDENTIAL STUFFING ATTACK — many accounts targeted');
} else {
  console.log('BRUTE FORCE — focused on few accounts');
}
```

### Step 2: Contain

```typescript
// Block the source IP
await blockIP(suspiciousIP, '24h');

// If credential stuffing, check if any succeeded
const successes = auditLog.query({
  startDate: twoMinutesAgo,
  action: 'auth.login',
  result: 'success',
});

const compromised = successes.filter(e =>
  targetedIPs.has(e.actor.ip!)
);

if (compromised.length > 0) {
  console.log(`${compromised.length} accounts may be compromised`);
  for (const event of compromised) {
    // Force password reset
    await forcePasswordReset(event.actor.id);
    // Revoke all sessions
    await revokeAllSessions(event.actor.id);
    // Notify the user
    await notifyUserOfBreach(event.actor.id);
  }
}
```

### Step 3: Investigate

```typescript
// Timeline of the attack
const timeline = auditLog.query({
  startDate: oneHourAgo,
  endDate: now,
});

// Sort by timestamp
timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

// Generate a report
for (const entry of timeline) {
  console.log(
    `${entry.timestamp} | ${entry.action} | ${entry.result} | ` +
    `${entry.actor.email} | ${entry.actor.ip}`
  );
}
```

### Step 4: Recover and Harden

```typescript
// Check which passwords from the attack matched
// (indicates passwords from a known breach list)
// Implement breach password checking if not already done

// Add any new IPs to a threat intelligence blocklist
// Increase rate limiting thresholds
// Consider requiring MFA for affected accounts
```

---

## Exercises

### Exercise 1: Auth Event Logger

Build a complete auth event logging system:
1. Define event types for all auth actions (login, logout, register,
   password change, MFA setup, etc.)
2. Log every auth event with full context
3. Never log passwords or tokens
4. Implement query methods (by user, by IP, by time range)
5. Write tests that verify logging for each auth flow

### Exercise 2: Anomaly Detector

Build an anomaly detection system:
1. Build user baselines from historical login data
2. Detect: unusual time, unknown IP, unknown device, unknown country
3. Implement impossible travel detection using the Haversine formula
4. Detect credential stuffing patterns (many accounts, one IP)
5. Detect distributed brute force (one account, many IPs)
6. Write tests with simulated attack scenarios

### Exercise 3: Alert Pipeline

Build an alert system with tiered severity:
1. Info: Log only
2. Warning: Slack notification
3. Critical: Page the on-call (simulate with console output)

Alert rules:
- More than 100 login failures in 5 minutes → critical
- Account locked → warning
- MFA disabled → warning
- Impossible travel detected → critical
- More than 5 password reset requests for one email → warning

### Exercise 4: Audit Log with Integrity

Build an immutable audit log:
1. Hash-chain all entries (each entry includes the hash of the previous)
2. Implement `verifyIntegrity()` that checks the entire chain
3. Demonstrate that modifying any entry breaks the chain
4. Store enough context for compliance (who, what, when, where, why)
5. Implement query methods with date filtering

### Exercise 5: Security Dashboard

Build an API that returns auth security metrics:
1. Login success/failure rates (5-minute, hourly, daily)
2. MFA adoption rate
3. Unique IPs and users
4. Account lockout count
5. Suspicious activity rate
6. Active session count

Bonus: Build a simple HTML dashboard that polls the metrics endpoint and
displays the data with charts.

---

## Summary

| Component | Purpose | Key Tools |
|-----------|---------|-----------|
| Event logging | Record all auth events | Structured JSON logs |
| Anomaly detection | Identify unusual patterns | Baselines, statistical rules |
| Impossible travel | Detect geographically impossible logins | Haversine distance |
| Alert pipeline | Notify on security events | Webhooks, PagerDuty |
| Audit logs | Compliance, forensics | Append-only, hash-chained |
| Metrics | Dashboard and monitoring | Prometheus, Grafana |
| Incident response | Investigate and contain breaches | Query audit logs |

This completes the authentication module. You now have the knowledge to
build, secure, monitor, and defend a production authentication system
from the ground up.
