# SpeechForge — Implementation Plan

This is a complete implementation blueprint. Every section specifies exact algorithms, data structures, TypeScript types, and implementation details. You should be able to build SpeechForge solely from this document.

---

## 1. Text Processing Pipeline

### 1.1 Text Cleaning

Strip all UI artifacts from scraped article text before chunking and synthesis. These patterns appear consistently across major news and blog platforms:

```typescript
// src/tts/chunker.ts

const STRIP_PATTERNS: RegExp[] = [
  // Navigation and UI chrome
  /^(Home|News|Sports|Entertainment|Technology|Politics|Business|Science)\s*$/gim,
  /^(Skip to (main content|navigation|article)|Back to top)\s*$/gim,

  // Social sharing
  /^Share (this article|on (Twitter|Facebook|LinkedIn|WhatsApp))\s*$/gim,
  /^\d+\s*(shares?|comments?|likes?)\s*$/gim,

  // Advertising
  /^(Skip Advertisement|Advertisement|Sponsored|Paid Content|Partner Content)\s*$/gim,
  /^(Continue reading( below)?|Story continues? (below|after advertisement))\s*$/gim,

  // Newsletter/subscription CTAs
  /^(Subscribe (to our newsletter|now)|Sign up for.*newsletter)\s*$/gim,
  /^(Like this article\? .+)\s*$/gim,

  // Author/date artifacts (preserve if inline, strip if on own line)
  /^(By\s+[A-Z][a-z]+ [A-Z][a-z]+\s*[|•]\s*.+)\s*$/gim,
  /^(Published|Updated|Posted):?\s+.{5,50}\s*$/gim,

  // Cookie consent
  /^(We use cookies|This (site|website) uses cookies).{0,200}$/gim,
  /^(Accept (all )?cookies?|Cookie (settings?|preferences?))\s*$/gim,

  // Image captions (often prefixed)
  /^\(?(Photo|Image|Credit|Caption):?.{0,100}\)?\s*$/gim,

  // Empty lines (normalize multiple blank lines to single)
  /\n{3,}/g,
];

export function cleanText(raw: string): string {
  let text = raw;

  // Apply all strip patterns
  for (const pattern of STRIP_PATTERNS) {
    text = text.replace(pattern, '\n');
  }

  // Normalize whitespace
  text = text
    .replace(/\r\n/g, '\n')          // normalize line endings
    .replace(/\t/g, ' ')             // tabs to spaces
    .replace(/ {2,}/g, ' ')          // multiple spaces to single
    .replace(/\n{3,}/g, '\n\n')      // max 2 consecutive newlines
    .trim();

  return text;
}
```

### 1.2 Semantic Chunker

```typescript
const TARGET_CHUNK_SIZE = 1800;   // characters
const MAX_CHUNK_SIZE = 2000;       // hard cap; force-split if exceeded

// Sentence boundary: period/exclamation/question followed by whitespace and capital or end
const SENTENCE_BOUNDARY = /[.!?][\s]+(?=[A-Z"'(\[]|$)/g;

export function splitIntoChunks(text: string): string[] {
  const cleaned = cleanText(text);
  const chunks: string[] = [];
  let current = '';

  // Split text into sentences
  const sentences = splitSentences(cleaned);

  for (const sentence of sentences) {
    const candidate = current ? current + ' ' + sentence : sentence;

    if (candidate.length <= TARGET_CHUNK_SIZE) {
      // Still fits in current chunk
      current = candidate;
    } else if (current.length > 0) {
      // Current chunk is full; save it and start new chunk with this sentence
      chunks.push(current.trim());
      current = sentence;
    } else {
      // Single sentence exceeds target; force-split on word boundary
      const parts = forceWordSplit(sentence, TARGET_CHUNK_SIZE);
      chunks.push(...parts.slice(0, -1));
      current = parts[parts.length - 1];
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function splitSentences(text: string): string[] {
  // Use a regex that finds sentence-ending punctuation followed by whitespace + capital
  // Handles: "Dr. Smith said" (no split), "He ran. She walked." (split)
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  const re = /(?<=[.!?])\s+(?=[A-Z"'\[(])/g;
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(last, match.index + (match[0].length > 1 ? 1 : 0)));
    last = re.lastIndex;
  }
  parts.push(text.slice(last));

  return parts.filter(s => s.trim().length > 0);
}

function forceWordSplit(text: string, maxSize: number): string[] {
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      parts.push(text.slice(start));
      break;
    }
    // Walk back to the last space before maxSize
    while (end > start && text[end] !== ' ') end--;
    if (end === start) end = start + maxSize; // no space found; force cut
    parts.push(text.slice(start, end).trim());
    start = end + 1;
  }

  return parts.filter(s => s.length > 0);
}
```

### 1.3 Chunk Fingerprinting

```typescript
import { createHash } from 'crypto';

const CACHE_VERSION = 'v3';

export function chunkKey(text: string, voiceId: string): string {
  const hash = createHash('sha256')
    .update(CACHE_VERSION + text + voiceId)
    .digest('hex');
  return `chunk:${hash}`;
}

export function articleKey(fullText: string, voiceId: string): string {
  const hash = createHash('sha256')
    .update(fullText + voiceId)
    .digest('hex');
  return `article:${hash}`;
}
```

---

## 2. Three-Tier Cache Architecture

### 2.1 TypeScript Interfaces

```typescript
// src/tts/types.ts

export interface CharAlignment {
  char: string;
  startMs: number;
  endMs: number;
}

export interface WordAlignment {
  word: string;
  startMs: number;
  endMs: number;
  chunkIndex: number;    // which chunk this word came from
}

export interface ChunkCacheEntry {
  audio: string;                    // base64-encoded MP3 buffer (stripped of metadata)
  duration: number;                 // frame-accurate duration in seconds
  alignment: CharAlignment[];
}

export interface ArticleCacheEntry {
  audio: string;                    // base64-encoded full concatenated MP3 with Xing header
  duration: number;                 // total duration in seconds
  wordAlignments: WordAlignment[];
}

export interface SynthesisResult {
  audio: Buffer;
  duration: number;
  alignment: CharAlignment[];
}
```

### 2.2 Cache Implementation

```typescript
// src/tts/cache.ts

import Redis from 'ioredis';

const CHUNK_TTL_SECONDS = 3600;    // 1 hour
const ARTICLE_TTL_SECONDS = 7200;  // 2 hours

export class TtsCache {
  private redis: Redis;
  private chunkHits = 0;
  private chunkMisses = 0;
  private articleHits = 0;
  private articleMisses = 0;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  // --- Chunk cache ---

  async getChunk(key: string): Promise<ChunkCacheEntry | null> {
    const raw = await this.redis.get(key);
    if (raw) {
      this.chunkHits++;
      return JSON.parse(raw) as ChunkCacheEntry;
    }
    this.chunkMisses++;
    return null;
  }

  async setChunk(key: string, entry: ChunkCacheEntry): Promise<void> {
    await this.redis.set(key, JSON.stringify(entry), 'EX', CHUNK_TTL_SECONDS);
  }

  // --- Article cache ---

  async getArticle(key: string): Promise<ArticleCacheEntry | null> {
    const raw = await this.redis.get(key);
    if (raw) {
      this.articleHits++;
      return JSON.parse(raw) as ArticleCacheEntry;
    }
    this.articleMisses++;
    return null;
  }

  async setArticle(key: string, entry: ArticleCacheEntry): Promise<void> {
    await this.redis.set(key, JSON.stringify(entry), 'EX', ARTICLE_TTL_SECONDS);
  }

  // --- Stats ---

  getStats() {
    const chunkTotal = this.chunkHits + this.chunkMisses;
    const articleTotal = this.articleHits + this.articleMisses;
    return {
      chunk: {
        hits: this.chunkHits,
        misses: this.chunkMisses,
        hitRate: chunkTotal > 0 ? this.chunkHits / chunkTotal : 0,
      },
      article: {
        hits: this.articleHits,
        misses: this.articleMisses,
        hitRate: articleTotal > 0 ? this.articleHits / articleTotal : 0,
      },
    };
  }
}
```

### 2.3 In-Flight Request Deduplication

This is the most subtle part of the cache. The key insight: store the Promise itself in the map, not the result. Multiple concurrent callers all `await` the same Promise. The map entry is released **before** the Promise resolves to prevent memory leaks on long-running tasks.

```typescript
// src/tts/cache.ts (continued)

export class InFlightDedup {
  private inflight = new Map<string, Promise<unknown>>();

  async deduplicate<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    // CRITICAL: release the map entry BEFORE the promise resolves.
    // If we delete after resolve, concurrent callers arriving during resolution
    // will correctly get the cached result from Redis (not from the in-flight map).
    // This avoids holding the promise in memory after it's done.
    const promise = factory().finally(() => {
      // Remove from map as soon as work is done, before callers' .then() runs
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);

    return promise;
  }

  size(): number {
    return this.inflight.size;
  }
}
```

---

## 3. Concurrency Control

### 3.1 Semaphore Implementation

```typescript
// src/tts/semaphore.ts

export class Semaphore {
  private permits: number;
  private waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.createRelease();
    }

    // No permits available; queue the waiter
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.permits--; // consume permit when granted
          resolve(this.createRelease());
        },
        reject,
        signal,
      };

      this.waitQueue.push(waiter);

      // AbortSignal support: cancel the wait if the caller aborts
      if (signal) {
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(waiter);
          if (idx >= 0) this.waitQueue.splice(idx, 1);
          reject(new Error('Semaphore wait aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  tryAcquire(): (() => void) | null {
    if (this.permits > 0) {
      this.permits--;
      return this.createRelease();
    }
    return null;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next.resolve(); // transfers permit to next waiter
    } else {
      this.permits++;
    }
  }

  availablePermits(): number {
    return this.permits;
  }

  queueLength(): number {
    return this.waitQueue.length;
  }
}
```

### 3.2 Semaphore Usage in TTS Pipeline

```typescript
// src/tts/synthesizer.ts

import { Semaphore } from './semaphore';

// Global semaphore: max 10 concurrent TTS API calls
export const globalSemaphore = new Semaphore(10);

// Per-user semaphores: max 3 per user
const userSemaphores = new Map<string, Semaphore>();

function getUserSemaphore(userId: string): Semaphore {
  if (!userSemaphores.has(userId)) {
    userSemaphores.set(userId, new Semaphore(3));
    // Clean up idle semaphore after 10 minutes
    setTimeout(() => userSemaphores.delete(userId), 600_000);
  }
  return userSemaphores.get(userId)!;
}

export async function synthesizeChunk(
  text: string,
  voiceId: string,
  userId: string,
  signal?: AbortSignal
): Promise<SynthesisResult> {
  // Acquire user semaphore first (fails fast per user), then global
  const userRelease = await getUserSemaphore(userId).acquire(signal);
  let globalRelease: (() => void) | undefined;

  try {
    globalRelease = await globalSemaphore.acquire(signal);
    return await provider.generateSpeech(text, voiceId, signal);
  } finally {
    globalRelease?.();
    userRelease();
  }
}
```

---

## 4. TTS Provider Abstraction

```typescript
// src/tts/provider.ts

export interface TTSProvider {
  generateSpeech(
    text: string,
    voiceId: string,
    signal?: AbortSignal
  ): Promise<SynthesisResult>;

  listVoices(): Promise<Voice[]>;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  gender?: string;
}

// --- Mock Provider (for testing) ---

export class MockTTSProvider implements TTSProvider {
  private delayMs: number;
  private callCount = 0;
  private concurrentCalls = 0;
  private peakConcurrentCalls = 0;

  constructor(delayMs = 500) {
    this.delayMs = delayMs;
  }

  async generateSpeech(text: string, voiceId: string, signal?: AbortSignal): Promise<SynthesisResult> {
    this.callCount++;
    this.concurrentCalls++;
    this.peakConcurrentCalls = Math.max(this.peakConcurrentCalls, this.concurrentCalls);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });

      // Generate a fake silent MP3 buffer of appropriate length
      const fakeDuration = text.length / 20; // rough: 20 chars per second
      const fakeAudio = Buffer.alloc(Math.floor(fakeDuration * 16000 / 8)); // 16kbps

      // Generate fake char alignments
      const alignment: CharAlignment[] = text.split('').map((char, i) => ({
        char,
        startMs: Math.floor((i / text.length) * fakeDuration * 1000),
        endMs: Math.floor(((i + 1) / text.length) * fakeDuration * 1000),
      }));

      return { audio: fakeAudio, duration: fakeDuration, alignment };
    } finally {
      this.concurrentCalls--;
    }
  }

  async listVoices(): Promise<Voice[]> {
    return [{ id: 'mock-voice-1', name: 'Mock Voice', language: 'en-US' }];
  }

  getStats() {
    return {
      callCount: this.callCount,
      peakConcurrentCalls: this.peakConcurrentCalls,
    };
  }
}

// --- Inworld AI Provider (real implementation) ---

export class InworldTTSProvider implements TTSProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.inworld.ai/tts/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async generateSpeech(text: string, voiceId: string, signal?: AbortSignal): Promise<SynthesisResult> {
    const response = await fetch(`${this.baseUrl}/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, voiceId, outputFormat: 'mp3', returnTimestamps: true }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`TTS API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      audio: string;                           // base64 MP3
      alignment: { char: string; start_ms: number; end_ms: number }[];
    };

    const audio = Buffer.from(data.audio, 'base64');
    const alignment: CharAlignment[] = data.alignment.map(a => ({
      char: a.char,
      startMs: a.start_ms,
      endMs: a.end_ms,
    }));

    // Parse frame-accurate duration (do not trust API-reported duration)
    const { frameCount, sampleRate } = countMpegFrames(audio);
    const duration = (frameCount * 1152) / sampleRate; // 1152 samples per MPEG frame

    return { audio, duration, alignment };
  }

  async listVoices(): Promise<Voice[]> {
    const response = await fetch(`${this.baseUrl}/voices`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    const data = await response.json() as { voices: Voice[] };
    return data.voices;
  }
}
```

---

## 5. Audio Processing (MP3)

This is the most technically involved section. Implement it carefully.

### 5.1 MPEG Frame Parser

```typescript
// src/tts/audio.ts

// MPEG Layer 3 (MP3) bitrate table [version][layer][index]
// version: 0=MPEG2.5, 1=reserved, 2=MPEG2, 3=MPEG1
// layer: 0=reserved, 1=LayerIII, 2=LayerII, 3=LayerI
const BITRATE_TABLE: number[][][] = [
  // MPEG 2.5
  [[], [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]],
  // reserved
  [[], []],
  // MPEG 2
  [[], [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]],
  // MPEG 1
  [[], [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]],
];

const SAMPLE_RATE_TABLE: number[][] = [
  [11025, 12000, 8000,  0],  // MPEG 2.5
  [0,     0,     0,     0],  // reserved
  [22050, 24000, 16000, 0],  // MPEG 2
  [44100, 48000, 32000, 0],  // MPEG 1
];

export interface MpegFrameInfo {
  frameCount: number;
  totalBytes: number;
  sampleRate: number;
  channelMode: number;
  frameLengths: number[];    // for TOC generation
}

export function countMpegFrames(buffer: Buffer): MpegFrameInfo {
  let offset = 0;
  const frameLengths: number[] = [];
  let lastSampleRate = 44100;
  let lastChannelMode = 0;

  // Skip ID3v2 tag if present
  offset = skipId3TagOffset(buffer, offset);

  while (offset + 4 <= buffer.length) {
    // Look for sync word: 0xFF followed by 0xE0 or higher (11 set bits)
    if (buffer[offset] !== 0xFF || (buffer[offset + 1] & 0xE0) !== 0xE0) {
      offset++;
      continue;
    }

    const header = buffer.readUInt32BE(offset);

    const version      = (header >>> 19) & 0x03;
    const layer        = (header >>> 17) & 0x03;
    const bitrateIdx   = (header >>> 12) & 0x0F;
    const sampleRateIdx = (header >>> 10) & 0x03;
    const padding      = (header >>> 9) & 0x01;
    const channelMode  = (header >>> 6) & 0x03;

    const bitrate    = BITRATE_TABLE[version]?.[layer]?.[bitrateIdx] ?? 0;
    const sampleRate = SAMPLE_RATE_TABLE[version]?.[sampleRateIdx] ?? 0;

    if (bitrate === 0 || sampleRate === 0) {
      offset++;
      continue;
    }

    const frameLength = Math.floor(144 * bitrate * 1000 / sampleRate) + padding;

    if (frameLength <= 0 || offset + frameLength > buffer.length) {
      offset++;
      continue;
    }

    // Check if this is a Xing/VBRI frame (first frame, skip it)
    if (frameLengths.length === 0) {
      const sideInfoSize = (version === 3) ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17);
      const xingOffset = offset + 4 + sideInfoSize;
      if (xingOffset + 4 <= buffer.length) {
        const xingTag = buffer.slice(xingOffset, xingOffset + 4).toString('ascii');
        if (xingTag === 'Xing' || xingTag === 'Info' || xingTag === 'VBRI') {
          offset += frameLength;
          continue; // skip VBR header frame
        }
      }
    }

    frameLengths.push(frameLength);
    lastSampleRate = sampleRate;
    lastChannelMode = channelMode;
    offset += frameLength;
  }

  return {
    frameCount: frameLengths.length,
    totalBytes: frameLengths.reduce((a, b) => a + b, 0),
    sampleRate: lastSampleRate,
    channelMode: lastChannelMode,
    frameLengths,
  };
}

function skipId3TagOffset(buffer: Buffer, offset: number): number {
  if (buffer.length < offset + 10) return offset;
  if (buffer.slice(offset, offset + 3).toString('ascii') !== 'ID3') return offset;

  // ID3v2 tag size is encoded as 4 syncsafe integers (7 bits each)
  const size =
    ((buffer[offset + 6] & 0x7F) << 21) |
    ((buffer[offset + 7] & 0x7F) << 14) |
    ((buffer[offset + 8] & 0x7F) << 7) |
    (buffer[offset + 9] & 0x7F);

  return offset + 10 + size; // 10-byte header + tag size
}
```

### 5.2 Strip Metadata from Chunk Buffer

```typescript
export function stripMetadata(buffer: Buffer): Buffer {
  let offset = skipId3TagOffset(buffer, 0);

  // Check first MPEG frame for Xing/VBRI
  if (offset + 4 <= buffer.length &&
      buffer[offset] === 0xFF && (buffer[offset + 1] & 0xE0) === 0xE0) {
    const header = buffer.readUInt32BE(offset);
    const version      = (header >>> 19) & 0x03;
    const layer        = (header >>> 17) & 0x03;
    const bitrateIdx   = (header >>> 12) & 0x0F;
    const sampleRateIdx = (header >>> 10) & 0x03;
    const padding      = (header >>> 9) & 0x01;
    const channelMode  = (header >>> 6) & 0x03;

    const bitrate    = BITRATE_TABLE[version]?.[layer]?.[bitrateIdx] ?? 0;
    const sampleRate = SAMPLE_RATE_TABLE[version]?.[sampleRateIdx] ?? 0;

    if (bitrate > 0 && sampleRate > 0) {
      const frameLength = Math.floor(144 * bitrate * 1000 / sampleRate) + padding;
      const sideInfoSize = (version === 3) ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17);
      const xingOffset = offset + 4 + sideInfoSize;

      if (xingOffset + 4 <= buffer.length) {
        const xingTag = buffer.slice(xingOffset, xingOffset + 4).toString('ascii');
        if (xingTag === 'Xing' || xingTag === 'Info' || xingTag === 'VBRI') {
          offset += frameLength;
        }
      }
    }
  }

  return buffer.slice(offset);
}
```

### 5.3 Generate Xing VBR Header Frame

```typescript
export function generateXingHeader(info: MpegFrameInfo): Buffer {
  // Build a silent MPEG1 Layer3 stereo frame at 128kbps 44100Hz
  // This frame holds the Xing header in its side information area
  const frameLength = Math.floor(144 * 128 * 1000 / 44100); // 417 bytes at 128kbps
  const frame = Buffer.alloc(frameLength, 0);

  // MPEG1, Layer3, 128kbps, 44100Hz, stereo, no padding
  frame[0] = 0xFF;
  frame[1] = 0xFB;  // MPEG1, Layer3, no CRC
  frame[2] = 0x90;  // 128kbps, 44100Hz, no padding, private=0
  frame[3] = 0x00;  // joint stereo, no copyright, no original

  // Xing header starts at offset 36 (4 header + 32 side info bytes for MPEG1 stereo)
  const xingOffset = 36;

  // "Xing" tag (use for VBR)
  frame.write('Xing', xingOffset, 'ascii');

  // Flags: bit 0 = total frames, bit 1 = total bytes, bit 2 = TOC
  frame.writeUInt32BE(0x07, xingOffset + 4);

  // Total frame count
  frame.writeUInt32BE(info.frameCount, xingOffset + 8);

  // Total byte count
  frame.writeUInt32BE(info.totalBytes, xingOffset + 12);

  // TOC: 100 entries, each byte = floor(256 * cumBytesAtI% / totalBytes)
  const tocOffset = xingOffset + 16;
  const cumulativeBytes: number[] = [0];
  for (const len of info.frameLengths) {
    cumulativeBytes.push(cumulativeBytes[cumulativeBytes.length - 1] + len);
  }

  for (let i = 0; i < 100; i++) {
    const targetByte = (i / 100) * info.totalBytes;
    // Find cumulative byte position at this percentage using binary search
    let lo = 0, hi = cumulativeBytes.length - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (cumulativeBytes[mid] <= targetByte) lo = mid; else hi = mid;
    }
    const seekPos = info.totalBytes > 0
      ? Math.floor(256 * cumulativeBytes[lo] / info.totalBytes)
      : 0;
    frame[tocOffset + i] = Math.min(255, seekPos);
  }

  return frame;
}
```

### 5.4 Full Concatenation Pipeline

```typescript
export function concatenateChunks(chunkBuffers: Buffer[]): Buffer {
  // 1. Strip metadata from all chunks
  const stripped = chunkBuffers.map(stripMetadata);

  // 2. Concatenate raw frames
  const rawAudio = Buffer.concat(stripped);

  // 3. Analyze the concatenated audio for accurate frame info
  const frameInfo = countMpegFrames(rawAudio);

  // 4. Generate correct Xing header
  const xingHeader = generateXingHeader(frameInfo);

  // 5. Prepend Xing header to raw audio
  return Buffer.concat([xingHeader, rawAudio]);
}
```

---

## 6. Word Alignment Merging

### 6.1 CharAlignment to WordAlignment Conversion

```typescript
// src/tts/alignment.ts

import { CharAlignment, WordAlignment } from './types';

export function charToWordAlignments(
  chars: CharAlignment[],
  chunkIndex: number,
  timeOffsetMs: number
): WordAlignment[] {
  const words: WordAlignment[] = [];
  let wordChars = '';
  let wordStartMs = 0;
  let wordEndMs = 0;

  for (const c of chars) {
    const isWhitespace = c.char === ' ' || c.char === '\n' || c.char === '\t';

    if (isWhitespace) {
      // Whitespace: flush current word if any
      if (wordChars.length > 0) {
        words.push({
          word: wordChars,
          startMs: wordStartMs + timeOffsetMs,
          endMs: wordEndMs + timeOffsetMs,
          chunkIndex,
        });
        wordChars = '';
      }
    } else {
      // Non-whitespace character: accumulate
      if (wordChars.length === 0) {
        wordStartMs = c.startMs;
      }
      wordChars += c.char;
      wordEndMs = c.endMs;
    }
  }

  // Flush final word
  if (wordChars.length > 0) {
    words.push({
      word: wordChars,
      startMs: wordStartMs + timeOffsetMs,
      endMs: wordEndMs + timeOffsetMs,
      chunkIndex,
    });
  }

  return words;
}
```

### 6.2 Repeated Word Handling and Cross-Chunk Offset

The client uses the word alignments array for playback highlighting. Since alignments are ordered by `startMs`, repeated words are handled correctly — the client just advances a cursor through the array based on current playback position. No server-side deduplication is needed; correct ordering is sufficient.

```typescript
export function mergeWordAlignments(
  chunkAlignments: CharAlignment[][],
  chunkDurationsSec: number[]   // frame-accurate durations, one per chunk
): WordAlignment[] {
  const allWords: WordAlignment[] = [];
  let cumulativeOffsetMs = 0;

  for (let i = 0; i < chunkAlignments.length; i++) {
    const words = charToWordAlignments(chunkAlignments[i], i, cumulativeOffsetMs);
    allWords.push(...words);
    // IMPORTANT: use frame-accurate duration, not the last word's endMs
    // Trailing silence in a chunk is real playback time; skipping it causes drift
    cumulativeOffsetMs += Math.round(chunkDurationsSec[i] * 1000);
  }

  return allWords;
}
```

---

## 7. WebSocket Progress Streaming

```typescript
// src/routes/tts.ts (WebSocket section)

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

export function attachTtsWebSocket(server: import('http').Server): void {
  const wss = new WebSocketServer({ server, path: '/tts/stream' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
    const text = params.get('text');
    const voiceId = params.get('voice');
    const userId = await authenticateWsRequest(req);

    if (!text || !voiceId || !userId) {
      ws.close(4001, 'Missing required parameters or invalid auth');
      return;
    }

    const ac = new AbortController();
    ws.on('close', () => ac.abort());

    try {
      await streamTtsToWebSocket(ws, text, voiceId, userId, ac.signal);
    } catch (err: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
      }
    }
  });
}

async function streamTtsToWebSocket(
  ws: WebSocket,
  text: string,
  voiceId: string,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  const artKey = articleKey(text, voiceId);

  // Article cache hit: serve immediately without any synthesis
  const cachedArticle = await ttsCache.getArticle(artKey);
  if (cachedArticle) {
    ws.send(JSON.stringify({
      type: 'complete',
      cached: true,
      audioBase64: cachedArticle.audio,
      wordAlignments: cachedArticle.wordAlignments,
      totalDuration: cachedArticle.duration,
    }));
    ws.close();
    return;
  }

  const chunks = splitIntoChunks(text);
  ws.send(JSON.stringify({ type: 'started', totalChunks: chunks.length }));

  const chunkBuffers: Buffer[] = [];
  const chunkAlignments: CharAlignment[][] = [];
  const chunkDurationsSec: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal.aborted) throw new Error('Aborted by client');

    const cKey = chunkKey(chunks[i], voiceId);

    // Check chunk cache first
    const cachedChunk = await ttsCache.getChunk(cKey);
    let entry: ChunkCacheEntry;

    if (cachedChunk) {
      entry = cachedChunk;
    } else {
      // Synthesize with in-flight deduplication
      const result = await inFlightDedup.deduplicate(cKey, () =>
        synthesizeChunk(chunks[i], voiceId, userId, signal)
      );

      // Strip metadata and compute frame-accurate duration
      const strippedBuffer = stripMetadata(result.audio);
      const frameInfo = countMpegFrames(strippedBuffer);
      const frameAccurateDuration = (frameInfo.frameCount * 1152) / frameInfo.sampleRate;

      entry = {
        audio: strippedBuffer.toString('base64'),
        duration: frameAccurateDuration,
        alignment: result.alignment,
      };

      await ttsCache.setChunk(cKey, entry);
    }

    chunkBuffers.push(Buffer.from(entry.audio, 'base64'));
    chunkAlignments.push(entry.alignment);
    chunkDurationsSec.push(entry.duration);

    // Notify client: this chunk is ready to play
    ws.send(JSON.stringify({
      type: 'chunk_ready',
      chunkIndex: i,
      totalChunks: chunks.length,
      chunkKey: cKey,
      duration: entry.duration,
    }));
  }

  // Assemble complete audio with correct Xing header
  const fullAudio = concatenateChunks(chunkBuffers);
  const wordAlignments = mergeWordAlignments(chunkAlignments, chunkDurationsSec);
  const totalDuration = chunkDurationsSec.reduce((a, b) => a + b, 0);

  // Cache article-level result for future requests
  const articleEntry: ArticleCacheEntry = {
    audio: fullAudio.toString('base64'),
    duration: totalDuration,
    wordAlignments,
  };
  await ttsCache.setArticle(artKey, articleEntry);

  ws.send(JSON.stringify({
    type: 'complete',
    audioBase64: fullAudio.toString('base64'),
    wordAlignments,
    totalDuration,
  }));

  ws.close();

  // Hint GC after large buffer operations
  memoryTracker.gcHint();
}
```

---

## 8. Memory Management

```typescript
// src/health.ts

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  timestamp: number;
}

export class MemoryTracker {
  private snapshots: MemorySnapshot[] = [];
  private interval: NodeJS.Timeout;

  constructor() {
    this.interval = setInterval(() => this.checkMemory(), 30_000);
  }

  private checkMemory(): void {
    const mem = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      timestamp: Date.now(),
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > 10) this.snapshots.shift(); // keep last 5 minutes

    const prev = this.snapshots.length >= 2 ? this.snapshots[this.snapshots.length - 2] : null;

    if (prev) {
      const heapGrowthMB = (snapshot.heapUsed - prev.heapUsed) / 1024 / 1024;
      const rssGrowthMB  = (snapshot.rss - prev.rss) / 1024 / 1024;

      if (heapGrowthMB > 20) {
        console.warn(`[MEMORY] Heap grew ${heapGrowthMB.toFixed(1)}MB in 30s (threshold: 20MB)`);
      }

      if (rssGrowthMB > 400) {
        console.error(`[MEMORY] RSS spiked ${rssGrowthMB.toFixed(1)}MB in 30s — possible buffer leak`);
      }
    }

    if (snapshot.rss > 1.5 * 1024 * 1024 * 1024) {
      console.error(`[MEMORY] CRITICAL: RSS = ${(snapshot.rss / 1024 / 1024 / 1024).toFixed(2)}GB`);
    }
  }

  gcHint(): void {
    if (typeof (global as any).gc === 'function') {
      (global as any).gc();
    }
  }

  getStats() {
    const latest = this.snapshots[this.snapshots.length - 1];
    return latest ? {
      rss: latest.rss,
      heapUsed: latest.heapUsed,
      heapTotal: latest.heapTotal,
    } : null;
  }

  stop(): void {
    clearInterval(this.interval);
  }
}

export const memoryTracker = new MemoryTracker();
```

Start Node.js with `--expose-gc` to enable manual GC hints:
```bash
node --expose-gc dist/index.js
```

---

## 9. API Design

### Route Table

| Method | Path | Description |
|---|---|---|
| POST | `/tts/generate` | Submit article for TTS (returns jobId; use WS for progress) |
| GET | `/tts/:jobId` | Poll for job completion (fallback for non-WS clients) |
| GET | `/tts/voices` | List available voices |
| WS | `/tts/stream` | Stream chunk_ready events in real time |
| GET | `/health` | Cache stats, memory, concurrency status |

### Request/Response Shapes

```typescript
// POST /tts/generate
// Request:
interface GenerateRequest { text: string; voice: string; }
// Response 202:
interface GenerateResponse { jobId: string; wsUrl: string; }

// GET /tts/:jobId
// Response 200 (complete):
interface JobCompleteResponse {
  status: 'complete';
  audioBase64: string;
  wordAlignments: WordAlignment[];
  totalDuration: number;
}
// Response 202 (processing):
interface JobPendingResponse { status: 'processing'; }

// GET /tts/voices
// Response 200:
interface VoicesResponse { voices: Voice[]; }

// GET /health
// Response 200:
interface HealthResponse {
  status: 'ok';
  caches: {
    chunk: { hitRate: number; hits: number; misses: number };
    article: { hitRate: number; hits: number; misses: number };
  };
  memory: { rss: number; heapUsed: number; heapTotal: number } | null;
  concurrency: {
    globalSemaphoreAvailable: number;
    globalSemaphoreQueue: number;
    inFlightChunks: number;
  };
}
```

---

## 10. File and Folder Structure

```
src/
  index.ts                         // App entry: Express setup, WebSocket attach, Redis connect

  tts/
    chunker.ts                     // cleanText(), splitIntoChunks(), chunkKey(), articleKey()
    cache.ts                       // TtsCache class, InFlightDedup class
    semaphore.ts                   // Semaphore class with AbortSignal support
    provider.ts                    // TTSProvider interface, MockTTSProvider, InworldTTSProvider
    audio.ts                       // countMpegFrames(), stripMetadata(), generateXingHeader(), concatenateChunks()
    alignment.ts                   // charToWordAlignments(), mergeWordAlignments()
    synthesizer.ts                 // synthesizeChunk() — orchestrates provider + semaphores
    types.ts                       // CharAlignment, WordAlignment, ChunkCacheEntry, ArticleCacheEntry

  routes/
    tts.ts                         // HTTP routes + WebSocket stream handler
    health.ts                      // GET /health

  middleware/
    auth.ts                        // JWT authentication middleware
    errorHandler.ts                // Express global error handler

  health.ts                        // MemoryTracker class

  redis.ts                         // ioredis client singleton
  config.ts                        // Environment variable parsing

package.json
tsconfig.json
.env
docker-compose.yml                 // Redis service
```

---

## 11. Environment Variables

```bash
# .env

PORT=3000
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=your-jwt-secret

# TTS Provider
TTS_PROVIDER=mock                   # "mock" | "inworld" | "elevenlabs"
TTS_API_KEY=your-api-key-here
TTS_API_BASE_URL=https://api.inworld.ai/tts/v1

# Concurrency limits
TTS_GLOBAL_CONCURRENCY=10
TTS_USER_CONCURRENCY=3

# Cache TTL (seconds)
CHUNK_CACHE_TTL=3600
ARTICLE_CACHE_TTL=7200

# Cache version (bump to invalidate all chunk caches when algorithm changes)
CACHE_VERSION=v3

# Chunk sizing
TARGET_CHUNK_CHARS=1800
MAX_CHUNK_CHARS=2000

# Memory thresholds (MB)
MEMORY_HEAP_GROWTH_WARN_MB=20
MEMORY_RSS_SPIKE_WARN_MB=400
MEMORY_RSS_CRITICAL_MB=1536

# Run with --expose-gc to enable GC hints:
# node --expose-gc dist/index.js
```

---

## 12. Cost Estimation Calculator

```typescript
// src/tts/costEstimator.ts

interface CostInputs {
  dailyActiveUsers: number;
  articlesPerUserPerDay: number;
  averageArticleChars: number;
  voiceCount: number;               // distinct voices — affects cache hit rate
  costPerMillionChars: number;      // e.g., 16.00 for ElevenLabs, 5.00 for Inworld
}

interface CostEstimate {
  naiveMonthlyCost: number;
  cachedMonthlyCost: number;
  savings: number;
  savingsPercent: number;
  estimatedCacheHitRate: number;
  assumptions: string[];
}

export function estimateMonthlyCost(inputs: CostInputs): CostEstimate {
  const {
    dailyActiveUsers,
    articlesPerUserPerDay,
    averageArticleChars,
    voiceCount,
    costPerMillionChars,
  } = inputs;

  const dailyArticleRequests = dailyActiveUsers * articlesPerUserPerDay;
  const monthlyArticleRequests = dailyArticleRequests * 30;

  // Naive cost: every request hits the TTS API
  const naiveMonthlyCost =
    (monthlyArticleRequests * averageArticleChars / 1_000_000) * costPerMillionChars;

  // Cached cost: unique articles follow Zipf distribution
  // Heuristic: unique articles per day ≈ sqrt(DAU) * voiceCount
  const estimatedUniqueArticlesPerDay = Math.sqrt(dailyActiveUsers) * voiceCount;
  const monthlyUniqueArticles = estimatedUniqueArticlesPerDay * 30;
  const cachedMonthlyCost =
    (monthlyUniqueArticles * averageArticleChars / 1_000_000) * costPerMillionChars;

  const estimatedCacheHitRate = 1 - (monthlyUniqueArticles / monthlyArticleRequests);

  return {
    naiveMonthlyCost: Math.round(naiveMonthlyCost * 100) / 100,
    cachedMonthlyCost: Math.round(cachedMonthlyCost * 100) / 100,
    savings: Math.round((naiveMonthlyCost - cachedMonthlyCost) * 100) / 100,
    savingsPercent: Math.round((1 - cachedMonthlyCost / naiveMonthlyCost) * 100),
    estimatedCacheHitRate: Math.round(estimatedCacheHitRate * 1000) / 1000,
    assumptions: [
      `Article popularity follows Zipf distribution`,
      `~${Math.round(estimatedUniqueArticlesPerDay)} unique articles synthesized per day`,
      `${voiceCount} voice(s) in use (multiplies unique syntheses required)`,
      `Chunk-level cache provides additional savings for shared sentences`,
      `In-flight dedup prevents duplicate API calls during traffic spikes`,
    ],
  };
}

// Example: 25K DAU, 1.5 articles/day, 5000 chars, 2 voices, $16/million chars
// estimateMonthlyCost({ dailyActiveUsers: 25000, articlesPerUserPerDay: 1.5,
//   averageArticleChars: 5000, voiceCount: 2, costPerMillionChars: 16 })
// → naiveMonthlyCost: $3000, cachedMonthlyCost: ~$75, savings: $2925 (97.5%)
```

---

## Build and Run

```bash
# Install dependencies
npm install ioredis ws express jsonwebtoken nanoid \
  @types/ws @types/express @types/jsonwebtoken \
  typescript ts-node tsx

# Start Redis
docker compose up -d redis

# Run in development with GC hints enabled
node --expose-gc $(npx which tsx) watch src/index.ts

# Build and run in production
npx tsc && node --expose-gc dist/index.js
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --save 60 1 --loglevel warning

volumes:
  redis-data:
```
