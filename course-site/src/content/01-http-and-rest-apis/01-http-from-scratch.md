# Lesson 1: HTTP from Scratch

## What You'll Learn

By the end of this lesson, you'll understand HTTP not as a magic black box, but as
a simple text-based protocol you can read and write by hand. You'll build a raw TCP
server that speaks HTTP, and you'll see the actual bytes traveling over the wire.

---

## Why Start Here?

Every backend framework -- Express, Fastify, Django, Rails -- is just a convenience
layer over HTTP. If you don't understand what's happening underneath, you'll spend
your career copy-pasting middleware configurations you don't understand, debugging
problems you can't see, and building APIs that accidentally break the protocol.

Think of it this way: a mechanic who doesn't understand engines can change your oil.
But when the car makes a weird noise, they're useless. We're going to understand the
engine.

---

## What Is HTTP, Really?

HTTP stands for **HyperText Transfer Protocol**. Let's break that down from first
principles.

### It's a Protocol

A protocol is just an agreement about how two parties will communicate. When you
call a restaurant to order takeout, there's an implicit protocol:

1. You call, they answer with the restaurant name
2. You state your order
3. They confirm or say "we're out of that"
4. You give your address
5. They give you a time estimate

If you called and just started reciting your credit card number, the protocol would
break. The same applies to HTTP -- both sides agree on the exact format of messages.

### It's Text-Based

This is the insight most people miss. HTTP/1.1 messages are **plain text**. Not
binary. Not encrypted (that's HTTPS/TLS, a layer below). Just text you could type
with a keyboard.

Here's a real HTTP request, character for character:

```
GET /hello HTTP/1.1\r\n
Host: example.com\r\n
Accept: text/html\r\n
\r\n
```

That's it. That's the entire request. If you opened a raw TCP connection to a web
server and typed exactly those bytes, you'd get a response back.

### It Runs Over TCP

TCP (Transmission Control Protocol) handles the boring-but-critical job of getting
bytes reliably from point A to point B. HTTP doesn't care how the bytes travel -- it
just needs them to arrive in order and without corruption. TCP guarantees that.

The relationship:

```
Your Application
     |
   HTTP       (formats the message)
     |
   TCP        (delivers the bytes reliably)
     |
   IP         (routes packets across the internet)
     |
   Network    (physical wires, radio waves, etc.)
```

HTTP is like the *language* you speak. TCP is like the *postal service* that
delivers your letter. You write in English (HTTP), put it in an envelope (TCP),
and the postal service (IP/network) gets it there.

---

## Request/Response: The Only Pattern

HTTP has exactly one interaction pattern: **request/response**.

1. The client sends a request
2. The server sends a response
3. Done.

There's no "server pushes a message to the client" in basic HTTP (that's what
WebSockets solve -- Module 5). There's no "ongoing conversation." Each
request/response pair is independent.

### Thought Experiment

Imagine you're at a library reference desk. You can ask one question at a time. The
librarian answers, then forgets you exist. Next time you walk up, you're a complete
stranger. That's HTTP. Every request starts from zero.

This property is called **statelessness**, and it's not a limitation -- it's a
deliberate design choice that makes HTTP incredibly scalable. Any server can handle
any request because no server needs to remember previous requests. (We'll deal with
the "but what about login sessions?" question in Module 2.)

---

## Anatomy of an HTTP Request

Let's examine every byte of a request. Here's one:

```
POST /api/users HTTP/1.1\r\n
Host: myapp.com\r\n
Content-Type: application/json\r\n
Content-Length: 27\r\n
Accept: application/json\r\n
Connection: keep-alive\r\n
\r\n
{"name":"Ada","age":36}
```

### The Request Line

```
POST /api/users HTTP/1.1\r\n
```

Three parts, separated by spaces:

| Part | Value | Meaning |
|------|-------|---------|
| Method | `POST` | What action to perform |
| Path | `/api/users` | What resource to act on |
| Version | `HTTP/1.1` | What version of the protocol |

The `\r\n` is a CRLF (carriage return + line feed). HTTP uses Windows-style line
endings, not Unix-style `\n`. This is baked into the spec and every HTTP parser must
handle it.

### Headers

```
Host: myapp.com\r\n
Content-Type: application/json\r\n
Content-Length: 27\r\n
Accept: application/json\r\n
Connection: keep-alive\r\n
```

Headers are key-value pairs, one per line, formatted as `Name: Value\r\n`. They're
metadata about the request -- think of them as the label on a package telling the
post office how to handle it.

Headers are **case-insensitive** in their names. `Content-Type`, `content-type`, and
`CONTENT-TYPE` are all the same header.

### The Empty Line

```
\r\n
```

This blank line (just a CRLF by itself) is the separator between headers and body.
It's how the parser knows "headers are done, body starts now." Miss this, and the
entire parsing breaks.

### The Body

```
{"name":"Ada","age":36}
```

The body is the payload. Not all requests have one -- GET requests typically don't.
The `Content-Length` header tells the server exactly how many bytes to read for the
body. Count the characters: `{"name":"Ada","age":36}` is 23 characters... wait,
that's not 27. Let me recount.

Actually, this is a great teaching moment. Let's be precise:

```
{"name":"Ada","age":36}
```

`{` `"` `n` `a` `m` `e` `"` `:` `"` `A` `d` `a` `"` `,` `"` `a` `g` `e` `"` `:` `3` `6` `}`

That's 23 bytes. So `Content-Length` should be `23`, not `27`. **Getting
Content-Length wrong is a real bug that causes real problems** -- the server would
try to read 4 more bytes that don't exist and hang waiting for them.

Corrected request:

```
POST /api/users HTTP/1.1\r\n
Host: myapp.com\r\n
Content-Type: application/json\r\n
Content-Length: 23\r\n
Accept: application/json\r\n
Connection: keep-alive\r\n
\r\n
{"name":"Ada","age":36}
```

---

## Anatomy of an HTTP Response

```
HTTP/1.1 201 Created\r\n
Content-Type: application/json\r\n
Content-Length: 39\r\n
X-Request-Id: abc-123\r\n
\r\n
{"id":1,"name":"Ada","age":36}
```

### The Status Line

```
HTTP/1.1 201 Created\r\n
```

| Part | Value | Meaning |
|------|-------|---------|
| Version | `HTTP/1.1` | Protocol version |
| Status Code | `201` | Machine-readable result |
| Reason Phrase | `Created` | Human-readable result |

The reason phrase is optional and ignored by clients. The status code is what
matters.

### Same structure after that

Headers, blank line, body -- identical structure to the request.

---

## HTTP Methods: Why They Exist

Methods tell the server what *kind* of action you want. You might wonder: "Why not
just use POST for everything and put the action in the body?" Some APIs actually do
this (looking at you, GraphQL and SOAP). But having standardized methods gives us
important properties.

### The Methods

| Method | Purpose | Has Body? | Safe? | Idempotent? |
|--------|---------|-----------|-------|-------------|
| GET | Retrieve a resource | No | Yes | Yes |
| POST | Create a resource or trigger action | Yes | No | No |
| PUT | Replace a resource entirely | Yes | No | Yes |
| PATCH | Partially update a resource | Yes | No | No* |
| DELETE | Remove a resource | Rarely | No | Yes |
| HEAD | Like GET but no body in response | No | Yes | Yes |
| OPTIONS | Ask what methods are allowed | No | Yes | Yes |

### What "Safe" Means

A **safe** method doesn't change anything on the server. GET is safe -- fetching a
web page shouldn't modify it. This isn't enforced by HTTP; it's a contract. If you
make a GET endpoint that deletes data, HTTP won't stop you, but you've violated the
contract and bad things will happen (web crawlers will "click" every link and
accidentally delete everything).

**Real-world disaster story:** In 2005, Google Web Accelerator pre-fetched links on
pages to speed up browsing. It would send GET requests to every link it found. Apps
that used GET requests for "delete this record" links had their data wiped out by
Google's well-intentioned crawler. The protocol contract existed for a reason.

### What "Idempotent" Means

An **idempotent** method produces the same result whether you call it once or ten
times. PUT is idempotent: "set user 5's name to Ada" has the same effect whether you
do it once or a hundred times. POST is not: "create a new user" called ten times
creates ten users.

Why does this matter? Network failures. If your request times out, should you retry?
With an idempotent method (GET, PUT, DELETE), yes -- worst case, you get the same
result. With a non-idempotent method (POST), retrying might create a duplicate.

### Thought Experiment

You're at an ATM. "Check balance" is a GET -- safe and idempotent. "Withdraw $100"
is a POST -- not safe, not idempotent. If the ATM freezes after you hit "withdraw,"
would you press it again? That's the idempotency problem. Banks solve this with
transaction IDs (idempotency keys) -- we'll cover that pattern later.

---

## Status Codes: The Server's Answer

Status codes are grouped by their first digit:

### 1xx: Informational

You'll rarely see these. `100 Continue` tells the client "I got your headers, go
ahead and send the body." Useful for large uploads where you want the server to
reject early.

### 2xx: Success

| Code | Meaning | When to Use |
|------|---------|-------------|
| 200 OK | Generic success | GET that returns data |
| 201 Created | Resource created | POST that creates something |
| 204 No Content | Success, nothing to return | DELETE that worked |

### 3xx: Redirection

| Code | Meaning | When to Use |
|------|---------|-------------|
| 301 Moved Permanently | Resource moved forever | URL changed, update bookmarks |
| 302 Found | Resource temporarily elsewhere | Temporary redirect |
| 304 Not Modified | Use your cached version | Client cache is still valid |

### 4xx: Client Error

The client did something wrong.

| Code | Meaning | When to Use |
|------|---------|-------------|
| 400 Bad Request | Malformed request | Invalid JSON, missing fields |
| 401 Unauthorized | Not authenticated | No token, expired token |
| 403 Forbidden | Authenticated but not allowed | Wrong permissions |
| 404 Not Found | Resource doesn't exist | Bad URL or deleted resource |
| 405 Method Not Allowed | Wrong HTTP method | POST to a GET-only endpoint |
| 409 Conflict | Conflicts with current state | Duplicate email, version conflict |
| 422 Unprocessable Entity | Valid syntax, invalid semantics | Email format wrong |
| 429 Too Many Requests | Rate limited | Slow down |

**Common confusion:** 401 vs 403. Think of a building. 401 means you didn't show
your ID badge (unauthenticated). 403 means you showed your badge but you don't have
access to that floor (unauthorized). The naming in the HTTP spec is unfortunate --
401 should really be called "Unauthenticated."

### 5xx: Server Error

The server messed up.

| Code | Meaning | When to Use |
|------|---------|-------------|
| 500 Internal Server Error | Something broke | Unhandled exception |
| 502 Bad Gateway | Upstream server error | Proxy got a bad response |
| 503 Service Unavailable | Server overloaded | Maintenance, overload |
| 504 Gateway Timeout | Upstream timed out | Backend too slow |

**Rule of thumb:** If the client could fix the problem by changing their request,
use 4xx. If the client can't do anything about it, use 5xx.

---

## Headers Deep Dive

### Content-Type

Tells the recipient what format the body is in.

```
Content-Type: application/json
Content-Type: text/html; charset=utf-8
Content-Type: multipart/form-data; boundary=----abc123
Content-Type: application/x-www-form-urlencoded
```

The format is `type/subtype`, optionally followed by parameters. The most common ones
you'll deal with in API development:

- `application/json` -- JSON. The bread and butter of modern APIs.
- `application/x-www-form-urlencoded` -- HTML form data. Key=value pairs like
  `name=Ada&age=36`.
- `multipart/form-data` -- File uploads. Each part has its own content type.
- `text/plain` -- Plain text. For logs, simple responses.

**Why this matters:** If a client sends JSON but forgets to set
`Content-Type: application/json`, your Express `express.json()` middleware won't
parse the body. The body will be `undefined`, and you'll spend an hour debugging
before noticing the missing header.

### Accept

Tells the server what format the client *wants* the response in.

```
Accept: application/json
Accept: text/html, application/json;q=0.9, */*;q=0.8
```

The `q` parameter is a quality factor (0 to 1) indicating preference. The second
example says: "I prefer HTML, but JSON is fine (0.9 weight), and I'll take anything
as a last resort (0.8 weight)."

Most API clients just send `Accept: application/json` and call it a day.

### Content-Length

Tells how many bytes are in the body. Critical for the parser to know when the body
ends.

```
Content-Length: 23
```

If you're using a framework, this is set automatically. If you're writing raw HTTP
(which we're about to do), get this wrong and things break silently.

### Connection

```
Connection: keep-alive
Connection: close
```

In HTTP/1.0, every request opened a new TCP connection, did one exchange, and closed
it. TCP connection setup takes time (the three-way handshake), so HTTP/1.1 defaults
to `keep-alive` -- reuse the connection for multiple requests. `close` tells the
server "I'm done after this request, close the connection."

### Host

```
Host: myapp.com
```

Required in HTTP/1.1. One server (one IP address) can host multiple websites
(virtual hosting). The `Host` header tells it which website you want. Without this
header, the server doesn't know which site to serve.

### Authorization

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Authorization: Basic YWRtaW46cGFzc3dvcmQ=
```

Carries authentication credentials. The `Bearer` scheme is used with tokens (JWT,
OAuth). The `Basic` scheme is base64-encoded `username:password` (not encrypted --
never use without HTTPS).

### Custom Headers

Convention: prefix with `X-` (though this convention is deprecated, it's still
widely used):

```
X-Request-Id: abc-123-def
X-RateLimit-Remaining: 42
```

---

## HTTP/1.1 vs HTTP/2: What Changed and Why

HTTP/1.1 has a fundamental performance problem: **head-of-line blocking**. On a
single connection, requests are processed sequentially. If request A takes 5 seconds,
requests B and C wait behind it.

Browsers worked around this by opening 6 parallel connections per domain. But that's
a hack.

### HTTP/2 Key Changes

1. **Binary framing.** Messages are encoded in binary, not text. More efficient to
   parse, but you can't read them with your eyes anymore.

2. **Multiplexing.** Multiple requests and responses travel over a single connection
   simultaneously, interleaved as frames. No more head-of-line blocking at the HTTP
   level.

3. **Header compression (HPACK).** HTTP/1.1 headers are verbose and repetitive.
   HTTP/2 compresses them, often reducing header size by 85-95%.

4. **Server push.** The server can proactively send resources it thinks the client
   will need. (In practice, this feature is rarely used and Chrome has removed
   support for it.)

5. **Stream prioritization.** The client can tell the server which resources are most
   important.

### What This Means for You as a Backend Developer

Mostly nothing, at first. HTTP/2 is handled by your reverse proxy (Nginx, Cloudflare)
or Node.js's `http2` module. Your Express code looks identical. But understanding
the differences helps you:

- Make better performance decisions (HTTP/2 makes domain sharding counterproductive)
- Debug network issues (HTTP/2 errors look different in dev tools)
- Understand why certain optimizations exist

For this course, we'll use HTTP/1.1 because it's human-readable and easier to learn
from. Everything we build works over HTTP/2 without changes.

---

## Building a Raw TCP Server That Speaks HTTP

Now for the fun part. We're going to build an HTTP server using only Node.js's `net`
module -- the raw TCP layer. No `http` module, no Express. Just TCP sockets and
string manipulation.

This is deliberately painful. You're supposed to think "wow, I don't want to do this
by hand." That's the point -- it will make you appreciate what `http.createServer()`
does for you.

### Step 1: A Basic TCP Server

```typescript
// 01-tcp-server.ts
import * as net from "net";

const server = net.createServer((socket) => {
  console.log("Client connected from", socket.remoteAddress);

  socket.on("data", (data) => {
    // 'data' is a Buffer -- raw bytes
    console.log("Received bytes:", data);
    console.log("As text:", data.toString("utf-8"));
  });

  socket.on("end", () => {
    console.log("Client disconnected");
  });
});

server.listen(3000, () => {
  console.log("TCP server listening on port 3000");
});
```

Run it with `npx tsx 01-tcp-server.ts`, then in another terminal:

```bash
curl http://localhost:3000/hello
```

You'll see the raw HTTP request that curl sent:

```
GET /hello HTTP/1.1
Host: localhost:3000
User-Agent: curl/8.1.2
Accept: */*
```

That's just text! curl formatted a text message according to the HTTP protocol and
sent it over TCP. Our server received the raw bytes.

### Step 2: Parse the HTTP Request

Now let's actually parse that text into something usable:

```typescript
// 02-parse-request.ts
import * as net from "net";

interface HttpRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: string;
}

function parseHttpRequest(raw: string): HttpRequest {
  // Split headers from body -- they're separated by \r\n\r\n
  const [headerSection, body = ""] = raw.split("\r\n\r\n");

  // Split into individual lines
  const lines = headerSection.split("\r\n");

  // First line is the request line
  const [method, path, httpVersion] = lines[0].split(" ");

  // Remaining lines are headers
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIndex = lines[i].indexOf(":");
    if (colonIndex === -1) continue;
    const key = lines[i].substring(0, colonIndex).trim().toLowerCase();
    const value = lines[i].substring(colonIndex + 1).trim();
    headers[key] = value;
  }

  return { method, path, httpVersion, headers, body };
}

const server = net.createServer((socket) => {
  socket.on("data", (data) => {
    const raw = data.toString("utf-8");
    const request = parseHttpRequest(raw);

    console.log("Method:", request.method);
    console.log("Path:", request.path);
    console.log("Headers:", request.headers);
    console.log("Body:", request.body);

    // We're not responding yet -- curl will hang. That's fine for now.
    socket.end();
  });
});

server.listen(3000, () => {
  console.log("Listening on :3000");
});
```

### Step 3: Send an HTTP Response

An HTTP response is just text too. Let's format and send one:

```typescript
// 03-http-response.ts
import * as net from "net";

interface HttpRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: string;
}

function parseHttpRequest(raw: string): HttpRequest {
  const [headerSection, body = ""] = raw.split("\r\n\r\n");
  const lines = headerSection.split("\r\n");
  const [method, path, httpVersion] = lines[0].split(" ");

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIndex = lines[i].indexOf(":");
    if (colonIndex === -1) continue;
    const key = lines[i].substring(0, colonIndex).trim().toLowerCase();
    const value = lines[i].substring(colonIndex + 1).trim();
    headers[key] = value;
  }

  return { method, path, httpVersion, headers, body };
}

function buildHttpResponse(
  statusCode: number,
  statusText: string,
  headers: Record<string, string>,
  body: string
): string {
  let response = `HTTP/1.1 ${statusCode} ${statusText}\r\n`;

  // Add Content-Length automatically
  const bodyBytes = Buffer.byteLength(body, "utf-8");
  headers["Content-Length"] = String(bodyBytes);

  for (const [key, value] of Object.entries(headers)) {
    response += `${key}: ${value}\r\n`;
  }

  response += "\r\n"; // Empty line between headers and body
  response += body;

  return response;
}

const server = net.createServer((socket) => {
  socket.on("data", (data) => {
    const request = parseHttpRequest(data.toString("utf-8"));
    console.log(`${request.method} ${request.path}`);

    // Simple routing
    let statusCode: number;
    let statusText: string;
    let responseBody: string;
    const responseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Powered-By": "raw-tcp",
    };

    if (request.path === "/hello" && request.method === "GET") {
      statusCode = 200;
      statusText = "OK";
      responseBody = JSON.stringify({ message: "Hello from raw TCP!" });
    } else if (request.path === "/echo" && request.method === "POST") {
      statusCode = 200;
      statusText = "OK";
      responseBody = JSON.stringify({
        youSent: request.body,
        method: request.method,
        headers: request.headers,
      });
    } else if (request.path === "/") {
      statusCode = 200;
      statusText = "OK";
      responseBody = JSON.stringify({
        endpoints: ["/hello", "/echo"],
      });
    } else {
      statusCode = 404;
      statusText = "Not Found";
      responseBody = JSON.stringify({
        error: `Cannot ${request.method} ${request.path}`,
      });
    }

    const response = buildHttpResponse(
      statusCode,
      statusText,
      responseHeaders,
      responseBody
    );

    console.log("Sending response:");
    console.log(response);

    socket.write(response);
    socket.end();
  });
});

server.listen(3000, () => {
  console.log("HTTP-over-TCP server on :3000");
});
```

Test it:

```bash
curl -v http://localhost:3000/hello
```

The `-v` flag shows the full HTTP conversation:

```
> GET /hello HTTP/1.1
> Host: localhost:3000
> User-Agent: curl/8.1.2
> Accept: */*
>
< HTTP/1.1 200 OK
< Content-Type: application/json
< X-Powered-By: raw-tcp
< Content-Length: 35
<
{"message":"Hello from raw TCP!"}
```

You can see both sides of the conversation. The `>` lines are what curl sent. The
`<` lines are what our server sent back. Text in, text out.

### Step 4: Seeing the Actual Bytes

Let's add hex output to see what's really on the wire:

```typescript
// 04-show-bytes.ts
import * as net from "net";

const server = net.createServer((socket) => {
  socket.on("data", (data) => {
    // Show the raw bytes in hex
    console.log("=== RAW BYTES (hex) ===");
    const hex = data.toString("hex");
    for (let i = 0; i < hex.length; i += 32) {
      const hexChunk = hex.substring(i, i + 32);
      const offset = i / 2;

      // Format: offset  hex bytes  ascii
      const hexFormatted = hexChunk.match(/../g)?.join(" ") ?? "";
      const asciiChars = data
        .subarray(offset, offset + 16)
        .toString("utf-8")
        .replace(/[^\x20-\x7e]/g, ".");

      console.log(
        `${offset.toString(16).padStart(4, "0")}  ${hexFormatted.padEnd(48)}  ${asciiChars}`
      );
    }

    console.log("\n=== AS TEXT ===");
    console.log(data.toString("utf-8"));

    // Send a minimal valid response
    const body = "Hello!";
    const response =
      `HTTP/1.1 200 OK\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `\r\n` +
      body;

    socket.write(response);
    socket.end();
  });
});

server.listen(3000, () => {
  console.log("Byte-inspector server on :3000");
});
```

Output looks like:

```
=== RAW BYTES (hex) ===
0000  47 45 54 20 2f 68 65 6c 6c 6f 20 48 54 54 50 2f  GET /hello HTTP/
0010  31 2e 31 0d 0a 48 6f 73 74 3a 20 6c 6f 63 61 6c  1.1..Host: local
0020  68 6f 73 74 3a 33 30 30 30 0d 0a ...              host:3000..
```

See the `0d 0a` bytes? That's `\r\n` -- carriage return (0x0D) and line feed (0x0A).
The HTTP line terminator, visible in raw hex.

---

## What Our Raw Server Gets Wrong

Our implementation has serious bugs that a real HTTP server handles:

### 1. We Assume the Entire Request Arrives in One Chunk

TCP is a **stream** protocol. It guarantees bytes arrive in order, but NOT that they
arrive all at once. A request might arrive as:

```
Chunk 1: "GET /hel"
Chunk 2: "lo HTTP/1.1\r\nHost: "
Chunk 3: "localhost:3000\r\n\r\n"
```

Our code would try to parse "GET /hel" as a complete request and fail. A real HTTP
parser buffers incoming data and only parses once it has a complete message.

### 2. We Don't Handle Keep-Alive Properly

With `Connection: keep-alive`, multiple requests can arrive on the same socket. Our
code closes the socket after one response. A real server would keep listening for
more requests on the same connection.

### 3. We Don't Handle Large Bodies

We read the entire body into memory. A real server would stream large bodies to disk
or process them in chunks. A malicious client could send a 10GB body and crash our
server.

### 4. No Timeout Handling

A client could connect and never send data. Our server would hold the socket open
forever, leaking resources.

### 5. No Concurrent Connection Handling

Actually, Node.js handles this for us with its event loop -- `net.createServer`
handles multiple connections out of the box. But in languages without an event loop,
you'd need threads or `select`/`epoll`.

This is exactly why Node's `http` module exists -- it handles all of these edge cases.
And that's what we'll explore in the next lesson.

---

## Key Takeaways

1. HTTP is a text protocol. Requests and responses are formatted text over TCP.
2. Every HTTP message has the same structure: start line, headers, blank line, body.
3. Methods (GET, POST, etc.) convey intent and have important properties (safe,
   idempotent).
4. Status codes tell the client what happened. 2xx = good, 4xx = client's fault,
   5xx = server's fault.
5. Headers are metadata. `Content-Type`, `Content-Length`, `Host`, and `Accept` are
   the most important ones to understand.
6. HTTP/2 is binary and multiplexed, but your application code doesn't change.
7. Building HTTP from raw TCP is educational but impractical -- too many edge cases.

---

## Exercises

### Exercise 1: Extend the Raw TCP Server

Add two new endpoints to the raw TCP server from Step 3:

- `GET /time` -- returns the current UTC time as JSON: `{"utc": "2024-01-15T10:30:00.000Z"}`
- `GET /headers` -- echoes back all request headers the client sent

Test with `curl -v`.

### Exercise 2: Status Code Quiz

For each scenario, what's the correct status code? Don't look at the table -- reason
from first principles.

1. Client requests `GET /users/999` but user 999 doesn't exist
2. Client sends `POST /users` with `{"name": ""}` (name is required)
3. Client sends `DELETE /users/5` successfully
4. Client sends `GET /admin` without an auth token
5. Client sends `POST /users` with `{"email": "already@used.com"}` (duplicate)
6. Client sends `PATCH /users/5` but the endpoint only supports GET and DELETE
7. Server crashes due to an unhandled exception in the handler

### Exercise 3: Parse a Raw HTTP Response

Given this raw HTTP response, identify all its components (status line parts,
each header's purpose, body). Explain what the server is telling the client.

```
HTTP/1.1 301 Moved Permanently\r\n
Location: https://example.com/new-path\r\n
Content-Type: text/html\r\n
Content-Length: 0\r\n
Cache-Control: max-age=3600\r\n
\r\n
```

### Exercise 4: Spot the Bugs

This HTTP request has multiple problems. Find all of them:

```
get /api/users HTTP/1.1
Content-Type=application/json
content-length: 15

{"name": "Ada"}
```

(Hints: look at the method casing, header format, content-length value, line endings,
and missing required headers.)

### Exercise 5: Build a Request Logger

Modify the raw TCP server to log every request in this format:

```
[2024-01-15T10:30:00.000Z] GET /hello 200 35B 2ms
```

Where the fields are: timestamp, method, path, status code, response body size,
and time taken to generate the response. You'll need to measure time with
`performance.now()` or `Date.now()`.
