# RaftKV — Implementation Plan

This is a complete implementation blueprint for a from-scratch Raft consensus implementation in TypeScript. Read the Raft paper (https://raft.github.io/raft.pdf) alongside this plan. Every section maps directly to a section of the paper.

---

## 1. Raft State Machine

Each node maintains the following state. Persistent state must be written to disk before sending any RPC response or changing role.

### Persistent State (survives crash+restart)

```typescript
interface PersistentState {
  currentTerm: number;        // latest term server has seen (init 0, monotonically increases)
  votedFor: string | null;    // candidateId this node voted for in currentTerm (null = not voted)
  log: LogEntry[];            // log entries; each entry contains command + term when received
}

interface LogEntry {
  index: number;              // 1-based position in the log
  term: number;               // term when entry was received by leader
  command: Command;           // the state machine command
}

type Command =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };           // leader no-op on election to commit previous entries
```

### Volatile State (reset on restart)

```typescript
interface VolatileState {
  commitIndex: number;        // index of highest log entry known to be committed (init 0)
  lastApplied: number;        // index of highest log entry applied to state machine (init 0)
  role: 'follower' | 'candidate' | 'leader';
  leaderId: string | null;    // so followers can redirect clients
  votes: Set<string>;         // votes received in current election (candidate only)
}
```

### Leader-Only Volatile State (reset on each new election)

```typescript
interface LeaderState {
  nextIndex: Map<string, number>;   // for each peer: index of next log entry to send (init lastLogIndex + 1)
  matchIndex: Map<string, number>;  // for each peer: index of highest log entry known replicated (init 0)
}
```

### Role Transition Diagram (ASCII)

```
                  ┌─────────────────────────────────────────┐
                  │  discovers current leader or             │
                  │  grants vote to candidate                │
                  ▼                                          │
           ┌──────────┐    election timeout     ┌────────────┴──┐
 startup → │ FOLLOWER │ ─────────────────────► │  CANDIDATE    │
           └──────────┘                         └───────────────┘
                  ▲                               │         │
                  │                               │ wins    │ discovers
                  │    discovers server with      │ election│ higher term
                  │    higher term                ▼         │
                  │                         ┌──────────┐   │
                  └─────────────────────── │  LEADER  │ ◄─┘
                    receives AppendEntries  └──────────┘
                    from new leader
```

---

## 2. Election Algorithm

### Election Timeout

Each node starts an election timeout on startup. The timeout is randomized to prevent all nodes from becoming candidates simultaneously.

```typescript
// src/raft/electionTimer.ts

function randomElectionTimeoutMs(): number {
  // Raft paper recommends 150-300ms. Use 200-400ms to give more slack for HTTP RPC latency.
  return 200 + Math.floor(Math.random() * 200);
}

class ElectionTimer {
  private timer: NodeJS.Timeout | null = null;
  private callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.callback, randomElectionTimeoutMs());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
```

### Follower → Candidate Transition

When the election timeout fires without receiving a heartbeat or granting a vote:

```typescript
async function startElection(node: RaftNode): Promise<void> {
  // 1. Transition to Candidate
  node.role = 'candidate';

  // 2. Increment term (MUST persist before sending RPCs)
  node.currentTerm += 1;
  node.votedFor = node.nodeId;  // vote for self
  node.votes = new Set([node.nodeId]);
  await node.persist();

  // 3. Reset election timer (in case this election also times out — start a new one)
  node.electionTimer.reset();

  // 4. Send RequestVote to all peers in parallel
  const lastLogIndex = node.log.length;
  const lastLogTerm = node.log.length > 0 ? node.log[node.log.length - 1].term : 0;

  const voteRequests = node.peers.map(peer =>
    sendRequestVote(peer, {
      term: node.currentTerm,
      candidateId: node.nodeId,
      lastLogIndex,
      lastLogTerm,
    }).then(response => node.handleVoteResponse(peer, response))
      .catch(() => {}) // ignore RPC failures; election timer will retry
  );

  await Promise.allSettled(voteRequests);
}
```

### RequestVote RPC

```typescript
// RPC handler on the receiving node:
interface RequestVoteRequest {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

interface RequestVoteResponse {
  term: number;
  voteGranted: boolean;
}

async function handleRequestVote(
  node: RaftNode,
  req: RequestVoteRequest
): Promise<RequestVoteResponse> {
  // Rule 1: if request term < our term, deny
  if (req.term < node.currentTerm) {
    return { term: node.currentTerm, voteGranted: false };
  }

  // Rule 2: if request term > our term, step down to follower
  if (req.term > node.currentTerm) {
    node.currentTerm = req.term;
    node.role = 'follower';
    node.votedFor = null;
    await node.persist();
  }

  // Rule 3: check if we have already voted in this term
  if (node.votedFor !== null && node.votedFor !== req.candidateId) {
    return { term: node.currentTerm, voteGranted: false };
  }

  // Rule 4: check candidate's log is at least as up-to-date as ours
  const myLastLogIndex = node.log.length;
  const myLastLogTerm = node.log.length > 0 ? node.log[node.log.length - 1].term : 0;

  const candidateLogUpToDate =
    req.lastLogTerm > myLastLogTerm ||
    (req.lastLogTerm === myLastLogTerm && req.lastLogIndex >= myLastLogIndex);

  if (!candidateLogUpToDate) {
    return { term: node.currentTerm, voteGranted: false };
  }

  // Grant vote
  node.votedFor = req.candidateId;
  await node.persist();
  node.electionTimer.reset(); // reset timer: we've interacted with a valid candidate

  return { term: node.currentTerm, voteGranted: true };
}
```

### Handling Vote Response

```typescript
async function handleVoteResponse(
  node: RaftNode,
  peer: string,
  response: RequestVoteResponse
): Promise<void> {
  // Stale response: we may have moved on to a new term
  if (node.role !== 'candidate' || response.term < node.currentTerm) return;

  // Higher term discovered: step down
  if (response.term > node.currentTerm) {
    node.currentTerm = response.term;
    node.role = 'follower';
    node.votedFor = null;
    await node.persist();
    node.electionTimer.reset();
    return;
  }

  if (response.voteGranted) {
    node.votes.add(peer);
    // Check if we have a majority
    const majority = Math.floor((node.peers.length + 1) / 2) + 1;
    if (node.votes.size >= majority) {
      await becomeLeader(node);
    }
  }
}

async function becomeLeader(node: RaftNode): Promise<void> {
  node.role = 'leader';
  node.leaderId = node.nodeId;
  node.electionTimer.stop();

  // Initialize nextIndex and matchIndex for all peers
  const nextLogIndex = node.log.length + 1;
  node.nextIndex = new Map(node.peers.map(p => [p, nextLogIndex]));
  node.matchIndex = new Map(node.peers.map(p => [p, 0]));

  // Immediately send a no-op entry to commit previous entries from past terms
  // This is essential for linearizability (Raft paper Section 8)
  await appendEntry(node, { op: 'noop' });

  // Start sending heartbeats every 50ms (must be << election timeout)
  node.startHeartbeatTimer();
}
```

---

## 3. Log Replication

### AppendEntries RPC

This RPC serves two purposes: heartbeat (entries=[] maintains authority) and log replication.

```typescript
interface AppendEntriesRequest {
  term: number;
  leaderId: string;
  prevLogIndex: number;       // index of log entry immediately preceding new ones
  prevLogTerm: number;        // term of prevLogIndex entry
  entries: LogEntry[];        // log entries to store (empty for heartbeat)
  leaderCommit: number;       // leader's commitIndex
}

interface AppendEntriesResponse {
  term: number;
  success: boolean;
  // Optimization: include conflict info to avoid O(n) probe-back
  conflictIndex?: number;     // index of first conflicting entry
  conflictTerm?: number;      // term of the conflicting entry
}

async function handleAppendEntries(
  node: RaftNode,
  req: AppendEntriesRequest
): Promise<AppendEntriesResponse> {
  // Rule 1: deny if stale term
  if (req.term < node.currentTerm) {
    return { term: node.currentTerm, success: false };
  }

  // Rule 2: update term and step down if needed
  if (req.term > node.currentTerm || node.role === 'candidate') {
    node.currentTerm = req.term;
    node.role = 'follower';
    node.votedFor = null; // do NOT clear votedFor — only clear on new term increment
    await node.persist();
  }

  node.leaderId = req.leaderId;
  node.electionTimer.reset(); // heard from leader; don't start election

  // Rule 3: consistency check — does our log contain an entry at prevLogIndex with prevLogTerm?
  if (req.prevLogIndex > 0) {
    const prevEntry = node.log[req.prevLogIndex - 1]; // 1-based index
    if (!prevEntry || prevEntry.term !== req.prevLogTerm) {
      // Reject with conflict info for fast rollback
      if (!prevEntry) {
        return { term: node.currentTerm, success: false, conflictIndex: node.log.length + 1 };
      }
      const conflictTerm = prevEntry.term;
      // Find the first index with this conflicting term
      const conflictIndex = node.log.findIndex(e => e.term === conflictTerm) + 1;
      return { term: node.currentTerm, success: false, conflictIndex, conflictTerm };
    }
  }

  // Rule 4: append new entries (overwrite any conflicting entries)
  if (req.entries.length > 0) {
    // Find where our log diverges from the new entries
    let insertIndex = req.prevLogIndex; // 0-based position to start inserting
    for (let i = 0; i < req.entries.length; i++) {
      const newEntry = req.entries[i];
      const existingEntry = node.log[insertIndex + i];
      if (!existingEntry || existingEntry.term !== newEntry.term) {
        // Truncate our log from this point and append remaining entries
        node.log.splice(insertIndex + i);
        node.log.push(...req.entries.slice(i));
        break;
      }
    }
    await node.persist();
  }

  // Rule 5: advance commit index
  if (req.leaderCommit > node.commitIndex) {
    node.commitIndex = Math.min(req.leaderCommit, node.log.length);
    node.applyCommitted();
  }

  return { term: node.currentTerm, success: true };
}
```

### Leader Sending AppendEntries

```typescript
// src/raft/replication.ts

async function replicateToPeer(node: RaftNode, peerId: string): Promise<void> {
  const nextIdx = node.nextIndex.get(peerId)!;

  // Check if we need to send a snapshot instead
  if (node.snapshot && nextIdx <= node.snapshot.lastIncludedIndex) {
    await sendSnapshot(node, peerId);
    return;
  }

  const prevLogIndex = nextIdx - 1;
  const prevLogEntry = node.log[prevLogIndex - 1]; // may be undefined if prevLogIndex=0
  const prevLogTerm = prevLogEntry ? prevLogEntry.term :
    (node.snapshot ? node.snapshot.lastIncludedTerm : 0);

  // Send all entries from nextIdx onward (up to a batch limit)
  const BATCH_SIZE = 100;
  const logOffset = node.snapshot ? node.snapshot.lastIncludedIndex : 0;
  const entries = node.log.slice(nextIdx - 1 - logOffset, nextIdx - 1 - logOffset + BATCH_SIZE);

  const request: AppendEntriesRequest = {
    term: node.currentTerm,
    leaderId: node.nodeId,
    prevLogIndex,
    prevLogTerm,
    entries,
    leaderCommit: node.commitIndex,
  };

  let response: AppendEntriesResponse;
  try {
    response = await rpc.appendEntries(peerId, request);
  } catch {
    return; // network error; will retry on next heartbeat
  }

  // Higher term: step down
  if (response.term > node.currentTerm) {
    node.currentTerm = response.term;
    node.role = 'follower';
    node.votedFor = null;
    await node.persist();
    node.electionTimer.reset();
    return;
  }

  if (response.success) {
    // Advance match and next index
    const newMatchIndex = prevLogIndex + entries.length;
    node.matchIndex.set(peerId, Math.max(node.matchIndex.get(peerId)!, newMatchIndex));
    node.nextIndex.set(peerId, newMatchIndex + 1);

    // Check if we can advance commitIndex
    // Rule: a log entry at index N can be committed if matchIndex[i] >= N for a majority
    // AND log[N].term === currentTerm (Figure 8 safety rule)
    advanceCommitIndex(node);
  } else {
    // Conflict: roll back nextIndex using conflict info
    if (response.conflictTerm !== undefined) {
      // Find last entry in our log with conflictTerm
      const logOffset = node.snapshot ? node.snapshot.lastIncludedIndex : 0;
      let lastEntryWithConflictTerm = -1;
      for (let i = node.log.length - 1; i >= 0; i--) {
        if (node.log[i].term === response.conflictTerm) {
          lastEntryWithConflictTerm = i + 1 + logOffset; // 1-based absolute index
          break;
        }
      }
      node.nextIndex.set(peerId,
        lastEntryWithConflictTerm !== -1 ? lastEntryWithConflictTerm + 1 : response.conflictIndex!
      );
    } else {
      node.nextIndex.set(peerId, response.conflictIndex ?? Math.max(1, node.nextIndex.get(peerId)! - 1));
    }
  }
}

function advanceCommitIndex(node: RaftNode): void {
  const logOffset = node.snapshot ? node.snapshot.lastIncludedIndex : 0;

  // Find the highest N such that:
  // 1. N > commitIndex
  // 2. A majority of matchIndex[i] >= N
  // 3. log[N - 1 - logOffset].term === currentTerm  (the critical safety rule)
  for (let n = node.log.length + logOffset; n > node.commitIndex; n--) {
    const logEntry = node.log[n - 1 - logOffset];
    if (!logEntry || logEntry.term !== node.currentTerm) continue;

    let replicatedCount = 1; // count self
    for (const [, matchIdx] of node.matchIndex) {
      if (matchIdx >= n) replicatedCount++;
    }

    const majority = Math.floor((node.peers.length + 1) / 2) + 1;
    if (replicatedCount >= majority) {
      node.commitIndex = n;
      node.applyCommitted();
      break;
    }
  }
}
```

---

## 4. State Machine (KV Store)

```typescript
// src/kv/stateMachine.ts

interface KVStateMachine {
  store: Map<string, string>;
  apply(command: Command): ApplyResult;
  serialize(): string;
  deserialize(data: string): void;
}

interface ApplyResult {
  value?: string;
  found?: boolean;
  ok: boolean;
}

class KVStore implements KVStateMachine {
  store = new Map<string, string>();

  apply(command: Command): ApplyResult {
    if (command.op === 'set') {
      this.store.set(command.key, command.value);
      return { ok: true };
    }
    if (command.op === 'del') {
      const existed = this.store.delete(command.key);
      return { ok: existed };
    }
    if (command.op === 'noop') {
      return { ok: true };
    }
    throw new Error(`Unknown command op: ${(command as any).op}`);
  }

  get(key: string): { value: string; found: true } | { found: false } {
    if (this.store.has(key)) {
      return { value: this.store.get(key)!, found: true };
    }
    return { found: false };
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.store));
  }

  deserialize(data: string): void {
    const obj = JSON.parse(data);
    this.store = new Map(Object.entries(obj));
  }
}
```

### Apply Loop

The `applyCommitted` method runs the state machine up to `commitIndex`. It must be called whenever `commitIndex` advances. Pending client requests waiting on a specific `logIndex` are resolved here.

```typescript
// Inside RaftNode class:

// Map from log index to pending client request resolve/reject functions
private pendingRequests = new Map<number, { resolve: (r: ApplyResult) => void, reject: (e: Error) => void }>();

applyCommitted(): void {
  while (this.lastApplied < this.commitIndex) {
    this.lastApplied++;
    const logOffset = this.snapshot ? this.snapshot.lastIncludedIndex : 0;
    const entry = this.log[this.lastApplied - 1 - logOffset];
    if (!entry) continue; // gap covered by snapshot

    const result = this.kvStore.apply(entry.command);

    // Resolve pending client request if any
    const pending = this.pendingRequests.get(this.lastApplied);
    if (pending) {
      pending.resolve(result);
      this.pendingRequests.delete(this.lastApplied);
    }
  }
}
```

---

## 5. Snapshot / Log Compaction

### Trigger

The leader compacts when the in-memory log (after the last snapshot offset) exceeds 1000 entries.

```typescript
interface Snapshot {
  lastIncludedIndex: number;  // last log index included in snapshot
  lastIncludedTerm: number;   // term of that entry
  state: string;              // JSON-serialized KV store
}
```

### Creating a Snapshot

```typescript
async function createSnapshot(node: RaftNode): Promise<void> {
  if (node.lastApplied <= (node.snapshot?.lastIncludedIndex ?? 0)) return;

  const logOffset = node.snapshot ? node.snapshot.lastIncludedIndex : 0;
  const lastEntry = node.log[node.lastApplied - 1 - logOffset];

  const snapshot: Snapshot = {
    lastIncludedIndex: node.lastApplied,
    lastIncludedTerm: lastEntry?.term ?? node.snapshot?.lastIncludedTerm ?? 0,
    state: node.kvStore.serialize(),
  };

  // Persist snapshot to disk
  await fs.writeFile(
    path.join(DATA_DIR, `snapshot-${node.nodeId}.json`),
    JSON.stringify(snapshot),
    'utf8'
  );

  // Truncate log: keep only entries after lastIncludedIndex
  const keepFrom = node.lastApplied - logOffset;
  node.log = node.log.slice(keepFrom);
  node.snapshot = snapshot;

  await node.persist(); // update persistent state (log is now shorter)
}
```

### InstallSnapshot RPC

```typescript
interface InstallSnapshotRequest {
  term: number;
  leaderId: string;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: string;               // full JSON snapshot
}

interface InstallSnapshotResponse {
  term: number;
}

async function handleInstallSnapshot(
  node: RaftNode,
  req: InstallSnapshotRequest
): Promise<InstallSnapshotResponse> {
  if (req.term < node.currentTerm) {
    return { term: node.currentTerm };
  }

  if (req.term > node.currentTerm) {
    node.currentTerm = req.term;
    node.role = 'follower';
    node.votedFor = null;
  }

  node.leaderId = req.leaderId;
  node.electionTimer.reset();

  // If we already have this snapshot or newer, ignore
  if (req.lastIncludedIndex <= (node.snapshot?.lastIncludedIndex ?? 0)) {
    return { term: node.currentTerm };
  }

  // Install snapshot
  const snapshot: Snapshot = {
    lastIncludedIndex: req.lastIncludedIndex,
    lastIncludedTerm: req.lastIncludedTerm,
    state: req.data,
  };

  node.kvStore.deserialize(req.data);

  // Retain any log entries after the snapshot's last included index
  const retainFrom = node.log.findIndex(e => e.index > req.lastIncludedIndex);
  node.log = retainFrom >= 0 ? node.log.slice(retainFrom) : [];
  node.snapshot = snapshot;

  node.commitIndex = Math.max(node.commitIndex, req.lastIncludedIndex);
  node.lastApplied = Math.max(node.lastApplied, req.lastIncludedIndex);

  // Persist
  await fs.writeFile(
    path.join(DATA_DIR, `snapshot-${node.nodeId}.json`),
    JSON.stringify(snapshot),
    'utf8'
  );
  await node.persist();

  return { term: node.currentTerm };
}
```

---

## 6. Transport Layer (HTTP/JSON RPC)

All inter-node RPCs are HTTP POST requests. Each node runs an Express server with RPC endpoints in addition to the client-facing KV API.

```typescript
// src/transport/rpcServer.ts

import { Router } from 'express';

export function createRpcRouter(node: RaftNode): Router {
  const router = Router();

  router.post('/rpc/request-vote', async (req, res) => {
    const response = await handleRequestVote(node, req.body);
    res.json(response);
  });

  router.post('/rpc/append-entries', async (req, res) => {
    const response = await handleAppendEntries(node, req.body);
    res.json(response);
  });

  router.post('/rpc/install-snapshot', async (req, res) => {
    const response = await handleInstallSnapshot(node, req.body);
    res.json(response);
  });

  return router;
}
```

```typescript
// src/transport/rpcClient.ts

import fetch from 'node-fetch';

const RPC_TIMEOUT_MS = 150; // must be << election timeout

export const rpc = {
  async requestVote(peerUrl: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
    const res = await fetch(`${peerUrl}/rpc/request-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    return res.json() as Promise<RequestVoteResponse>;
  },

  async appendEntries(peerUrl: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    const res = await fetch(`${peerUrl}/rpc/append-entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    return res.json() as Promise<AppendEntriesResponse>;
  },

  async installSnapshot(peerUrl: string, req: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    const res = await fetch(`${peerUrl}/rpc/install-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(5_000), // snapshots can be large
    });
    return res.json() as Promise<InstallSnapshotResponse>;
  },
};
```

---

## 7. Client API

```typescript
// src/api/kvRoutes.ts

import { Router } from 'express';

export function createKvRouter(node: RaftNode): Router {
  const router = Router();

  router.get('/kv/:key', async (req, res) => {
    // Any node can serve reads (linearizable reads require ReadIndex protocol,
    // but for this project, leader-only reads are acceptable)
    if (node.role !== 'leader') {
      if (node.leaderId) {
        const leaderUrl = node.getPeerUrl(node.leaderId);
        return res.status(307).json({ redirectTo: leaderUrl });
      }
      return res.status(503).json({ error: 'no_leader' });
    }

    const result = node.kvStore.get(req.params.key);
    if (!result.found) return res.status(404).json({ error: 'not_found' });
    res.json({ value: result.value });
  });

  router.put('/kv/:key', async (req, res) => {
    if (node.role !== 'leader') {
      if (node.leaderId) {
        return res.status(307).json({ ok: false, redirectTo: node.getPeerUrl(node.leaderId) });
      }
      return res.status(503).json({ error: 'no_leader' });
    }

    const { value } = req.body;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }

    try {
      await appendEntry(node, { op: 'set', key: req.params.key, value });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/kv/:key', async (req, res) => {
    if (node.role !== 'leader') {
      if (node.leaderId) {
        return res.status(307).json({ ok: false, redirectTo: node.getPeerUrl(node.leaderId) });
      }
      return res.status(503).json({ error: 'no_leader' });
    }

    try {
      await appendEntry(node, { op: 'del', key: req.params.key });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/cluster/status', (req, res) => {
    res.json({
      nodeId: node.nodeId,
      role: node.role,
      term: node.currentTerm,
      leaderId: node.leaderId,
      commitIndex: node.commitIndex,
      lastApplied: node.lastApplied,
      logSize: node.log.length,
      snapshotIndex: node.snapshot?.lastIncludedIndex ?? 0,
    });
  });

  return router;
}

// appendEntry: leader appends to log and waits for commitment
async function appendEntry(node: RaftNode, command: Command): Promise<ApplyResult> {
  const logOffset = node.snapshot ? node.snapshot.lastIncludedIndex : 0;
  const index = node.log.length + 1 + logOffset;
  const entry: LogEntry = { index, term: node.currentTerm, command };

  node.log.push(entry);
  await node.persist();

  // Immediately replicate to all peers (don't wait for heartbeat interval)
  node.peers.forEach(peer => replicateToPeer(node, peer).catch(() => {}));

  // Wait for this entry to be committed (applied to state machine)
  return new Promise<ApplyResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      node.pendingRequests.delete(index);
      reject(new Error('Write timed out — lost leadership or no quorum'));
    }, 5_000);

    node.pendingRequests.set(index, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
  });
}
```

---

## 8. Persistence

Persistent state is written to a JSON file. The log is appended incrementally to a separate log file for efficiency. On startup, both files are read to reconstruct state.

```typescript
// src/storage/persistence.ts

import * as fs from 'fs/promises';
import * as path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? './data';

interface MetaFile {
  currentTerm: number;
  votedFor: string | null;
  logLength: number; // how many entries are in the log file
}

export async function persistState(node: RaftNode): Promise<void> {
  // Write metadata atomically (write to temp, rename)
  const meta: MetaFile = {
    currentTerm: node.currentTerm,
    votedFor: node.votedFor,
    logLength: node.log.length,
  };

  const metaPath = path.join(DATA_DIR, `meta-${node.nodeId}.json`);
  const tmpPath = metaPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf8');
  await fs.rename(tmpPath, metaPath); // atomic on POSIX

  // Write log entries to log file (full rewrite; optimize to append-only if needed)
  const logPath = path.join(DATA_DIR, `log-${node.nodeId}.jsonl`);
  const lines = node.log.map(e => JSON.stringify(e)).join('\n');
  const logTmpPath = logPath + '.tmp';
  await fs.writeFile(logTmpPath, lines, 'utf8');
  await fs.rename(logTmpPath, logPath);
}

export async function loadState(nodeId: string): Promise<PersistentState | null> {
  const metaPath = path.join(DATA_DIR, `meta-${nodeId}.json`);
  const logPath = path.join(DATA_DIR, `log-${nodeId}.jsonl`);

  try {
    const metaRaw = await fs.readFile(metaPath, 'utf8');
    const meta: MetaFile = JSON.parse(metaRaw);

    let log: LogEntry[] = [];
    try {
      const logRaw = await fs.readFile(logPath, 'utf8');
      log = logRaw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      log = [];
    }

    return { currentTerm: meta.currentTerm, votedFor: meta.votedFor, log };
  } catch {
    return null; // fresh node
  }
}

export async function loadSnapshot(nodeId: string): Promise<Snapshot | null> {
  const snapPath = path.join(DATA_DIR, `snapshot-${nodeId}.json`);
  try {
    const raw = await fs.readFile(snapPath, 'utf8');
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}
```

---

## 9. Observability

```typescript
// src/api/metricsRoute.ts

import { Router } from 'express';

export function createMetricsRouter(node: RaftNode): Router {
  const router = Router();

  router.get('/metrics', (req, res) => {
    const roleValue = node.role === 'leader' ? 2 : node.role === 'candidate' ? 1 : 0;
    const leaderIdHash = node.leaderId
      ? parseInt(node.leaderId.replace(/\D/g, '').slice(0, 9), 10)
      : 0;

    const metrics = [
      `# HELP raft_term Current Raft term`,
      `# TYPE raft_term gauge`,
      `raft_term ${node.currentTerm}`,
      ``,
      `# HELP raft_role Node role: 0=follower 1=candidate 2=leader`,
      `# TYPE raft_role gauge`,
      `raft_role ${roleValue}`,
      ``,
      `# HELP raft_commit_index Highest log index known to be committed`,
      `# TYPE raft_commit_index gauge`,
      `raft_commit_index ${node.commitIndex}`,
      ``,
      `# HELP raft_log_size Number of log entries in memory (after snapshot)`,
      `# TYPE raft_log_size gauge`,
      `raft_log_size ${node.log.length}`,
      ``,
      `# HELP raft_snapshot_index Last log index included in snapshot`,
      `# TYPE raft_snapshot_index gauge`,
      `raft_snapshot_index ${node.snapshot?.lastIncludedIndex ?? 0}`,
      ``,
      `# HELP raft_leader_id_hash Hash of current leader ID for Grafana display`,
      `# TYPE raft_leader_id_hash gauge`,
      `raft_leader_id_hash ${leaderIdHash}`,
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics);
  });

  return router;
}
```

---

## 10. Node Configuration

Each node is started with environment variables:

```bash
NODE_ID=node1
NODE_PORT=3001
PEERS=node2:http://localhost:3002,node3:http://localhost:3003
DATA_DIR=./data/node1
```

```typescript
// src/config.ts

export const config = {
  nodeId: process.env.NODE_ID!,
  nodePort: parseInt(process.env.NODE_PORT!, 10),
  peers: (process.env.PEERS ?? '').split(',').filter(Boolean).map(entry => {
    const [id, url] = entry.split(':http://');
    return { id, url: `http://${url}` };
  }),
  dataDir: process.env.DATA_DIR ?? './data',
  electionTimeoutMinMs: parseInt(process.env.ELECTION_TIMEOUT_MIN ?? '200', 10),
  electionTimeoutMaxMs: parseInt(process.env.ELECTION_TIMEOUT_MAX ?? '400', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL ?? '50', 10),
  snapshotThreshold: parseInt(process.env.SNAPSHOT_THRESHOLD ?? '1000', 10),
};
```

---

## 11. File and Folder Structure

```
src/
  index.ts                     // Entry point: load config, create RaftNode, start Express

  raft/
    node.ts                    // RaftNode class: all state, persist(), applyCommitted()
    election.ts                // startElection(), handleRequestVote(), handleVoteResponse(), becomeLeader()
    replication.ts             // replicateToPeer(), advanceCommitIndex(), sendSnapshot()
    snapshot.ts                // createSnapshot(), handleInstallSnapshot()
    electionTimer.ts           // ElectionTimer class with randomized timeout
    heartbeatTimer.ts          // HeartbeatTimer: fires replicateToPeer for all peers every 50ms

  kv/
    stateMachine.ts            // KVStore class: apply(), get(), serialize(), deserialize()

  transport/
    rpcServer.ts               // Express router for /rpc/* endpoints
    rpcClient.ts               // fetch-based RPC client with timeout

  api/
    kvRoutes.ts                // GET/PUT/DELETE /kv/:key, GET /cluster/status
    metricsRoute.ts            // GET /metrics

  storage/
    persistence.ts             // persistState(), loadState(), loadSnapshot()

  config.ts                    // Environment variable parsing

data/                          // Created at runtime, gitignored
  node1/
    meta-node1.json
    log-node1.jsonl
    snapshot-node1.json

docker-compose.yml
package.json
tsconfig.json
```

---

## 12. Testing Approach

### Docker Compose for Local Cluster

```yaml
# docker-compose.yml
version: '3.8'

x-raft-node: &raft-node
  build: .
  volumes:
    - ./data:/app/data

services:
  node1:
    <<: *raft-node
    environment:
      NODE_ID: node1
      NODE_PORT: "3001"
      PEERS: "node2:http://node2:3002,node3:http://node3:3003"
      DATA_DIR: /app/data/node1
    ports:
      - "3001:3001"

  node2:
    <<: *raft-node
    environment:
      NODE_ID: node2
      NODE_PORT: "3002"
      PEERS: "node1:http://node1:3001,node3:http://node3:3003"
      DATA_DIR: /app/data/node2
    ports:
      - "3002:3002"

  node3:
    <<: *raft-node
    environment:
      NODE_ID: node3
      NODE_PORT: "3003"
      PEERS: "node1:http://node1:3001,node2:http://node2:3002"
      DATA_DIR: /app/data/node3
    ports:
      - "3003:3003"
```

### Manual Test Script

```bash
#!/bin/bash
# test-raft.sh

# Start cluster
docker compose up -d
sleep 3

# Find leader
for port in 3001 3002 3003; do
  role=$(curl -s http://localhost:$port/cluster/status | jq -r '.role')
  echo "Node on port $port: $role"
  if [ "$role" = "leader" ]; then LEADER_PORT=$port; fi
done
echo "Leader port: $LEADER_PORT"

# Write 10 keys
for i in $(seq 1 10); do
  curl -s -X PUT http://localhost:$LEADER_PORT/kv/key$i -H 'Content-Type: application/json' -d "{\"value\":\"val$i\"}"
done

# Read from a follower (port 3002 if leader is 3001)
FOLLOWER_PORT=3002
echo "Reading key1 from follower:"
curl -s http://localhost:$FOLLOWER_PORT/kv/key1

# Kill the leader
LEADER_CID=$(docker compose ps -q node$(($LEADER_PORT - 3000)))
docker kill $LEADER_CID
echo "Killed leader. Waiting 5s for new election..."
sleep 5

# Find new leader
for port in 3001 3002 3003; do
  role=$(curl -s http://localhost:$port/cluster/status 2>/dev/null | jq -r '.role // "down"')
  echo "Node on port $port: $role"
  if [ "$role" = "leader" ]; then NEW_LEADER_PORT=$port; fi
done
echo "New leader port: $NEW_LEADER_PORT"

# Write to new leader
curl -s -X PUT http://localhost:$NEW_LEADER_PORT/kv/afterFailover \
  -H 'Content-Type: application/json' \
  -d '{"value":"survived"}'

echo "Test complete"
```

### Invariants to Assert in Automated Tests

1. **Election safety**: At most one leader per term. Check `/cluster/status` across all nodes; no two should report `role=leader` for the same `term`.
2. **Log matching**: After a failover, all surviving nodes have identical log entries up to `commitIndex`.
3. **No lost writes**: Every write that received a successful HTTP 200 response is present on all nodes after re-election.
4. **Monotonic commit index**: `commitIndex` never decreases.
