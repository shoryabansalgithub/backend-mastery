# PlatformDB — Implementation Plan

This plan breaks the project into five sequential phases. Each phase builds on the
previous. Do not skip ahead — the schema from Phase 1 underpins everything else, and
a schema mistake discovered in Phase 4 is much more expensive than one discovered in
Phase 1.

Estimated time: 8–12 hours for a competent developer working through the material for
the first time.

---

## Phase 1: Drizzle Setup + Schema Definitions

**Goal:** A working Drizzle connection and the complete schema in TypeScript, before
writing a single migration.

### 1.1 — Project Scaffolding

```bash
mkdir platformdb && cd platformdb
npm init -y
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg typescript tsx dotenv
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  }
}
```

Create `drizzle.config.ts`:

```typescript
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

### 1.2 — Database Connection

Create `src/db/index.ts` with:
- A `Pool` from `pg` using `process.env.DATABASE_URL`
- A `drizzle()` instance that imports the full schema (needed for relational queries)
- Export both `db` (primary) and `dbRead` (can point to same URL during development)

### 1.3 — Schema Definitions

Work through the schema in dependency order — a table cannot reference a table that
has not been defined yet:

1. `usersTable` — no foreign keys
2. `workspacesTable` — no foreign keys
3. `workspaceMembersTable` — references users + workspaces
4. `projectsTable` — references workspaces + users (owner)
5. `tasksTable` — references workspaces + projects + users (creator)
6. `taskAssignmentsTable` — references tasks + workspaces + users (x2)
7. `commentsTable` — references workspaces + tasks + users
8. `fileAttachmentsTable` — references workspaces + tasks + comments + users

After each table, define its `relations()` immediately below it. Do not define all
tables first and all relations after — keeping them co-located makes the schema easier
to read and maintain.

### 1.4 — Schema Validation Checklist

Before moving to Phase 2, verify:

- [ ] Every tenant-scoped table has a `workspace_id` column
- [ ] `tasksTable` has `version integer NOT NULL DEFAULT 1`
- [ ] `projectsTable` and `tasksTable` have `deleted_at timestamp` (nullable)
- [ ] `commentsTable` has `deleted_at timestamp` (nullable)
- [ ] `workspaceMembersTable` has a unique index on `(workspace_id, user_id)`
- [ ] `taskAssignmentsTable` has a unique index on `(task_id, assignee_id)`
- [ ] All `references()` calls have `{ onDelete: "cascade" }` where appropriate
- [ ] All enums are defined and used (not raw strings)
- [ ] All `relations()` definitions are complete and correctly linked

---

## Phase 2: Migrations

**Goal:** Run `drizzle-kit generate:pg` and produce a clean migration file that creates
all tables, enums, indexes, and constraints.

### 2.1 — Generate the Initial Migration

```bash
npx drizzle-kit generate:pg
```

This creates a file like `drizzle/migrations/0000_initial.sql`. Open it and read it.
Verify:

- All 8 tables are present
- All 5 enums are created before the tables that use them
- Foreign keys reference the correct columns
- The unique indexes on `workspace_members` and `task_assignments` exist
- The `version` column has `DEFAULT 1`

If anything is missing, fix the schema and regenerate (delete the migration file first).

### 2.2 — Apply the Migration

```bash
npx drizzle-kit push:pg
# Or if you prefer migration files:
npx drizzle-kit migrate
```

Connect to your database and run `\dt` (in psql) to see all tables. Run `\d tasks` to
inspect the tasks table columns and constraints.

### 2.3 — Add Performance Indexes

The initial migration from Drizzle covers structural constraints. Add a second
migration file for performance indexes. Create
`drizzle/migrations/0001_indexes.sql` manually:

```sql
-- Tenant-scoped access patterns (most common queries)
CREATE INDEX idx_projects_workspace ON projects (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_tasks_workspace ON tasks (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_tasks_project ON tasks (workspace_id, project_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_tasks_due_date ON tasks (workspace_id, due_date)
  WHERE deleted_at IS NULL AND status NOT IN ('done', 'cancelled');

CREATE INDEX idx_task_assignments_workspace ON task_assignments (workspace_id, assignee_id);

CREATE INDEX idx_comments_task ON comments (workspace_id, task_id, created_at ASC)
  WHERE deleted_at IS NULL;

-- Activity feed (UNION query needs each table individually indexed)
CREATE INDEX idx_tasks_created_at ON tasks (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_comments_created_at ON comments (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

### 2.4 — Migration Naming Convention

Use a consistent prefix format: `NNNN_description.sql`. Never modify a migration that
has already been applied to any environment. If you need to fix something, create a
new migration.

---

## Phase 3: Repository Layer

**Goal:** One file per entity with full CRUD and correct tenant isolation. Every
function should be tested manually (or with a simple test script) before moving on.

### 3.1 — Error Classes

Create `src/errors.ts` first:

```typescript
export class NotFoundError extends Error {
  constructor(entity: string, id: number) {
    super(`${entity} with id ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(
    entity: string,
    id: number,
    expectedVersion: number,
    currentVersion: number
  ) {
    super(
      `${entity} ${id} was modified by another user. ` +
        `Expected version ${expectedVersion}, current version ${currentVersion}.`
    );
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
  currentVersion: number;
}

export class TenantIsolationError extends Error {
  constructor() {
    super("Access denied: resource belongs to a different workspace");
    this.name = "TenantIsolationError";
  }
}
```

### 3.2 — Implementation Order

Implement repositories in this order (each depends on the previous):

**`src/repositories/users.ts`**
- Start here — users have no foreign keys; simplest possible repository
- Implement: `createUser`, `getUserByEmail`, `getUserById`
- No tenant scoping needed (users are global entities)

**`src/repositories/workspaces.ts`**
- Key challenge: `createWorkspace` must use `db.transaction()` to create the workspace
  and add the owner as a member atomically
- Implement: `createWorkspace`, `getWorkspaceBySlug`, `getWorkspaceMembers`,
  `addMember`, `updateMemberRole`, `removeMember`, `isMember`
- `getWorkspaceMembers` requires a JOIN with `usersTable`

**`src/repositories/projects.ts`**
- Introduce the tenant isolation pattern
- `softDeleteProject` must soft-delete all tasks in the project in the same transaction
- Implement: `createProject`, `getProjects`, `getProjectById`, `updateProject`,
  `softDeleteProject`

**`src/repositories/tasks.ts`**
- Most complex repository — optimistic locking + soft deletes + assignments
- `updateTask` must check `expectedVersion` and throw `ConflictError` on mismatch
- `getTaskWithDetails` should use Drizzle's relational `query.tasksTable.findFirst`
  with `with: { assignments: { with: { assignee: true } } }`
- Count comments with a subquery or aggregate
- Implement: `createTask`, `getTasksByProject`, `getTaskWithDetails`, `updateTask`,
  `softDeleteTask`, `assignTask`, `unassignTask`

**`src/repositories/comments.ts`**
- Authorization rule: only the original author can edit; author or admin can delete
- For delete: fetch the workspace member's role, then decide whether to allow
- Implement: `createComment`, `getComments`, `updateComment`, `softDeleteComment`

**`src/repositories/attachments.ts`**
- Straightforward — no soft deletes, just metadata storage
- Implement: `createAttachment`, `getTaskAttachments`, `deleteAttachment`

### 3.3 — Testing Each Repository

Write a `src/smoke-test.ts` file that exercises each repository function:

```typescript
import { createUser } from "./repositories/users";
import { createWorkspace } from "./repositories/workspaces";
// ...

async function smokeTest() {
  const alice = await createUser({ email: "alice@test.com", displayName: "Alice" });
  console.assert(alice.id > 0, "User created");

  const workspace = await createWorkspace(
    { name: "Test Corp", slug: "test-corp" },
    alice.id
  );
  console.assert(workspace.id > 0, "Workspace created");

  const isMember = await isMemberOf(workspace.id, alice.id);
  console.assert(isMember, "Creator is a member");

  console.log("All smoke tests passed");
}

smokeTest().catch(console.error);
```

Run it with: `npx tsx src/smoke-test.ts`

---

## Phase 4: Complex Queries

**Goal:** Implement the four reporting queries. These are pure SQL challenges — focus
on correctness before performance.

### 4.1 — Task Summaries with Assignees and Comment Counts

File: `src/queries/task-summaries.ts`

Strategy:
- JOIN tasks with task_assignments and users (LEFT JOIN — tasks can have zero assignees)
- LEFT JOIN comments to count them
- GROUP BY all non-aggregated task columns
- Use `json_agg` or `array_agg` for the assignees array

Key SQL pattern:
```sql
SELECT
  t.id,
  t.title,
  t.status,
  t.priority,
  t.due_date,
  COALESCE(
    json_agg(
      json_build_object('id', u.id, 'displayName', u.display_name)
    ) FILTER (WHERE u.id IS NOT NULL),
    '[]'
  ) AS assignees,
  COUNT(DISTINCT c.id)::int AS comment_count
FROM tasks t
LEFT JOIN task_assignments ta ON ta.task_id = t.id AND ta.workspace_id = $1
LEFT JOIN users u ON u.id = ta.assignee_id
LEFT JOIN comments c ON c.task_id = t.id AND c.workspace_id = $1 AND c.deleted_at IS NULL
WHERE t.workspace_id = $1
  AND t.project_id = $2
  AND t.deleted_at IS NULL
GROUP BY t.id
ORDER BY t.created_at DESC
```

Use `db.execute(sql`...`)` with the `sql` template tag.

### 4.2 — Activity Feed with UNION

File: `src/queries/activity-feed.ts`

Strategy: UNION four SELECT statements (one per event type), ORDER BY `occurred_at`
DESC, LIMIT.

Each branch of the UNION must SELECT the same columns in the same order:
`event_type, actor_id, actor_name, target_id, target_title, project_id, project_name, occurred_at`

Note: `file_attachments` does not store `target_title` naturally — use `filename` as
the `target_title`. For `project_name`, you may need to JOIN through tasks to projects.

The task status change event requires a separate `task_status_history` table (consider
whether to add it or simplify to just `task_created`). If you skip status history,
document the simplification.

### 4.3 — Overdue Tasks

File: `src/queries/overdue-tasks.ts`

Strategy:
- Filter: `due_date < NOW()`, `status NOT IN ('done', 'cancelled')`, `deleted_at IS NULL`
- Calculate `daysOverdue`: use `EXTRACT(DAY FROM NOW() - due_date)::int`
- LEFT JOIN task_assignments + users for assignees
- Same `json_agg` pattern as task summaries

### 4.4 — Member Workload Report

File: `src/queries/workload-report.ts`

Strategy: Start from `workspace_members` (so members with zero tasks are included),
LEFT JOIN `task_assignments` and `tasks`, then use conditional aggregation:

```sql
SELECT
  wm.user_id,
  u.display_name,
  wm.role,
  COUNT(t.id) FILTER (WHERE t.status = 'todo')::int AS todo,
  COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
  COUNT(t.id) FILTER (WHERE t.status = 'in_review')::int AS in_review,
  COUNT(t.id) FILTER (WHERE t.status NOT IN ('done', 'cancelled') AND t.id IS NOT NULL)::int AS total
FROM workspace_members wm
JOIN users u ON u.id = wm.user_id
LEFT JOIN task_assignments ta ON ta.assignee_id = wm.user_id AND ta.workspace_id = wm.workspace_id
LEFT JOIN tasks t ON t.id = ta.task_id AND t.deleted_at IS NULL
WHERE wm.workspace_id = $1
GROUP BY wm.user_id, u.display_name, wm.role
ORDER BY total DESC
```

---

## Phase 5: Soft Deletes + Optimistic Locking

**Goal:** Verify and harden the special behaviors that distinguish this codebase from
basic CRUD.

### 5.1 — Soft Delete Verification

Write explicit tests (or test scripts) for each scenario:

1. **Project soft delete cascades to tasks**

   ```typescript
   await projectsRepo.softDeleteProject(workspaceId, projectId);
   const tasks = await tasksRepo.getTasksByProject(workspaceId, projectId);
   assert(tasks.length === 0, "All tasks soft-deleted when project soft-deleted");
   ```

2. **Soft-deleted records invisible to standard queries**

   ```typescript
   const task = await tasksRepo.createTask(workspaceId, { ... });
   await tasksRepo.softDeleteTask(workspaceId, task.id);
   const found = await tasksRepo.getTaskWithDetails(workspaceId, task.id);
   assert(found === null, "Soft-deleted task not found");
   ```

3. **Comments show `[deleted]` text after soft delete**

   Decide: do you truly delete the body or replace it with `"[deleted]"`? The README
   says "content is replaced with `[deleted]` on read." The simpler approach:
   in `softDeleteComment`, set `body = '[deleted]'` AND `deletedAt = now()`. Then
   `getComments` returns them but with the `[deleted]` body.

### 5.2 — Optimistic Locking Verification

Test the conflict scenario explicitly:

```typescript
// Two concurrent clients read version 1
const [taskA, taskB] = await Promise.all([
  tasksRepo.getTaskWithDetails(workspaceId, taskId),
  tasksRepo.getTaskWithDetails(workspaceId, taskId),
]);

// Client A saves first — succeeds, version becomes 2
await tasksRepo.updateTask(workspaceId, taskId, taskA!.version, {
  title: "Client A's title",
});

// Client B tries to save with stale version 1 — must throw ConflictError
try {
  await tasksRepo.updateTask(workspaceId, taskId, taskB!.version, {
    title: "Client B's title",
  });
  assert(false, "Should have thrown");
} catch (err) {
  assert(err instanceof ConflictError, "ConflictError thrown");
  assert(err.currentVersion === 2, "Current version reported correctly");
}
```

### 5.3 — Tenant Isolation Verification

This is the most critical correctness test:

```typescript
// Setup: two workspaces, each with a project and task
const ws1 = await createWorkspaceWithOwner("Workspace 1", alice.id);
const ws2 = await createWorkspaceWithOwner("Workspace 2", bob.id);

const task1 = await tasksRepo.createTask(ws1.id, { ... });

// Attempt: ws2 tries to read ws1's task using its own workspace ID
const stolen = await tasksRepo.getTaskWithDetails(ws2.id, task1.id);
assert(stolen === null, "Cross-tenant read returns null");

// Attempt: ws2 tries to delete ws1's task
const deleted = await tasksRepo.softDeleteTask(ws2.id, task1.id);
assert(!deleted, "Cross-tenant delete returns false");
```

---

## Key Architectural Decisions

### Why functional repositories instead of classes?

Both are valid. The functional factory approach (`createTasksRepository(workspaceId)`)
makes it impossible to accidentally call a method without a workspace ID — the ID is
captured at construction time. A class-based approach is equally valid; the important
thing is consistency.

### Why `workspace_id` on `task_assignments` when `tasks` already has it?

Two reasons:
1. **Query performance**: fetching assignments by workspace avoids a JOIN to tasks.
2. **Index design**: a partial index on `task_assignments (workspace_id, assignee_id)`
   supports the workload report query without touching the tasks table at all.

The denormalization is intentional and justified.

### Why not use Drizzle's relational query API for the complex queries?

Drizzle's `db.query.*` API is excellent for N-level nested object loading. But it
cannot express aggregate functions like `COUNT`, `json_agg`, or UNION queries. For
the four reporting queries, raw SQL (via the `sql` template tag) is the right tool.
Use `db.query.*` in repositories for single-entity fetches with relations.

### Why soft deletes instead of hard deletes?

Audit trails: knowing that a project was deleted, when, and (if you add a `deleted_by`
column) by whom is valuable for debugging, compliance, and customer support. Hard
deletes destroy this information permanently.

A secondary reason: cascade hard deletes would destroy all tasks under a project,
which is usually not what users intend when they archive a project.

### Should `version` be on `tasks` only?

For this project, yes. Tasks are the most frequently concurrently edited entity.
Projects are less frequently edited and typically by fewer people. Adding optimistic
locking to every entity adds complexity; apply it where concurrent edits are actually
likely.

---

## Testing Strategy

### Unit Tests (Logic, No Database)

These functions can be tested without any database:

- Error class constructors
- Any pure transformation functions (e.g., formatting query results)
- Enum validation logic

Use plain Node.js `assert` or a minimal test library like `uvu`.

### Integration Tests (Real Database)

Most of the interesting logic requires a real database. Use a separate test database
or a schema prefix to isolate test data.

Recommended pattern: create a `beforeEach` hook that runs all migrations on a clean
database, and an `afterEach` hook that truncates all tables.

```typescript
// test/helpers.ts
export async function resetDatabase() {
  await db.execute(sql`
    TRUNCATE
      file_attachments,
      comments,
      task_assignments,
      tasks,
      projects,
      workspace_members,
      workspaces,
      users
    CASCADE
  `);
}
```

### What to Test

| Test Category | Priority |
|---------------|----------|
| Tenant isolation (cross-workspace reads return null) | Critical |
| Optimistic locking conflict detection | Critical |
| Soft delete visibility (deleted records not in default queries) | Critical |
| Project soft-delete cascades to tasks | High |
| Workspace creation adds owner as member (transactional) | High |
| Complex query correctness (correct counts, correct grouping) | High |
| Comment author-only edit rule | Medium |
| Seed script idempotency | Medium |

### Property-Based Testing

Consider using `fast-check` to generate random sequences of operations and verify
invariants:

- After any number of soft deletes, `findAll()` count never increases
- After any number of `updateTask` calls, `version` always equals (initial version +
  number of successful updates)
- Querying with workspace A's ID never returns data inserted under workspace B's ID

These catch edge cases that example-based tests miss.

### Performance Baseline

Before calling the project done, measure these:

```bash
# Using pgbench or a simple script:
# 1. Insert 10,000 tasks across 100 projects in 10 workspaces
# 2. Run getTaskSummaries for one project — should complete in <100ms
# 3. Run getActivityFeed — should complete in <200ms
# 4. Run getOverdueTasks — should complete in <200ms
# 5. Run getMemberWorkloadReport — should complete in <100ms
```

If any query exceeds these thresholds, `EXPLAIN ANALYZE` the query and verify your
indexes are being used.
