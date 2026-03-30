# Project 2: SpeechForge — Production Text-to-Speech Service at Scale

## Context

This is the capstone project. It synthesizes every skill from the entire course — HTTP APIs, authentication, PostgreSQL, WebSockets, background jobs, Redis caching, and production engineering — into a single coherent system that solves a real, hard problem.

SpeechForge is based on a production TTS (text-to-speech) service built for an article reader app with **25,000 daily active users**. The problem is real and the constraints are real. If you have ever read a long-form article on your phone with headphones in while the app read it to you, you have used something like this.

### The Problem with Naive TTS

A naive implementation looks like this:

```
POST /tts/generate
  → call TTS API with full article text
  → wait 30 seconds
  → return audio buffer
```

This approach fails in every dimension at scale:

**Cost**: A TTS API charges per character. An average article is 5,000 characters. At $0.000016 per character (ElevenLabs pricing), that is $0.08 per article. With 25,000 DAU each reading 1.5 articles per day, that is $3,000 per month — for reads. The same article read by 100 users costs $8.00. With caching, it costs $0.08 once, then $0.00 for the next 99 users. That is a **100x cost reduction** from a correct cache implementation.

**Latency**: TTS APIs are slow. A 5,000-character article takes 25-30 seconds to synthesize end-to-end. A user will not wait 30 seconds before audio starts. They will close the app. The correct solution is to chunk the article, synthesize chunks in parallel, and stream the first chunk to the user within 2-3 seconds.

**Mobile Safari**: Concatenating raw MP3 buffers produces files that Mobile Safari (iOS WebKit) cannot seek or play correctly. The cause is the VBR (variable bitrate) header — specifically the Xing header — which must be present at the start of the file and must accurately describe the total frame count and byte count. When you concatenate chunks, this header is absent or wrong, so iOS refuses to play the file. Fixing this requires parsing MPEG frames from scratch.

**Concurrency storms**: Without bounded concurrency, 100 simultaneous users requesting the same uncached article would fire 100 TTS API calls for the same content, spending $8.00 instead of $0.08, and potentially hitting API rate limits. In-flight deduplication — where the second through hundredth request all wait on the result of the first request — solves this.

---

## What You Are Building

A production-grade TTS backend service that handles all of the above:

### 1. Text Processing Pipeline

- **HTML cleaning**: Articles come from web scraping and contain UI artifacts — "Skip Advertisement", "Share on Twitter", "Cookie Consent", navigation labels, author bylines. These must be stripped before synthesis. Synthesizing "Like this article? Subscribe to our newsletter!" costs money and ruins the listening experience.
- **Semantic chunking**: Chunk the cleaned text into segments of approximately 1,800 characters each. Never break mid-sentence. Respect sentence boundaries (`.`, `!`, `?` followed by whitespace). If a single sentence exceeds 1,800 characters, force-split on a word boundary.
- **Chunk fingerprinting**: Each chunk is identified by `SHA-256("v3" + text + voiceId)`. The version prefix (`v3`) allows cache invalidation when the chunking algorithm changes — bump the version, all cached audio is regenerated.

### 2. Three-Tier Cache Architecture

**Tier 1 — Per-chunk cache (Redis, 1-hour TTL)**
- Key: `chunk:{sha256}`
- Value: `{ audio: base64, duration: number, alignment: CharAlignment[] }`
- Rationale: the same sentence appears in many articles and many users' articles ("The White House said on Monday that..."). Cache at the chunk level, not the article level, to maximize hit rate.

**Tier 2 — Per-article cache (Redis, 2-hour TTL)**
- Key: `article:{sha256(fullText + voiceId)}`
- Value: `{ audio: base64, duration: number, wordAlignments: WordAlignment[] }`
- Rationale: the full assembled audio with merged word alignments, ready to serve. Second request for the same article is served in under 10ms.

**Tier 3 — In-flight request deduplication (in-memory Map)**
- Key: same as tier-1 or tier-2 key
- Value: `Promise<Result>` — the in-flight synthesis request
- Rationale: prevents a thundering herd. When 50 users simultaneously request the same uncached article, only 1 TTS API call is made. The other 49 await the same Promise.

### 3. Bounded Concurrency

The TTS API has rate limits and cost implications. You must limit concurrent synthesis calls.

- **Global semaphore**: maximum 10 concurrent TTS API calls across all users
- **Per-user semaphore**: maximum 3 concurrent TTS API calls per userId
- **AbortSignal propagation**: if the user's HTTP request is aborted (they navigated away), cancel the semaphore wait and the in-flight TTS API call

### 4. Streaming Delivery via WebSocket

Users should start hearing audio within 3 seconds, not 30. Implement a WebSocket endpoint that streams progress events as chunks complete synthesis:

```json
{ "type": "chunk_ready", "chunkIndex": 0, "totalChunks": 4, "chunkKey": "chunk:abc123" }
{ "type": "chunk_ready", "chunkIndex": 1, "totalChunks": 4, "chunkKey": "chunk:def456" }
{ "type": "complete", "audioUrl": "/tts/audio/article:xyz", "wordAlignments": [...], "totalDuration": 187.4 }
```

The client fetches and plays each chunk audio as it arrives, giving the illusion of real-time playback. The user hears the first sentence while the last one is still being synthesized.

### 5. Word-Level Alignment

TTS APIs return character-level timestamps: `[{ char: 'H', startMs: 0, endMs: 45 }, { char: 'e', startMs: 46, endMs: 82 }, ...]`

You must:
1. Convert character timestamps to **word timestamps** (group non-whitespace characters into words)
2. Handle **repeated words** correctly: in "the cat sat on the mat", the second "the" must not be mapped to the first "the"'s timestamps. Use a forward-scanning algorithm that tracks `lastMatchedPosition`.
3. Merge word alignments **across chunks**: each chunk's timestamps are relative to the start of that chunk. Add the cumulative duration of all preceding chunks (computed from frame-accurate MPEG frame counting, not the API's reported duration) to get absolute timestamps in the full audio.

### 6. MP3 Processing

This is the iOS Safari fix. You need to implement an MPEG frame parser.

- **Strip ID3v2 tags**: check for `"ID3"` magic bytes at offset 0 and skip the tag block
- **Strip Xing/VBRI headers**: the first MPEG frame of a VBR file contains a Xing or VBRI frame instead of audio data; skip it
- **Count MPEG frames**: iterate through every frame in each chunk buffer, computing exact frame lengths from the header bits (bitrate, sample rate, padding bit). Sum the frames for accurate duration.
- **Generate Xing VBR header**: for the concatenated output, create a new, correct Xing header frame containing the accurate total frame count, total byte count, and TOC (table of contents, 100 evenly-spaced seek points)
- **Concatenate correctly**: strip metadata from each chunk → concat raw MPEG frames → prepend new Xing header → return complete, iOS-safe buffer

### 7. Memory Management

Node.js processes handling large audio buffers can accumulate memory unexpectedly. You must:
- Track RSS memory every 30 seconds
- Alert (log a warning) if heap grows by more than 20MB between snapshots
- Alert if RSS spikes by more than 400MB in a 30-second window (sign of a buffer leak)
- Log a critical error if RSS exceeds 1.5GB
- Issue explicit GC hints (`if (global.gc) global.gc()`) after processing large buffers

---

## Technical Constraints

- **Language**: TypeScript, Node.js
- **Framework**: Express for HTTP; `ws` library for WebSockets
- **Cache storage**: Redis (via `ioredis`) for chunk and article caches
- **TTS provider**: configurable via environment variable; primary implementation uses Inworld AI or ElevenLabs; a mock implementation must exist for tests
- **No external MP3 library**: implement MPEG frame parsing manually. The point is to understand the binary format.
- **No external chunking library**: implement semantic text splitting manually.

---

## Acceptance Criteria

1. **Cache hit speed**: The second request for the same article (same voice) is served from the article-level Redis cache in under **10ms** (measure with `Date.now()` or a timer middleware).

2. **In-flight deduplication**: Send 100 concurrent HTTP requests for the same uncached article. The TTS API should be called exactly **N times** where N is the number of chunks (not 100×N). Verify by counting API calls in the mock provider.

3. **iOS Safari compatibility**: The generated MP3 file plays correctly on iOS Safari with correct seek behavior. If you do not have an iPhone, verify with `ffprobe` that the Xing header is present and correct: `ffprobe -v quiet -print_format json -show_format output.mp3` should show correct `duration` and `size`.

4. **Streaming latency**: The first `chunk_ready` WebSocket event is emitted within **3 seconds** of connecting. (Measure against a mock TTS provider with a 1-second simulated delay per chunk.)

5. **Word alignment correctness**: In a 3-chunk article containing the phrase "the", word alignment timestamps for the second and third occurrences of "the" are not identical to the first occurrence. The forward-scan algorithm handles repeated words.

6. **Cross-chunk alignment offsets**: Word alignments in chunk 2 have `startMs` values greater than chunk 1's total duration. The offset is applied correctly.

7. **Memory stability**: Process a 10,000-character article 1,000 times in a loop. RSS does not grow unboundedly. After each batch of 100, RSS is within 50MB of its baseline (GC is running between batches).

8. **Semaphore enforcement**: With a global semaphore of 10, fire 50 concurrent synthesis requests. At any point in time, no more than 10 TTS API calls are executing simultaneously. Verify with a mock provider that records concurrency high-water marks.

---

## Skills from This Course That This Project Uses

| Course Module | How It Appears in SpeechForge |
|---|---|
| **01 HTTP and REST** | Express routes, request validation, proper status codes, redirect for cache hits |
| **02 Authentication** | JWT middleware on all TTS endpoints; per-user semaphores keyed by userId |
| **03 PostgreSQL** | Optional: store job history, voice preferences, usage statistics |
| **04 ORMs** | Optional: job/request log with Prisma |
| **05 WebSockets** | Streaming chunk_ready events to the client during synthesis |
| **06 Cron and Background Jobs** | Optional: pre-warm popular articles' TTS cache overnight |
| **07 Redis** | Chunk cache, article cache, in-flight dedup (in-memory), TTL management |
| **08 Scaling** | Semaphore concurrency control, in-flight dedup (thundering herd), memory management |
| **09 Capstone** | MP3 binary processing, word alignment, semantic text chunking — the hard parts |
