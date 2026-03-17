# Backend Mastery: TypeScript

> Build production-grade backend systems from first principles.

---

## Welcome

Backend Mastery is a hands-on, project-driven course that takes you from TypeScript
fundamentals to deploying production systems. Every module teaches concepts through
**first principles** -- you'll understand *why* things work, not just *how* to copy-paste
them.

Each module ends with a project that forces you to synthesize everything you learned.
There are no shortcuts. By the end, you'll have built a portfolio of real backend systems.

---

## Prerequisites

- **Basic JavaScript knowledge**: variables, functions, arrays, objects, loops.
  You don't need to be an expert, but you should be able to write a simple program.
- **A terminal**: You'll live in the terminal. Get comfortable with `cd`, `ls`, `mkdir`.
- **Node.js 20+**: Install from [nodejs.org](https://nodejs.org).
- **A code editor**: VS Code recommended (TypeScript support is excellent).
- **Curiosity**: The most important prerequisite. You'll be asked to think, not just type.

---

## Course Modules

### Module 0: Foundations
**Directory:** `00-foundations/`

The bedrock everything else builds on. TypeScript's type system for backend work,
how Node.js actually executes your code, async patterns that go beyond `async/await`,
and error handling that doesn't rely on `try/catch` everywhere.

**Project:** TaskForge CLI -- A command-line task manager with file-based persistence.

---

### Module 1: HTTP from Scratch
**Directory:** `01-http-from-scratch/`

Build an HTTP server using only `net.createServer()`. Parse raw HTTP requests by hand.
Understand what Express hides from you. Implement routing, middleware, and content
negotiation from the ground up.

**Project:** Build a minimal HTTP framework and use it to serve a REST API.

---

### Module 2: Databases & Data Modeling
**Directory:** `02-databases/`

SQL fundamentals with PostgreSQL. Schema design, migrations, indexes, query planning
with `EXPLAIN ANALYZE`. ORMs vs query builders vs raw SQL -- the real tradeoffs.
Connection pooling and transaction isolation levels.

**Project:** Design and implement the database layer for a multi-tenant SaaS application.

---

### Module 3: Authentication & Authorization
**Directory:** `03-auth/`

Sessions vs JWTs (and why the internet argues about this). Password hashing with bcrypt
and argon2. OAuth 2.0 and OpenID Connect flows. Role-based and attribute-based access
control. CSRF, XSS, and the security headers that matter.

**Project:** Build a complete auth system with registration, login, password reset,
and role-based permissions.

---

### Module 4: API Design
**Directory:** `04-api-design/`

REST constraints (most "REST" APIs aren't RESTful). GraphQL -- when it helps and when
it hurts. gRPC and Protocol Buffers for service-to-service communication. API versioning,
pagination, rate limiting, and documentation with OpenAPI.

**Project:** Build the same API in REST, GraphQL, and gRPC. Compare the tradeoffs.

---

### Module 5: Testing & Reliability
**Directory:** `05-testing/`

Unit tests, integration tests, and end-to-end tests -- what each actually proves.
Test doubles (mocks, stubs, fakes, spies) and when each is appropriate. Property-based
testing. Load testing with k6. Chaos engineering basics.

**Project:** Add comprehensive tests to your Module 4 API. Hit 90%+ meaningful coverage.

---

### Module 6: Caching & Performance
**Directory:** `06-caching/`

CPU caches to Redis -- caching at every layer. Cache invalidation strategies (the hard
problem). CDNs, HTTP caching headers, application-level caching. Profiling Node.js
applications. Memory leaks and how to find them.

**Project:** Add caching layers to your API. Benchmark before and after.

---

### Module 7: Message Queues & Background Jobs
**Directory:** `07-queues/`

Why synchronous request/response isn't enough. Message brokers (RabbitMQ, Redis Streams).
Pub/sub vs point-to-point. Dead letter queues. Idempotency and exactly-once processing.
Saga pattern for distributed transactions.

**Project:** Build an email notification system with retry logic and dead letter handling.

---

### Module 8: Deployment & Operations
**Directory:** `08-deployment/`

Docker from first principles (namespaces, cgroups, overlay filesystems). Docker Compose
for local development. CI/CD pipelines. Health checks, graceful shutdown, and zero-downtime
deploys. Structured logging with Pino. Metrics with Prometheus. Distributed tracing.

**Project:** Containerize and deploy your application with full observability.

---

### Module 9: System Design Capstone
**Directory:** `09-capstone/`

Put it all together. Design a system that handles real-world requirements: high
availability, horizontal scaling, data consistency, and fault tolerance. You'll make
architectural decisions and defend them.

**Project:** Design and build a URL shortener that handles 10,000 requests/second.
Includes database sharding, caching, rate limiting, and analytics.

---

## How to Navigate This Course

Each module directory contains:

```
XX-module-name/
  01-lesson-topic.md        # Lesson content
  02-another-topic.md       # Lesson content
  ...
  project/
    README.md               # Project requirements
    starter/                # Starter code (your starting point)
    solution-locked/        # Encrypted solutions
```

### Workflow

1. **Read the lessons in order.** Each one builds on the previous.
2. **Type every code example yourself.** Do not copy-paste. Your fingers need to learn.
3. **Do the exercises** at the end of each lesson. They're not optional.
4. **Build the project** using only the starter code. Struggle is the point.
5. **Unlock the solution** only after you've attempted the project yourself.

### Unlocking Solutions

Solutions are locked to prevent peeking. Once you've genuinely attempted the project:

```bash
./unlock.sh <module-number> <password>
```

Passwords are earned by completing each module's exercises. The password for Module 0
is revealed after completing all four lesson exercise sets.

> **Honor system:** You could read the solution files directly -- they're just files on
> disk. But you'd only be cheating yourself. The struggle of building something from
> scratch is where the learning happens.

---

## Philosophy

1. **First principles over frameworks.** Frameworks change. Principles don't.
2. **Struggle is learning.** If it feels easy, you're not growing.
3. **Bad code teaches.** We show broken code on purpose. Understanding *why* it's broken
   matters more than memorizing the fix.
4. **Production matters.** Every concept is taught in the context of real systems.
5. **Depth over breadth.** We'd rather you deeply understand 10 things than superficially
   know 100.

---

## Technical Setup

```bash
# Verify your environment
node --version    # Should be 20+
npm --version     # Should be 9+
tsc --version     # Install: npm install -g typescript

# For each project
cd XX-module-name/project/starter
npm install
npm run dev
```

---

## License

This course material is for personal learning use. Do not redistribute.

---

*Built with care. No AI-generated filler. Every sentence is intentional.*
