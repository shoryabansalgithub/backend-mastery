# ChatScale — Exhaustive Implementation Plan

## 1. Project Structure

```
chatscale/
├── package.json
├── tsconfig.json
├── docker-compose.yml          # 2 app instances + Redis for scaling test
├── .env.example
├── src/
│   ├── index.ts                # Express + WebSocket server startup
│   ├── ws/
│   │   ├── handler.ts          # Message router (dispatch by type)
│   │   ├── registry.ts         # Connection registry (userId → ws, roomId → userIds)
│   │   ├── rooms.ts            # Join/leave room logic
│   │   ├── presence.ts         # Online/offline tracking
│   │   ├── heartbeat.ts        # Ping/pong manager
│   │   └── protocol.ts         # TypeScript types for all messages
│   ├── pubsub/
│   │   └── redis.ts            # Redis pub/sub adapter
│   ├── history/
│   │   └── messages.ts         # Redis List-based message history
│   ├── routes/
│   │   └── rooms.ts            # REST endpoints
│   ├── middleware/
│   │   ├── authenticate.ts     # HTTP JWT middleware
│   │   └── errorHandler.ts
│   └── types.ts
```

---

## 2. Protocol Types (`src/ws/protocol.ts`)

```typescript
export interface Message {
  id:        string;
  roomId:    string;
  userId:    string;
  content:   string;
  createdAt: string;  // ISO 8601
  clientId:  string;  // for deduplication
}

// Client → Server
export type ClientMessage =
  | { type: 'join_room';    roomId: string }
  | { type: 'leave_room';   roomId: string }
  | { type: 'send_message'; roomId: string; content: string; clientId: string }
  | { type: 'typing_start'; roomId: string }
  | { type: 'typing_stop';  roomId: string }
  | { type: 'get_history';  roomId: string; beforeId?: string }
  | { type: 'ping' }

// Server → Client
export type ServerMessage =
  | { type: 'joined_room';     roomId: string; members: string[]; history: Message[] }
  | { type: 'left_room';       roomId: string }
  | { type: 'new_message';     roomId: string; message: Message }
  | { type: 'typing';          roomId: string; userId: string; isTyping: boolean }
  | { type: 'presence_update'; roomId: string; userId: string; status: 'online' | 'offline' }
  | { type: 'history';         roomId: string; messages: Message[]; hasMore: boolean }
  | { type: 'close_reason';    reason: string }
  | { type: 'error';           code: string; message: string }
  | { type: 'pong' }

// Redis pub/sub envelope (includes serverId to avoid echo)
export interface PubSubEnvelope {
  serverId:      string;  // source server, skip if matches this server
  roomId:        string;
  serverMessage: ServerMessage;
}
```

---

## 3. Connection Registry (`src/ws/registry.ts`)

```typescript
import { WebSocket } from 'ws';

interface Connection {
  ws:          WebSocket;
  userId:      string;
  rooms:       Set<string>;
  lastPong:    number;  // Date.now()
}

// In-memory maps — local to this server instance only
// Cross-server coordination is handled by Redis pub/sub
const connections = new Map<string, Connection>();  // connectionId → Connection
const userConnections = new Map<string, Set<string>>();  // userId → Set<connectionId>
const roomConnections = new Map<string, Set<string>>();  // roomId → Set<connectionId>

export function registerConnection(connectionId: string, userId: string, ws: WebSocket): void {
  connections.set(connectionId, { ws, userId, rooms: new Set(), lastPong: Date.now() });
  if (!userConnections.has(userId)) userConnections.set(userId, new Set());
  userConnections.get(userId)!.add(connectionId);
}

export function deregisterConnection(connectionId: string): void {
  const conn = connections.get(connectionId);
  if (!conn) return;
  // Remove from all rooms
  for (const roomId of conn.rooms) {
    roomConnections.get(roomId)?.delete(connectionId);
  }
  userConnections.get(conn.userId)?.delete(connectionId);
  connections.delete(connectionId);
}

export function joinRoom(connectionId: string, roomId: string): void {
  connections.get(connectionId)?.rooms.add(roomId);
  if (!roomConnections.has(roomId)) roomConnections.set(roomId, new Set());
  roomConnections.get(roomId)!.add(connectionId);
}

export function leaveRoom(connectionId: string, roomId: string): void {
  connections.get(connectionId)?.rooms.delete(roomId);
  roomConnections.get(roomId)?.delete(connectionId);
}

// Send a message to all local connections in a room
export function broadcastToRoom(roomId: string, message: unknown, excludeConnectionId?: string): void {
  const connIds = roomConnections.get(roomId) ?? new Set();
  const payload = JSON.stringify(message);
  for (const connId of connIds) {
    if (connId === excludeConnectionId) continue;
    const conn = connections.get(connId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
    }
  }
}

export function sendToConnection(connectionId: string, message: unknown): void {
  const conn = connections.get(connectionId);
  if (conn?.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
  }
}

export function getRoomMembers(roomId: string): string[] {
  const connIds = roomConnections.get(roomId) ?? new Set();
  const userIds = new Set<string>();
  for (const connId of connIds) {
    const conn = connections.get(connId);
    if (conn) userIds.add(conn.userId);
  }
  return [...userIds];
}

export function updatePong(connectionId: string): void {
  const conn = connections.get(connectionId);
  if (conn) conn.lastPong = Date.now();
}

export function getStaleConnections(timeoutMs: number): string[] {
  const now = Date.now();
  return [...connections.entries()]
    .filter(([, conn]) => now - conn.lastPong > timeoutMs)
    .map(([id]) => id);
}

export function getAllConnections(): Map<string, Connection> {
  return connections;
}
```

---

## 4. Redis Pub/Sub Adapter (`src/pubsub/redis.ts`)

```typescript
import Redis from 'ioredis';
import { broadcastToRoom } from '../ws/registry';
import type { PubSubEnvelope } from '../ws/protocol';

const SERVER_ID = process.env.SERVER_ID ?? Math.random().toString(36).slice(2);

// Use two separate Redis connections: one for publishing, one for subscribing
// (ioredis subscribing connection can't issue regular commands)
const pub = new Redis(process.env.REDIS_URL!);
const sub = new Redis(process.env.REDIS_URL!);

// Subscribe to a room channel when the first user joins that room on this server
const subscribedRooms = new Set<string>();

export async function subscribeToRoom(roomId: string): Promise<void> {
  if (subscribedRooms.has(roomId)) return;
  subscribedRooms.add(roomId);
  await sub.subscribe(`room:${roomId}`);
}

export async function unsubscribeFromRoom(roomId: string): Promise<void> {
  subscribedRooms.delete(roomId);
  await sub.unsubscribe(`room:${roomId}`);
}

// Publish a message to all servers (including this one)
export async function publishToRoom(roomId: string, serverMessage: unknown): Promise<void> {
  const envelope: PubSubEnvelope = {
    serverId: SERVER_ID,
    roomId,
    serverMessage: serverMessage as any,
  };
  await pub.publish(`room:${roomId}`, JSON.stringify(envelope));
}

// Handle messages from Redis — forward to local WebSocket connections
sub.on('message', (channel: string, data: string) => {
  const envelope: PubSubEnvelope = JSON.parse(data);

  // Skip messages this server sent (already broadcast locally)
  if (envelope.serverId === SERVER_ID) return;

  const roomId = channel.replace('room:', '');
  broadcastToRoom(roomId, envelope.serverMessage);
});
```

---

## 5. Message History (`src/history/messages.ts`)

```typescript
import Redis from 'ioredis';
import { Message } from '../ws/protocol';

const redis = new Redis(process.env.REDIS_URL!);
const HISTORY_KEY = (roomId: string) => `history:${roomId}`;
const MAX_HISTORY = 50;

export async function appendMessage(msg: Message): Promise<void> {
  const key = HISTORY_KEY(msg.roomId);
  await redis.lpush(key, JSON.stringify(msg));
  await redis.ltrim(key, 0, MAX_HISTORY - 1);  // keep only last 50
  await redis.expire(key, 60 * 60 * 24 * 7);   // 7 day TTL
}

export async function getHistory(roomId: string, beforeId?: string): Promise<Message[]> {
  const raw = await redis.lrange(HISTORY_KEY(roomId), 0, MAX_HISTORY - 1);
  const messages: Message[] = raw.map(r => JSON.parse(r));

  if (!beforeId) return messages;

  // Return only messages before the given message ID (for replay on reconnect)
  const idx = messages.findIndex(m => m.id === beforeId);
  return idx === -1 ? [] : messages.slice(idx + 1);
}
```

---

## 6. WebSocket Handler (`src/ws/handler.ts`)

```typescript
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import * as registry from './registry';
import * as pubsub from '../pubsub/redis';
import * as history from '../history/messages';
import type { ClientMessage } from './protocol';

const seenClientIds = new Set<string>();  // dedup within this server's memory window

export function handleUpgrade(wss: WebSocketServer) {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    // Parse JWT from query param: ws://host/chat?token=...
    const token = new URL(req.url!, 'ws://localhost').searchParams.get('token');
    if (!token) { ws.close(4001, 'Missing token'); return; }

    let user: { id: string; email: string };
    try {
      user = jwt.verify(token, process.env.JWT_SECRET!) as any;
    } catch {
      ws.close(4001, 'Invalid token');
      return;
    }

    const connectionId = uuidv4();
    registry.registerConnection(connectionId, user.id, ws);

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }  // ignore malformed

      switch (msg.type) {
        case 'ping':
          registry.updatePong(connectionId);
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'join_room': {
          registry.joinRoom(connectionId, msg.roomId);
          await pubsub.subscribeToRoom(msg.roomId);
          const members = registry.getRoomMembers(msg.roomId);
          const messages = await history.getHistory(msg.roomId);
          ws.send(JSON.stringify({ type: 'joined_room', roomId: msg.roomId, members, history: messages }));
          // Broadcast presence update to room
          await pubsub.publishToRoom(msg.roomId, {
            type: 'presence_update', roomId: msg.roomId, userId: user.id, status: 'online'
          });
          break;
        }

        case 'leave_room':
          registry.leaveRoom(connectionId, msg.roomId);
          await pubsub.publishToRoom(msg.roomId, {
            type: 'presence_update', roomId: msg.roomId, userId: user.id, status: 'offline'
          });
          break;

        case 'send_message': {
          // Dedup by clientId
          if (seenClientIds.has(msg.clientId)) break;
          seenClientIds.add(msg.clientId);
          setTimeout(() => seenClientIds.delete(msg.clientId), 60_000);  // expire after 1 min

          const message = {
            id: uuidv4(), roomId: msg.roomId, userId: user.id,
            content: msg.content, createdAt: new Date().toISOString(), clientId: msg.clientId
          };
          await history.appendMessage(message);
          await pubsub.publishToRoom(msg.roomId, { type: 'new_message', roomId: msg.roomId, message });
          break;
        }

        case 'typing_start':
        case 'typing_stop':
          await pubsub.publishToRoom(msg.roomId, {
            type: 'typing', roomId: msg.roomId, userId: user.id,
            isTyping: msg.type === 'typing_start'
          });
          break;

        case 'get_history': {
          const messages = await history.getHistory(msg.roomId, msg.beforeId);
          ws.send(JSON.stringify({ type: 'history', roomId: msg.roomId, messages, hasMore: messages.length === 50 }));
          break;
        }
      }
    });

    ws.on('close', async () => {
      const conn = registry.getAllConnections().get(connectionId);
      if (conn) {
        for (const roomId of conn.rooms) {
          await pubsub.publishToRoom(roomId, {
            type: 'presence_update', roomId, userId: user.id, status: 'offline'
          });
        }
      }
      registry.deregisterConnection(connectionId);
    });
  });
}
```

---

## 7. Heartbeat Manager (`src/ws/heartbeat.ts`)

```typescript
import { WebSocket } from 'ws';
import * as registry from './registry';

const PING_INTERVAL_MS = 30_000;   // ping every 30s
const PONG_TIMEOUT_MS  = 40_000;   // drop if no pong for 40s (10s grace)

export function startHeartbeat(): NodeJS.Timeout {
  return setInterval(() => {
    // 1. Drop stale connections (no pong for >40s)
    const stale = registry.getStaleConnections(PONG_TIMEOUT_MS);
    for (const connId of stale) {
      const conn = registry.getAllConnections().get(connId);
      if (conn) conn.ws.terminate();  // terminate (not close) — it's already unresponsive
      registry.deregisterConnection(connId);
    }

    // 2. Ping all active connections
    for (const [, conn] of registry.getAllConnections()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();  // native WebSocket ping frame
      }
    }
  }, PING_INTERVAL_MS);
}
```

---

## 8. Graceful Shutdown

```typescript
// src/index.ts
import { WebSocketServer } from 'ws';
import * as registry from './ws/registry';

function gracefulShutdown(wss: WebSocketServer, server: any) {
  console.log('SIGTERM received. Closing connections...');

  // 1. Stop accepting new connections
  server.close();

  // 2. Notify all clients and close their connections
  for (const [, conn] of registry.getAllConnections()) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'close_reason', reason: 'server_restart' }));
      conn.ws.close(1001, 'Server restarting');  // 1001 = Going Away
    }
  }

  // 3. Give clients 5 seconds to ACK, then force-exit
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => gracefulShutdown(wss, httpServer));
```

---

## 9. Docker Compose (for multi-server test)

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']

  app1:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
      SERVER_ID: server-1
      PORT: 3001
    ports: ['3001:3001']
    depends_on: [redis]

  app2:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
      SERVER_ID: server-2
      PORT: 3002
    ports: ['3002:3002']
    depends_on: [redis]
```

### Test multi-server scaling:
```bash
# Terminal 1: connect to server 1
wscat -c "ws://localhost:3001/chat?token=<jwt_user_a>"
> {"type":"join_room","roomId":"room-1"}

# Terminal 2: connect to server 2
wscat -c "ws://localhost:3002/chat?token=<jwt_user_b>"
> {"type":"join_room","roomId":"room-1"}
> {"type":"send_message","roomId":"room-1","content":"hello from server 2","clientId":"abc123"}

# Terminal 1 should receive:
# {"type":"new_message","roomId":"room-1","message":{...}}
```

---

## 10. Environment Variables

```env
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-jwt-secret
SERVER_ID=server-1          # unique per instance
PORT=3000
NODE_ENV=development
```
