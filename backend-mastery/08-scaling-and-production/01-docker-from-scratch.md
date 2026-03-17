# Lesson 1: Docker from Scratch

## The Problem Docker Solves

Before containers, deploying software meant managing dependencies on the
target machine directly. A Node.js app might need Node 20, a specific
version of OpenSSL, a particular libc version, and a timezone configured
correctly. The developer's machine had all of that. The production server
might not. The QA server was six months out of sync with both.

"Works on my machine" became a punchline because it was a genuine,
day-to-day obstacle. The traditional solution was the virtual machine: ship
an entire OS image alongside your app. This worked, but a VM with a full
Linux kernel, init system, and filesystem weighed gigabytes and took minutes
to boot. You were running a server inside a server.

Docker's insight was that you do not need to virtualize the kernel — you
only need to isolate the process. Linux already had the mechanisms to do
this. Docker made them approachable.

Understanding Docker at this level — what it actually does in the Linux
kernel — makes you a better operator. You stop treating containers as magic
boxes and start reasoning about what is actually happening when one starts.

---

## Linux Namespaces: The Isolation Primitive

A namespace wraps a global Linux resource and makes it appear, to the
processes inside, as if they have their own isolated instance of that
resource. Docker uses six of them.

### pid namespace

Normally, every process on a Linux machine has a globally unique process ID.
PID 1 is the init system. PID 1847 is your database. If your app spawns
a subprocess, both appear in the global process table.

In a pid namespace, the first process inside gets PID 1. It has its own
process tree. From inside the container, running `ps aux` shows only
container processes. From outside, the kernel still assigns host-level PIDs
to those processes — they are just mapped.

This matters for signals. PID 1 in a container receives signals that would
otherwise go to the host init. This is why Node.js apps often behave
strangely with SIGTERM unless you handle PID 1 carefully.

### net namespace

Each container gets its own network stack: interfaces, routing table, port
space. The container can listen on port 3000 without conflicting with any
other container also listening on port 3000. Docker bridges these isolated
stacks to the host via a virtual network interface (docker0 or custom
networks) and maps ports through NAT rules (iptables/nftables).

### mnt namespace

Mount points. Each container has its own view of the filesystem. The
container sees its own root filesystem rather than the host's. The host's
filesystem is invisible to the container unless explicitly mounted in.

### uts namespace

UTS stands for UNIX Time-sharing System. This namespace isolates the
hostname and domain name. Your container can have its own hostname
(`webapp-1`) without changing the host's hostname.

### ipc namespace

Isolates inter-process communication resources: System V IPC objects (shared
memory segments, message queues, semaphores) and POSIX message queues.
Processes in different containers cannot accidentally share IPC objects.

### user namespace

Maps user and group IDs inside the container to different IDs on the host.
This allows a container process to run as UID 0 (root) inside the container
while being mapped to an unprivileged UID on the host — a major security
improvement. Docker enables user namespaces by default only with specific
configuration, but rootless Docker uses them fully.

---

## cgroups: Resource Limits

Namespaces provide isolation. cgroups (control groups) provide resource
accounting and limits. Without cgroups, a container could consume all CPU
time, exhaust memory, and starve other processes. With them, you declare
limits the kernel enforces.

The kernel exposes cgroup configuration via a pseudo-filesystem, typically
mounted at `/sys/fs/cgroup`. Docker writes to this filesystem when you
use `--memory`, `--cpus`, or `--pids-limit`.

### CPU limits

`docker run --cpus="1.5" ...` tells the kernel to limit the container to
at most 1.5 CPU cores worth of time. Under the hood, this sets
`cpu.max` in cgroup v2 (or `cpu.cfs_quota_us` / `cpu.cfs_period_us` in
cgroup v1): if the period is 100ms, a quota of 150ms means the container
can run for 150ms out of every 100ms window across all CPUs.

### Memory limits

`docker run --memory="512m" ...` sets `memory.max`. If the container's
processes exceed 512 MB of resident memory, the kernel's OOM killer
terminates a process inside the container. This is why container OOM kills
surface as exit code 137 (128 + SIGKILL).

### Why this matters for Node.js

Node.js does not automatically know the container's memory limit. It reads
`/proc/meminfo`, which reports the host's total memory. The V8 heap size
defaults are based on that. A Node.js process in a 512 MB container on a
32 GB host will happily try to use gigabytes of heap before triggering an
OOM kill. You must explicitly set `--max-old-space-size`:

```dockerfile
ENV NODE_OPTIONS="--max-old-space-size=400"
```

Set this to roughly 80% of your container memory limit, leaving headroom
for the stack, native modules, and OS overhead.

---

## Overlay Filesystems: How Image Layers Work

A Docker image is not a single filesystem. It is a stack of read-only
layers, combined by the kernel's overlay filesystem driver.

Each `RUN`, `COPY`, or `ADD` instruction in a Dockerfile creates a new
layer. A layer is a diff: a record of what files were added, modified, or
deleted relative to the layer below it.

When you run a container, Docker mounts these layers using `overlayfs`:

```
Container writable layer (upperdir)
        ↑
Layer N: /app/dist/
        ↑
Layer N-1: node_modules installed
        ↑
Layer N-2: package.json + package-lock.json copied
        ↑
Layer 1: base OS (node:20-alpine)
```

The kernel merges these into a single coherent filesystem view. Reads come
from the highest layer that contains the file. Writes go to the writable
container layer (upperdir), leaving all read-only layers unchanged.

This is why images are shared efficiently: if ten containers use the same
Node 20 Alpine base layer, that layer exists once on disk and is shared
across all ten. Only the upper writable layer is per-container.

### Layer caching during builds

The build cache exploits this structure. When Docker builds an image, it
compares each instruction against cached layers. If the instruction and its
inputs are identical to a previous build, Docker reuses the cached layer and
skips the step. The moment any layer is invalidated, all subsequent layers
must be rebuilt.

This is the core insight for writing fast Dockerfiles: **put things that
change rarely near the top, things that change frequently near the bottom.**

If your Dockerfile starts with `COPY . .` followed by `RUN npm ci`, every
single code change invalidates the `COPY` layer and forces `npm ci` to
re-run. That is slow. Instead:

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
```

Now `npm ci` is only re-run when `package.json` or `package-lock.json`
change. Regular source changes only invalidate the final `COPY` layer.

---

## Dockerfile Instructions: What Each One Actually Does

### FROM

```dockerfile
FROM node:20-alpine AS base
```

Sets the base image. Everything starts here. `AS base` names this stage
for use in multi-stage builds. `node:20-alpine` is the official Node.js 20
image built on Alpine Linux — roughly 50 MB vs 1 GB for the Debian-based
image.

### RUN

```dockerfile
RUN npm ci --only=production
```

Executes a command during the build. Each `RUN` instruction creates a layer.
Chain related commands with `&&` to collapse them into one layer and avoid
bloat from intermediate states:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
```

### COPY

```dockerfile
COPY package.json package-lock.json ./
COPY --from=builder /app/dist ./dist
```

Copies files from the build context (or another stage) into the image.
Prefer `COPY` over `ADD` for local files. `ADD` has magic behavior (it
auto-extracts tarballs and fetches URLs) that can surprise you.

### WORKDIR

```dockerfile
WORKDIR /app
```

Sets the working directory for subsequent `RUN`, `COPY`, `CMD`, and
`ENTRYPOINT` instructions. Creates the directory if it does not exist.
Always use an absolute path. Always set `WORKDIR` rather than using `cd`
in `RUN` instructions.

### ENV

```dockerfile
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=400"
```

Sets environment variables that persist into the running container.
Be careful: secrets set via `ENV` are baked into the image and visible to
anyone who inspects it. Use Docker secrets or runtime environment variables
for sensitive values.

### EXPOSE

```dockerfile
EXPOSE 3000
```

Documents that the container listens on port 3000. This is metadata only —
it does not actually publish the port. Publishing requires `-p 3000:3000`
at runtime or the `ports` key in Compose. Expose is useful documentation.

### CMD vs ENTRYPOINT: The Real Difference

This is one of the most misunderstood aspects of Dockerfiles.

`ENTRYPOINT` sets the executable that runs when the container starts.
`CMD` provides default arguments to that executable.

When you run `docker run myimage`, the container runs:
`ENTRYPOINT + CMD`

When you run `docker run myimage custom-arg`, the CMD is overridden:
`ENTRYPOINT + custom-arg`

```dockerfile
# Pattern 1: CMD only (ENTRYPOINT defaults to /bin/sh -c)
CMD ["node", "dist/index.js"]
# docker run myimage → runs node dist/index.js
# docker run myimage bash → runs bash (overrides everything)

# Pattern 2: ENTRYPOINT + CMD
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
# docker run myimage → runs node dist/index.js
# docker run myimage dist/other.js → runs node dist/other.js
# docker run --entrypoint bash myimage → runs bash (must override entrypoint explicitly)
```

For a Node.js application that should always run Node and only allow the
script path to be overridden, use `ENTRYPOINT ["node"]` with `CMD
["dist/index.js"]`. For maximum flexibility (e.g., a development image
where you might want to `bash` in), use just `CMD`.

**Always use the exec form (JSON array) rather than the shell form (string):**

```dockerfile
# Shell form — runs through /bin/sh -c, which becomes PID 1
# Signals sent to PID 1 go to /bin/sh, not Node.js
CMD node dist/index.js

# Exec form — node becomes PID 1, receives signals directly
CMD ["node", "dist/index.js"]
```

This is critical for graceful shutdown. With the shell form, `docker stop`
sends SIGTERM to `/bin/sh`, which may not forward it to Node.js, and the
container gets killed after 10 seconds.

---

## Multi-Stage Builds: Why They Matter for Node.js

Without multi-stage builds, your production image contains everything used
during development: TypeScript, ts-node, all devDependencies, build tools.
That is hundreds of megabytes of unnecessary surface area — slower to push,
slower to pull, more vulnerabilities in your CVE scan.

Multi-stage builds let you use multiple `FROM` instructions in one
Dockerfile. Each stage can build on the previous or start fresh. Only the
final stage ships in the image.

The canonical pattern for a TypeScript Node.js app:

```dockerfile
# ---- Stage 1: deps ----
# Install all dependencies (including dev) for building
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Stage 2: builder ----
# Compile TypeScript
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: production ----
# Lean runtime image — no dev tools, no source code, no TypeScript compiler
FROM node:20-alpine AS production
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001 -G nodejs

# Copy only what's needed to run
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Runtime configuration
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=400"
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Run as non-root
USER nodeuser

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
```

The final image contains: Alpine Linux, Node.js runtime, production
node_modules, and your compiled JavaScript. No TypeScript, no build tools,
no source `.ts` files. A typical TypeScript app goes from 1.5 GB (with dev
deps) to ~150 MB.

---

## .dockerignore: What Not to Send

When you run `docker build`, Docker sends the entire build context (your
project directory) to the Docker daemon before processing a single
instruction. Without a `.dockerignore`, it sends `node_modules` (often
hundreds of MB), `.git`, test fixtures, and everything else — even if your
`COPY` instructions never reference them.

```
# .dockerignore
node_modules
npm-debug.log*
.git
.gitignore
.env
.env.*
*.md
*.test.ts
*.spec.ts
coverage/
dist/
.nyc_output/
.eslintrc*
.prettierrc*
docker-compose*.yml
Dockerfile*
```

Note: `.env` files should always be in `.dockerignore`. You do not want
secrets baked into the image.

---

## Running as Non-Root

By default, Docker containers run as root (UID 0). If a container is
compromised, the attacker has root inside it — and depending on your
configuration, potentially on the host.

The fix is straightforward. On Alpine Linux:

```dockerfile
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001 -G nodejs

# ... set up files as root ...

USER nodeuser
```

On Debian/Ubuntu-based images:

```dockerfile
RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nodeuser

USER nodeuser
```

Make sure files your app needs to write to (temp directories, log files
if logging to disk) are owned by that user. Everything in your app
directory should be readable by it.

---

## Health Checks in Docker

A health check tells Docker how to determine if a container is healthy.
Docker runs the check command periodically. If it fails enough times
consecutively, the container is marked `unhealthy`. Orchestrators like
Kubernetes and Docker Swarm can restart unhealthy containers automatically.

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1
```

- `--interval=30s`: Check every 30 seconds
- `--timeout=10s`: Consider the check failed if it takes more than 10 seconds
- `--start-period=15s`: Wait 15 seconds before starting checks (startup grace period)
- `--retries=3`: Unhealthy after 3 consecutive failures

Use `wget` rather than `curl` in Alpine images — `curl` must be installed
separately, but `wget` is included. The `|| exit 1` ensures a non-zero
exit code on failure.

Your `/health` endpoint should verify that critical dependencies (database
connection, cache connection) are reachable, not just that the HTTP server
is running.

---

## Complete Multi-Stage Dockerfile

Here is a production-grade Dockerfile for a TypeScript Express application:

```dockerfile
# ===================================================================
# Stage 1: Install all dependencies
# ===================================================================
FROM node:20-alpine AS deps
WORKDIR /app

# Copy lockfile first — this layer is cached unless lockfile changes
COPY package.json package-lock.json ./
RUN npm ci

# ===================================================================
# Stage 2: Build TypeScript
# ===================================================================
FROM node:20-alpine AS builder
WORKDIR /app

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

# ===================================================================
# Stage 3: Production image
# ===================================================================
FROM node:20-alpine AS production
WORKDIR /app

# Security: create non-root user
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001 -G nodejs

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --only=production \
    && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy any static assets or config files needed at runtime
# COPY --from=builder /app/public ./public

# Runtime environment
ENV NODE_ENV=production
ENV PORT=3000
# Reserve ~80% of container memory limit for V8 heap
ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

HEALTHCHECK \
    --interval=30s \
    --timeout=10s \
    --start-period=15s \
    --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Drop privileges
USER nodeuser

# Use exec form so node is PID 1 and receives signals
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
```

### Build and run it:

```bash
# Build the image
docker build -t myapp:latest .

# Run it
docker run \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host/db" \
  --memory="512m" \
  --cpus="0.5" \
  myapp:latest

# Inspect layers
docker history myapp:latest

# Check health status
docker inspect myapp-container | jq '.[0].State.Health'
```

### Image size comparison

| Approach | Approximate size |
|---|---|
| Single stage with all devDeps | 1.2 – 2.0 GB |
| Single stage, production deps only | 400 – 600 MB |
| Multi-stage, Alpine base | 100 – 200 MB |
| Multi-stage, distroless base | 80 – 150 MB |

Smaller images pull faster, scan faster, and present a smaller attack
surface. The 90 seconds you spend structuring a multi-stage build correctly
pays dividends on every deployment.

---

## Image Layer Caching in Practice

Understanding exactly what invalidates a cache layer lets you structure
your Dockerfile for maximum cache efficiency:

| What changes | Layers invalidated |
|---|---|
| Source code (`.ts` files) | Only the `COPY src` layer onward |
| `package.json` or lockfile | `COPY package*.json` + `npm ci` + everything after |
| `tsconfig.json` | `COPY tsconfig.json` + `RUN npm run build` onward |
| Base image tag (`node:20-alpine`) | Everything (complete rebuild) |
| `ENV` instruction value | That layer and everything after |

The order of operations in the Dockerfile above is deliberate:
1. Copy lockfiles → install all deps (cached unless deps change)
2. Copy source → build (cached unless source changes, but using node_modules from step 1)
3. Final stage: copy lockfiles → install prod deps (separate cache from step 1)
4. Copy compiled output (only invalidated by source changes)

---

## Exercises

### Exercise 1: Build and Inspect

Take any Node.js project (or create one with a single `index.js` that
starts an HTTP server on port 3000). Write a Dockerfile for it — no
multi-stage yet. Build it, run it, and verify it works. Then:

1. Run `docker history <image>` and identify each layer and its size.
2. Run `docker inspect <container>` and find the PID namespace, IP address,
   and mount points.
3. Make a trivial change to `index.js` and rebuild. Observe which layers
   were cached.
4. Move your `npm install` AFTER `COPY . .` and rebuild. Observe that
   `npm install` re-runs on every change.

### Exercise 2: Multi-Stage Build

Convert a TypeScript project to a multi-stage Dockerfile (or write one
from scratch). Measure the image size at each stage:

```bash
docker build --target deps -t myapp:deps .
docker build --target builder -t myapp:builder .
docker build --target production -t myapp:prod .
docker images myapp
```

Confirm that the production image does NOT contain `.ts` files, `tsconfig.json`,
or devDependencies like `typescript` and `ts-node`. Use `docker run --rm
myapp:prod ls /app` and `docker run --rm myapp:prod ls /app/node_modules/.bin`
to verify.

### Exercise 3: Signal Handling

Create a Node.js server with this in `index.js`:

```javascript
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  process.exit(0);
});
```

Build two images: one using the shell form for `CMD` (`CMD node index.js`)
and one using exec form (`CMD ["node", "index.js"]`). Run both containers.
Run `docker stop <container>` on each. Use `docker logs` to see which one
logs the SIGTERM message. Explain why there is a difference.

### Exercise 4: Non-Root and File Permissions

Build an image that runs as a non-root user. Add a feature: the app writes
to a file in `/app/logs/app.log`. Notice it fails because the non-root user
does not have write permission. Fix it by:

1. Creating the directory in the Dockerfile as root before switching users.
2. Changing ownership to the non-root user.

Verify that `docker run --rm myapp id` shows the non-root UID, and the app
can still write to the log file.

### Exercise 5: cgroup Limits and the OOM Killer

Write a Node.js script that intentionally consumes memory in a loop:

```javascript
const chunks = [];
setInterval(() => {
  chunks.push(Buffer.alloc(10 * 1024 * 1024)); // 10 MB every second
  console.log(`Heap used: ${process.memoryUsage().heapUsed / 1024 / 1024} MB`);
}, 1000);
```

Build it into an image. Run it with `--memory="128m"`. Observe the OOM kill
(`exit code 137`). Then add `--max-old-space-size=100` to `NODE_OPTIONS` and
re-run. Observe Node.js's own heap limit trigger before the OS OOM killer,
resulting in a different error. Document the difference.

---

## Summary

| Concept | What it does |
|---|---|
| pid namespace | Isolated process IDs; container processes have their own PID tree |
| net namespace | Isolated network stack; containers own their port space |
| mnt namespace | Isolated filesystem view |
| uts namespace | Isolated hostname |
| cgroups | CPU, memory, PID limits enforced by the kernel |
| Overlay filesystem | Read-only layers + writable container layer |
| Layer caching | Build speed; order instructions from least to most volatile |
| Multi-stage build | Lean production images without build tools or devDeps |
| Exec form CMD | Node.js receives signals directly as PID 1 |
| Non-root user | Limits blast radius if container is compromised |
| HEALTHCHECK | Lets Docker (and orchestrators) detect unhealthy containers |

Next lesson: Docker Compose — orchestrating multiple containers locally.
