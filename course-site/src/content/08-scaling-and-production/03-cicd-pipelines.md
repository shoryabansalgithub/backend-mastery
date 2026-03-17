# Lesson 3: CI/CD Pipelines

## What CI/CD Actually Is

Continuous Integration and Continuous Delivery are not just "automated
testing" and "automated deployment." They are a discipline about how
software moves from a developer's machine to production, and how quickly
and safely that movement can happen.

The core insight: every minute a change sits unintegrated is a minute it
might be incompatible with another change. Every day code sits unreleased is
a day you have not learned whether it works in production. CI/CD is about
compressing that time to near zero.

**Continuous Integration** means every developer merges to the main branch
frequently — at minimum daily. Each merge triggers an automated process that
verifies the code: runs tests, checks types, lints, builds. If that process
fails, the team knows immediately and fixes it before moving forward. The
branch is always in a deployable state.

**Continuous Delivery** means that after CI passes, the software is
automatically prepared for release — built, packaged, pushed to a registry,
and deployed to a staging environment. Deploying to production may still be
a manual click, but it is always possible.

**Continuous Deployment** is Continuous Delivery with the manual gate
removed. Every commit that passes CI automatically ships to production.

The difference matters because many teams claim they "do CI/CD" but what
they actually do is run tests on PRs and deploy manually once a week. That
is not CI/CD. That is test automation with ad hoc deployment.

---

## GitHub Actions from First Principles

GitHub Actions is an event-driven automation platform built into GitHub.
When events happen on your repository (pushes, pull requests, issue
comments, schedule triggers, etc.), GitHub Actions executes workflows you
define.

### The core model

```
Repository event
    → triggers one or more Workflows
        → each Workflow contains one or more Jobs
            → each Job runs on a Runner
                → each Job contains one or more Steps
                    → each Step runs a shell command or an Action
```

### Workflow

A workflow is a YAML file in `.github/workflows/`. It defines when to run
(the trigger) and what to run (the jobs).

```yaml
# .github/workflows/ci.yml
name: CI

on:                           # Triggers
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:                       # Job name (arbitrary)
    runs-on: ubuntu-latest    # Runner
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
```

### Runner

A runner is the machine that executes a job. GitHub provides hosted runners
(`ubuntu-latest`, `windows-latest`, `macos-latest`). Each job gets a fresh,
clean virtual machine. `ubuntu-latest` is Linux x86-64, typically the
cheapest and fastest for server-side work.

Self-hosted runners are machines you control (your own servers, Kubernetes
pods) that connect to GitHub and pull jobs. Use them for: access to internal
resources, specific hardware requirements, cost optimization at high volume,
or persistent environments.

### Step

A step is one unit of work in a job. Steps run sequentially. A step can be
either:

1. A shell command via `run:`
2. An action via `uses:`

```yaml
steps:
  # Action: pre-built reusable step
  - uses: actions/checkout@v4

  # Shell command
  - run: npm ci

  # Shell command with a name for readability
  - name: Run tests
    run: npm test

  # Multi-line shell command
  - name: Build and tag
    run: |
      docker build -t myapp:${{ github.sha }} .
      docker tag myapp:${{ github.sha }} myapp:latest
```

### Action

An action is a reusable step, published to the GitHub Marketplace or
referenced from a repository. `actions/checkout@v4` checks out your code.
`actions/setup-node@v4` installs a specific Node.js version. `docker/login-
action@v3` authenticates to a container registry.

Actions are versioned by tag or SHA. Always pin to a specific version tag
(e.g., `@v4`) rather than `@main` or `@latest`, because unpinned actions
can introduce breaking changes silently. For the highest security, pin to
a full commit SHA.

### Context and expressions

GitHub Actions provides context objects that expose information about the
workflow run:

| Expression | Value |
|---|---|
| `${{ github.sha }}` | Full commit SHA |
| `${{ github.ref_name }}` | Branch or tag name |
| `${{ github.actor }}` | Username who triggered the run |
| `${{ github.repository }}` | `owner/repo` |
| `${{ github.event_name }}` | `push`, `pull_request`, etc. |
| `${{ runner.os }}` | `Linux`, `macOS`, `Windows` |
| `${{ secrets.MY_SECRET }}` | A repository secret |
| `${{ vars.MY_VAR }}` | A repository variable (non-secret) |

---

## Secrets Management in CI

Secrets are sensitive values (API keys, registry passwords, signing keys,
database URLs) that workflows need but must not appear in logs or source code.

GitHub stores secrets encrypted at rest and injects them into workflow runs
as environment variables. They are masked in log output — if a step
accidentally prints a secret, GitHub replaces it with `***`.

Set secrets via: GitHub repository settings → Secrets and variables →
Actions → New repository secret.

```yaml
steps:
  - name: Push to registry
    env:
      REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}   # Injected from secrets
    run: |
      echo "$REGISTRY_TOKEN" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
      docker push ghcr.io/${{ github.repository }}/myapp:latest
```

### Secret scopes

| Scope | Visibility |
|---|---|
| Repository secrets | Visible to workflows in that repository |
| Environment secrets | Visible only to jobs targeting that environment |
| Organization secrets | Visible to selected repositories in the organization |

Environment-scoped secrets are the right tool for deployment credentials.
Only jobs targeting the `production` environment can access production
secrets:

```yaml
jobs:
  deploy-production:
    environment: production     # Activates environment secrets
    steps:
      - run: deploy-script.sh
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}  # production-scoped secret
```

Environments also support protection rules: require manual approval, restrict
to specific branches, enforce wait timers. This is how you prevent
accidental production deployments.

---

## Common Workflow Patterns

### Pattern 1: Test on every PR

```yaml
name: CI

on:
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]    # Test against multiple Node versions

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test
        env:
          DATABASE_URL: postgresql://postgres:testpass@localhost:5432/testdb
```

The `services:` block starts containers alongside the job's runner. Unlike
Compose's `depends_on`, service containers in GitHub Actions use
`options: --health-cmd ...` to wait for readiness. The `ports:` mapping
exposes the container to `localhost` in the runner.

### Pattern 2: Build and push Docker image on merge to main

```yaml
name: Build and Push

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write    # Required to push to GHCR

    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}  # Automatic token, no setup needed

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=sha-         # sha-abc1234
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha      # Use GitHub Actions cache for Docker layers
          cache-to: type=gha,mode=max
```

`docker/build-push-action` integrates with BuildKit's caching. The
`cache-from: type=gha` pulls cached layers from GitHub Actions cache;
`cache-to: type=gha,mode=max` saves all intermediate layers, not just the
final image. This dramatically speeds up builds where only source code
changes (npm install layers are cached).

### Pattern 3: Deploy to staging, then production

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    # ... (same as above)

  build:
    needs: test
    # ... (same as above)
    outputs:
      image: ${{ steps.meta.outputs.tags }}

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging

    steps:
      - name: Deploy to staging
        run: |
          ssh deployer@staging.example.com \
            "docker pull ${{ needs.build.outputs.image }} && \
             docker compose -f /opt/app/docker-compose.yml up -d"
        env:
          SSH_PRIVATE_KEY: ${{ secrets.STAGING_SSH_KEY }}

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production     # Requires manual approval

    steps:
      - name: Deploy to production
        run: |
          ssh deployer@prod.example.com \
            "docker pull ${{ needs.build.outputs.image }} && \
             docker compose -f /opt/app/docker-compose.yml up -d"
        env:
          SSH_PRIVATE_KEY: ${{ secrets.PROD_SSH_KEY }}
```

The `needs:` key creates dependencies between jobs. Jobs run in parallel
unless `needs:` creates an ordering. The DAG (directed acyclic graph) of
jobs determines parallelism automatically.

---

## Deployment Strategies

The strategy you choose determines how users experience a deployment — whether
they see downtime, whether they can be served by old and new code simultaneously,
and how quickly you can roll back.

### Rolling deployment

Replace instances one at a time, or in small batches. At any point during
the deployment, some instances run old code and some run new. Users may hit
either. Requires backward-compatible API changes.

```
Before: [v1] [v1] [v1] [v1]
Step 1: [v2] [v1] [v1] [v1]
Step 2: [v2] [v2] [v1] [v1]
Step 3: [v2] [v2] [v2] [v1]
After:  [v2] [v2] [v2] [v2]
```

Rolling is the default in Kubernetes. Simple and resource-efficient, but
the mixed-version period can cause subtle bugs if your new and old code
interact through shared state.

### Blue-green deployment

Run two identical environments: blue (current production) and green (new
version). Deploy to green. Test green. Switch the load balancer to send
traffic to green. Blue becomes idle standby.

```
Load balancer → [blue: v1] [blue: v1]
                [green: v2] [green: v2]  (deployed, being tested)

Switch:
Load balancer → [green: v2] [green: v2]  (now production)
                [blue: v1] [blue: v1]    (idle, instant rollback)
```

Instant rollback: just switch the load balancer back to blue. Costs double
the resources during the transition. Clean version boundary — no mixed-version
period.

### Canary deployment

Route a small percentage of traffic (1%, 5%, 10%) to the new version.
Monitor error rates, latency, and business metrics. Gradually increase
the percentage if everything looks good. Roll back to 0% if anything goes
wrong.

```
95% → [v1] [v1] [v1]
 5% → [v2]
```

Best for catching bugs that only manifest with real user data. Requires a
load balancer with percentage-based routing (nginx weighted upstream, AWS
ALB weighted target groups, Kubernetes Argo Rollouts). The most operationally
complex but the safest.

---

## Zero-Downtime Deployments with Node.js

### The problem

When you deploy a new container, the old one stops and the new one starts.
During this window, requests that were in-flight on the old container may
be dropped. New requests may arrive before the new container is ready.

### SIGTERM and graceful shutdown

When an orchestrator (Docker, Kubernetes, a shell script) wants to stop a
container, it sends SIGTERM first. The process has `docker stop --time N`
seconds (default 10) to finish in-flight work and exit cleanly. If it does
not exit in time, the orchestrator sends SIGKILL, which is immediate and
uncatchable.

A Node.js server that handles SIGTERM correctly:

```typescript
import http from 'node:http';

const server = http.createServer(app);

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});

// Track in-flight requests
let connections = 0;
server.on('connection', () => connections++);
server.on('request', (_req, res) => {
  res.on('finish', () => connections--);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  // Step 1: Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed (no more new connections)');
  });

  // Step 2: Wait for in-flight requests with a timeout
  const shutdownTimeout = setTimeout(() => {
    console.error('Shutdown timeout — forcing exit');
    process.exit(1);
  }, 30_000);

  // Step 3: Close database connections
  try {
    await dbPool.end();
    console.log('Database pool closed');
  } catch (err) {
    console.error('Error closing database pool:', err);
  }

  // Step 4: Close Redis connections
  try {
    await redis.quit();
    console.log('Redis connection closed');
  } catch (err) {
    console.error('Error closing Redis connection:', err);
  }

  clearTimeout(shutdownTimeout);
  console.log('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C in development
```

### Health check during startup

The new container should not receive traffic until it is ready. Configure
your load balancer to only route to containers that pass their health check.
In Docker, the `HEALTHCHECK` instruction + `start_period` gives the container
time to initialize before health checks begin. In Kubernetes, `readinessProbe`
serves this purpose.

---

## Rollback Strategies

### Image tag rollback

If every deployment uses a specific image tag (e.g., the commit SHA), rolling
back is re-deploying a previous tag:

```bash
# Current deployment: ghcr.io/myorg/myapp:sha-abc1234
# Bad deployment detected — roll back to previous known good
docker compose set myapp image=ghcr.io/myorg/myapp:sha-def5678
docker compose up -d
```

This is why you should never deploy `latest` directly to production.
`latest` is mutable — you cannot roll back to a specific `latest` because
it changes. Tag with commit SHAs or semantic versions.

### Blue-green instant rollback

If running blue-green, the rollback is a load balancer switch — seconds,
not minutes. The old environment is intact and ready.

### Database migration rollbacks

Code rollbacks are easy. Database schema rollbacks are hard. If your new
deployment runs a migration (adds a column, renames a table), rolling back
the code does not roll back the migration. The old code may not handle the
new schema.

The safest strategy: make schema changes backward-compatible. Add new
columns as nullable. Keep old columns until you know the old code is gone.
Remove them in a separate migration, days or weeks later. This is the
"expand, contract" or "parallel change" pattern.

---

## Full GitHub Actions Workflow

Here is a production-grade workflow that ties everything together:

```yaml
# .github/workflows/ci-cd.yml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:

  # ============================================================
  # Job 1: Test
  # ============================================================
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
        options: >-
          --health-cmd "pg_isready -U testuser -d testdb"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
        ports:
          - 5432:5432

      redis:
        image: redis:7-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
        ports:
          - 6379:6379

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Run tests
        run: npm test -- --coverage
        env:
          NODE_ENV: test
          DATABASE_URL: postgresql://testuser:testpass@localhost:5432/testdb
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: test-secret-not-real

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        if: always()
        with:
          token: ${{ secrets.CODECOV_TOKEN }}

  # ============================================================
  # Job 2: Build Docker image (only on push to main)
  # ============================================================
  build:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    outputs:
      image-digest: ${{ steps.build.outputs.digest }}
      image-tag: sha-${{ github.sha }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest,enable=true

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          target: production
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BUILD_VERSION=${{ github.sha }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}

  # ============================================================
  # Job 3: Deploy to staging
  # ============================================================
  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.myapp.example.com

    steps:
      - name: Deploy to staging
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: deployer
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /opt/myapp
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            docker pull ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}
            APP_IMAGE=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }} \
              docker compose up -d --no-deps app

            # Wait for health check
            for i in $(seq 1 30); do
              if curl -sf http://localhost:3000/health; then
                echo "App is healthy"
                exit 0
              fi
              sleep 2
            done
            echo "App failed to become healthy"
            exit 1

  # ============================================================
  # Job 4: Deploy to production (requires manual approval)
  # ============================================================
  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://myapp.example.com

    steps:
      - name: Deploy to production
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PROD_HOST }}
          username: deployer
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/myapp
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            docker pull ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}
            APP_IMAGE=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }} \
              docker compose up -d --no-deps app

      - name: Verify production health
        run: |
          for i in $(seq 1 30); do
            if curl -sf https://myapp.example.com/health; then
              echo "Production deployment successful"
              exit 0
            fi
            sleep 5
          done
          echo "Production health check failed"
          exit 1

      - name: Notify on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "Production deployment FAILED for ${{ github.sha }}. Rollback manually if needed."
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

---

## Exercises

### Exercise 1: Your First Workflow

Create a GitHub repository with a Node.js application. Write a `.github/
workflows/ci.yml` that triggers on push and pull_request to main. The
workflow should: install Node 20, run `npm ci`, run `npm test`. Make a
change, push it, and watch the workflow run. Then intentionally break a
test and push again — observe the workflow fail and the red X appear on
the commit.

### Exercise 2: Matrix Builds

Extend your CI workflow to use a strategy matrix that tests on Node 18, 20,
and 22. Observe three parallel test jobs running. Add `fail-fast: false` to
the matrix strategy and intentionally make Node 18 fail but not 20 or 22.
Observe that without `fail-fast: false`, GitHub cancels all matrix jobs when
one fails; with it, the others complete.

### Exercise 3: Build and Push to GHCR

Add a second job to your workflow (conditioned on `push` to main only) that
builds a Docker image and pushes it to GitHub Container Registry using the
`GITHUB_TOKEN`. The job should depend on the test job. Use the commit SHA as
the image tag. After a successful run, install the image locally with
`docker pull ghcr.io/<your-username>/<your-repo>:sha-<commit>` and verify it
runs.

### Exercise 4: Secrets and Environments

Create two environments in your GitHub repository settings: `staging` and
`production`. Add a protection rule to `production` requiring one reviewer.
Add a secret `DEPLOY_MESSAGE` to each environment with different values.
Write a workflow with two deployment jobs: `deploy-staging` (targets the
`staging` environment) and `deploy-production` (targets `production`, needs
`deploy-staging`). Each job should `echo` the `DEPLOY_MESSAGE` secret. Push
to main and observe that the production job waits for manual approval.

### Exercise 5: Graceful Shutdown Test

Write a Node.js HTTP server that:
1. Has a `GET /slow` endpoint that takes 5 seconds to respond
2. Handles `SIGTERM` gracefully: stops accepting new connections, waits for
   in-flight requests, then exits

Write a test script that:
1. Starts the server
2. Makes a request to `/slow`
3. Immediately sends `SIGTERM` to the server process
4. Verifies the slow request still completes (not dropped)
5. Verifies the server does not accept new connections after SIGTERM

Add this as a step in your GitHub Actions workflow.

---

## Summary

| Concept | Key point |
|---|---|
| CI vs CD | CI = integrate frequently + auto-verify; CD = always releasable |
| Workflow | Triggered by events; contains jobs |
| Job | Runs on a fresh runner VM; contains steps |
| Runner | Clean VM per job; `ubuntu-latest` for server work |
| Action | Reusable step — pin to version tag, not `@main` |
| Secrets | Encrypted, masked in logs; scope to environments for deployment creds |
| Service containers | Spin up dependencies (DB, cache) alongside a job |
| Rolling deployment | Gradual replacement; mixed-version period |
| Blue-green | Two environments; instant rollback |
| Canary | Percentage-based traffic split; monitor before expanding |
| SIGTERM handling | The key to zero-downtime deployments |
| Image tagging | Use commit SHA, never deploy raw `latest` |

Next lesson: Observability — logs, metrics, and traces.
