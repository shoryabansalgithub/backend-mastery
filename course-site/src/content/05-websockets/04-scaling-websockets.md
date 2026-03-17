# Lesson 4: Scaling WebSockets

## The Problem With Stateful Connections

HTTP is stateless. Any request from any client can be handled by any server in your
cluster. This is why horizontal scaling of HTTP servers is almost trivially easy: add
more servers behind a load balancer and distribute requests across them. Each request
carries all the information needed to serve it (headers, body, cookies), so the server
that receives it does not need to know anything about previous requests.

WebSockets shatter this model.

A WebSocket connection is a persistent TCP connection. It lives for minutes, hours, or
days. It is bound to one server process. The client and that specific server process
share state — the connection itself, plus whatever application state your server tracks
per connection (current room, authenticated user, cursor position).

Now scale to two servers:

```
              ┌───────────────────────────────────┐
              │           Load Balancer           │
              └──────────┬────────────────────────┘
                         │
             ┌───────────┴──────────┐
             ▼                      ▼
        ┌─────────┐           ┌─────────┐
        │ Server 1│           │ Server 2│
        │         │           │         │
        │ Alice ──┤           │ Bob ────┤
        │ Carol ──┤           │ Dave ───┤
        └─────────┘           └─────────┘
```

Alice and Carol are connected to Server 1. Bob and Dave are on Server 2.

Alice sends a message to a chat room. Server 1 needs to deliver it to all room members.
It can reach Carol — she is on Server 1. But Bob and Dave are on Server 2. Server 1
has no direct access to Server 2's connections.

Without a solution to this, your chat app silently fails to deliver messages to half
your users when you scale past one server. This is not a hypothetical edge case. It
is the core scaling problem for every stateful real-time system.

---

## Sticky Sessions

The simplest workaround: make the load balancer always route a given client to the same
server. If Alice always hits Server 1, and Bob always hits Server 2, they never need
to cross over.

This is called **session affinity** or **sticky sessions**.

```
              ┌───────────────────────────────────┐
              │   Load Balancer (sticky sessions)  │
              │                                   │
              │  Alice → always Server 1          │
              │  Bob   → always Server 2          │
              └──────────┬────────────────────────┘
```

Most load balancers support this. The affinity can be based on:
- **IP address**: Same client IP always routes to the same server
- **Cookie**: Load balancer sets a cookie (`SERVERID=server1`) on first request; future
  requests with that cookie go to the same server
- **Consistent hashing**: Client identifier is hashed to a server slot

### Why Sticky Sessions Alone Are Not Enough

Sticky sessions solve the routing problem but introduce new ones:

**Uneven load distribution.** If Alice's connection is idle but Bob is streaming 10
messages per second, Server 2 does the work of Server 1. Sticky sessions prevent the
balancer from redistributing load when behavior changes.

**Server failures.** If Server 1 goes down, every client on Server 1 loses their
connection. They reconnect, but now Server 1 is gone — the load balancer must route
them to Server 2. Any state that existed only in Server 1's memory (rooms, presence,
message history) is lost.

**Horizontal autoscaling doesn't work cleanly.** When you add Server 3, existing
connections stay on Servers 1 and 2. New connections can go to Server 3, but you
still cannot rebalance existing connections without disconnecting them.

Sticky sessions are a reasonable short-term solution for a small cluster (2-4 servers)
with low failure rates. For a serious production system, you need a message bus.

---

## Redis Pub/Sub as a Message Bus

The canonical solution: a **central message bus** that all server instances subscribe
to. When Server 1 needs to broadcast to a room, it publishes to the bus. Every server
(including Server 1) receives the publication and delivers it to their local connections
in that room.

```
┌────────────────────────────────────────────────────────────┐
│                      Load Balancer                         │
└───────────────────┬────────────────────────────────────────┘
                    │
        ┌───────────┴──────────┐
        ▼                      ▼
   ┌─────────┐           ┌─────────┐
   │ Server 1│           │ Server 2│
   │         │           │         │
   │ Alice ──┤           │ Bob ────┤
   │ Carol ──┤           │ Dave ───┤
   └────┬────┘           └────┬────┘
        │  PUBLISH             │  SUBSCRIBE
        └──────────┬───────────┘
                   ▼
            ┌────────────┐
            │   Redis    │
            │  Pub/Sub   │
            └────────────┘
```

The flow when Alice sends a message to "room_123":

1. Alice's message arrives at Server 1 via WebSocket
2. Server 1 validates the message and publishes to Redis channel `room:room_123`
3. Redis delivers the publication to **all subscribers** of `room:room_123`
4. Both Server 1 and Server 2 receive the publication (they both subscribed on startup)
5. Each server iterates its local connections that are in `room_123` and sends the
   message
6. Carol (on Server 1) and Bob + Dave (on Server 2) all receive Alice's message

The servers do not communicate directly with each other. They communicate through Redis.
Redis is the single source of truth for cross-server messages.

### Installing the Redis Client

```bash
npm install ioredis
npm install -D @types/ioredis
```

### The Redis Pub/Sub Pattern

```typescript
// redis.ts
import Redis from "ioredis";

// Separate clients for pub and sub — a client in subscribe mode
// can ONLY subscribe/unsubscribe, not publish or run other commands
export const publisher = new Redis(process.env.REDIS_URL!);
export const subscriber = new Redis(process.env.REDIS_URL!);
```

### The Room-to-Channel Naming Convention

Map room IDs to Redis channel names with a consistent prefix:

```typescript
function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

function workspaceChannel(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}
```

### Multi-Server Chat: Full Implementation

```typescript
// server.ts
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import Redis from "ioredis";

// --- Redis Setup ---

const publisher = new Redis(process.env.REDIS_URL!);
const subscriber = new Redis(process.env.REDIS_URL!);

// --- Local State (per-server) ---

interface ConnectedClient extends WebSocket {
  userId: string;
  displayName: string;
  rooms: Set<string>; // which rooms this connection is in
  isAlive: boolean;
}

// roomId → Set of LOCAL connections in that room
const localRooms = new Map<string, Set<ConnectedClient>>();

// --- Room Management ---

function joinLocalRoom(ws: ConnectedClient, roomId: string): void {
  if (!localRooms.has(roomId)) {
    localRooms.set(roomId, new Set());

    // Subscribe to Redis channel when first local client joins a room
    subscriber.subscribe(roomChannel(roomId), (err) => {
      if (err) console.error(`Redis subscribe error for ${roomId}:`, err);
    });
  }

  localRooms.get(roomId)!.add(ws);
  ws.rooms.add(roomId);
}

function leaveLocalRoom(ws: ConnectedClient, roomId: string): void {
  const room = localRooms.get(roomId);
  if (!room) return;

  room.delete(ws);
  ws.rooms.delete(roomId);

  if (room.size === 0) {
    localRooms.delete(roomId);

    // Unsubscribe from Redis channel when no local clients remain in the room
    subscriber.unsubscribe(roomChannel(roomId));
  }
}

function leaveAllRooms(ws: ConnectedClient): void {
  for (const roomId of [...ws.rooms]) {
    leaveLocalRoom(ws, roomId);
  }
}

function roomChannel(roomId: string): string {
  return `ws:room:${roomId}`;
}

// --- Publishing ---

interface BroadcastMessage {
  type: string;
  payload: unknown;
  fromUserId?: string; // used to exclude sender when delivering
}

async function publishToRoom(
  roomId: string,
  message: BroadcastMessage
): Promise<void> {
  await publisher.publish(roomChannel(roomId), JSON.stringify(message));
}

// --- Receiving Published Messages ---

// This fires on the CURRENT server when Redis delivers a message
subscriber.on("message", (channel: string, rawMessage: string) => {
  // Determine which room this is for
  // channel format: "ws:room:{roomId}"
  if (!channel.startsWith("ws:room:")) return;

  const roomId = channel.slice("ws:room:".length);
  const room = localRooms.get(roomId);
  if (!room) return;

  let message: BroadcastMessage;
  try {
    message = JSON.parse(rawMessage) as BroadcastMessage;
  } catch {
    return;
  }

  const serialized = JSON.stringify({ type: message.type, payload: message.payload });

  for (const ws of room) {
    // Skip sender if fromUserId is set (avoid echo to sender's own connection)
    if (message.fromUserId && ws.userId === message.fromUserId) continue;

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
});

// --- Message Handlers ---

async function handleChat(
  ws: ConnectedClient,
  roomId: string,
  text: string
): Promise<void> {
  if (!ws.rooms.has(roomId)) {
    sendTo(ws, "error", { code: "NOT_IN_ROOM" });
    return;
  }

  const sanitized = text.trim().slice(0, 2000);
  if (!sanitized) return;

  // Publish through Redis — all servers (including this one) will deliver it
  await publishToRoom(roomId, {
    type: "chat.message",
    payload: {
      from: ws.displayName,
      fromUserId: ws.userId,
      text: sanitized,
      timestamp: Date.now(),
    },
    // Do not set fromUserId here if you want the sender to see their own message
    // Set it if you want to suppress echo to sender
  });
}

async function handleJoin(
  ws: ConnectedClient,
  roomId: string,
  displayName: string
): Promise<void> {
  ws.displayName = displayName.trim().slice(0, 32);
  joinLocalRoom(ws, roomId);

  sendTo(ws, "room.joined", {
    roomId,
    localMemberCount: localRooms.get(roomId)?.size,
  });

  // Announce via Redis so all servers' clients in this room see it
  await publishToRoom(roomId, {
    type: "room.member_joined",
    payload: { displayName: ws.displayName },
  });
}

function sendTo(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// --- Server Setup ---

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach((rawWs) => {
    const ws = rawWs as ConnectedClient;
    if (!ws.isAlive) {
      leaveAllRooms(ws);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("connection", (rawWs: WebSocket) => {
  const ws = rawWs as ConnectedClient;
  ws.isAlive = true;
  ws.userId = crypto.randomUUID();
  ws.displayName = "Anonymous";
  ws.rooms = new Set();

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "room.join") {
        handleJoin(ws, msg.payload.roomId, msg.payload.displayName).catch(console.error);
      } else if (msg.type === "chat.send") {
        handleChat(ws, msg.payload.roomId, msg.payload.text).catch(console.error);
      }
    } catch {
      sendTo(ws, "error", { code: "INVALID_JSON" });
    }
  });

  ws.on("close", () => {
    leaveAllRooms(ws);
  });
});

wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(parseInt(process.env.PORT || "8080"), () => {
  console.log(`Server ${process.pid} listening on port ${process.env.PORT || 8080}`);
});
```

Run two instances of this with different ports and a Redis instance. Messages sent
from a client on Server 1 will appear on clients connected to Server 2. The servers
are now stateless from the routing perspective — you can add more at any time.

---

## The Fan-Out Problem

Publishing one message to a room with 10,000 members means 10,000 WebSocket `send()`
calls. If those 10,000 clients are spread across 10 servers (1,000 per server), each
server loops 1,000 times. That is fast.

But if a celebrity user has 1,000,000 followers and posts something, you have a
**fan-out problem**: one write must produce one million notifications. Each server that
has followers connected must loop over its local clients. Redis must deliver the
publication to every server. This takes time.

Strategies for extreme fan-out:

**Fan-out on write vs. fan-out on read.** Instead of broadcasting immediately, write
the message to a database. Each client polls (or uses a personal channel in Redis) for
their own feed. This shifts from "one write, many reads at write time" to "one write,
many reads spread out over time."

**Tiered broadcasting.** Large rooms are split into sub-shards. Each server only
subscribes to the shards relevant to its local connections.

**Backpressure at the room level.** Limit room size. Enforce a maximum of 1,000
members per room. Create overflow rooms or a read-only announcement channel for
large audiences.

For most applications (team chat, collaborative documents, game lobbies), rooms have
10–1,000 members and fan-out is not a meaningful problem.

---

## Socket.io vs. Raw `ws`

Socket.io is built on top of `ws` (and other transports) and adds a significant
feature layer. Understanding the tradeoffs helps you choose correctly.

| Feature | Raw `ws` | Socket.io |
|---------|----------|-----------|
| Transport fallback | WebSocket only | WebSocket → long-polling fallback |
| Rooms | Manual implementation | Built-in (`socket.join("room")`) |
| Namespaces | Manual | Built-in (`io.of("/admin")`) |
| Redis adapter | Manual | `@socket.io/redis-adapter` |
| Reconnection | Manual | Automatic with backoff |
| Message ACKs | Manual | Built-in callbacks |
| Binary data | Manual framing | Automatic |
| Payload size | Your serializer | Adds ~10 bytes per message |
| Client library | Browser WebSocket API | Must use Socket.io client |
| Debugging | Raw frames | Socket.io DevTools extension |

**Use raw `ws` when:**
- Your clients use the browser WebSocket API or a native client (mobile apps)
- You need extreme performance and cannot afford Socket.io's overhead
- You prefer explicit control over every behavior
- Your infrastructure reliably supports WebSockets (no corporate proxies that block
  upgrades)

**Use Socket.io when:**
- You need to support clients behind proxies that break WebSocket (the long-polling
  fallback saves you)
- You want rooms, namespaces, and Redis scaling without writing the infrastructure
- Your team is unfamiliar with WebSocket protocol details
- You need reliable message delivery with ACKs

Socket.io's abstractions are well-designed. The cost is coupling: both server and
client must use Socket.io, and upgrading either side requires upgrading both (Socket.io
protocol versions are not always compatible with the browser WebSocket API).

---

## Connection State Recovery

Clients disconnect. Networks are unreliable. Your real-time application must handle:

1. Client disconnects briefly (mobile switching from WiFi to LTE)
2. Client disconnects for a long time (laptop sleeps overnight)
3. Server restarts

For case 1, the client should reconnect and resume exactly where it left off — no
missed messages, no duplicate messages.

The general approach is **sequence numbers and replay**:

```typescript
// Each message sent to a room gets a sequence number
interface SequencedMessage {
  seq: number;        // monotonically increasing per room
  type: string;
  payload: unknown;
  timestamp: number;
}

// Server stores the last N messages in Redis with their sequence numbers
const HISTORY_LENGTH = 500; // keep last 500 messages per room

async function publishSequenced(roomId: string, message: unknown): Promise<void> {
  const key = `room:${roomId}:history`;

  // Atomic: get next seq, append message, trim old messages
  const seq = await publisher.incr(`room:${roomId}:seq`);
  const entry: SequencedMessage = {
    seq,
    ...(message as object),
    timestamp: Date.now(),
  } as SequencedMessage;

  await publisher
    .multi()
    .rpush(key, JSON.stringify(entry))
    .ltrim(key, -HISTORY_LENGTH, -1)
    .exec();

  // Publish the sequenced message via pub/sub
  await publisher.publish(roomChannel(roomId), JSON.stringify(entry));
}

// On reconnect, client sends the last seq it received
async function recoverMessages(
  roomId: string,
  lastSeq: number
): Promise<SequencedMessage[]> {
  const key = `room:${roomId}:history`;
  const all = await publisher.lrange(key, 0, -1);

  return all
    .map((raw) => JSON.parse(raw) as SequencedMessage)
    .filter((msg) => msg.seq > lastSeq);
}
```

Client reconnect flow:

```typescript
// Client stores the last sequence number it received
let lastSeq = 0;

ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.seq) lastSeq = msg.seq;
  // handle message
});

// On reconnect, send lastSeq to server
function reconnect() {
  const newWs = new WebSocket("ws://server/ws");
  newWs.onopen = () => {
    newWs.send(JSON.stringify({
      type: "room.rejoin",
      payload: { roomId: "room_123", lastSeq }
    }));
  };
}
```

Server handles `room.rejoin`:

```typescript
async function handleRejoin(ws: ConnectedClient, roomId: string, lastSeq: number) {
  joinLocalRoom(ws, roomId);

  // Replay missed messages
  const missed = await recoverMessages(roomId, lastSeq);
  for (const msg of missed) {
    sendTo(ws, msg.type, msg.payload);
  }
}
```

---

## Client-Side Reconnection with Exponential Backoff

The browser WebSocket API does not reconnect automatically. When a connection drops,
you get a `close` event and that is the end. Your client code must handle reconnection.

A naive approach reconnects immediately. If the server is down, this creates a
thundering herd: thousands of clients retry simultaneously, overwhelming the server
the moment it comes back up.

The solution: **exponential backoff with jitter**.

```typescript
class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private readonly maxDelay = 30_000; // cap at 30 seconds
  private readonly baseDelay = 1_000;  // start at 1 second
  private stopped = false;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("Connected");
      this.attempt = 0; // reset backoff on successful connection
      this.onOpen?.();
    };

    this.ws.onmessage = (event) => {
      this.onMessage?.(event);
    };

    this.ws.onclose = (event) => {
      if (this.stopped) return;

      this.onClose?.(event);

      // Close code 1000 (normal) or 1001 (going away) — reconnect
      // Close code 4001 (auth failure) — do not reconnect
      if (event.code === 4001) {
        console.error("Authentication failed. Not reconnecting.");
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      this.onError?.(err);
      // onerror is always followed by onclose — do not reconnect here
    };
  }

  private scheduleReconnect(): void {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
    const exponential = this.baseDelay * Math.pow(2, this.attempt);
    const capped = Math.min(exponential, this.maxDelay);

    // Add jitter: random +/-20% to avoid thundering herd
    const jitter = capped * (0.8 + Math.random() * 0.4);
    const delay = Math.round(jitter);

    this.attempt++;
    console.log(`Reconnecting in ${delay}ms (attempt ${this.attempt})`);
    setTimeout(() => this.connect(), delay);
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.stopped = true;
    this.ws?.close(1000, "Client closed");
  }

  // Hooks
  onOpen?: () => void;
  onMessage?: (event: MessageEvent) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

// Usage
const socket = new ReconnectingWebSocket("wss://myapp.com/ws?token=abc");

socket.onOpen = () => socket.send(JSON.stringify({ type: "room.join", ... }));
socket.onMessage = (e) => handleServerMessage(JSON.parse(e.data));
```

The jitter is important. Without it, if 10,000 clients all disconnect at the same time
(server restart), they all reconnect after exactly the same delay — piling onto the
server simultaneously.

---

## Rate Limiting WebSocket Messages

An unauthenticated user on a slow connection can do surprising damage by hammering your
server with messages. Rate limiting at the message level prevents this.

The token bucket algorithm is well-suited here:

```typescript
class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private lastRefill: number;

  constructor(
    maxTokens: number,
    refillsPerSecond: number
  ) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillsPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  consume(count = 1): boolean {
    this.refill();

    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

// Per-connection rate limiting
interface RateLimitedClient extends WebSocket {
  bucket: TokenBucket;
  violations: number;
}

wss.on("connection", (ws: WebSocket) => {
  const client = ws as RateLimitedClient;
  client.bucket = new TokenBucket(20, 10); // 20 tokens max, refill 10/sec
  client.violations = 0;

  client.on("message", (data) => {
    if (!client.bucket.consume()) {
      client.violations++;
      client.send(
        JSON.stringify({
          type: "error",
          payload: {
            code: "RATE_LIMITED",
            message: "You are sending messages too fast",
          },
        })
      );

      if (client.violations >= 5) {
        client.close(4029, "Rate limit exceeded"); // 4029 = custom code
      }

      return;
    }

    // Process message normally
    handleMessage(client, data as Buffer);
  });
});
```

Rate limiting per connection is necessary but not sufficient. A single IP can open
many connections. Rate limit at the IP level too, using a shared store (Redis) rather
than per-process memory.

---

## Authentication on WebSocket Upgrade

WebSocket connections are persistent but start as HTTP. The upgrade request is the
only opportunity to authenticate before the connection is established.

### Option 1: JWT in Query Parameter

```typescript
// Client
const token = getJWT();
const ws = new WebSocket(`wss://api.example.com/ws?token=${encodeURIComponent(token)}`);
```

```typescript
// Server
wss.on("connection", (ws, request) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(4001, "Authentication required");
    return;
  }

  try {
    const payload = verifyJWT(token);
    (ws as AuthenticatedWS).userId = payload.sub;
    (ws as AuthenticatedWS).workspaceId = payload.workspaceId;
  } catch {
    ws.close(4001, "Invalid token");
    return;
  }
});
```

**Tradeoff**: Tokens in URLs appear in server logs and browser history. Use only if
the token has a short TTL (< 60 seconds) — a separate "WebSocket ticket" endpoint can
issue short-lived tokens.

### Option 2: Cookie

```typescript
// Client — browser automatically sends cookies
const ws = new WebSocket("wss://api.example.com/ws");
// Cookie is sent with the upgrade request automatically
```

```typescript
// Server
import { parse as parseCookie } from "cookie";

wss.on("connection", (ws, request) => {
  const rawCookie = request.headers.cookie ?? "";
  const cookies = parseCookie(rawCookie);
  const sessionToken = cookies["session"];

  if (!sessionToken) {
    ws.close(4001, "No session cookie");
    return;
  }

  const session = verifySession(sessionToken);
  if (!session) {
    ws.close(4001, "Invalid session");
    return;
  }
});
```

**Tradeoff**: Works only for browser clients on the same domain. Requires proper
`SameSite` and `Secure` cookie configuration.

### Option 3: First-Message Authentication

The connection is accepted without authentication, but the server ignores all messages
until the client sends a valid auth message:

```typescript
interface PendingClient extends WebSocket {
  authenticated: boolean;
  userId?: string;
  authTimeout?: NodeJS.Timeout;
}

wss.on("connection", (rawWs: WebSocket) => {
  const ws = rawWs as PendingClient;
  ws.authenticated = false;

  // Give the client 10 seconds to authenticate
  ws.authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      ws.close(4001, "Authentication timeout");
    }
  }, 10_000);

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (!ws.authenticated) {
      if (msg.type === "auth") {
        try {
          const payload = verifyJWT(msg.payload.token);
          ws.authenticated = true;
          ws.userId = payload.sub;
          clearTimeout(ws.authTimeout);
          ws.send(JSON.stringify({ type: "auth.success" }));
        } catch {
          ws.close(4001, "Invalid token");
        }
      } else {
        ws.send(JSON.stringify({ type: "error", code: "AUTHENTICATION_REQUIRED" }));
      }
      return;
    }

    // Process authenticated message
    handleMessage(ws as AuthenticatedWS, data as Buffer);
  });
});
```

**Tradeoff**: The most flexible option — works with any client. Slightly more complex
because you have an "unauthenticated" state to manage. The auth timeout prevents
unauthenticated connections from lingering.

### Recommendation

For browser-based applications: use Option 2 (cookies) if the WebSocket server is on
the same domain as the web app. Use Option 3 (first-message auth) for mobile clients
and cross-domain scenarios. Option 1 (query param token) is acceptable only with very
short-lived tokens specifically issued for WebSocket connections.

---

## Multi-Server Architecture: Full Diagram

```
                    ┌────────────────────────────┐
                    │     Clients (browsers,     │
                    │     mobile, other services)│
                    └───────────┬────────────────┘
                                │ HTTPS / WSS
                    ┌───────────▼────────────────┐
                    │      Load Balancer         │
                    │   (NGINX / AWS ALB)        │
                    │                            │
                    │  sticky sessions enabled   │
                    │  health checks on /health  │
                    └──┬──────────────┬──────────┘
                       │              │
              ┌────────▼───┐    ┌─────▼──────┐
              │  WS Server │    │  WS Server │   ... N servers
              │  (Node.js) │    │  (Node.js) │
              │            │    │            │
              │  Port 8080 │    │  Port 8080 │
              │  in K8s    │    │  in K8s    │
              └───┬────┬───┘    └────┬───┬───┘
                  │    │             │   │
          PUBLISH │    │ SUBSCRIBE   │   │ SUBSCRIBE / PUBLISH
                  │    └──────┐ ┌───┘   │
                  └─────────┐ │ │ ┌─────┘
                            ▼ ▼ ▼ ▼
                    ┌────────────────────┐
                    │    Redis Cluster   │
                    │   (Pub/Sub bus)    │
                    │                   │
                    │  room:room_123     │
                    │  workspace:ws_456  │
                    │  presence:user_789 │
                    └────────────────────┘
                            │
                    ┌───────▼────────────┐
                    │   PostgreSQL       │
                    │   (persistent      │
                    │    state)          │
                    └────────────────────┘
```

Key architectural principles:
- **WebSocket servers are horizontally scalable** because they share no in-process
  state for cross-server communication.
- **Redis is the cross-server message bus**, not direct server-to-server communication.
- **PostgreSQL holds durable state** (message history, user data, documents). Redis
  holds ephemeral state (who is online, which rooms are active, recent message buffers).
- **The load balancer uses sticky sessions** as an optimization (avoids re-routing
  established connections), but the system is correct even without them.

---

## Summary

| Problem | Solution |
|---------|----------|
| Connections are sticky to one server | Sticky sessions as optimization |
| Messages can't cross server boundaries | Redis pub/sub as a message bus |
| Fan-out to large rooms is slow | Tiered sharding, fan-out on read |
| Zombie connections accumulate | Heartbeat with 30s ping/pong cycle |
| Client disconnects and misses messages | Sequence numbers + Redis message history |
| Clients reconnect simultaneously (thundering herd) | Exponential backoff with jitter |
| Abusive clients flood the server with messages | Per-connection token bucket rate limiting |
| Who is this connection talking to? | JWT auth on upgrade, cookie auth, or first-message auth |

---

## Exercises

### Exercise 1: Measure the Sticky Session Problem

Write a Node.js script that:
1. Starts two WebSocket servers on ports 8080 and 8081
2. Connects 10 clients, 5 to each server
3. Has Client 1 (on Server 1) send a message to a room all 10 clients are in
4. Counts how many clients receive the message
5. Verify that without Redis pub/sub, only the 5 clients on Server 1 receive it
6. Add Redis pub/sub and verify all 10 clients receive it

### Exercise 2: Reconnection Strategy

Write a `ReconnectingWebSocket` class (Node.js client-side, using the `ws` library
rather than the browser API) with:
- Exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (max)
- Jitter: ±25%
- Maximum 10 reconnection attempts before giving up
- An `onReconnect` hook that fires each time a connection is re-established
- Automatic re-subscription to rooms on reconnect (hint: store the list of joined rooms)

Test it by having the server close connections on a timer.

### Exercise 3: Redis Pub/Sub vs. Direct Connection

Compare two architectures:
1. Two servers, no Redis: Server 1 maintains a TCP connection to Server 2 and forwards
   messages directly.
2. Two servers, with Redis pub/sub.

For each:
- What happens when a third server is added?
- What happens when Server 2 goes down?
- What is the message latency difference?
- How many network connections are maintained with N servers?

Write up a one-page comparison. The answer should reveal why the Redis approach is
preferred at scale.

### Exercise 4: Authentication Security Audit

Given this authentication code:

```typescript
wss.on("connection", (ws, request) => {
  const url = new URL(request.url!, "http://localhost");
  const token = url.searchParams.get("token");
  const user = verifyJWT(token!);
  (ws as any).userId = user.sub;
});
```

Identify at least 5 security or correctness issues. Fix each one.

### Exercise 5: Rate Limiter with Redis

The per-process token bucket from this lesson does not protect against a client opening
10 connections across 10 servers. Rewrite the rate limiter to use Redis:

```typescript
// Use Redis INCR with EXPIRE for a sliding window rate limiter
async function checkRateLimit(clientId: string, limit: number, windowMs: number): Promise<boolean>
```

The key should be `ratelimit:{clientId}:{windowBucket}` where `windowBucket` is
`Math.floor(Date.now() / windowMs)`. This creates a time-bucketed counter that expires
automatically.

Test it by opening connections on two different servers and verifying the global limit
is enforced.
