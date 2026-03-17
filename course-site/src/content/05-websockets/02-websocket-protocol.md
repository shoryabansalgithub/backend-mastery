# Lesson 2: The WebSocket Protocol

## Why Learn the Protocol?

You could use a WebSocket library without ever understanding the protocol. So why
are we spending an entire lesson on it?

Because when things go wrong -- and they will -- you need to know what is happening on
the wire. When your WebSocket connection fails silently through a corporate proxy, when
frames arrive fragmented, when a load balancer kills your connections after 60 seconds,
you need to understand the protocol to debug effectively.

More importantly, understanding the protocol reveals *design decisions* that inform how
you build applications on top of it. Why are client frames masked? Why is there a close
handshake? Why does the upgrade request use HTTP? These are not arbitrary choices --
they are solutions to real security and compatibility problems.

---

## RFC 6455: The WebSocket Standard

The WebSocket protocol is defined in RFC 6455 (published December 2011). It specifies:

1. An **opening handshake** that upgrades an HTTP connection to a WebSocket connection
2. A **data framing** format for sending messages over that connection
3. A **closing handshake** for cleanly terminating the connection

The protocol is designed to work within the existing web infrastructure. It starts as
HTTP (so it passes through firewalls and proxies), then switches to a binary framing
protocol that is much more efficient.

---

## The Upgrade Handshake

Every WebSocket connection begins with an HTTP request. The client asks the server to
"upgrade" the connection from HTTP to WebSocket.

### Why Start with HTTP?

This is a pragmatic choice, not a technical necessity. The web's infrastructure --
firewalls, proxies, load balancers -- is built around HTTP. A brand-new protocol on a
custom port would be blocked by most corporate firewalls. By starting as HTTP on port
80 or 443, WebSocket connections look like regular web traffic to network infrastructure.

Think of it like getting through a building's security desk. You show your regular
visitor badge (HTTP) to get past the front door. Once inside, you switch to doing
something different (WebSocket frames). The security desk does not need to understand
what you are doing inside -- it only needed to recognize the initial request.

### The Client Request

Here is what a raw WebSocket upgrade request looks like:

```http
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Origin: http://example.com
```

Let's examine each header:

| Header | Purpose |
|--------|---------|
| `GET /chat HTTP/1.1` | Must be GET, must be HTTP/1.1 or higher |
| `Host: example.com` | Standard HTTP host header |
| `Upgrade: websocket` | "I want to switch protocols to WebSocket" |
| `Connection: Upgrade` | "This connection should be upgraded" |
| `Sec-WebSocket-Key` | Random 16-byte value, base64-encoded (for handshake validation) |
| `Sec-WebSocket-Version: 13` | Protocol version (13 is the only version in use) |
| `Origin` | Where the request came from (for CORS-like protection) |

The `Sec-WebSocket-Key` is **not** for security. It is a nonce that the server must
echo back (after transformation) to prove it understands the WebSocket protocol. This
prevents accidental upgrades by servers that do not support WebSockets.

### The Server Response

If the server accepts the upgrade:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

The `101 Switching Protocols` status code means "I'm changing the protocol on this
connection." After this response, the connection is no longer HTTP. Raw WebSocket
frames flow in both directions.

### The Accept Key Calculation

The server computes `Sec-WebSocket-Accept` by:

1. Concatenating the client's `Sec-WebSocket-Key` with a magic string:
   `"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"` (defined in the RFC)
2. Computing the SHA-1 hash
3. Base64-encoding the result

```typescript
import { createHash } from 'crypto';

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + MAGIC_STRING)
    .digest('base64');
}

// Example:
const clientKey = 'dGhlIHNhbXBsZSBub25jZQ==';
const acceptKey = computeAcceptKey(clientKey);
// Result: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
```

This is not encryption or authentication. It is a **proof of protocol understanding**.
If a server just blindly echoes back headers, it will not produce the correct accept
key. The client validates this to ensure it is actually talking to a WebSocket server.

### What You Can Send During the Handshake

The handshake is regular HTTP, so you can include:
- **Cookies** (for session-based auth)
- **Query parameters** (for tokens: `ws://example.com/chat?token=abc123`)
- **Custom headers** (from non-browser clients)

However, the browser's `WebSocket` API does **not** let you set custom headers. This
is a deliberate limitation. You cannot send an `Authorization` header from the browser
WebSocket constructor. Common workarounds:

1. Pass the token as a query parameter
2. Pass the token in the first WebSocket message after connecting
3. Use cookies (set via a prior HTTP request)
4. Use a ticket/nonce: make an HTTP request to get a one-time token, then connect with it

We will cover this in detail in Lesson 3.

---

## Frame Format

After the handshake, data is transmitted in **frames**. A WebSocket frame is the
fundamental unit of data, analogous to an HTTP request/response but much simpler.

### Why Frames Instead of Raw Bytes?

TCP provides a raw byte stream. It has no concept of "messages." If you send "hello"
and "world" over TCP, the receiver might get "hellow" and "orld" -- TCP does not
preserve message boundaries.

WebSocket frames add message boundaries on top of TCP. Each frame has a clear start
and end, so the receiver knows exactly where one message ends and the next begins.

### The Frame Structure

Here is the binary layout of a WebSocket frame:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |            (16/64)            |
|N|V|V|V|       |S|             |   (if payload len==126/127)   |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
|     Extended payload length continued, if payload len == 127  |
+ - - - - - - - - - - - - - - - +-------------------------------+
|                               |Masking-key, if MASK set to 1  |
+-------------------------------+-------------------------------+
| Masking-key (continued)       |          Payload Data         |
+-------------------------------- - - - - - - - - - - - - - - - +
:                     Payload Data continued ...                :
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
|                     Payload Data (continued)                  |
+---------------------------------------------------------------+
```

Don't panic. Let's break it down piece by piece.

### FIN Bit (1 bit)

Indicates whether this is the final frame of a message. A message can be split across
multiple frames (fragmentation).

- `FIN = 1`: This is the complete message (or the last frame of a fragmented message)
- `FIN = 0`: More frames follow

Most messages fit in a single frame, so FIN is usually 1.

### RSV1, RSV2, RSV3 (1 bit each)

Reserved bits for extensions. Must be 0 unless an extension defines their use.
The `permessage-deflate` compression extension uses RSV1 to indicate a compressed
frame.

### Opcode (4 bits)

Tells the receiver what kind of frame this is:

| Opcode | Meaning | Description |
|--------|---------|-------------|
| `0x0`  | Continuation | Continuation of a fragmented message |
| `0x1`  | Text | UTF-8 text data |
| `0x2`  | Binary | Binary data |
| `0x8`  | Close | Connection close |
| `0x9`  | Ping | Heartbeat request |
| `0xA`  | Pong | Heartbeat response |

Opcodes `0x3`-`0x7` and `0xB`-`0xF` are reserved for future use.

### MASK Bit (1 bit)

Whether the payload is masked (XOR-encoded). **Client-to-server frames MUST be
masked. Server-to-client frames MUST NOT be masked.** This is not optional.

We will explain *why* shortly.

### Payload Length (7 bits, or 7+16, or 7+64)

The length encoding is clever -- it uses variable-length encoding to minimize overhead
for small messages while supporting huge payloads:

- If the 7-bit value is 0-125: that is the payload length.
- If the 7-bit value is 126: the *next 2 bytes* contain the actual length (up to 65,535 bytes).
- If the 7-bit value is 127: the *next 8 bytes* contain the actual length (up to 2^63 bytes).

```
Small message (≤125 bytes):
  [opcode + mask + length (7 bits)] = 2 bytes overhead

Medium message (126-65535 bytes):
  [opcode + mask + 126 + length (16 bits)] = 4 bytes overhead

Large message (>65535 bytes):
  [opcode + mask + 127 + length (64 bits)] = 10 bytes overhead
```

Compare this to HTTP, where headers alone are typically 500-800 bytes.

### Masking Key (4 bytes, if MASK bit is set)

A random 32-bit value used to XOR-encode the payload. Only present in client-to-server
frames.

### Payload Data

The actual message content, masked if the MASK bit is set.

---

## Frame Types Deep Dive

### Text Frames (opcode 0x1)

The payload must be valid UTF-8. This is the most common frame type for web applications.

```typescript
// Sending a text frame with JSON
ws.send(JSON.stringify({ type: 'message', text: 'Hello!' }));
// Transmits a text frame with payload: {"type":"message","text":"Hello!"}
```

### Binary Frames (opcode 0x2)

The payload is raw bytes. Used for images, audio, protobuf, or any non-text data.

```typescript
// Sending a binary frame
const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);
ws.send(buffer);
```

### Ping Frames (opcode 0x9)

A ping is a heartbeat request. When a peer sends a ping, the other peer MUST respond
with a pong containing the same payload data.

```
Client sends: Ping (payload: "heartbeat-42")
Server responds: Pong (payload: "heartbeat-42")
```

Pings are used to:
1. Detect dead connections (if no pong comes back, the peer is gone)
2. Keep the connection alive (prevent NAT/proxy timeout)

### Pong Frames (opcode 0xA)

The response to a ping. Must contain the same payload data as the ping.

A peer may also send an *unsolicited pong* (without a preceding ping). This serves
as a unidirectional heartbeat.

### Close Frames (opcode 0x8)

Initiates the close handshake. The payload contains a 2-byte status code followed by
an optional UTF-8 reason string.

```
Close frame payload:
[status code (2 bytes)] [reason string (optional UTF-8)]
```

---

## Why Client Frames Are Masked

This is one of the most interesting design decisions in the WebSocket protocol, and
most developers never learn the reason. It is worth understanding because it reveals
a class of attack that affects protocol design.

### The Proxy Cache Poisoning Attack

The attack works like this:

1. An attacker's JavaScript opens a WebSocket connection to the attacker's server.
2. The intermediary proxy sees the initial HTTP upgrade request and passes it through.
3. After the upgrade, the proxy may or may not understand that the connection has
   switched to WebSocket.
4. The attacker's client sends data that *looks like* an HTTP request to a different
   server.
5. A confused proxy interprets this as a regular HTTP request and caches the response.
6. Now the proxy's cache contains poisoned data.

Here is the scenario in detail:

```
Attacker's                Confused            Attacker's
Browser                   Proxy               Server
   |                        |                     |
   |--- Upgrade Request --> |--- Upgrade Req ---> |
   |<-- 101 Switching ------|-<- 101 Switching ---|
   |                        |                     |
   | Now sends raw data that looks like:          |
   | "GET /evil.js HTTP/1.1\r\nHost: cdn.example.com\r\n\r\n"
   |                        |                     |
   |              Proxy thinks this is            |
   |              an HTTP request to              |
   |              cdn.example.com!                |
   |                        |                     |
   |              Attacker's server sends         |
   |              malicious JavaScript            |
   |              as the "response"               |
   |                        |                     |
   |              Proxy caches the malicious      |
   |              script under cdn.example.com    |
```

Now when a real user requests `cdn.example.com/evil.js`, the proxy serves the attacker's
malicious script.

### How Masking Prevents This

Masking ensures that the raw bytes on the wire cannot be predicted by the attacker. Even
if the attacker crafts a payload that looks like `GET /evil.js HTTP/1.1`, the masking
transforms it into random-looking bytes.

The masking key is chosen randomly for each frame:

```typescript
// How masking works (simplified)
function maskPayload(payload: Buffer, maskKey: Buffer): Buffer {
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ maskKey[i % 4];
  }
  return masked;
}

// Unmasking is the same operation (XOR is its own inverse)
function unmaskPayload(masked: Buffer, maskKey: Buffer): Buffer {
  return maskPayload(masked, maskKey); // Same function!
}
```

Because the mask key is random and unpredictable, the attacker cannot craft a payload
that will look like a valid HTTP request after masking. The proxy will see garbage bytes,
not an HTTP request.

### Why Only Client Frames?

The attack requires the *attacker* to control the bytes on the wire. The attacker
controls the client (their JavaScript in the browser), so client-to-server frames must
be masked. The attacker does not control the server, so server-to-client frames do not
need masking.

### Is XOR Masking Real Security?

No. Masking is not encryption. It does not provide confidentiality. Anyone who can see
the frame can also see the masking key (it is in the frame header) and unmask the data.

Masking *only* prevents the specific attack of crafting wire-level bytes that confuse
intermediary proxies. For actual security (confidentiality, integrity), you need TLS
(wss:// instead of ws://).

---

## Close Handshake and Status Codes

### Why a Close Handshake?

TCP has its own close mechanism (FIN/ACK), but WebSocket adds its own on top. Why?

Because a TCP close does not carry a reason. The WebSocket close handshake lets the
peers communicate *why* the connection is closing. This is essential for application
logic -- "connection closed because you are not authenticated" is very different from
"connection closed because the server is shutting down."

### The Close Process

```
Initiator                              Responder
    |                                      |
    |--- Close frame (code + reason) ----->|
    |                                      |
    |<--- Close frame (code + reason) ----|
    |                                      |
    |       TCP connection closed           |
```

Either side can initiate. The other side should respond with its own close frame and
then both sides close the TCP connection.

### Status Codes

| Code | Name | Meaning |
|------|------|---------|
| 1000 | Normal Closure | The connection fulfilled its purpose |
| 1001 | Going Away | Server shutting down, or browser navigating away |
| 1002 | Protocol Error | A protocol violation was detected |
| 1003 | Unsupported Data | Received data type the endpoint cannot handle |
| 1005 | No Status Received | Reserved -- no status code was present |
| 1006 | Abnormal Closure | Reserved -- connection closed without a close frame |
| 1007 | Invalid Payload Data | Received text frame with invalid UTF-8 |
| 1008 | Policy Violation | A generic "you broke the rules" code |
| 1009 | Message Too Big | Message exceeds the size limit |
| 1010 | Mandatory Extension | Client expected an extension the server did not negotiate |
| 1011 | Internal Error | Server hit an unexpected condition |
| 1012 | Service Restart | Server is restarting |
| 1013 | Try Again Later | Server is temporarily unavailable |
| 1014 | Bad Gateway | Server acting as gateway received an invalid response |
| 1015 | TLS Handshake Failure | Reserved -- TLS handshake failed |

Codes 4000-4999 are reserved for application use. You can define your own:

```typescript
// Application-defined close codes
const CLOSE_CODES = {
  AUTH_FAILED: 4001,
  RATE_LIMITED: 4002,
  ROOM_DELETED: 4003,
  DUPLICATE_SESSION: 4004,
} as const;

// Closing with a custom code
ws.close(CLOSE_CODES.AUTH_FAILED, 'Invalid token');
```

---

## Build a Minimal WebSocket Server from Raw TCP

Now let's put all of this together. We will build a WebSocket server using nothing but
Node.js's `net` and `crypto` modules. This is for understanding -- you would never do
this in production.

```typescript
import { createServer, Socket } from 'net';
import { createHash } from 'crypto';

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = createServer((socket: Socket) => {
  console.log('TCP connection from', socket.remoteAddress);

  let upgraded = false;
  let buffer = Buffer.alloc(0);

  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    if (!upgraded) {
      handleHttpUpgrade(socket, buffer);
      upgraded = true;
      buffer = Buffer.alloc(0);
      return;
    }

    // Parse WebSocket frames
    processFrames(socket, buffer);
    buffer = Buffer.alloc(0);
  });

  socket.on('close', () => {
    console.log('Connection closed');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
});

function handleHttpUpgrade(socket: Socket, data: Buffer): void {
  const request = data.toString('utf-8');
  console.log('--- HTTP Upgrade Request ---');
  console.log(request);

  // Extract the Sec-WebSocket-Key header
  const keyMatch = request.match(/Sec-WebSocket-Key:\s*(.+)\r\n/);
  if (!keyMatch) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const clientKey = keyMatch[1].trim();

  // Compute the accept key
  const acceptKey = createHash('sha1')
    .update(clientKey + MAGIC_STRING)
    .digest('base64');

  // Send the upgrade response
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n');

  socket.write(response);
  console.log('--- Upgrade Complete ---');
}

function processFrames(socket: Socket, data: Buffer): void {
  if (data.length < 2) return;

  // First byte: FIN + opcode
  const firstByte = data[0];
  const fin = (firstByte & 0b10000000) !== 0;
  const opcode = firstByte & 0b00001111;

  // Second byte: MASK + payload length
  const secondByte = data[1];
  const isMasked = (secondByte & 0b10000000) !== 0;
  let payloadLength = secondByte & 0b01111111;

  let offset = 2;

  // Extended payload length
  if (payloadLength === 126) {
    payloadLength = data.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    // For simplicity, read as 32-bit (files > 4GB are unlikely here)
    payloadLength = data.readUInt32BE(offset + 4);
    offset += 8;
  }

  // Read masking key (if present)
  let maskKey: Buffer | null = null;
  if (isMasked) {
    maskKey = data.subarray(offset, offset + 4);
    offset += 4;
  }

  // Read payload
  const payload = data.subarray(offset, offset + payloadLength);

  // Unmask if needed
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i] ^ maskKey[i % 4];
    }
  }

  // Handle by opcode
  switch (opcode) {
    case 0x1: { // Text frame
      const message = payload.toString('utf-8');
      console.log('Received:', message);

      // Echo back (server frames are NOT masked)
      const response = `Echo: ${message}`;
      sendTextFrame(socket, response);
      break;
    }
    case 0x8: { // Close frame
      console.log('Client initiated close');
      // Send close frame back
      const closeFrame = Buffer.alloc(2);
      closeFrame[0] = 0b10001000; // FIN + close opcode
      closeFrame[1] = 0; // No payload
      socket.write(closeFrame);
      socket.end();
      break;
    }
    case 0x9: { // Ping
      console.log('Received ping');
      // Respond with pong (same payload)
      const pongFrame = Buffer.alloc(2 + payload.length);
      pongFrame[0] = 0b10001010; // FIN + pong opcode
      pongFrame[1] = payload.length;
      payload.copy(pongFrame, 2);
      socket.write(pongFrame);
      break;
    }
    case 0xA: { // Pong
      console.log('Received pong');
      break;
    }
    default:
      console.log(`Unknown opcode: ${opcode}`);
  }
}

function sendTextFrame(socket: Socket, message: string): void {
  const payload = Buffer.from(message, 'utf-8');
  const frame: Buffer[] = [];

  // First byte: FIN (1) + Text opcode (0x1)
  const firstByte = Buffer.alloc(1);
  firstByte[0] = 0b10000001;
  frame.push(firstByte);

  // Second byte: MASK (0, server never masks) + payload length
  if (payload.length < 126) {
    const lengthByte = Buffer.alloc(1);
    lengthByte[0] = payload.length;
    frame.push(lengthByte);
  } else if (payload.length < 65536) {
    const lengthBytes = Buffer.alloc(3);
    lengthBytes[0] = 126;
    lengthBytes.writeUInt16BE(payload.length, 1);
    frame.push(lengthBytes);
  } else {
    const lengthBytes = Buffer.alloc(9);
    lengthBytes[0] = 127;
    lengthBytes.writeUInt32BE(0, 1); // High 32 bits (0 for reasonable sizes)
    lengthBytes.writeUInt32BE(payload.length, 5);
    frame.push(lengthBytes);
  }

  // Payload (unmasked)
  frame.push(payload);

  socket.write(Buffer.concat(frame));
}

server.listen(8080, () => {
  console.log('Raw WebSocket server listening on ws://localhost:8080');
  console.log('Connect with: new WebSocket("ws://localhost:8080")');
});
```

### Testing It

Open a browser console and run:

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected!');
  ws.send('Hello from the browser!');
};

ws.onmessage = (event) => {
  console.log('Server says:', event.data);
};

ws.onclose = (event) => {
  console.log('Closed:', event.code, event.reason);
};
```

You should see:
- The server logs the raw HTTP upgrade request
- The connection is established
- The server echoes your message back
- Both sides log the text

### What This Demonstrates

Building from raw TCP teaches you:

1. **The upgrade is just HTTP.** Regular headers, regular response. Then the protocol
   switches.

2. **Frames are binary.** Bit manipulation is needed to parse them. This is very
   different from HTTP's text-based headers.

3. **Masking is XOR.** Simple, deterministic, and not for security. The same operation
   masks and unmasks.

4. **Server frames are not masked.** Notice we set the MASK bit to 0 in `sendTextFrame`.

5. **A real implementation is complex.** Our version does not handle fragmentation,
   multiple frames in one TCP segment, partial frames across segments, or large
   payloads. A production library like `ws` handles all of this.

---

## Fragmentation

A single WebSocket message can be split across multiple frames. This is useful for:

1. **Streaming.** Start sending data before you know the total size.
2. **Interleaving.** Control frames (ping/pong/close) can be sent between data frames
   of a fragmented message.
3. **Memory efficiency.** Send large messages in chunks instead of buffering the entire
   thing.

```
Message "Hello, World!" fragmented into 3 frames:

Frame 1: FIN=0, opcode=0x1, payload="Hello"     (text, not final)
Frame 2: FIN=0, opcode=0x0, payload=", Wor"     (continuation, not final)
Frame 3: FIN=1, opcode=0x0, payload="ld!"       (continuation, final)
```

The first frame has the actual opcode (text). Continuation frames use opcode 0x0.
The last frame has FIN=1 to signal the message is complete.

**Important rule:** Control frames (ping, pong, close) can be *interleaved* with
data frames, but they cannot themselves be fragmented. Control frames must fit in a
single frame (max 125 bytes payload).

```
This is valid:
  Data frame 1 (FIN=0, text)
  Ping frame (FIN=1)         <-- interleaved control frame
  Data frame 2 (FIN=1, continuation)

This is invalid:
  Ping frame (FIN=0)         <-- control frames cannot be fragmented
  Ping frame (FIN=1)
```

---

## Extensions and Subprotocols

### Extensions

Extensions modify the WebSocket protocol itself. The most common extension is
`permessage-deflate`, which compresses message payloads using the DEFLATE algorithm.

Extensions are negotiated during the handshake:

```http
// Client requests compression
GET /chat HTTP/1.1
Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits

// Server accepts
HTTP/1.1 101 Switching Protocols
Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover
```

`permessage-deflate` can reduce bandwidth significantly for text-heavy messages
(like JSON), but it adds CPU overhead and memory usage (each connection needs its
own compression context). We will discuss when to enable it in Lesson 4.

### Subprotocols

Subprotocols define the application-level protocol used over WebSocket. They do not
change the framing -- they specify how the *payload* should be interpreted.

```http
// Client offers subprotocol options
GET /chat HTTP/1.1
Sec-WebSocket-Protocol: chat-v2, chat-v1

// Server picks one
HTTP/1.1 101 Switching Protocols
Sec-WebSocket-Protocol: chat-v2
```

Common subprotocols:
- `graphql-ws` (GraphQL subscriptions)
- `wamp.2.json` (Web Application Messaging Protocol)
- `mqtt` (MQTT over WebSocket)

You can define your own subprotocol for your application:

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({
  port: 8080,
  handleProtocols: (protocols: Set<string>) => {
    // Client offered these subprotocols
    if (protocols.has('chat-v2')) return 'chat-v2';
    if (protocols.has('chat-v1')) return 'chat-v1';
    return false; // Reject -- no compatible subprotocol
  },
});
```

---

## WebSocket vs. HTTP/2 Server Push

You might wonder: "HTTP/2 has server push. Does that replace WebSockets?"

No. HTTP/2 server push lets the server *preemptively send resources* that the client
will likely request (like pushing a CSS file alongside the HTML). It is not the same
as pushing arbitrary real-time data.

HTTP/2 server push:
- Pushes complete HTTP responses
- Designed for cache-warming, not real-time updates
- The client can reject pushes
- Most browsers have deprecated HTTP/2 push support

WebSockets:
- Send arbitrary data in either direction
- Designed for real-time bidirectional communication
- Lightweight framing
- Persistent connection

They solve different problems. HTTP/2 does not eliminate the need for WebSockets.

---

## Security Considerations

### Always Use WSS (WebSocket Secure)

`ws://` is unencrypted WebSocket. `wss://` is WebSocket over TLS. **Always use WSS
in production.** The reasons are the same as HTTPS:

1. **Confidentiality.** Without TLS, anyone on the network can read your messages.
2. **Integrity.** Without TLS, attackers can modify messages in transit.
3. **Authentication.** TLS verifies the server's identity.
4. **Proxy compatibility.** Many proxies interfere with unencrypted WebSocket traffic
   but pass encrypted traffic through cleanly (they cannot inspect it).

### Origin Checking

Unlike HTTP APIs where CORS headers control cross-origin access, WebSocket servers must
check the `Origin` header themselves:

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({
  port: 8080,
  verifyClient: (info) => {
    const origin = info.origin || info.req.headers.origin;
    const allowedOrigins = ['https://myapp.com', 'https://staging.myapp.com'];
    return allowedOrigins.includes(origin as string);
  },
});
```

If you skip this check, any website can open a WebSocket connection to your server.
Combined with cookie-based authentication, this enables cross-site WebSocket hijacking.

### Message Validation

Never trust data from a WebSocket client:

```typescript
// BAD: Trusting client data
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  // What if msg.userId is spoofed?
  // What if msg.text contains <script>?
  broadcastToRoom(msg.room, msg);
});

// GOOD: Validate and sanitize
ws.on('message', (data) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    ws.close(1003, 'Invalid JSON');
    return;
  }

  const result = messageSchema.safeParse(parsed);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    return;
  }

  // Use the authenticated user ID from the connection, not from the message
  const msg = result.data;
  broadcastToRoom(msg.room, {
    userId: ws.userId, // From authentication, not from the message
    text: sanitize(msg.text),
  });
});
```

---

## Summary

| Concept | Key Insight |
|---------|-------------|
| Upgrade handshake | WebSocket starts as HTTP, then switches protocols |
| Sec-WebSocket-Key | Proof of protocol understanding, not security |
| Frame format | Binary, variable-length, minimal overhead (2-14 bytes) |
| Opcodes | Text (0x1), Binary (0x2), Close (0x8), Ping (0x9), Pong (0xA) |
| Client masking | Prevents proxy cache poisoning, not encryption |
| Close handshake | Clean shutdown with status code and reason |
| Fragmentation | Large messages can be split across frames |
| Extensions | Modify the protocol (e.g., compression) |
| Subprotocols | Define application-level message format |

---

## Exercises

### Exercise 1: Compute the Accept Key

Given the client key `x3JJHMbDL1EzLkh9GBhXDw==`, manually compute the
`Sec-WebSocket-Accept` value. Write a Node.js script that:
1. Concatenates the client key with the magic string
2. Computes the SHA-1 hash
3. Base64-encodes the result

Verify your answer by also having the `ws` library accept a connection with that key.

### Exercise 2: Parse a Frame by Hand

Given this hex dump of a WebSocket frame received from a client:

```
81 85 37 fa 21 3d 7f 9f 4d 51 58
```

Parse it by hand:
1. What is the FIN bit?
2. What is the opcode?
3. Is it masked?
4. What is the payload length?
5. What is the masking key?
6. What is the unmasked payload? (Hint: XOR each payload byte with the corresponding
   masking key byte)

### Exercise 3: Extend the Raw Server

Take the raw WebSocket server from this lesson and add:
1. **Broadcasting.** Track all connected sockets in a `Set`. When one client sends a
   message, relay it to all other clients.
2. **Binary frame support.** Handle opcode 0x2 and log the hex bytes.
3. **Fragmentation handling.** Buffer continuation frames and assemble the complete
   message before processing.

### Exercise 4: Close Code Analysis

For each scenario, which close code should the server use?
1. The server is shutting down for maintenance
2. A client sent a text frame containing invalid UTF-8
3. A client sent a message larger than the 1MB limit
4. A client's authentication token has expired
5. The server encountered a bug while processing a message

### Exercise 5: Security Audit

Review this WebSocket server code and identify all security issues:

```typescript
const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws, req) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    // Store in database
    db.query(`INSERT INTO messages (user, text) VALUES ('${msg.user}', '${msg.text}')`);
    // Broadcast to all
    wss.clients.forEach(client => {
      client.send(JSON.stringify(msg));
    });
  });
});
```

List every issue you find, explain the attack vector, and provide a corrected version.
