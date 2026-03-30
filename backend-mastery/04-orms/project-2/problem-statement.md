# Project: TenantKit — Multi-Tenant SaaS API

## Context

You're building the backend for a project management SaaS — think a stripped-down Linear or Jira. The product has multiple customers (organizations), each with their own users, projects, and tasks. The most critical requirement: **zero cross-tenant data leakage**. Organization A must never see Organization B's data, even if a developer makes a mistake in a query.

This project teaches you how to build a real, production-grade multi-tenant API using Drizzle ORM — and how to make tenant isolation a structural guarantee, not a manual checklist.

---

## What You're Building

**TenantKit** is a REST API for a project management tool with these resources:

```
Organization → has many → Members (Users)
Organization → has many → Projects
Project      → has many → Tasks
Task         → has many → Comments
Task         → has many → Labels (many-to-many)
```

### Core Features

1. **Multi-tenancy** — Every resource belongs to an organization. Middleware extracts `orgId` from the authenticated user's JWT and injects it into every query. A query missing the `orgId` filter should fail at the type level.

2. **Soft deletes** — Records are never permanently deleted. Instead, a `deletedAt` timestamp is set. All queries must automatically filter out soft-deleted records.

3. **Audit log** — Every create, update, and delete is recorded in an `audit_events` table: who did it, what changed, when. This is a compliance requirement.

4. **Cursor-based pagination** — All list endpoints use keyset pagination (no `OFFSET`). Clients receive a `nextCursor` token to fetch the next page.

5. **Full-text search** — Tasks and comments are searchable by content. Must use PostgreSQL's `pg_trgm` extension via a GIN index — not `ILIKE '%query%'` (no seq scan).

---

## Constraints

1. **Drizzle ORM only** — No raw SQL except when Drizzle's API cannot express the query. When you use `sql` template tag, add a comment explaining why.
2. **Migration files** — Every schema change must have a corresponding Drizzle migration file (generated via `drizzle-kit generate`). Do not manually alter the database.
3. **Type-safe tenant scope** — The `orgId` parameter must flow through the type system. Create a `TenantContext` type and require it in every service function that touches org-scoped data.
4. **No `SELECT *`** — All Drizzle queries must specify columns or use typed `select()` — never `select()` with no arguments on production queries.
5. **Optimistic locking** on task updates — Include a `version` column. If the client sends an outdated version, the update fails with `409 Conflict`.

---

## Deliverables

### API Endpoints

#### Auth (simplified, no full OAuth)
```
POST /auth/login    body: { email, password } → { accessToken, refreshToken }
POST /auth/refresh  body: { refreshToken }    → { accessToken }
```

#### Organizations
```
GET    /orgs/:orgId              → Organization
PATCH  /orgs/:orgId              → Updated Organization
POST   /orgs/:orgId/members      → Invite a member (send invite token)
DELETE /orgs/:orgId/members/:userId → Remove member
GET    /orgs/:orgId/members      → List members (paginated)
```

#### Projects
```
GET    /orgs/:orgId/projects            → List projects (paginated)
POST   /orgs/:orgId/projects            → Create project
GET    /orgs/:orgId/projects/:id        → Get project
PATCH  /orgs/:orgId/projects/:id        → Update project
DELETE /orgs/:orgId/projects/:id        → Soft-delete project
```

#### Tasks
```
GET    /orgs/:orgId/projects/:projectId/tasks     → List tasks (paginated, filterable, searchable)
POST   /orgs/:orgId/projects/:projectId/tasks     → Create task
GET    /orgs/:orgId/projects/:projectId/tasks/:id → Get task with comments
PATCH  /orgs/:orgId/projects/:projectId/tasks/:id → Update task (optimistic locking)
DELETE /orgs/:orgId/projects/:projectId/tasks/:id → Soft-delete task
```

#### Comments
```
POST   /orgs/:orgId/tasks/:taskId/comments        → Add comment
PATCH  /orgs/:orgId/tasks/:taskId/comments/:id    → Edit comment
DELETE /orgs/:orgId/tasks/:taskId/comments/:id    → Soft-delete comment
```

#### Audit Log
```
GET /orgs/:orgId/audit-log  ?resource&resourceId&userId&cursor → Paginated audit events
```

---

## Acceptance Criteria

- [ ] Creating a task in Org A is invisible to a request authenticated as Org B (even with a direct resource ID in the URL)
- [ ] Soft-deleting a task removes it from all list queries but doesn't delete from DB
- [ ] Updating a task with `version: 1` when the DB has `version: 2` returns `409 Conflict`
- [ ] All writes create a corresponding entry in `audit_events`
- [ ] `GET /tasks?search=login+bug` uses GIN index (no seq scan in EXPLAIN output)
- [ ] Pagination: requesting with `cursor=<token>` returns the correct next page
- [ ] All Drizzle queries are type-safe — no raw `sql` tag except for the search query

---

## Concepts This Project Exercises

| Concept | Where |
|---------|-------|
| Drizzle schema definition | All 6 tables |
| Relations API (one-to-many, many-to-many) | Tasks ↔ Labels junction |
| Migrations (drizzle-kit) | Every schema change |
| Soft deletes | `deletedAt` column + automatic filter |
| Optimistic locking | `version` column on tasks |
| Cursor-based pagination | All list endpoints |
| Full-text search (pg_trgm) | Task/comment search |
| Audit logging | `audit_events` table + middleware |
| Multi-tenant isolation | `orgId` in every query via middleware |
| Drizzle `sql` escape hatch | GIN search query |
| Joined queries with `with` | Get task + comments |

---

## Difficulty

**Advanced.** The multi-tenancy enforcement and audit logging patterns are the hard parts. The schema design requires careful thought about which tables carry `orgId` directly vs. which inherit it through a relation.

## Estimated Time

10–16 hours.
