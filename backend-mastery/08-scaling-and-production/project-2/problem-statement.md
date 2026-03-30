# Project 2: RaftKV — Distributed Key-Value Store with Raft Consensus

## Context

This is the flagship advanced project of the course. You are building something that most engineers will never build from scratch: a distributed, fault-tolerant key-value store using the Raft consensus algorithm — the same algorithm that powers **etcd** (Kubernetes' configuration backbone), **CockroachDB** (distributed SQL), and **Consul** (service mesh). This is not a toy. The Raft paper was published in 2014 specifically because Paxos — the prior standard consensus algorithm — was considered too hard to understand and implement correctly. Raft was designed to be understandable. You are going to understand it deeply by implementing it.

Distributed consensus solves a specific problem: how can a cluster of N machines agree on the state of a system even when some machines crash, lose network connectivity, or receive messages out of order? The answer is: elect one leader, route all writes through it, replicate every write to a majority of nodes before acknowledging it, and if the leader dies, elect a new one. This guarantees that any committed write survives any minority failure.

After this project, phrases like "split-brain", "log replication", "election quorum", "commit index", and "snapshot installation" will mean something concrete to you.

---

## What You Are Building

A cluster of **3 to 5 nodes** where each node is a separate Node.js process (or Docker container). The cluster collectively maintains a consistent key-value store. Clients interact with any node; writes are automatically routed to the current leader.

The implementation covers the full Raft protocol:

1. **Leader election** — nodes use randomized timeouts to prevent split votes; a candidate that collects votes from a majority becomes the new leader
2. **Log replication** — every write is appended to the leader's log and replicated to followers before being acknowledged to the client
3. **Log compaction (snapshots)** — when the log grows too large, the leader creates a snapshot of the current state and truncates the log; slow followers receive the snapshot via RPC
4. **Membership changes** — adding or removing nodes from the cluster (joint consensus or single-step, your choice)

---

## Features

### Client-Facing Key-Value API

- `GET /kv/:key` — retrieve a value; returns 404 if the key does not exist
- `PUT /kv/:key` with body `{ "value": "..." }` — set a value; must be processed by the leader; if this node is a follower, it returns a redirect hint (`{ "redirectTo": "http://leader-addr" }`)
- `DELETE /kv/:key` — delete a key; same leader-routing semantics as PUT
- `GET /cluster/status` — returns the current leader ID, current term, commit index, and a status summary for each known node

### Cluster Internals

- The cluster automatically elects a leader on startup. No manual configuration of a "primary" node is required.
- All reads and writes are linearizable: after a write is acknowledged, any subsequent read — to any node — reflects that write.
- The cluster survives the failure of a minority of nodes. In a 3-node cluster, 1 node can fail. In a 5-node cluster, 2 nodes can fail.
- A restarted node automatically rejoins and catches up to the current state via snapshot installation or incremental log replication.

### Observability

- `GET /metrics` — Prometheus-style text output with metrics: `raft_term`, `raft_role` (0=follower, 1=candidate, 2=leader), `raft_log_size`, `raft_commit_index`, `raft_leader_id_hash` (for Grafana display)
- Structured JSON logs on stdout: every state transition, every RPC sent and received, every commit

---

## The Challenge

This is not a project where you install a library and wire up a framework. You are implementing the Raft algorithm from the specification (Diego Ongaro's 2014 paper and thesis). The hard parts are:

**Election safety**: Two candidates may both believe they should be leader. Raft prevents split-brain through the "log up-to-date" check in RequestVote: a node only votes for a candidate whose log is at least as current as its own. Implement this incorrectly and you will have two leaders acknowledging conflicting writes.

**Log matching**: When a follower's log diverges from the leader's (e.g., after a network partition), the leader must find the exact point of divergence and overwrite the follower's log. Implement this incorrectly and committed entries will be lost.

**Commit index advancement**: The leader only advances its `commitIndex` when an entry has been replicated to a majority of nodes **and** that entry is from the leader's current term. This prevents a subtle bug where a log entry from a previous term is prematurely committed. This is Figure 8 in the Raft paper — the most commonly misunderstood aspect of Raft.

**Snapshot installation**: A node that has been down for a long time may be so far behind that it is impractical to send it the full log. The leader sends a snapshot instead. The follower must discard its log and replace it with the snapshot atomically.

**Persistence**: `currentTerm`, `votedFor`, and `log[]` must be written to durable storage before any RPC response is sent. A node that lies about its term or its vote after a restart will corrupt the cluster.

---

## Constraints

- **Language**: TypeScript, Node.js
- **No external consensus library**: You cannot use `raft-js`, `hashicorp/raft`, or any library that implements Raft, leader election, or distributed locking. The point is to implement the algorithm.
- **HTTP transport**: Client-facing API uses HTTP/JSON. Inter-node RPC also uses HTTP/JSON (simpler than gRPC for this project; the algorithm is what matters, not the transport).
- **Each node is a separate process**: Use `NODE_ID`, `NODE_PORT`, and `PEERS` environment variables to configure each node. Orchestrate with Docker Compose.
- **Persistence**: Use the local filesystem (append-only log file + metadata JSON). SQLite is also acceptable.
- **In-memory state machine**: The key-value store lives in memory. The snapshot serializes it to JSON on disk.

---

## Acceptance Criteria

### Scenario 1: Basic Operations

Start a 3-node cluster. Once a leader is elected:
- `PUT /kv/foo` with value `"bar"` returns `{ "ok": true }`
- `GET /kv/foo` on any node (including followers) returns `{ "value": "bar" }`
- `DELETE /kv/foo` returns `{ "ok": true }`
- `GET /kv/foo` returns 404

### Scenario 2: Leader Failure and Re-Election

Start a 3-node cluster. Send 10 writes. Kill the leader process (SIGKILL, not graceful shutdown). Within **5 seconds**, the remaining two nodes elect a new leader. Send 5 more writes to the new leader. All 15 writes are reflected on both surviving nodes.

### Scenario 3: Node Rejoin via Snapshot

Start a 3-node cluster. Kill one follower. Send 1500 writes (enough to trigger log compaction at threshold 1000). Restart the killed follower. It receives a snapshot from the leader and catches up. All keys written during its absence are now present on the rejoined node.

### Scenario 4: Follower Redirect

Send a `PUT /kv/bar` request directly to a follower node. The response is:
```json
{ "ok": false, "redirectTo": "http://node1:3001" }
```
The client follows the redirect and the write succeeds.

### Scenario 5: Observability

`GET /metrics` on the leader node returns text including:
```
raft_role 2
raft_term 3
raft_commit_index 15
raft_log_size 3
```

---

## What This Project Exercises

| Concept | Where Applied |
|---|---|
| **Distributed consensus** | Raft algorithm: election, replication, commitment |
| **State machines** | Key-value store driven by an ordered command log |
| **Fault tolerance** | Cluster survives minority failures; split-brain prevention |
| **Linearizability** | Reads reflect all prior acknowledged writes, across all nodes |
| **Log compaction** | Snapshots prevent unbounded log growth; InstallSnapshot RPC |
| **Persistence** | Write-ahead log for crash recovery; fsync before responding |
| **Timeouts and retries** | Election timeout, heartbeat interval, RPC retry with backoff |
| **Concurrency control** | Single-threaded Raft state machine with async I/O for RPCs |
| **Observability** | Prometheus metrics, structured logging, cluster status API |
| **Docker Compose orchestration** | Multi-node local cluster for manual and automated testing |
| **Network partition simulation** | Use `iptables` or `tc` to simulate partition; observe behavior |
