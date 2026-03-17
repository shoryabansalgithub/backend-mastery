# Project: Relay

## Overview

You are building **Relay** — the real-time backend for a collaborative document
editing system. Think of it as the server that powers the live collaboration layer of
a simplified Google Docs: multiple users can open the same document, see each other's
presence (who is in the document), observe each other's cursor positions, and receive
each other's edits in real time.

This project is exclusively about the WebSocket layer. There is no HTTP API to build
for document retrieval or storage — the focus is on connection management, message
routing, presence, and real-time broadcasting. Persistence of edits can be to an
in-memory store for this project.

By the end, you will have a production-quality WebSocket server that handles
authentication, rooms, presence tracking, cursor sharing, broadcast of edits, and
edit history.

---

## The Domain

A **document** is the unit of collaboration. Multiple users can be in a document
simultaneously. The set of users currently connected to a document is the document's
**presence list**.

Each user in a document has a **cursor**: a position in the document (line and column)
that is broadcast to other users so they can see where others are working.

**Edits** are changes to the document's content. Every edit has an author, a timestamp,
and an operation (insert text, delete text). Relay maintains an in-memory **edit
history** for each document — the last 200 edits.

**Authentication** is required to connect. Clients pass a JWT in the WebSocket
handshake. The JWT contains the user's ID and display name.

---

## Connection Lifecycle

```
Client                               Server
  │                                     │
  │──── WebSocket upgrade request ─────►│
  │     GET /ws?token=<JWT>             │
  │     Upgrade: websocket              │
  │                                     │
  │     [Server validates JWT]          │
  │     [If invalid: close 4001]        │
  │                                     │
  │◄─── 101 Switching Protocols ────────│
  │     (connection established)        │
  │                                     │
  │──── doc.join ──────────────────────►│
  │                                     │  [Server adds client to doc room]
  │                                     │  [Server announces presence join]
  │                                     │
  │◄─── doc.joined ─────────────────────│ (confirm join + current presence)
  │◄─── presence.updated ───────────────│ (broadcast to others in doc)
  │◄─── history.replay ─────────────────│ (last N edits for this doc)
  │                                     │
  │──── cursor.move ───────────────────►│
  │◄─── cursor.updated ─────────────────│ (broadcast to others, not sender)
  │                                     │
  │──── edit.submit ───────────────────►│
  │◄─── edit.ack ───────────────────────│ (confirm to sender)
  │◄─── edit.broadcast ─────────────────│ (to all others in doc)
  │                                     │
  │──── doc.leave ─────────────────────►│ (optional graceful leave)
  │◄─── doc.left ───────────────────────│
  │◄─── presence.updated ───────────────│ (broadcast to remaining members)
  │                                     │
  │     [TCP connection drops]          │
  │     [Server detects via heartbeat]  │
  │     [Handles as implicit leave]     │
```

---

## Message Protocol

All messages are JSON objects with this envelope:

```typescript
interface Message {
  type: string;          // identifies the message type
  payload?: unknown;     // message-specific data
  msgId?: string;        // optional: client-generated ID for correlation
}
```

The server echoes `msgId` in acknowledgement messages so clients can correlate requests
with responses.

### Client → Server Messages

---

#### `doc.join`

Join a document room. Must be the first message after connecting, or the server will
reject subsequent messages with `error.not_joined`.

```typescript
{
  type: "doc.join",
  payload: {
    docId: string;        // which document to join
  },
  msgId?: string;
}
```

---

#### `doc.leave`

Gracefully leave the current document. The client remains connected but is no longer
in any document room.

```typescript
{
  type: "doc.leave",
  payload: {}
}
```

---

#### `cursor.move`

Report a cursor position change. Should be sent whenever the user's cursor moves.
High frequency — expect up to 10 per second.

```typescript
{
  type: "cursor.move",
  payload: {
    line: number;         // 0-indexed line number
    column: number;       // 0-indexed column number
    selection?: {         // optional: a text selection range
      anchorLine: number;
      anchorColumn: number;
      focusLine: number;
      focusColumn: number;
    };
  }
}
```

---

#### `edit.submit`

Submit a document edit operation.

```typescript
{
  type: "edit.submit",
  msgId: string;          // required for acknowledgement correlation
  payload: {
    docId: string;
    operation: EditOperation;
  }
}

type EditOperation =
  | {
      type: "insert";
      position: { line: number; column: number };
      text: string;       // text to insert (can be multi-line)
    }
  | {
      type: "delete";
      from: { line: number; column: number };
      to: { line: number; column: number };
    }
  | {
      type: "replace";    // delete a range and insert new text
      from: { line: number; column: number };
      to: { line: number; column: number };
      text: string;
    };
```

---

#### `history.request`

Request edit history for the current document.

```typescript
{
  type: "history.request",
  payload: {
    limit?: number;       // default: 50, max: 200
    before?: string;      // editId — get history before this edit (pagination)
  }
}
```

---

### Server → Client Messages

---

#### `doc.joined`

Sent to the joining client after a successful `doc.join`.

```typescript
{
  type: "doc.joined",
  payload: {
    docId: string;
    members: PresenceMember[];   // current members in the document
    memberCount: number;
  }
}

interface PresenceMember {
  userId: string;
  displayName: string;
  color: string;          // a color string assigned to this user in this doc
  cursor: {
    line: number;
    column: number;
    selection?: { anchorLine: number; anchorColumn: number; focusLine: number; focusColumn: number };
  } | null;
  joinedAt: number;       // Unix timestamp ms
}
```

---

#### `presence.updated`

Broadcast to all members in a document when the member list changes (join or leave).

```typescript
{
  type: "presence.updated",
  payload: {
    docId: string;
    members: PresenceMember[];
    memberCount: number;
    event: "joined" | "left";
    userId: string;           // who joined or left
    displayName: string;
  }
}
```

---

#### `cursor.updated`

Broadcast to all members in a document except the sender when a cursor moves.

```typescript
{
  type: "cursor.updated",
  payload: {
    docId: string;
    userId: string;
    displayName: string;
    color: string;
    cursor: {
      line: number;
      column: number;
      selection?: { ... };
    };
  }
}
```

---

#### `edit.ack`

Sent only to the submitter to acknowledge a received edit.

```typescript
{
  type: "edit.ack",
  msgId: string;              // echoes the msgId from edit.submit
  payload: {
    editId: string;           // server-assigned ID for this edit
    seq: number;              // global sequence number for the doc
    appliedAt: number;        // server timestamp
  }
}
```

---

#### `edit.broadcast`

Sent to all members in the document except the submitter.

```typescript
{
  type: "edit.broadcast",
  payload: {
    editId: string;
    docId: string;
    seq: number;
    authorId: string;
    authorName: string;
    operation: EditOperation;
    appliedAt: number;
  }
}
```

---

#### `history.replay`

Sent to a newly joined member with recent edit history, or in response to
`history.request`.

```typescript
{
  type: "history.replay",
  payload: {
    docId: string;
    edits: Array<{
      editId: string;
      seq: number;
      authorId: string;
      authorName: string;
      operation: EditOperation;
      appliedAt: number;
    }>;
    totalCount: number;       // total edits in history (may be more than returned)
  }
}
```

---

#### `error`

Sent to a client when their message cannot be processed.

```typescript
{
  type: "error",
  msgId?: string;             // echoes msgId if the failed message had one
  payload: {
    code: ErrorCode;
    message: string;
  }
}

type ErrorCode =
  | "AUTHENTICATION_FAILED"  // bad or missing JWT
  | "INVALID_JSON"           // could not parse message
  | "UNKNOWN_TYPE"           // unrecognized message type
  | "INVALID_PAYLOAD"        // missing required field
  | "NOT_JOINED"             // tried to do something without joining a doc first
  | "ALREADY_JOINED"         // tried to join while already in a document
  | "RATE_LIMITED"           // too many messages
  | "INTERNAL_ERROR";        // unexpected server error
```

---

#### `ping` / `pong`

The server sends `ping` control frames (not JSON messages) every 30 seconds. Clients
must respond with `pong` frames. If a pong is not received within 30 seconds of the
ping, the server terminates the connection.

---

## Authentication Flow

1. Client generates or retrieves a JWT with claims:
   ```json
   { "sub": "user_123", "name": "Alice Chen", "iat": 1710000000, "exp": 1710003600 }
   ```

2. Client opens WebSocket: `wss://relay.example.com/ws?token=<JWT>`

3. Server, on receiving the upgrade request:
   - Extracts `token` from the query string
   - Verifies signature and expiry
   - On failure: sends HTTP 401 or closes with code 4001 and reason "Authentication failed"
   - On success: stores `userId` and `displayName` on the connection, allows the upgrade

4. Connection is now authenticated. The client can send `doc.join`.

### JWT Secret

For this project, use a symmetric HS256 JWT with a secret from an environment variable:
`JWT_SECRET=your-secret-here`

For testing, you may sign tokens locally. The `jsonwebtoken` package handles both
signing and verification.

### User Color Assignment

Each user in a document is assigned a color so their cursor and edits can be
distinguished. Use a deterministic mapping: hash the `userId` to one of a predefined
color palette. The same user should always get the same color in the same document.

```typescript
const COLORS = [
  "#E57373", "#F06292", "#BA68C8", "#7986CB",
  "#4FC3F7", "#4DB6AC", "#81C784", "#FFD54F",
  "#FF8A65", "#A1887F",
];

function assignColor(userId: string, docId: string): string {
  const hash = cyrb53(userId + docId); // simple hash function
  return COLORS[hash % COLORS.length];
}
```

---

## State Design

### In-Memory State

```typescript
// Per-document presence
type DocPresence = Map<string, PresenceMember>; // userId → PresenceMember

// Per-document edit history (ring buffer, last 200 edits)
type DocHistory = EditEntry[];

// Per-connection state
interface ConnectedUser {
  ws: WebSocket;
  userId: string;
  displayName: string;
  currentDocId: string | null;
  isAlive: boolean;
}

// Global state
const presence = new Map<string, DocPresence>();    // docId → presence
const history = new Map<string, DocHistory>();      // docId → edit list
const connections = new Map<string, ConnectedUser>(); // userId → connection
                                                    // (one connection per user)
const docRooms = new Map<string, Set<ConnectedUser>>(); // docId → connected users
```

### State Consistency Rules

- A user can be in at most one document at a time. Joining a new document
  automatically leaves the current one.
- `presence.get(docId)` is the authoritative member list for a document.
- When a user's connection closes (by any means: graceful or heartbeat timeout),
  they are removed from all presence maps and the `docRooms` map.
- Edit history is bounded to 200 entries per document. Older entries are evicted
  when the limit is reached.

---

## Getting Started

### Prerequisites

- Node.js 18+
- The `ws`, `jsonwebtoken`, and `dotenv` npm packages

### Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Set: JWT_SECRET=any-random-secret-string

# Start the server
npm start

# Start in development mode with auto-restart
npm run dev
```

### Environment Variables

```
PORT=8080
JWT_SECRET=your-secret-here
HEARTBEAT_INTERVAL=30000     # milliseconds between pings
HISTORY_LIMIT=200            # max edits to keep per document
RATE_LIMIT_MESSAGES=20       # max messages per second per connection
```

### Project Structure

```
src/
├── server.ts               # Entry point: creates HTTP + WS server
├── auth.ts                 # JWT verification on upgrade
├── connection.ts           # Connection type definitions and lifecycle
├── rooms/
│   ├── presence.ts         # Presence tracking logic
│   └── history.ts          # Edit history ring buffer
├── handlers/
│   ├── doc.ts              # doc.join, doc.leave handlers
│   ├── cursor.ts           # cursor.move handler
│   ├── edit.ts             # edit.submit handler
│   └── history.ts          # history.request handler
├── broadcast.ts            # Broadcasting utilities
├── heartbeat.ts            # Ping/pong heartbeat management
├── rate-limit.ts           # Token bucket rate limiter
└── protocol.ts             # TypeScript types for all messages
```

### Generating Test JWTs

```bash
# Quick script to generate a test token (valid for 1 hour)
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { sub: 'user_001', name: 'Alice Chen' },
  process.env.JWT_SECRET || 'dev-secret',
  { expiresIn: '1h' }
);
console.log(token);
"
```

### Testing with wscat

```bash
# Install wscat globally
npm install -g wscat

# Connect with a token
wscat -c "ws://localhost:8080/ws?token=<your-token>"

# After connecting, join a document:
> {"type":"doc.join","payload":{"docId":"doc_001"}}

# Move your cursor:
> {"type":"cursor.move","payload":{"line":5,"column":12}}

# Submit an edit:
> {"type":"edit.submit","msgId":"m1","payload":{"docId":"doc_001","operation":{"type":"insert","position":{"line":0,"column":0},"text":"Hello, world!"}}}
```

---

## Grading Criteria

| Area | Points | What is Evaluated |
|------|--------|-------------------|
| Connection authentication | 15 | JWT verified on upgrade; invalid tokens rejected with code 4001 |
| `doc.join` / `doc.leave` | 15 | Correct room management; `doc.joined` contains current members; presence broadcast sent to others |
| Presence tracking | 15 | `presence.updated` sent correctly on join/leave/disconnect; no phantom members after disconnect |
| Cursor sharing | 10 | `cursor.updated` broadcast to others but not sender; high-frequency cursor moves handled without crashing |
| Edit broadcasting | 20 | `edit.ack` to sender; `edit.broadcast` to others; sequence numbers increment monotonically |
| Edit history | 10 | `history.replay` sent on join; `history.request` pagination works; history bounded to 200 entries |
| Heartbeat | 10 | Zombie connections terminated after missed pong; termination triggers correct presence cleanup |
| Error handling | 5 | All error codes sent correctly; malformed JSON handled; unknown message types handled |
| Code quality | 5 | Types defined for all messages; no `any`; handlers separated from server setup |
| Graceful shutdown | 5 | SIGTERM closes all connections with code 1001 before process exits |

**Total: 110 points**

### Bonus (up to 15 extra points)

| Bonus Area | Points | Description |
|------------|--------|-------------|
| Rate limiting | +5 | Token bucket per connection; rate-limited clients receive `RATE_LIMITED` error |
| Reconnection recovery | +5 | Client can send `lastSeq` on `doc.join` and receive missed edits since that seq |
| Multi-server with Redis | +5 | Server works correctly when multiple instances are run; messages cross server boundaries via Redis pub/sub |
