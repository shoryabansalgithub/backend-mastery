# Lesson 1: TCP and Real-Time Communication

## Why HTTP Falls Short

Before we talk about WebSockets, we need to understand *why* they exist. And to do
that, we need to understand what HTTP was designed for -- and what it was not.

HTTP was invented in 1991 for fetching documents. A browser asks for a page, a server
sends it back. That is the fundamental model:

```
Client: "Give me /index.html"
Server: "Here it is."
(Connection closes)
```

This is called **request-response**. The client always initiates. The server can never
say, "Hey, I have something new for you." It can only respond to questions.

Think of HTTP like sending a letter. You write a question, mail it, wait for a reply.
If you want to know whether something has changed, you have to write *another* letter
and ask again. The post office cannot spontaneously deliver a letter to you just because
something happened at the other end.

Now imagine you are building a chat application. Alice sends a message. Bob needs to
see it immediately. But Bob's browser is sitting there doing nothing -- it has no
active request to the server. The server has Alice's message, but HTTP gives it no way
to push that message to Bob.

This is the fundamental problem: **HTTP is client-driven, but real-time applications
need server-driven communication.**

### The Request-Response Mismatch

Let's make this concrete. Here is a naive approach to "real-time" chat with HTTP:

```typescript
// Client-side: Check for messages every time the user clicks "Refresh"
async function checkMessages() {
  const res = await fetch('/api/messages?after=' + lastMessageId);
  const messages = await res.json();
  renderMessages(messages);
}

document.getElementById('refresh')!.addEventListener('click', checkMessages);
```

This works, but it requires the user to manually refresh. That is not real-time.
That is "whenever the user gets impatient."

So what if we automate the checking?

---

## The Workarounds: Polling, Long Polling, and SSE

### Short Polling

The simplest approach: ask the server repeatedly on a timer.

```typescript
// Client: Check every 2 seconds
setInterval(async () => {
  const res = await fetch('/api/messages?after=' + lastMessageId);
  const messages = await res.json();
  if (messages.length > 0) {
    renderMessages(messages);
  }
}, 2000);
```

```typescript
// Server
app.get('/api/messages', (req, res) => {
  const after = req.query.after as string;
  const newMessages = messages.filter(m => m.id > after);
  res.json(newMessages);
});
```

**Why this is bad:**

1. **Wasted bandwidth.** If no one has sent a message in 30 seconds, you have made
   15 requests that all returned empty arrays. Each request has HTTP headers (cookies,
   auth tokens, content-type) -- easily 500 bytes per request. That is 7.5 KB of pure
   waste.

2. **Latency.** If your interval is 2 seconds, messages are delayed by up to 2 seconds
   on average. Want faster updates? Poll more frequently, which multiplies the waste.

3. **Scaling disaster.** If you have 10,000 connected users polling every 2 seconds,
   that is 5,000 requests per second to your server -- most returning nothing useful.

**The trade-off is clear:** short polling forces you to choose between latency and
server load. You cannot have both low latency and low overhead.

### Long Polling

A clever hack: instead of returning immediately when there are no messages, the server
*holds the request open* until it has something to send.

```typescript
// Server: Hold the request until a new message arrives
app.get('/api/messages/wait', async (req, res) => {
  const after = req.query.after as string;

  // Check immediately
  const existing = messages.filter(m => m.id > after);
  if (existing.length > 0) {
    return res.json(existing);
  }

  // No new messages -- wait for one
  const listener = (newMessage: Message) => {
    res.json([newMessage]);
  };

  messageEmitter.once('new-message', listener);

  // Timeout after 30 seconds to prevent zombie connections
  setTimeout(() => {
    messageEmitter.off('new-message', listener);
    res.json([]); // Empty response, client will retry
  }, 30000);
});
```

```typescript
// Client: Immediately re-request after each response
async function longPoll() {
  try {
    const res = await fetch('/api/messages/wait?after=' + lastMessageId);
    const messages = await res.json();
    if (messages.length > 0) {
      renderMessages(messages);
    }
  } catch (err) {
    // Network error -- wait a bit before retrying
    await sleep(1000);
  }
  longPoll(); // Immediately poll again
}

longPoll();
```

**Better, but still problematic:**

1. **Connection churn.** Every time a message arrives, the HTTP connection closes and
   the client must open a new one. TCP handshake, TLS handshake, HTTP headers -- all
   repeated for every message.

2. **Server resource consumption.** Each waiting client holds an open HTTP connection.
   The server has to track all these pending responses.

3. **Message bursts cause storms.** If 100 messages arrive quickly, each one triggers
   a response, a reconnection, and another request. You end up with rapid-fire HTTP
   round-trips.

4. **Still unidirectional.** The client still cannot send messages over the same
   connection. Sending a message requires a separate POST request.

### Server-Sent Events (SSE)

SSE is a standardized way for the server to push events to the client over a
long-lived HTTP connection. Unlike long polling, the connection stays open.

```typescript
// Server
app.get('/api/messages/stream', (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send a comment to prevent proxy timeout
  res.write(':keepalive\n\n');

  // Push new messages as they arrive
  const listener = (message: Message) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  messageEmitter.on('new-message', listener);

  // Clean up when client disconnects
  req.on('close', () => {
    messageEmitter.off('new-message', listener);
  });
});
```

```typescript
// Client (browser built-in API)
const source = new EventSource('/api/messages/stream');

source.onmessage = (event) => {
  const message = JSON.parse(event.data);
  renderMessage(message);
};

source.onerror = () => {
  // Browser automatically reconnects
  console.log('Connection lost, reconnecting...');
};
```

**SSE is genuinely good for many use cases:**

- Server pushes data to the client over a persistent connection
- Built-in reconnection in the browser
- Simple protocol (just text over HTTP)
- Works with existing HTTP infrastructure (proxies, load balancers)

**But SSE has limits:**

1. **Unidirectional.** The server can push to the client, but the client cannot send
   data back over the same connection. For chat, you still need separate POST requests
   to send messages.

2. **Text only.** SSE transmits text. Binary data must be base64-encoded, which adds
   ~33% overhead.

3. **Limited connections.** Browsers limit the number of SSE connections per domain
   (typically 6 in HTTP/1.1). With HTTP/2 this limit is much higher, but it is still
   a constraint.

4. **No multiplexing.** Each SSE connection is a one-way stream. If you need different
   types of real-time data (messages, presence, typing indicators), you either multiplex
   them over one SSE stream or open multiple connections.

### Thought Experiment

Imagine you are building a collaborative document editor (like Google Docs). Users type
characters, move their cursors, select text, and see each other's changes in real-time.

- **Short polling:** Every keystroke would be delayed by the polling interval. The
  experience would be miserable. And you would be making thousands of requests per
  second per document.

- **Long polling:** Every keystroke triggers a response-reconnect cycle. With 5 users
  typing simultaneously, you have a storm of connections opening and closing.

- **SSE:** You can push changes from the server, but each user's keystrokes still need
  to go via separate POST requests. That is two connections per user -- one SSE for
  receiving, one HTTP for sending.

What you *actually* want is a single persistent connection where both sides can send
data at any time. That is a WebSocket.

---

## TCP Primer

Before we get to WebSockets, we need to understand what is underneath. WebSockets run
on top of TCP, and understanding TCP explains *why* WebSockets work the way they do.

### What TCP Does

TCP (Transmission Control Protocol) provides **reliable, ordered, bidirectional**
byte-stream communication between two machines.

Think of TCP like a phone call:
1. You dial (connection establishment)
2. Both sides can talk at the same time (full-duplex)
3. If a word gets garbled, you say "what?" and the other side repeats it (reliability)
4. Words arrive in order (ordering)
5. Either side can hang up (connection termination)

Compare this to UDP, which is like shouting across a room:
- No guarantee anyone heard you
- No guarantee messages arrive in order
- No "call setup" step
- Faster, but unreliable

### The TCP Three-Way Handshake

Every TCP connection starts with a handshake:

```
Client                    Server
  |                         |
  |--- SYN (seq=100) ----->|    "I want to connect, my sequence starts at 100"
  |                         |
  |<-- SYN-ACK (seq=300,   |    "OK, my sequence starts at 300, I acknowledge 101"
  |    ack=101) -----------|
  |                         |
  |--- ACK (ack=301) ----->|    "I acknowledge 301, we're connected"
  |                         |
  |   Connection established|
```

This takes one round-trip (plus a bit) before any data can flow. On a 50ms latency
connection, that is 75ms before the first byte of data.

For HTTPS, add a TLS handshake on top: another 1-2 round-trips. Now you are at 150-225ms
before sending data.

This matters because HTTP/1.1 traditionally opens a new connection for each request
(or a few connections with keep-alive). Long polling opens new connections frequently.
WebSockets open *one* connection and keep it.

### Segments, Flow Control, and Congestion

TCP breaks your data into **segments** (chunks). Each segment has a sequence number so
the receiver can reassemble them in order.

**Flow control** prevents a fast sender from overwhelming a slow receiver. The receiver
advertises a "window size" -- how much data it can accept. The sender limits itself
accordingly.

```
Receiver: "My window is 64KB"
Sender: sends 64KB
Receiver: "I processed 32KB, window is now 32KB"
Sender: sends 32KB
Receiver: "I processed everything, window is 64KB again"
```

**Congestion control** prevents a fast sender from overwhelming the *network*. TCP
starts slow (slow start) and gradually increases sending rate until it detects packet
loss, then backs off.

Why does this matter for WebSockets? Because WebSocket data rides on TCP, it gets all
of these guarantees for free: reliability, ordering, flow control, and congestion
control. You do not have to implement any of this yourself.

### Ports and Connections

A TCP connection is identified by four things:
1. Source IP address
2. Source port
3. Destination IP address
4. Destination port

This means a single server port (say, 443) can handle millions of simultaneous
connections, because each connection has a unique (source IP, source port) pair.

WebSocket servers typically run on port 80 (ws://) or 443 (wss://), the same ports
as HTTP. This is intentional -- it means WebSocket traffic passes through firewalls
and proxies that allow HTTP.

---

## Full-Duplex Communication

This is the key concept. Let's define the communication models:

### Simplex
Data flows in one direction only. Like a radio broadcast.

```
Server ----data----> Client
```

### Half-Duplex
Data flows in both directions, but only one direction at a time. Like a walkie-talkie:
you press to talk, release to listen.

```
Server ----data----> Client    (server sends)
Server <---data----- Client    (then client sends)
```

HTTP is effectively half-duplex. The client sends a request, then the server sends a
response. They take turns.

### Full-Duplex
Data flows in both directions simultaneously. Like a phone call.

```
Server ----data----> Client    (both at
Server <---data----- Client     the same time)
```

TCP is full-duplex. Two independent byte streams flow in opposite directions over the
same connection.

**WebSockets expose TCP's full-duplex nature to web applications.** Both the client and
the server can send messages at any time, without waiting for the other side.

This is why WebSockets feel fundamentally different from HTTP-based solutions. There is
no request-response pattern. There are no turns. Either side can send a message whenever
it wants.

```typescript
// With WebSockets, the server can push data at any time:
ws.send('New message from Alice');

// And the client can send data at any time:
ws.send('Bob is typing...');

// These can happen simultaneously -- no coordination needed.
```

### Why Full-Duplex Matters

Consider a multiplayer game. The server needs to send you position updates for every
other player (60 times per second). Simultaneously, you need to send your input to the
server (also 60 times per second). With HTTP, you would need to complete a
request-response cycle for each piece of data. With WebSockets, both streams flow
independently.

Here is the overhead comparison:

| Protocol     | Per-message overhead | Setup cost        | Direction    |
|-------------|---------------------|-------------------|--------------|
| HTTP/1.1    | ~800 bytes (headers)| TCP + TLS per req | Half-duplex  |
| Long Poll   | ~800 bytes (headers)| TCP + TLS per msg | Half-duplex  |
| SSE         | ~0 bytes (after setup)| Once            | Server→Client|
| WebSocket   | 2-14 bytes          | Once (HTTP upgrade)| Full-duplex |

After the initial handshake, a WebSocket frame can have as little as 2 bytes of
overhead. Compare that to HTTP's ~800 bytes of headers on every message.

---

## When You Need Real-Time

Not everything needs WebSockets. In fact, many applications that *think* they need
WebSockets actually don't. Let's be precise about when each tool is appropriate.

### Chat Applications

The classic use case. Users send messages and need to see responses immediately. Chat
requires:
- Bidirectional communication (sending and receiving messages)
- Low latency (typing indicators, presence updates)
- Server-initiated pushes (new message from another user)

**Verdict:** WebSockets are ideal.

### Live Dashboards

A monitoring dashboard showing server metrics, stock prices, or social media stats.
The server pushes new data as it arrives.

- Primarily server-to-client
- Client rarely sends data (maybe filter changes)
- Could tolerate a few seconds of latency

**Verdict:** SSE is often sufficient. WebSockets work but may be overkill if the
client rarely sends data.

### Online Gaming

Multiplayer games need:
- Extremely low latency (< 50ms)
- High-frequency updates (30-60 per second)
- Bidirectional (input from player, state from server)

**Verdict:** WebSockets for turn-based or low-frequency games. For fast-paced games
(FPS, racing), developers often use UDP (via WebRTC data channels) because TCP's
reliability guarantees add latency that games cannot afford.

### Collaborative Editing

Multiple users editing the same document:
- Bidirectional (user edits, other users' edits)
- Every keystroke or cursor movement
- Conflict resolution needed
- Must handle offline/reconnection

**Verdict:** WebSockets are essential. This is one of the most demanding real-time
use cases.

### Notifications

"You have a new follower" or "Your order shipped."
- Server-to-client only
- Low frequency (a few per minute at most)
- Can tolerate seconds of latency

**Verdict:** SSE is ideal. Even long polling would be fine. WebSockets are unnecessary
overhead.

### IoT / Sensor Data

Devices sending telemetry to a server:
- Primarily client-to-server
- Could be high frequency
- Often needs binary data support

**Verdict:** WebSockets work, but MQTT (a lightweight pub/sub protocol) is often a
better fit for IoT. Depends on the constraints.

---

## The Real-Time Spectrum

Let's arrange our options from simplest to most capable:

```
Least capable                                               Most capable
Least complex                                               Most complex

Short       Long         Server-Sent     WebSockets        WebRTC
Polling     Polling      Events                            Data Channels
  |           |             |                |                 |
  +-----------+-------------+----------------+-----------------+

  Client-     Client-       Server→Client    Bidirectional    Peer-to-peer
  initiated   initiated     push             full-duplex      bidirectional

  High        Medium        Low (server      Minimal          Minimal
  latency     latency       push only)       overhead         overhead

  ~800B/msg   ~800B/msg     ~0B/msg          2-14B/msg        Variable
  overhead    overhead      (after setup)    (after setup)
```

### Decision Framework

Ask these questions:

1. **Does the server need to push data to the client?**
   - No: Regular HTTP is fine.
   - Yes: Continue.

2. **Does the client need to send data frequently too?**
   - No: SSE is probably sufficient.
   - Yes: Continue.

3. **How latency-sensitive is the application?**
   - Seconds are OK: Long polling works.
   - Sub-second needed: WebSockets.
   - Sub-50ms needed: Consider WebRTC data channels.

4. **Do you need binary data?**
   - No: SSE or WebSockets.
   - Yes: WebSockets or WebRTC.

5. **Is this peer-to-peer?**
   - No: WebSockets (client↔server).
   - Yes: WebRTC (client↔client).

### The Cost of WebSockets

WebSockets are not free. You should understand the costs before choosing them:

1. **Stateful connections.** Each WebSocket connection is a persistent TCP connection.
   Your server must track them. Unlike HTTP, where you can use stateless load balancing,
   WebSocket connections are sticky.

2. **Scaling complexity.** If you have multiple server instances, a message sent to
   server A must somehow reach a client connected to server B. This requires
   infrastructure (Redis pub/sub, message brokers) that stateless HTTP does not need.

3. **Connection management.** Connections drop. Clients go offline. Servers restart.
   You need reconnection logic, heartbeats, and message replay -- none of which HTTP
   requires.

4. **Harder to debug.** You cannot just open browser dev tools and see a clean list of
   request/response pairs. WebSocket traffic is a continuous stream that is harder to
   inspect and replay.

5. **Infrastructure compatibility.** Some proxies, firewalls, and CDNs do not handle
   WebSocket connections well. You may need to fall back to long polling in certain
   environments.

This module will teach you to handle all of these challenges. But first, understand
that they exist. Do not reach for WebSockets when a simpler solution would work.

---

## A Mental Model: Pipes vs. Letters

Here is an analogy that ties everything together.

**HTTP** is like exchanging letters. You write a letter (request), mail it, and wait
for a reply. Each exchange is independent. The postal system (network) does not maintain
any ongoing relationship between sender and recipient.

**Long polling** is like sending a letter that says "reply whenever you have something
to say." The recipient holds the letter until they have news, then sends a reply. You
immediately send another "standing request" letter.

**SSE** is like hiring a courier who stands at the recipient's door. Whenever the
recipient has something to say, the courier runs it back to you. But you cannot send
messages back through the courier.

**WebSockets** are like installing a telephone line between you and the recipient. Once
the line is set up (the handshake), either side can talk at any time. There is no
per-message overhead of envelopes and stamps -- just raw conversation.

**WebRTC** is like installing a telephone line directly between two people (peer-to-peer),
without going through a switchboard (server).

---

## What We Will Build in This Module

Over the next four lessons, you will:

1. **Understand the WebSocket protocol** at the byte level -- how the upgrade handshake
   works, what frames look like, and why client frames are masked.

2. **Build WebSocket servers** using the `ws` library, with proper message handling,
   authentication, and integration with Express.

3. **Scale WebSocket connections** across multiple servers using Redis pub/sub.

4. **Handle the messy real world** -- dropped connections, reconnection with exponential
   backoff, heartbeats, message replay, and graceful shutdown.

By the end of this module, you will build a distributed chat system that handles all of
these concerns.

---

## Summary

| Concept | Key Insight |
|---------|-------------|
| HTTP | Request-response model -- server cannot push data |
| Short polling | Wastes bandwidth, trades latency for server load |
| Long polling | Reduces waste but causes connection churn |
| SSE | Efficient server push, but unidirectional |
| TCP | Reliable, ordered, full-duplex byte streams |
| Full-duplex | Both sides can send simultaneously |
| WebSockets | Full-duplex, low overhead, persistent connections |
| WebRTC | Peer-to-peer, lowest latency |

---

## Exercises

### Exercise 1: Measure Polling Overhead

Calculate the total bandwidth waste for a chat app using short polling:
- 5,000 connected users
- Polling every 2 seconds
- Average HTTP request headers: 500 bytes
- Average HTTP response headers: 400 bytes
- Average response body (when empty): 2 bytes (`[]`)
- On average, only 1 in 50 polls returns actual data

How many bytes per second are wasted on empty polls? How does this compare to WebSocket
overhead?

### Exercise 2: Build a Long Polling Server

Implement a simple message board using long polling:
- `POST /messages` to send a message (store in an in-memory array)
- `GET /messages/wait?after=<id>` that blocks until a new message is available
- Include a 30-second timeout
- Write client code that long-polls continuously

Then count how many TCP connections are opened per message sent (hint: use a counter
that increments in your request handler).

### Exercise 3: SSE Comparison

Convert your long-polling message board to use Server-Sent Events:
- `GET /messages/stream` endpoint that sends SSE
- Use the `EventSource` API on the client
- Compare: how many connections are opened when 10 messages arrive in quick succession?
  With long polling vs. SSE?

### Exercise 4: Thought Experiment -- Choosing the Right Tool

For each scenario, decide which technology you would use (short polling, long polling,
SSE, WebSockets, or WebRTC) and explain your reasoning:

1. A weather app that updates the current temperature every 5 minutes
2. A stock trading platform showing real-time price changes and allowing instant trades
3. A CI/CD dashboard that shows build log output in real-time
4. A video call application between two users
5. A multiplayer chess game
6. An IoT dashboard showing 1,000 sensor readings per second

### Exercise 5: TCP Handshake Latency

A client in New York is connecting to a server in London. The round-trip time (RTT) is
75ms.

Calculate the total time before the first WebSocket message can be sent, accounting for:
1. TCP three-way handshake
2. TLS 1.3 handshake (1 round-trip)
3. HTTP upgrade handshake (1 round-trip)

Then compare: if this same client used short polling over HTTP/1.1 with a new connection
per request, what would the overhead be for sending 10 messages in quick succession?
