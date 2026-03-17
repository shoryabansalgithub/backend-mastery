# Lesson 3: The `ws` Library and Application Patterns

## From Protocol to Practice

Lessons 1 and 2 covered the theory: why real-time connections matter and how the
WebSocket protocol works at the frame level. Now we write code.

The `ws` npm package is the de facto standard for WebSocket servers in Node.js. It is
not the flashiest library — there is no magic, no automatic reconnection, no built-in
rooms. What it gives you is a thin, correct implementation of RFC 6455 with no
opinions about how you structure your application.

That spareness is a feature, not a limitation. Every pattern you are about to learn
works with `ws` because the patterns are general — they describe how to think about
stateful network connections, not how to use a specific API. Understanding these
patterns with `ws` means you can apply the same thinking to Socket.io, uWebSockets.js,
or any WebSocket stack you encounter.

---

## Setting Up

```bash
npm install ws
npm install -D @types/ws
```

The basic server in twelve lines:

```typescript
import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");

  ws.on("message", (data) => {
    console.log("Received:", data.toString());
    ws.send("Echo: " + data.toString());
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

console.log("WebSocket server running on ws://localhost:8080");
```

Test it from a browser console:
```javascript
const ws = new WebSocket("ws://localhost:8080");
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () => ws.send("Hello!");
```

You will see `Echo: Hello!` in the browser console. This is a working WebSocket
server. Now let us understand every piece of it.

---

## The WebSocketServer API

`WebSocketServer` (abbreviated `wss`) is the server-side listener. It binds to a port
and emits events as clients connect.

### Constructor Options

```typescript
import { WebSocketServer } from "ws";
import { createServer } from "http";

// Option 1: Standalone server on a dedicated port
const wss = new WebSocketServer({ port: 8080 });

// Option 2: Attach to an existing HTTP server (most common in real apps)
const httpServer = createServer(app); // Express app
const wss = new WebSocketServer({ server: httpServer });
// Now WebSocket upgrades on port 3000 route to wss

// Option 3: Attach to a specific path
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
// Only connections to ws://host/ws go to this server
```

Attaching to an existing HTTP server (Option 2) is almost always the right choice in
production. It means your WebSocket server and your HTTP API share a port, which
matters for firewalls, load balancers, and TLS certificates.

### Server Events

```typescript
wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
  // ws: the individual client connection
  // request: the original HTTP upgrade request (contains headers, URL, etc.)
});

wss.on("error", (err: Error) => {
  // Server-level error (bind failed, etc.)
  console.error("Server error:", err);
});

wss.on("listening", () => {
  // Server is bound and ready
  console.log("WebSocket server listening");
});

wss.on("close", () => {
  // Server has been shut down
});
```

The `request` parameter in the `connection` event is crucial. It carries everything
from the original HTTP upgrade:

```typescript
wss.on("connection", (ws, request) => {
  // Parse the URL and query parameters
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const token = url.searchParams.get("token"); // ws://host/ws?token=abc

  // Read headers
  const origin = request.headers.origin;
  const cookies = request.headers.cookie;

  // Client IP (for rate limiting, logging)
  const ip = request.socket.remoteAddress;
});
```

---

## The Client Connection API

Each individual connection is a `WebSocket` instance. Think of it as one end of a
bidirectional pipe.

### Client Events

```typescript
wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data: RawData, isBinary: boolean) => {
    // data: Buffer, ArrayBuffer, or Buffer[] depending on the message
    // isBinary: true if sent as binary frame, false if text frame
    if (!isBinary) {
      const text = data.toString(); // for text frames
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    // code: WebSocket close code (1000=normal, 1001=going away, etc.)
    // reason: Buffer with human-readable reason
    console.log(`Closed: ${code} ${reason.toString()}`);
  });

  ws.on("error", (err: Error) => {
    // A connection-level error. This fires before "close".
    console.error("Connection error:", err.message);
  });

  ws.on("ping", (data: Buffer) => {
    // Server received a ping from the client (rare — usually it's the other way)
  });

  ws.on("pong", (data: Buffer) => {
    // Server received a pong in response to a ping it sent
    // Used for heartbeat: mark this connection as alive
  });
});
```

### Sending Data

```typescript
// Send text
ws.send("Hello, client!");

// Send JSON
ws.send(JSON.stringify({ type: "welcome", payload: { userId: 42 } }));

// Send binary
ws.send(Buffer.from([0x01, 0x02, 0x03]));

// Send with a callback to know when it's flushed
ws.send("Important message", (err) => {
  if (err) {
    console.error("Send failed:", err);
  }
});
```

### Connection State

Before sending, always check whether the connection is still open:

```typescript
if (ws.readyState === WebSocket.OPEN) {
  ws.send(message);
}
```

The four states, mirroring the browser WebSocket API:

| State | Value | Meaning |
|-------|-------|---------|
| `CONNECTING` | 0 | Opening handshake in progress |
| `OPEN` | 1 | Connection is open and operational |
| `CLOSING` | 2 | Close handshake has been initiated |
| `CLOSED` | 3 | Connection is closed |

Sending to a non-`OPEN` connection silently fails or throws, depending on the timing.
The `readyState` check is cheap — always do it before sending.

---

## Heartbeat: Detecting Stale Connections

Here is a problem the WebSocket protocol does not solve by itself: connections can
die silently.

Imagine a mobile user's phone goes into a tunnel. The TCP connection is severed. But
there is no TCP FIN packet — the connection simply disappears. Your server still holds
the `WebSocket` object in memory. The client still thinks they are connected. Neither
side knows the truth.

This is a **zombie connection**. Your server might accumulate thousands of them,
wasting memory and sending messages to dead connections.

The solution is a **heartbeat**: periodically ping each client and expect a pong back
within a timeout. If the pong does not arrive, terminate the connection.

### How Ping/Pong Works

The WebSocket protocol has built-in ping and pong control frames. You send a ping;
the other side must respond with a pong with the same payload. If no pong arrives, the
connection is dead.

```typescript
import { WebSocketServer, WebSocket } from "ws";

// Extend WebSocket to track liveness
interface HeartbeatWebSocket extends WebSocket {
  isAlive: boolean;
}

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws: WebSocket) => {
  const conn = ws as HeartbeatWebSocket;
  conn.isAlive = true;

  // When we receive a pong, mark the connection alive
  conn.on("pong", () => {
    conn.isAlive = true;
  });
});

// Every 30 seconds, ping all connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const conn = ws as HeartbeatWebSocket;

    if (!conn.isAlive) {
      // No pong since last ping — connection is dead
      console.log("Terminating zombie connection");
      conn.terminate(); // forceful close, no handshake
      return;
    }

    // Mark as not-alive until we get the pong back
    conn.isAlive = false;
    conn.ping();
  });
}, 30_000);

// Clean up the interval when the server shuts down
wss.on("close", () => {
  clearInterval(heartbeatInterval);
});
```

The logic:
1. At heartbeat time, mark all connections `isAlive = false` and send a ping.
2. Each connection that responds with a pong sets its `isAlive = true`.
3. At the next heartbeat, any connection still marked `false` did not respond — kill it.

`terminate()` is a hard close — it forcefully destroys the TCP connection without a
WebSocket close handshake. Use it for dead connections; use `ws.close(code, reason)`
for graceful closes.

---

## Message Types and Routing: Designing a JSON Protocol

Raw WebSocket connections carry byte sequences. To build a real application, you need
to agree on a message format so the server and client know what each message means.

The most common approach: **a JSON envelope with a `type` field**.

```typescript
// Every message has this shape
interface Message {
  type: string;      // what kind of message this is
  payload?: unknown; // the message-specific data
  id?: string;       // optional: request ID for request-response patterns
}
```

Examples:

```json
// Client → Server: send a chat message
{ "type": "chat.send", "payload": { "roomId": "room_123", "text": "Hello!" } }

// Server → Client: deliver a chat message
{ "type": "chat.message", "payload": { "from": "alice", "text": "Hello!", "timestamp": 1710000000000 } }

// Client → Server: join a room
{ "type": "room.join", "payload": { "roomId": "room_123" } }

// Server → Client: acknowledge
{ "type": "room.joined", "payload": { "roomId": "room_123", "memberCount": 5 } }

// Server → Client: error
{ "type": "error", "payload": { "code": "ROOM_NOT_FOUND", "message": "Room does not exist" } }
```

### The Message Router

With multiple message types, you need a dispatcher:

```typescript
// Message handler type
type MessageHandler<T = unknown> = (
  ws: WebSocket,
  payload: T
) => void | Promise<void>;

// Registry of handlers keyed by message type
const handlers = new Map<string, MessageHandler<any>>();

function on<T>(type: string, handler: MessageHandler<T>) {
  handlers.set(type, handler);
}

// Parse and dispatch incoming messages
function handleMessage(ws: WebSocket, rawData: Buffer | string) {
  let message: Message;

  try {
    message = JSON.parse(rawData.toString()) as Message;
  } catch {
    ws.send(JSON.stringify({ type: "error", payload: { code: "INVALID_JSON" } }));
    return;
  }

  if (!message.type || typeof message.type !== "string") {
    ws.send(JSON.stringify({ type: "error", payload: { code: "MISSING_TYPE" } }));
    return;
  }

  const handler = handlers.get(message.type);
  if (!handler) {
    ws.send(
      JSON.stringify({ type: "error", payload: { code: "UNKNOWN_TYPE", type: message.type } })
    );
    return;
  }

  Promise.resolve(handler(ws, message.payload)).catch((err) => {
    console.error(`Handler error for ${message.type}:`, err);
    ws.send(
      JSON.stringify({ type: "error", payload: { code: "INTERNAL_ERROR" } })
    );
  });
}

// Register handlers
on("chat.send", handleChatSend);
on("room.join", handleRoomJoin);
on("room.leave", handleRoomLeave);

// Wire up in the connection handler
wss.on("connection", (ws) => {
  ws.on("message", (data) => handleMessage(ws, data as Buffer));
});
```

This is the same pattern as an HTTP router, applied to WebSocket message types.

---

## Rooms and Channels: Grouping Connections

A "room" is a named group of connections. Messages sent to a room are delivered to
every connection in that room. This is how you build chat channels, document collaboration
spaces, game lobbies — any feature where multiple users share a context.

The `ws` library does not have a rooms concept. You build it yourself. The data
structure is a `Map` from room name to a `Set` of `WebSocket` connections:

```typescript
// The entire rooms system is one data structure
const rooms = new Map<string, Set<WebSocket>>();

function joinRoom(ws: WebSocket, roomId: string): void {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId)!.add(ws);
  console.log(`Client joined room ${roomId}. Room size: ${rooms.get(roomId)!.size}`);
}

function leaveRoom(ws: WebSocket, roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(ws);

  // Clean up empty rooms to prevent memory leak
  if (room.size === 0) {
    rooms.delete(roomId);
  }
}

// When a connection closes, remove it from ALL rooms
function leaveAllRooms(ws: WebSocket): void {
  for (const [roomId, members] of rooms.entries()) {
    if (members.has(ws)) {
      members.delete(ws);
      if (members.size === 0) {
        rooms.delete(roomId);
      }
    }
  }
}

function getRoomSize(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0;
}
```

The `leaveAllRooms` call on disconnect is essential. If you miss it, the `rooms` map
slowly fills with closed `WebSocket` objects — a memory leak that grows until the
process crashes.

---

## Broadcasting

Broadcasting means sending a message to multiple connections. There are three common
variants.

### 1. Broadcast to All Connected Clients

```typescript
function broadcast(message: unknown): void {
  const serialized = JSON.stringify(message);

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  });
}

// Example: server-wide announcement
broadcast({
  type: "announcement",
  payload: { text: "Server will restart in 5 minutes" },
});
```

### 2. Broadcast to a Room

```typescript
function broadcastToRoom(roomId: string, message: unknown): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const serialized = JSON.stringify(message);

  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
}
```

### 3. Broadcast to a Room, Excluding One Client

The most common pattern: User A sends a message, the server validates it and broadcasts
it to everyone else in the room, but not back to User A (they already know what they
typed).

```typescript
function broadcastToRoomExcept(
  roomId: string,
  exclude: WebSocket,
  message: unknown
): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const serialized = JSON.stringify(message);

  for (const ws of room) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
}
```

Serializing once and sending the same buffer to every client is an important
optimization. Do not call `JSON.stringify` inside the loop — it would re-serialize
on every iteration.

---

## Complete Example: A Chat Room Server

Let us put everything together: a full working chat server with rooms, heartbeats,
proper cleanup, and typed messages.

```typescript
// server.ts
import { WebSocketServer, WebSocket, RawData } from "ws";
import { createServer } from "http";

// --- Types ---

interface AuthenticatedWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string;
  displayName: string;
  currentRoom: string | null;
}

interface ClientMessage {
  type: string;
  payload?: unknown;
}

interface JoinPayload {
  roomId: string;
  displayName: string;
}

interface ChatPayload {
  text: string;
}

// --- State ---

// Map of roomId → Set of connected clients
const rooms = new Map<string, Set<AuthenticatedWebSocket>>();

// --- Room Helpers ---

function joinRoom(ws: AuthenticatedWebSocket, roomId: string): void {
  // Leave current room first
  if (ws.currentRoom) leaveRoom(ws);

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  rooms.get(roomId)!.add(ws);
  ws.currentRoom = roomId;
}

function leaveRoom(ws: AuthenticatedWebSocket): void {
  if (!ws.currentRoom) return;

  const room = rooms.get(ws.currentRoom);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(ws.currentRoom);
  }

  ws.currentRoom = null;
}

function broadcastToRoom(
  roomId: string,
  message: unknown,
  exclude?: AuthenticatedWebSocket
): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const serialized = JSON.stringify(message);
  for (const client of room) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", payload: { code, message } }));
  }
}

// --- Message Handlers ---

function handleJoin(ws: AuthenticatedWebSocket, payload: JoinPayload): void {
  const { roomId, displayName } = payload;

  if (!roomId || typeof roomId !== "string") {
    return sendError(ws, "INVALID_PAYLOAD", "roomId is required");
  }
  if (!displayName || typeof displayName !== "string") {
    return sendError(ws, "INVALID_PAYLOAD", "displayName is required");
  }

  ws.displayName = displayName.trim().slice(0, 32);

  joinRoom(ws, roomId);

  // Confirm to the joining user
  ws.send(
    JSON.stringify({
      type: "room.joined",
      payload: {
        roomId,
        memberCount: rooms.get(roomId)!.size,
      },
    })
  );

  // Announce to the room (excluding the new joiner)
  broadcastToRoom(
    roomId,
    {
      type: "room.member_joined",
      payload: { displayName: ws.displayName, memberCount: rooms.get(roomId)!.size },
    },
    ws
  );
}

function handleChat(ws: AuthenticatedWebSocket, payload: ChatPayload): void {
  if (!ws.currentRoom) {
    return sendError(ws, "NOT_IN_ROOM", "You must join a room before chatting");
  }

  const text = String(payload?.text ?? "").trim().slice(0, 2000);
  if (!text) return;

  // Broadcast to entire room (including sender, so sender sees echo)
  broadcastToRoom(ws.currentRoom, {
    type: "chat.message",
    payload: {
      from: ws.displayName,
      text,
      timestamp: Date.now(),
    },
  });
}

function handleLeave(ws: AuthenticatedWebSocket): void {
  if (!ws.currentRoom) return;

  const roomId = ws.currentRoom;
  leaveRoom(ws);

  broadcastToRoom(roomId, {
    type: "room.member_left",
    payload: { displayName: ws.displayName },
  });

  ws.send(JSON.stringify({ type: "room.left", payload: { roomId } }));
}

// --- Message Dispatch ---

function dispatch(ws: AuthenticatedWebSocket, rawData: RawData): void {
  let message: ClientMessage;

  try {
    message = JSON.parse(rawData.toString()) as ClientMessage;
  } catch {
    return sendError(ws, "INVALID_JSON", "Message must be valid JSON");
  }

  switch (message.type) {
    case "room.join":
      handleJoin(ws, message.payload as JoinPayload);
      break;
    case "chat.send":
      handleChat(ws, message.payload as ChatPayload);
      break;
    case "room.leave":
      handleLeave(ws);
      break;
    default:
      sendError(ws, "UNKNOWN_TYPE", `Unknown message type: ${message.type}`);
  }
}

// --- Server Setup ---

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach((rawWs) => {
    const ws = rawWs as AuthenticatedWebSocket;
    if (!ws.isAlive) {
      leaveRoom(ws);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("connection", (rawWs: WebSocket) => {
  const ws = rawWs as AuthenticatedWebSocket;
  ws.isAlive = true;
  ws.userId = crypto.randomUUID(); // until auth is added
  ws.displayName = "Anonymous";
  ws.currentRoom = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => dispatch(ws, data as RawData));

  ws.on("close", () => {
    if (ws.currentRoom) {
      const roomId = ws.currentRoom;
      leaveRoom(ws);
      broadcastToRoom(roomId, {
        type: "room.member_left",
        payload: { displayName: ws.displayName },
      });
    }
  });

  ws.on("error", (err) => {
    console.error(`Connection error for ${ws.userId}:`, err.message);
  });
});

wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(8080, () => {
  console.log("Chat server listening on ws://localhost:8080");
});
```

This is ~180 lines and it handles: room join/leave, chat broadcasting, heartbeat,
disconnect cleanup, and error feedback. Every non-trivial WebSocket application is a
variation of this structure.

---

## Error Handling

WebSocket error handling has three layers, and you need all three.

### Layer 1: Connection Errors

```typescript
ws.on("error", (err: Error) => {
  // Fires for TCP-level errors: ECONNRESET, ETIMEDOUT, etc.
  // This fires BEFORE "close". The connection will close after this.
  console.error("Socket error:", err.message);
  // Do not try to send here — the socket is already broken
});
```

### Layer 2: Message Processing Errors

```typescript
ws.on("message", (data) => {
  try {
    processMessage(ws, data);
  } catch (err) {
    // Catch synchronous errors in message handlers
    console.error("Message processing failed:", err);
    sendError(ws, "INTERNAL_ERROR", "Failed to process message");
  }
});
```

For async handlers, catch at the handler level:

```typescript
async function handleMessage(ws: WebSocket, data: RawData): Promise<void> {
  try {
    const message = JSON.parse(data.toString());
    await dispatch(ws, message);
  } catch (err) {
    console.error("Unhandled error:", err);
    sendError(ws, "INTERNAL_ERROR", "Something went wrong");
  }
}
```

### Layer 3: Server Errors

```typescript
wss.on("error", (err) => {
  // Port already in use, permissions denied, etc.
  console.error("WebSocket server error:", err);
  process.exit(1); // or restart strategy
});
```

---

## Backpressure in WebSockets

Here is a problem most tutorials skip: what happens if you send data faster than the
client can receive it?

Each `ws.send()` call queues the data in the kernel's TCP send buffer. If the client
is slow (slow connection, not reading, sleeping), this buffer fills up. The data piles
up in memory. With many slow clients, this causes your Node.js process to consume
gigabytes of RAM until it crashes.

The mechanism to detect this: `ws.bufferedAmount` — the number of bytes queued in
the send buffer but not yet transmitted.

```typescript
function safeSend(ws: WebSocket, message: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;

  const BUFFER_THRESHOLD = 512 * 1024; // 512 KB

  if (ws.bufferedAmount > BUFFER_THRESHOLD) {
    // Client is too far behind — this is a slow consumer
    // Options:
    // 1. Drop the message (acceptable for non-critical updates like cursor positions)
    // 2. Close the connection (acceptable for abuse/overload)
    // 3. Queue with a size limit and send when buffer drains
    console.warn(
      `Client buffer full (${ws.bufferedAmount} bytes queued). Dropping message.`
    );
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}
```

For most applications — chat, notifications, collaborative editing — dropping stale
messages is the right call. A cursor position that is 5 updates old is useless; better
to drop it and send the current one when the buffer drains.

For critical messages (financial transactions, auth tokens), use a queue with bounded
size and a drain event:

```typescript
ws.on("drain", () => {
  // Buffer has been flushed — safe to send more
});
```

---

## Graceful Shutdown

When your server restarts (deploy, crash recovery, scale-down), connected clients
should receive a proper close frame, not a TCP RST. This gives them the opportunity
to reconnect immediately rather than waiting for a timeout.

```typescript
async function gracefulShutdown(): Promise<void> {
  console.log("Shutting down WebSocket server...");

  // Stop accepting new connections
  wss.close();

  // Send close frame to all connected clients
  const closePromises: Promise<void>[] = [];

  wss.clients.forEach((ws) => {
    closePromises.push(
      new Promise((resolve) => {
        ws.close(1001, "Server is restarting"); // 1001 = "Going Away"
        ws.once("close", resolve);
        // Force-terminate if client does not close within 5 seconds
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
          }
          resolve();
        }, 5000);
      })
    );
  });

  await Promise.all(closePromises);
  console.log("All connections closed. Server shut down cleanly.");
}

// Handle SIGTERM (sent by process managers like PM2, Kubernetes)
process.on("SIGTERM", () => {
  gracefulShutdown().then(() => process.exit(0));
});

// Handle SIGINT (Ctrl+C during development)
process.on("SIGINT", () => {
  gracefulShutdown().then(() => process.exit(0));
});
```

Close code `1001` ("Going Away") is the standard code for server shutdowns and
navigating away. Clients that understand this code will attempt to reconnect
immediately. Close code `1000` means "normal closure" — the session is intentionally
ending and reconnection is not expected.

---

## Summary

| Concept | Key Insight |
|---------|-------------|
| `WebSocketServer` | Binds to a port; emits `connection` events with the HTTP upgrade request |
| Per-connection events | `message`, `close`, `error`, `pong` — handle all four |
| `readyState` | Always check `OPEN` before sending; silent failure otherwise |
| Heartbeat / ping-pong | Detect zombie connections; terminate without a pong response |
| JSON envelope protocol | `{ type, payload }` structure enables message routing |
| Rooms | `Map<string, Set<WebSocket>>` — built manually, cleaned up on disconnect |
| Broadcast | Serialize once, iterate the set, check `readyState` per client |
| Backpressure | Check `bufferedAmount`; drop or queue for slow consumers |
| Error handling | Three layers: socket, handler, server |
| Graceful shutdown | Send close frame, wait, then force-terminate |

---

## Exercises

### Exercise 1: Private Messaging

Extend the chat room server to support direct messages between users:

1. Add a `user.register` message type that lets a client claim a username.
2. Store a `Map<string, WebSocket>` of username → connection.
3. Add a `dm.send` message type: `{ to: "username", text: "hello" }`.
4. Deliver the DM to the recipient if online, or return an error if offline.
5. What happens if the same username registers twice? Handle it.

### Exercise 2: Room Listing

Add two new message types:
- `rooms.list` (no payload): Server responds with `{ type: "rooms.list", payload: { rooms: [{ id, memberCount }] } }`
- `rooms.subscribe`: Client subscribes to room list updates. Whenever any room's
  membership changes, broadcast an updated list to all subscribed clients.

What data structure do you use to track subscribers to the room list?

### Exercise 3: Message History

When a client joins a room, send them the last 50 messages in that room. Store messages
in an in-memory circular buffer (array with a maximum size — when full, the oldest
message is evicted).

Implement:
- `RingBuffer<T>` class with `push(item)` and `getAll()` methods
- One ring buffer per room
- On `room.join`, send a `room.history` message with the buffered messages

### Exercise 4: Rate Limiting

Prevent a single client from sending more than 10 messages per second. If they exceed
the limit:
- Drop the message
- Send them a `{ type: "error", payload: { code: "RATE_LIMITED", retryAfter: 1000 } }` message
- After 3 rate-limit violations in 10 seconds, disconnect them

Use a token bucket algorithm: each client gets 10 tokens. A message costs 1 token.
Tokens refill at 10 per second. If the bucket is empty, rate limit.

### Exercise 5: Graceful Shutdown Test

Write a test that verifies graceful shutdown:
1. Start a server
2. Connect 5 clients
3. Call `gracefulShutdown()`
4. Verify all 5 clients receive a close frame with code `1001`
5. Verify the `close` event fires on all 5 client connections
6. Verify no client receives a `1006` (abnormal closure) code

Use the `ws` library's client-side WebSocket to connect from the test.
