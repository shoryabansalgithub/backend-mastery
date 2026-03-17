# Lesson 2: Docker Compose and Local Development

## Why Compose Exists

A single `docker run` command with all its flags quickly becomes
unmanageable. By the time you have a database, a cache, and your app, you
are juggling three terminals, three port mappings, two volume definitions,
a shared network, and environment variables scattered across your shell
history.

Docker Compose solves the operational problem of multi-container applications
during development. It lets you describe your entire local environment in
a single YAML file and spin it up with one command: `docker compose up`.
Everything starts, everything is networked together, and everything tears
down cleanly with `docker compose down`.

Compose is also a useful mental model for production: it forces you to think
explicitly about the dependencies between services, the environment each
needs, and the data each persists. The thinking you do in Compose informs
how you structure Kubernetes manifests, Terraform configs, and production
deployments later.

This lesson covers the Compose file format deeply, then builds a realistic
local development stack: a Node.js application with PostgreSQL and Redis.

---

## The Compose File Format

Modern Compose uses `docker-compose.yml` (or `compose.yml` — Docker now
prefers the shorter name). The top-level keys are:

```yaml
version: "3.9"   # Compose file format version (optional in modern Docker)

services:         # The containers you want to run
  app:
    ...
  db:
    ...

networks:         # Custom networks
  backend:
    ...

volumes:          # Named volumes for persistent data
  postgres_data:
    ...
```

The `version` field is optional in Docker Compose v2 (the current CLI).
You will still see it in most real projects because older tooling required
it. It does not hurt to include it.

---

## Services: The Core Unit

Each key under `services` defines one container.

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: production        # Stop at this multi-stage build stage
    image: myapp:local          # Tag the built image
    container_name: myapp       # Predictable container name (avoid in prod)
    restart: unless-stopped     # Restart policy
    ports:
      - "3000:3000"             # host:container
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://user:pass@db:5432/mydb
    env_file:
      - .env                    # Load from file (merged with environment:)
    depends_on:
      db:
        condition: service_healthy
    networks:
      - backend
    volumes:
      - ./src:/app/src:ro       # Bind mount for hot reload
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "0.5"
```

### restart policies

| Policy | Behavior |
|---|---|
| `no` (default) | Never restart |
| `always` | Always restart, even on clean exit |
| `unless-stopped` | Restart unless explicitly stopped by the user |
| `on-failure` | Restart only on non-zero exit code |

For local dev, `unless-stopped` is convenient: your app comes back after a
host reboot. For CI, `no` is correct: you want to know if something fails.

---

## Service Dependencies: depends_on and the Real Problem

`depends_on` tells Compose to start dependencies before the dependant. But
it does not tell Compose to wait until the dependency is *ready*. By default,
`depends_on: db` means "start `db` first, then immediately start `app`,"
which might start `app` before PostgreSQL has finished its initialization and
is accepting connections.

### The naive (broken) approach

```yaml
services:
  app:
    depends_on:
      - db      # Only guarantees db CONTAINER started, not that PostgreSQL is ready
```

### The correct approach: condition: service_healthy

If your dependency defines a health check, you can wait for it to become
healthy:

```yaml
services:
  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

  app:
    depends_on:
      db:
        condition: service_healthy   # Wait until db is healthy
      redis:
        condition: service_healthy
```

This is the correct approach and does not require external tools like
`wait-for-it.sh` or `dockerize`. The `service_healthy` condition is
available in Compose v2 and Docker Compose 3.4+.

### wait-for-it as a fallback

If the dependency does not define a health check (e.g., a third-party image
you cannot modify), the classic approach is to embed a wait script:

```dockerfile
# In your Dockerfile
COPY wait-for-it.sh /wait-for-it.sh
RUN chmod +x /wait-for-it.sh
```

```yaml
services:
  app:
    command: ["/wait-for-it.sh", "db:5432", "--", "node", "dist/index.js"]
```

This is a workaround. Prefer health checks.

---

## Environment Variables in Compose

Compose supports multiple ways to inject environment variables, and they
interact in ways that are easy to get wrong.

### Option 1: Inline in the service definition

```yaml
services:
  app:
    environment:
      NODE_ENV: production
      PORT: "3000"
```

Fine for non-secret values. These are visible in version control.

### Option 2: Pass-through from the host shell

```yaml
services:
  app:
    environment:
      - DATABASE_URL          # No = means: take from host shell environment
```

If `DATABASE_URL` is set in your shell, Compose passes it through. If it
is not set, the variable is not set in the container either. Useful for
CI systems that set secrets as environment variables.

### Option 3: .env file

Compose automatically reads `.env` from the project root. Variables defined
there are available in the Compose file itself as variable substitution:

```
# .env
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mysecret
POSTGRES_DB=mydb
```

```yaml
services:
  db:
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
```

You can also load a `.env` file into the container directly with `env_file`:

```yaml
services:
  app:
    env_file:
      - .env
      - .env.local    # Overrides .env if it exists
```

### The critical distinction

Variables in `.env` that Compose reads for interpolation inside the YAML
file are **not** automatically passed to the container. They are only
available as `${VAR}` substitutions in the YAML itself. To pass them to
the container, you must either list them under `environment:` or use
`env_file:`.

Always add `.env` to `.gitignore`. Create `.env.example` with the keys
but not the values for documentation.

---

## Named Volumes vs Bind Mounts

This distinction matters and is frequently confused.

### Named volumes

```yaml
services:
  db:
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:   # Docker manages this volume
```

A named volume is managed by Docker. The data lives in Docker's internal
storage area (typically `/var/lib/docker/volumes/` on Linux). You do not
see it as a directory on your host filesystem. It survives `docker compose
down` but is deleted by `docker compose down -v`.

Use named volumes for: database data, anything that must persist across
container restarts, anything you do not need to directly edit on the host.

Named volumes have much better I/O performance than bind mounts on Docker
Desktop (macOS, Windows) because they live in the Linux VM rather than
being shared across the VM boundary.

### Bind mounts

```yaml
services:
  app:
    volumes:
      - ./src:/app/src:ro   # Host path:container path:options
```

A bind mount mirrors a host directory into the container. Changes on the
host appear immediately inside the container, and vice versa. This is the
key mechanism for hot reload in development — your editor saves a file,
your file watcher inside the container picks it up.

The `:ro` option makes the bind mount read-only inside the container.
Use `:ro` for source code that the container should read but not modify.

Use bind mounts for: source code during development, configuration files,
SSL certificates.

**Do not use bind mounts for node_modules.** If you bind-mount `.:/app`,
your container's `/app/node_modules` gets replaced by the host's
`node_modules`, which may be built for a different OS (macOS vs Linux).
The standard fix:

```yaml
services:
  app:
    volumes:
      - .:/app                          # Bind mount everything...
      - /app/node_modules               # ...but keep container's node_modules
```

The second volume entry is an anonymous volume that shadows the host's
`node_modules`. The container's npm-installed modules (built for Linux)
are preserved.

---

## Networking Between Containers

When you define services in Compose, they are placed on a shared network
by default (named after your project). Containers can reach each other by
service name.

If your `db` service is named `db`, your app connects to it at host `db`:

```typescript
const pool = new Pool({
  host: 'db',       // Service name, resolved by Docker's internal DNS
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});
```

This works because Docker runs an internal DNS server that maps service
names to container IP addresses. You never need to hardcode IPs.

### Custom networks

The default network works fine for simple setups. Custom networks give you
control over isolation:

```yaml
networks:
  frontend:    # Only the app and the load balancer are here
  backend:     # Database and cache are only on this network

services:
  nginx:
    networks:
      - frontend
  app:
    networks:
      - frontend
      - backend
  db:
    networks:
      - backend    # Not reachable from nginx
  redis:
    networks:
      - backend    # Not reachable from nginx
```

This mirrors real security architecture: your database should not be
reachable from the public-facing load balancer, only from the application.

---

## Compose Profiles: Dev vs Prod

Profiles let you define services that only start under certain conditions.
This is useful for development-only tools (adminer, pgadmin, redis-commander)
that you do not want in CI or production-mimicking environments.

```yaml
services:
  app:
    # No profile — always starts

  db:
    # No profile — always starts

  adminer:
    image: adminer
    profiles: [dev]           # Only starts with: docker compose --profile dev up
    ports:
      - "8080:8080"
    depends_on:
      - db

  redis-commander:
    image: rediscommander/redis-commander
    profiles: [dev]
    ports:
      - "8081:8081"
    environment:
      - REDIS_HOSTS=local:redis:6379
    depends_on:
      - redis
```

```bash
# Start everything including dev tools
docker compose --profile dev up

# Start only the core services (no dev tools)
docker compose up
```

---

## docker-compose.override.yml

Docker Compose automatically merges `docker-compose.override.yml` on top
of `docker-compose.yml`. This is the official mechanism for local
customizations that should not go into the main file.

The override file is additive: keys in the override merge into the base,
with overrides taking precedence for scalar values.

```yaml
# docker-compose.yml (committed to git)
services:
  app:
    image: myapp:${APP_VERSION:-latest}
    environment:
      NODE_ENV: production

# docker-compose.override.yml (in .gitignore for personal overrides)
# OR committed for a dev-specific setup
services:
  app:
    build:
      context: .
      target: development     # Use dev stage instead of production
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
    volumes:
      - ./src:/app/src:ro
      - /app/node_modules
    command: ["node", "--watch", "src/index.js"]
```

The canonical pattern:
- `docker-compose.yml`: production-mirroring configuration, committed
- `docker-compose.override.yml`: developer-specific overrides, in `.gitignore`
  (so each developer can have their own)

Or:
- `docker-compose.yml`: base configuration
- `docker-compose.dev.yml`: development overrides (committed, explicit)
- `docker-compose.prod.yml`: production overrides (committed, explicit)

Used with: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`

---

## Complete Example: Node.js + PostgreSQL + Redis

Here is a full `docker-compose.yml` for a realistic local development setup:

```yaml
# docker-compose.yml
version: "3.9"

services:

  # -------------------------------------------------------
  # Application
  # -------------------------------------------------------
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: production
    container_name: myapp
    restart: unless-stopped
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - backend
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "0.5"

  # -------------------------------------------------------
  # PostgreSQL
  # -------------------------------------------------------
  db:
    image: postgres:16-alpine
    container_name: myapp-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-myuser}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-mysecret}
      POSTGRES_DB: ${POSTGRES_DB:-mydb}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro  # SQL scripts run on first start
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-myuser} -d ${POSTGRES_DB:-mydb}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 256m

  # -------------------------------------------------------
  # Redis
  # -------------------------------------------------------
  redis:
    image: redis:7-alpine
    container_name: myapp-redis
    restart: unless-stopped
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    networks:
      - backend
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 192m

  # -------------------------------------------------------
  # Development tools (only with --profile dev)
  # -------------------------------------------------------
  adminer:
    image: adminer:latest
    container_name: myapp-adminer
    profiles: [dev]
    restart: unless-stopped
    ports:
      - "8080:8080"
    networks:
      - backend
    depends_on:
      - db

  redis-commander:
    image: rediscommander/redis-commander:latest
    container_name: myapp-redis-commander
    profiles: [dev]
    restart: unless-stopped
    ports:
      - "8081:8081"
    environment:
      REDIS_HOSTS: "local:redis:6379"
    networks:
      - backend
    depends_on:
      - redis

# -------------------------------------------------------
# Volumes
# -------------------------------------------------------
volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local

# -------------------------------------------------------
# Networks
# -------------------------------------------------------
networks:
  backend:
    driver: bridge
```

```yaml
# docker-compose.override.yml (for local development)
version: "3.9"

services:
  app:
    build:
      target: development         # Use dev stage of multi-stage build
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
    volumes:
      - ./src:/app/src:ro         # Hot reload source
      - /app/node_modules         # Keep container's node_modules
    command: ["node", "--watch", "src/index.js"]
```

```
# .env (never commit — add to .gitignore)
POSTGRES_USER=myuser
POSTGRES_PASSWORD=supersecretpassword
POSTGRES_DB=mydb
JWT_SECRET=a-very-long-random-secret-string-here
APP_PORT=3000
```

```
# .env.example (commit this — documents required variables)
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=
JWT_SECRET=
APP_PORT=3000
```

### Common Compose commands

```bash
# Start all services (builds if needed)
docker compose up --build

# Start in background
docker compose up -d

# Start with dev profile
docker compose --profile dev up -d

# View logs (follow mode)
docker compose logs -f app

# View logs for specific service
docker compose logs -f db

# Run a one-off command in a service container
docker compose exec app sh
docker compose exec db psql -U myuser -d mydb

# Run migrations (without starting the app)
docker compose run --rm app node dist/migrate.js

# Stop and remove containers (preserves volumes)
docker compose down

# Stop and remove containers AND volumes (destroys data)
docker compose down -v

# Rebuild a specific service
docker compose build app

# Scale a service
docker compose up -d --scale app=3

# Check status
docker compose ps
```

---

## Health Check Integration and Dependency Resolution

Understanding the full lifecycle when you run `docker compose up`:

1. Compose creates networks and volumes defined in the file
2. Compose starts services with no `depends_on` dependencies first
3. For services with `depends_on: condition: service_healthy`, Compose
   polls the dependency's health check, retrying at the defined interval
4. Once the dependency reports `healthy`, Compose starts the dependent
5. If a dependency never becomes healthy (all retries exhausted), Compose
   exits with an error

This means your health checks must be accurate. A health check that always
passes (or a missing health check) defeats the purpose. Test your health
checks explicitly:

```bash
# Manually run a container's health check command
docker compose exec db pg_isready -U myuser -d mydb

# Inspect health status
docker inspect myapp-db | jq '.[0].State.Health'

# Watch health status change over time
watch -n 2 'docker compose ps'
```

---

## Exercises

### Exercise 1: Full Stack Bootstrap

Create a `docker-compose.yml` for a Node.js app + PostgreSQL + Redis. Write
a simple Express server that:
- Connects to PostgreSQL (create a `health_checks` table on startup)
- Connects to Redis (ping on startup)
- Returns `{ status: "ok", db: true, redis: true }` at `GET /health`

Run `docker compose up --build`. Verify all three containers start, the
app logs successful connections, and `GET /health` returns a healthy response.

### Exercise 2: Volume Persistence

Start your Compose stack. Connect to PostgreSQL with `docker compose exec db
psql` and insert a row into a table. Run `docker compose down`. Then run
`docker compose up -d` again. Verify the row still exists. Now run `docker
compose down -v`. Start again. Verify the row is gone. This proves named
volumes persist across container restarts but not volume deletion.

### Exercise 3: Development Overlay

Add a `docker-compose.override.yml` that changes your app service to use a
development Node image, mount the source code as a bind mount, and run
`node --watch` for hot reload. Add a dev-only `mailhog` service for email
testing. Run `docker compose up` and verify the override is applied. Then
run `docker compose -f docker-compose.yml up` (explicitly ignoring the
override) and verify it uses the production configuration.

### Exercise 4: Broken Dependency

Comment out the health check from your PostgreSQL service definition.
Change your app's `depends_on` to use `condition: service_started` instead
of `condition: service_healthy`. Slow down your PostgreSQL startup by
adding `sleep 10 &&` before the startup command. Start the stack and observe
your app failing to connect. Restore the health check and `service_healthy`
condition. Start again and observe the dependency waiting correctly.

### Exercise 5: Resource Limits Under Load

Add `deploy.resources.limits` to all your services (app: 256m memory, db:
128m memory, redis: 64m memory). Install `hey` or `k6` locally. Start the
stack and hit your API with 100 concurrent requests for 30 seconds. Use
`docker stats` in another terminal to observe memory and CPU consumption.
Tighten the limits until you find the minimum that the app can run under
without getting OOM-killed. Document your findings.

---

## Summary

| Concept | When to use |
|---|---|
| Named volumes | Persistent data (databases, uploads) — survives restarts |
| Bind mounts | Source code during development — enables hot reload |
| `condition: service_healthy` | Always, when depending on a service that takes time to initialize |
| `.env` file | Local secrets — never commit to git |
| `env_file:` | Pass environment file contents into a container |
| Profiles | Development-only tools (database GUIs, mail catchers) |
| Override file | Local developer customizations on top of committed base config |
| Custom networks | Isolate groups of services from each other |

Next lesson: CI/CD pipelines — automating test, build, and deployment with
GitHub Actions.
