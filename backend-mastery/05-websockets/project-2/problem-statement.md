# Project: ChatScale — Distributed Real-Time Chat System

## Context

You've been asked to build the backend for a Slack-like chat application. The first version needs to work for 10,000 concurrent users, distributed across multiple server instances behind a load balancer.

Here's the core challenge: WebSocket connections are **stateful**. When User A on Server 1 sends a message to a room, Server 2 needs to know about it — because User B might be connected to Server 2. Without a cross-server messaging layer, users on different servers can't talk to each other.

This project forces you to solve that problem using Redis pub/sub, and it will make you understand exactly why horizontal scaling of WebSocket servers is fundamentally different from scaling stateless HTTP servers.

---

## What You're Building

**ChatScale** is a real-time chat API with:

### WebSocket Features
- Join and leave chat rooms
- Send messages to a room (broadcast to all members, across all servers)
- Typing indicators (start/stop typing)
- Presence: see who's online in a room
- Message history: receive last 50 messages on room join
- Missed messages on reconnect: client sends `lastMessageId`, server replays

### REST Features
- Create, list, and get rooms
- Get room member list

### Technical Requirements
- **Raw `ws` library** — No Socket.IO. You're working with the protocol directly.
- **JWT authentication** on WebSocket upgrade — reject unauthenticated connections at the HTTP upgrade step
- **Redis pub/sub** for cross-server message delivery
- **Heartbeat/ping-pong** — server pings every 30 seconds, drops unresponsive connections
- **Graceful shutdown** — on SIGTERM, close all client connections with a close frame before process exits

---

## The Scaling Architecture

```
Client A ──── Server 1 ────┐
                             ├── Redis Pub/Sub ──── (channel: room:{roomId})
Client B ──── Server 2 ────┘
```

When Client A (on Server 1) sends a message to Room 123:
1. Server 1 broadcasts to all Room 123 clients connected to **Server 1**
2. Server 1 publishes the message to Redis channel `room:123`
3. Server 2 is subscribed to `room:123`, receives the message from Redis
4. Server 2 broadcasts to all Room 123 clients connected to **Server 2**

---

## WebSocket Message Protocol

All messages are JSON. Each message has a `type` field.

### Client → Server
```typescript
type ClientMessage =
  | { type: 'join_room';    roomId: string }
  | { type: 'leave_room';   roomId: string }
  | { type: 'send_message'; roomId: string; content: string; clientId: string }
  | { type: 'typing_start'; roomId: string }
  | { type: 'typing_stop';  roomId: string }
  | { type: 'get_history';  roomId: string; beforeId?: string }
  | { type: 'ping' }
```

### Server → Client
```typescript
type ServerMessage =
  | { type: 'joined_room';    roomId: string; members: string[]; history: Message[] }
  | { type: 'left_room';      roomId: string }
  | { type: 'new_message';    roomId: string; message: Message }
  | { type: 'typing';         roomId: string; userId: string; isTyping: boolean }
  | { type: 'presence_update'; roomId: string; userId: string; status: 'online' | 'offline' }
  | { type: 'history';        roomId: string; messages: Message[] }
  | { type: 'error';          code: string; message: string }
  | { type: 'pong' }
```

---

## Deliverables

### REST Endpoints
```
POST   /rooms             → Create room { name, description }
GET    /rooms             → List rooms (paginated)
GET    /rooms/:id         → Get room + member count
GET    /rooms/:id/members → List online members
```

### WebSocket
```
WS /chat?token=<jwt>      → Main WebSocket connection
```

---

## Acceptance Criteria

- [ ] Client A and Client B, connected to **different server instances**, can exchange messages in the same room (use Docker Compose with two app instances to verify)
- [ ] `join_room` response includes last 50 messages as history
- [ ] Disconnecting a client broadcasts a `presence_update` (offline) to all room members
- [ ] A connection that doesn't respond to ping for 40 seconds is terminated
- [ ] On SIGTERM, all connected clients receive `type: close_reason, reason: "server_restart"` before the process exits
- [ ] JWT with invalid signature is rejected at the HTTP upgrade step (returns `401` before WebSocket is established)
- [ ] `send_message` with `clientId` is idempotent — duplicate clientIds (retry) don't double-broadcast

---

## Concepts Exercised

| Concept | Where |
|---------|-------|
| WebSocket upgrade authentication | `wsAuth.ts` middleware |
| Raw `ws` library | `ws/handler.ts` |
| Per-connection state | Connection registry (Map) |
| Redis pub/sub (ioredis) | `pubsub/redis.ts` adapter |
| Message history (Redis List) | `LPUSH` + `LTRIM` + `LRANGE` |
| Presence (Redis Set) | `SADD` / `SREM` per room |
| Reconnect + replay | `get_history` with `beforeId` |
| Heartbeat/ping-pong | 30s interval + pong timeout |
| Graceful shutdown | SIGTERM handler |
| Horizontal scaling with stateful servers | Full architecture |

---

## Difficulty

**Advanced.** The distributed pub/sub architecture and the reconnect-with-replay logic are the hardest parts. Start by getting a single-server version working, then add Redis pub/sub.

## Estimated Time

10–15 hours.
