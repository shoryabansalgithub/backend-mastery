# Relay — Implementation Plan

This plan breaks the project into five sequential phases. Each phase produces working,
testable code before the next begins. Do not jump to Phase 3 until Phase 2's room
management is solid — a bug in presence tracking is much harder to diagnose when you
are also debugging edit broadcasting.

Estimated time: 6–10 hours for a developer working through WebSocket patterns for the
first time.

---

## Phase 1: Base WebSocket Server + Auth Middleware

**Goal:** A running WebSocket server that authenticates connections and rejects invalid
ones. No rooms, no messages — just a secure handshake.

### 1.1 — Project Setup

```bash
mkdir relay && cd relay
npm init -y
npm install ws jsonwebtoken dotenv
npm install -D @types/ws @types/jsonwebtoken typescript tsx
```

Create `tsconfig.json` with `"strict": true` and `"target": "ES2022"`.

Create `.env.example`:
```
PORT=8080
JWT_SECRET=dev-secret-change-in-production
HEARTBEAT_INTERVAL=30000
HISTORY_LIMIT=200
RATE_LIMIT_MESSAGES=20
```

### 1.2 — Protocol Types

Create `src/protocol.ts` first. Define TypeScript interfaces for every message type
documented in the README. This file is your contract — everything else is built to
satisfy it.

```typescript
// src/protocol.ts — excerpt
export interface DocJoinMessage {
  type: "doc.join";
  payload: { docId: string };
  msgId?: string;
}

export interface EditSubmitMessage {
  type: "edit.submit";
  msgId: string;
  payload: { docId: string; operation: EditOperation };
}

// ... all other message types
```

Getting the types right now means TypeScript will catch mismatches throughout the
project. Do not use `any` — define types for everything.

### 1.3 — Authentication Module

Create `src/auth.ts`:

```typescript
import jwt from "jsonwebtoken";
import { IncomingMessage } from "http";

interface AuthResult {
  success: true;
  userId: string;
  displayName: string;
} | {
  success: false;
  reason: string;
}

export function authenticateUpgrade(request: IncomingMessage): AuthResult {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    return { success: false, reason: "No token provided" };
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      sub: string;
      name: string;
    };

    if (!payload.sub || !payload.name) {
      return { success: false, reason: "Invalid token claims" };
    }

    return { success: true, userId: payload.sub, displayName: payload.name };
  } catch (err) {
    return { success: false, reason: "Invalid or expired token" };
  }
}
```

### 1.4 — Connection Type

Create `src/connection.ts`:

```typescript
import { WebSocket } from "ws";

export interface ConnectedUser {
  ws: WebSocket;
  userId: string;
  displayName: string;
  currentDocId: string | null;
  isAlive: boolean;
}
```

### 1.5 — Server Entry Point

Create `src/server.ts` that:
1. Creates an HTTP server
2. Creates a `WebSocketServer` attached to it
3. On `connection`, calls `authenticateUpgrade` and closes with code 4001 on failure
4. On successful auth, creates a `ConnectedUser` and adds it to a connections map
5. Cleans up the connection on close

Verify by connecting without a token (should get 4001), with an invalid token (4001),
and with a valid token (connection stays open).

### 1.6 — Heartbeat

Create `src/heartbeat.ts` with the ping/pong interval. Wire it into `server.ts`.

The heartbeat module should export:
```typescript
export function startHeartbeat(wss: WebSocketServer): NodeJS.Timeout
export function stopHeartbeat(interval: NodeJS.Timeout): void
```

It must call `leaveAllRooms` (from Phase 2) when terminating a connection. For now,
stub that function.

### 1.7 — Message Dispatch Skeleton

Create `src/dispatch.ts` with a `dispatch(user: ConnectedUser, raw: Buffer)` function
that:
1. Parses JSON, sends `INVALID_JSON` on failure
2. Checks `type` field, sends `UNKNOWN_TYPE` if unrecognized
3. Switches on `type` and calls stub handler functions
4. Catches any error and sends `INTERNAL_ERROR`

Wire it into the `message` event handler in `server.ts`.

**Phase 1 is done when:** A client can connect with a valid JWT and the server logs their
userId. An invalid JWT results in a 4001 close. The heartbeat fires every 30 seconds.

---

## Phase 2: Room Management

**Goal:** Full `doc.join` and `doc.leave` handling, presence tracking, and correct
cleanup on disconnect.

### 2.1 — State Store

Create `src/state.ts` as the single module that owns all mutable state:

```typescript
// src/state.ts
import { ConnectedUser } from "./connection";
import { PresenceMember } from "./protocol";

export const docRooms = new Map<string, Set<ConnectedUser>>();
export const presence = new Map<string, Map<string, PresenceMember>>();
export const connections = new Map<string, ConnectedUser>(); // userId → user
```

State in one place means you can reason about consistency. Never duplicate state
across modules.

### 2.2 — Presence Module

Create `src/rooms/presence.ts`:

```typescript
export function addToPresence(docId: string, user: ConnectedUser): void
export function removeFromPresence(docId: string, userId: string): void
export function getPresence(docId: string): PresenceMember[]
export function assignColor(userId: string, docId: string): string
export function leaveAllRooms(user: ConnectedUser): void
```

Implement `leaveAllRooms` to remove the user from `docRooms` and `presence` for every
document they are in, then broadcast `presence.updated` to each affected document.

### 2.3 — Broadcast Module

Create `src/broadcast.ts`:

```typescript
// Send to one specific connection
export function sendTo(user: ConnectedUser, message: unknown): void

// Send to all members in a document
export function broadcastToDoc(docId: string, message: unknown): void

// Send to all members in a document except one user
export function broadcastToDocExcept(
  docId: string,
  excludeUserId: string,
  message: unknown
): void
```

These are simple wrappers over `ws.send()` with `readyState` checks and JSON
serialization. Centralizing them here means you can add logging or metrics in one place.

### 2.4 — `doc.join` Handler

Create `src/handlers/doc.ts`:

```typescript
export function handleDocJoin(user: ConnectedUser, payload: { docId: string }): void {
  // 1. If already in a doc, leave it first
  // 2. Validate docId
  // 3. Add user to docRooms[docId]
  // 4. Add user to presence[docId] with color assigned
  // 5. Send doc.joined to the joining user (include current members + history.replay)
  // 6. Broadcast presence.updated to all other members
}
```

### 2.5 — `doc.leave` Handler

```typescript
export function handleDocLeave(user: ConnectedUser): void {
  // 1. If not in a doc, send error NOT_JOINED
  // 2. Remove from docRooms and presence
  // 3. Send doc.left to the leaving user
  // 4. Broadcast presence.updated to remaining members
}
```

### 2.6 — Disconnect Cleanup

In `server.ts`, in the `close` event handler:

```typescript
ws.on("close", () => {
  if (user.currentDocId) {
    leaveAllRooms(user);
  }
  connections.delete(user.userId);
});
```

**Critical test:** Connect two clients to the same document. Disconnect one. Verify the
remaining client receives `presence.updated` with the departed user removed.

**Phase 2 is done when:** Two clients can join the same document and each receives the
other's presence. When either disconnects (or heartbeat kills the connection), the
other receives `presence.updated`.

---

## Phase 3: Message Protocol + Broadcasting

**Goal:** Edit submission, acknowledgement, and broadcasting. The core real-time feature.

### 3.1 — Edit History Module

Create `src/rooms/history.ts`:

```typescript
interface EditEntry {
  editId: string;
  seq: number;
  authorId: string;
  authorName: string;
  operation: EditOperation;
  appliedAt: number;
}

export function appendEdit(docId: string, entry: EditEntry): void
export function getHistory(docId: string, limit?: number, before?: string): EditEntry[]
export function getNextSeq(docId: string): number
export function clearHistory(docId: string): void
```

The history for each document is a fixed-size array (bounded by `HISTORY_LIMIT` from
env). When full, shift out the oldest entry.

The sequence number per document: maintain a `Map<string, number>` of `docId → seq`.
Increment atomically (single-threaded Node.js makes this safe — no concurrent writes).

### 3.2 — `edit.submit` Handler

Create `src/handlers/edit.ts`:

```typescript
export function handleEditSubmit(
  user: ConnectedUser,
  message: EditSubmitMessage
): void {
  // 1. Verify user is in the specified docId
  // 2. Validate the operation shape
  // 3. Assign editId (UUID) and seq (next seq for this doc)
  // 4. Append to history
  // 5. Send edit.ack to submitter (echo msgId)
  // 6. Broadcast edit.broadcast to all others in the doc
}
```

The `edit.ack` includes `editId`, `seq`, and `appliedAt`. The `edit.broadcast` includes
everything in `edit.ack` plus `authorId`, `authorName`, and the full `operation`.

### 3.3 — `history.request` Handler

Create `src/handlers/history.ts`:

```typescript
export function handleHistoryRequest(
  user: ConnectedUser,
  payload: { limit?: number; before?: string }
): void {
  // 1. Verify user is in a document
  // 2. Clamp limit to max 200
  // 3. Fetch from history module
  // 4. Send history.replay
}
```

### 3.4 — Wiring to Dispatch

In `src/dispatch.ts`, fill in the stub cases:

```typescript
switch (message.type) {
  case "doc.join":    handleDocJoin(user, message.payload);    break;
  case "doc.leave":   handleDocLeave(user);                    break;
  case "cursor.move": handleCursorMove(user, message.payload); break;
  case "edit.submit": handleEditSubmit(user, message);         break;
  case "history.request": handleHistoryRequest(user, message.payload); break;
}
```

**Phase 3 is done when:** Two clients connect, join the same document, and edits
submitted by one appear as `edit.broadcast` messages on the other. The sequence numbers
are monotonically increasing.

---

## Phase 4: Presence and Cursor Tracking

**Goal:** Real-time cursor position sharing between document members.

### 4.1 — Cursor State in Presence

Extend `PresenceMember` to include a cursor:

```typescript
interface PresenceMember {
  userId: string;
  displayName: string;
  color: string;
  cursor: CursorPosition | null;
  joinedAt: number;
}
```

When a user first joins, `cursor` is `null`. It updates as they send `cursor.move`
messages.

### 4.2 — `cursor.move` Handler

Create `src/handlers/cursor.ts`:

```typescript
export function handleCursorMove(
  user: ConnectedUser,
  payload: CursorMovePayload
): void {
  // 1. Verify user is in a document
  // 2. Validate line/column are non-negative integers
  // 3. Update presence[docId][userId].cursor
  // 4. Broadcast cursor.updated to all others in the doc (NOT back to sender)
}
```

### 4.3 — Cursor in `doc.joined`

When building the member list for `doc.joined`, include each member's current cursor
position from the presence map. A newly joined user immediately sees where everyone
else's cursor is.

### 4.4 — Rate Consideration

Cursor moves can arrive up to 10 times per second per user. With 10 users in a document,
that is 100 broadcasts per second from cursor moves alone. This is fine for a single
server and modest user counts, but worth noting.

A practical optimization: **cursor throttling** on the client. The client should not
send `cursor.move` on every keypress — only when the position actually changes, and
throttled to at most 10/second. The server does not enforce this limit, but you can
mention it in code comments.

**Phase 4 is done when:** Connecting two browser tabs to the same document, moving the
cursor in one tab's simulated input, and verifying the other tab receives `cursor.updated`
with the correct line/column.

---

## Phase 5: Edit History on Join + Graceful Shutdown

**Goal:** Newly joined users receive recent edit history. Server shuts down cleanly.

### 5.1 — `history.replay` on Join

In `handleDocJoin`, after sending `doc.joined`, send a `history.replay` message with
the last 50 edits for the document (or all edits if fewer than 50 exist):

```typescript
// In handleDocJoin, after sendTo(user, docJoinedMessage):
const recentEdits = getHistory(docId, 50);
if (recentEdits.length > 0) {
  sendTo(user, {
    type: "history.replay",
    payload: {
      docId,
      edits: recentEdits,
      totalCount: getHistory(docId, 200).length,
    },
  });
}
```

This allows a reconnecting user to see recent changes without requesting them
explicitly.

### 5.2 — Graceful Shutdown

Create `src/graceful-shutdown.ts`:

```typescript
export async function gracefulShutdown(
  wss: WebSocketServer,
  heartbeatInterval: NodeJS.Timeout
): Promise<void> {
  console.log("Relay shutting down...");

  stopHeartbeat(heartbeatInterval);
  wss.close();

  const closePromises: Promise<void>[] = [];

  wss.clients.forEach((ws) => {
    closePromises.push(
      new Promise((resolve) => {
        ws.close(1001, "Server restarting");
        ws.once("close", resolve);
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
          resolve();
        }, 5000);
      })
    );
  });

  await Promise.all(closePromises);
  console.log("All connections closed cleanly.");
}
```

Wire into `server.ts`:
```typescript
process.on("SIGTERM", () => gracefulShutdown(wss, heartbeat).then(() => process.exit(0)));
process.on("SIGINT", () => gracefulShutdown(wss, heartbeat).then(() => process.exit(0)));
```

**Phase 5 is done when:** A client receives `history.replay` immediately after joining
a document that has existing edits. Ctrl+C sends code 1001 to all connected clients.

---

## Key Decisions

### In-Memory vs. Redis

For this project, all state (presence, history, rooms) is in-memory. This means:

**Advantages:**
- Zero infrastructure dependencies
- Zero latency for presence lookups and broadcasts
- Simple to reason about

**Disadvantages:**
- State is lost on server restart
- Does not scale beyond one process

For production, presence should live in Redis (with TTL per member), edit history in
PostgreSQL, and the message bus should use Redis pub/sub as described in Lesson 4.

The in-memory approach is correct for a single-server deployment and appropriate for
this project's scope.

### Message Protocol Design: Why `{ type, payload }` Envelope?

Alternatives considered:
- **Flat messages**: `{ "action": "join", "docId": "..." }` — fields collide between
  message types; harder to validate
- **RPC-style**: `{ "method": "joinDoc", "params": [...] }` — more like JSON-RPC; works
  but less idiomatic for push-based protocols
- **Typed union**: `{ "type": "doc.join", "payload": { "docId": "..." } }` — selected
  approach; the `payload` field scopes all type-specific data; TypeScript discriminated
  unions map cleanly to this structure

The `msgId` field in the envelope enables request-response correlation (for `edit.ack`)
without building a full RPC layer. Only messages that expect acknowledgements need to
send `msgId`.

### One Connection Per User vs. Multiple Connections Per User

This project assumes one connection per user. Attempting to connect a second time with
the same `userId` either closes the old connection or rejects the new one (your choice).

In production, users often have multiple browser tabs or devices. Supporting this
requires namespacing all presence and cursor state by connection ID, not user ID, and
merging them for display. That complexity is out of scope here.

### Edit Operations: Why Not Operational Transformation?

True collaborative editing (Google Docs style) uses Operational Transformation (OT) or
CRDTs to merge concurrent edits from different users. This is a complex topic with
significant academic literature.

This project intentionally avoids OT. Edits are applied in the order they arrive at
the server. Concurrent edits can produce conflicts that this system does not resolve.
This is acceptable for the WebSocket learning goals — the focus is on connection
management and message routing, not conflict resolution algorithms.

If you want to explore OT, look at the `ot.js` and `sharedb` libraries.

---

## Testing Approach

### Testing WebSocket Servers

WebSocket servers are integration-tested — unit tests of individual handler functions
can be useful, but the meaningful tests require a real server and client.

The `ws` library includes a WebSocket client that works in Node.js tests without a
browser:

```typescript
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";

function createTestClient(token?: string): WebSocket {
  const t = token ?? jwt.sign(
    { sub: "test_user", name: "Test User" },
    process.env.JWT_SECRET!
  );
  return new WebSocket(`ws://localhost:${process.env.PORT}/ws?token=${t}`);
}

// Wait for a specific message type
function waitForMessage(ws: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      3000
    );

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}
```

### Test Structure

Use a `beforeEach` that starts a fresh server instance and an `afterEach` that shuts
it down. This keeps tests independent.

```typescript
let server: ReturnType<typeof startServer>;

beforeEach(async () => {
  server = await startServer(0); // port 0 = OS-assigned port
});

afterEach(async () => {
  await server.shutdown();
});
```

### What to Test

| Test | Priority |
|------|----------|
| Connection rejected without token → 4001 | Critical |
| Connection rejected with expired token → 4001 | Critical |
| Valid token establishes connection | Critical |
| `doc.join` sends `doc.joined` with member list | Critical |
| Second client joining receives first client in member list | Critical |
| Joining sends `presence.updated` to existing members | Critical |
| Disconnecting client triggers `presence.updated` on remaining clients | Critical |
| Heartbeat terminates zombie connection (stub ws.ping, no pong response) | Critical |
| `edit.submit` sends `edit.ack` to sender | High |
| `edit.submit` broadcasts `edit.broadcast` to others | High |
| Sequence numbers are monotonically increasing | High |
| `history.replay` is sent on join with existing history | High |
| `cursor.move` broadcasts `cursor.updated` to others but not sender | High |
| Graceful shutdown sends 1001 to all clients | Medium |
| Malformed JSON sends `INVALID_JSON` error | Medium |
| Unknown message type sends `UNKNOWN_TYPE` error | Medium |
| `edit.submit` without joining sends `NOT_JOINED` | Medium |

### Testing Heartbeat Behavior

Heartbeat testing is tricky because the 30-second interval is too long for a test.
Use dependency injection to make the interval configurable:

```typescript
export function startHeartbeat(
  wss: WebSocketServer,
  intervalMs = 30_000
): NodeJS.Timeout
```

In tests, use `intervalMs = 100` and mock the `pong` event to verify termination:

```typescript
// Test: connection with no pong response is terminated
const ws = createTestClient();
await connected(ws);

// Don't respond to ping — simulate zombie connection
ws.on("ping", () => { /* don't pong */ });

// Wait for the heartbeat interval × 2
await sleep(250);

// Connection should be closed
expect(ws.readyState).toBe(WebSocket.CLOSED);
```

### Load Testing

For a bonus exercise, use the `ws` library to open 100 simultaneous connections to the
same document and measure:
- Message throughput (edits per second before latency degrades)
- Presence update latency (time from one client's `doc.join` to another client
  receiving `presence.updated`)
- Memory usage per connection

A reasonable baseline: 100 concurrent users in one document, 10 edits/second total,
with <50ms presence update latency and <100MB total memory.
