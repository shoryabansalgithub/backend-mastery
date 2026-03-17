# Project: PlatformDB

## Overview

You are building the database layer for **PlatformDB** — the persistence backbone of
a multi-tenant project management tool similar to Linear or Asana.

This project is exclusively about data: schema design, query writing, and enforcing
business rules at the database layer. There is no HTTP server to build. Your deliverable
is a library of typed repository functions that other parts of the system would call.

By the end, you will have a production-quality database layer that handles multi-tenant
isolation, soft deletes, optimistic locking, complex reporting queries, and a seeded
demo dataset.

---

## The Domain

**Workspaces** are the top-level tenant boundary. Every company that signs up gets one
workspace. All their data lives under that workspace, and no data should ever cross
workspace boundaries.

Within a workspace:
- **Users** can be **members** of a workspace with a role (owner, admin, member, viewer).
- A workspace contains **projects** (e.g., "Website Redesign", "API v2").
- Projects contain **tasks** (the actual units of work).
- Tasks can be **assigned** to workspace members.
- Tasks have **comments** (threaded replies are out of scope).
- Comments and tasks can have **file attachments**.

---

## Schema Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                            workspaces                               │
│  id | name | slug | plan | created_at | deleted_at                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (1:N)
          ┌────────────────────┼───────────────────────┐
          │                    │                       │
          ▼                    ▼                       ▼
┌──────────────────┐  ┌────────────────────┐  ┌───────────────────┐
│ workspace_members│  │      projects      │  │      users        │
│ id               │  │ id                 │  │ id                │
│ workspace_id (FK)│  │ workspace_id (FK)  │  │ email             │
│ user_id (FK)     │  │ name               │  │ display_name      │
│ role             │  │ description        │  │ avatar_url        │
│ joined_at        │  │ status             │  │ created_at        │
└──────────────────┘  │ owner_id (FK→users)│  └───────────────────┘
                      │ created_at         │
                      │ deleted_at         │       (users are global;
                      └────────┬───────────┘        workspace_members
                               │ (1:N)               ties them to a
                               ▼                     workspace with a role)
                    ┌──────────────────────┐
                    │        tasks         │
                    │ id                   │
                    │ workspace_id (FK)    │
                    │ project_id (FK)      │
                    │ title                │
                    │ description          │
                    │ status               │
                    │ priority             │
                    │ due_date             │
                    │ version              │◄── optimistic lock
                    │ created_by (FK→users)│
                    │ created_at           │
                    │ updated_at           │
                    │ deleted_at           │◄── soft delete
                    └───┬──────────────────┘
                        │
          ┌─────────────┼──────────────────────┐
          │             │                      │
          ▼             ▼                      ▼
┌─────────────────┐ ┌──────────────────┐ ┌───────────────────┐
│ task_assignments│ │     comments     │ │  file_attachments │
│ id              │ │ id               │ │ id                │
│ task_id (FK)    │ │ workspace_id (FK)│ │ workspace_id (FK) │
│ workspace_id(FK)│ │ task_id (FK)     │ │ task_id (FK)      │
│ assignee_id (FK)│ │ author_id (FK)   │ │ comment_id (FK)   │
│ assigned_by (FK)│ │ body             │ │ filename          │
│ assigned_at     │ │ created_at       │ │ mime_type         │
└─────────────────┘ │ updated_at       │ │ size_bytes        │
                    │ deleted_at       │ │ storage_url       │
                    └──────────────────┘ │ uploaded_by (FK)  │
                                         │ uploaded_at       │
                                         └───────────────────┘
```

---

## Full Schema Definition

Here is the complete Drizzle schema you should implement in `src/db/schema.ts`:

```typescript
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// --- Enums ---

export const workspacePlanEnum = pgEnum("workspace_plan", [
  "free",
  "pro",
  "enterprise",
]);

export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
]);

// --- Tables ---

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workspacesTable = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: workspacePlanEnum("plan").notNull().default("free"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const workspaceMembersTable = pgTable(
  "workspace_members",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueMember: uniqueIndex("unique_workspace_member").on(
      t.workspaceId,
      t.userId
    ),
  })
);

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: projectStatusEnum("status").notNull().default("active"),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatusEnum("status").notNull().default("todo"),
  priority: taskPriorityEnum("priority").notNull().default("none"),
  dueDate: timestamp("due_date"),
  version: integer("version").notNull().default(1),
  createdBy: integer("created_by")
    .notNull()
    .references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const taskAssignmentsTable = pgTable(
  "task_assignments",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    assigneeId: integer("assignee_id")
      .notNull()
      .references(() => usersTable.id),
    assignedBy: integer("assigned_by")
      .notNull()
      .references(() => usersTable.id),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueAssignment: uniqueIndex("unique_task_assignment").on(
      t.taskId,
      t.assigneeId
    ),
  })
);

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
    .notNull()
    .references(() => usersTable.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const fileAttachmentsTable = pgTable("file_attachments", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  commentId: integer("comment_id").references(() => commentsTable.id, {
    onDelete: "set null",
  }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageUrl: text("storage_url").notNull(),
  uploadedBy: integer("uploaded_by")
    .notNull()
    .references(() => usersTable.id),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

// --- Relations ---

export const usersRelations = relations(usersTable, ({ many }) => ({
  workspaceMemberships: many(workspaceMembersTable),
  ownedProjects: many(projectsTable),
  createdTasks: many(tasksTable),
  taskAssignments: many(taskAssignmentsTable, { relationName: "assignee" }),
  comments: many(commentsTable),
  fileAttachments: many(fileAttachmentsTable),
}));

export const workspacesRelations = relations(workspacesTable, ({ many }) => ({
  members: many(workspaceMembersTable),
  projects: many(projectsTable),
  tasks: many(tasksTable),
}));

export const workspaceMembersRelations = relations(
  workspaceMembersTable,
  ({ one }) => ({
    workspace: one(workspacesTable, {
      fields: [workspaceMembersTable.workspaceId],
      references: [workspacesTable.id],
    }),
    user: one(usersTable, {
      fields: [workspaceMembersTable.userId],
      references: [usersTable.id],
    }),
  })
);

export const projectsRelations = relations(projectsTable, ({ one, many }) => ({
  workspace: one(workspacesTable, {
    fields: [projectsTable.workspaceId],
    references: [workspacesTable.id],
  }),
  owner: one(usersTable, {
    fields: [projectsTable.ownerId],
    references: [usersTable.id],
  }),
  tasks: many(tasksTable),
}));

export const tasksRelations = relations(tasksTable, ({ one, many }) => ({
  workspace: one(workspacesTable, {
    fields: [tasksTable.workspaceId],
    references: [workspacesTable.id],
  }),
  project: one(projectsTable, {
    fields: [tasksTable.projectId],
    references: [projectsTable.id],
  }),
  creator: one(usersTable, {
    fields: [tasksTable.createdBy],
    references: [usersTable.id],
  }),
  assignments: many(taskAssignmentsTable),
  comments: many(commentsTable),
  attachments: many(fileAttachmentsTable),
}));

export const taskAssignmentsRelations = relations(
  taskAssignmentsTable,
  ({ one }) => ({
    task: one(tasksTable, {
      fields: [taskAssignmentsTable.taskId],
      references: [tasksTable.id],
    }),
    assignee: one(usersTable, {
      fields: [taskAssignmentsTable.assigneeId],
      references: [usersTable.id],
      relationName: "assignee",
    }),
    assigner: one(usersTable, {
      fields: [taskAssignmentsTable.assignedBy],
      references: [usersTable.id],
    }),
  })
);

export const commentsRelations = relations(commentsTable, ({ one, many }) => ({
  task: one(tasksTable, {
    fields: [commentsTable.taskId],
    references: [tasksTable.id],
  }),
  author: one(usersTable, {
    fields: [commentsTable.authorId],
    references: [usersTable.id],
  }),
  attachments: many(fileAttachmentsTable),
}));

export const fileAttachmentsRelations = relations(
  fileAttachmentsTable,
  ({ one }) => ({
    task: one(tasksTable, {
      fields: [fileAttachmentsTable.taskId],
      references: [tasksTable.id],
    }),
    comment: one(commentsTable, {
      fields: [fileAttachmentsTable.commentId],
      references: [commentsTable.id],
    }),
    uploader: one(usersTable, {
      fields: [fileAttachmentsTable.uploadedBy],
      references: [usersTable.id],
    }),
  })
);
```

---

## API Function Signatures to Implement

Implement each of the following in the appropriate repository file. All functions that
take a `workspaceId` must enforce tenant isolation — they must never return data from
a different workspace.

### Users (`src/repositories/users.ts`)

```typescript
// Create a new user (global — not workspace-scoped)
createUser(data: { email: string; displayName: string; avatarUrl?: string }): Promise<User>

// Find user by email
getUserByEmail(email: string): Promise<User | null>

// Find user by ID
getUserById(id: number): Promise<User | null>
```

### Workspaces (`src/repositories/workspaces.ts`)

```typescript
// Create a workspace AND add the creator as owner in one transaction
createWorkspace(data: { name: string; slug: string; plan?: WorkspacePlan }, ownerId: number): Promise<Workspace>

// Get a workspace by slug (for URL routing)
getWorkspaceBySlug(slug: string): Promise<Workspace | null>

// Get all members of a workspace with their user info
getWorkspaceMembers(workspaceId: number): Promise<WorkspaceMemberWithUser[]>

// Add a user to a workspace
addMember(workspaceId: number, userId: number, role: MemberRole, addedBy: number): Promise<WorkspaceMember>

// Change a member's role
updateMemberRole(workspaceId: number, userId: number, newRole: MemberRole): Promise<WorkspaceMember | null>

// Remove a member from a workspace
removeMember(workspaceId: number, userId: number): Promise<boolean>

// Check if a user is a member of a workspace
isMember(workspaceId: number, userId: number): Promise<boolean>
```

### Projects (`src/repositories/projects.ts`)

```typescript
// Create a project
createProject(workspaceId: number, data: { name: string; description?: string; ownerId: number }): Promise<Project>

// Get all active projects in a workspace
getProjects(workspaceId: number): Promise<Project[]>

// Get a project by ID (must verify workspace membership)
getProjectById(workspaceId: number, projectId: number): Promise<Project | null>

// Update project
updateProject(workspaceId: number, projectId: number, data: ProjectUpdate): Promise<Project | null>

// Soft delete a project (also soft-deletes all its tasks)
softDeleteProject(workspaceId: number, projectId: number): Promise<boolean>
```

### Tasks (`src/repositories/tasks.ts`)

```typescript
// Create a task
createTask(workspaceId: number, data: { projectId: number; title: string; description?: string; priority?: TaskPriority; dueDate?: Date; createdBy: number }): Promise<Task>

// Get all active tasks in a project
getTasksByProject(workspaceId: number, projectId: number): Promise<Task[]>

// Get a task by ID with its assignees and comment count (single query)
getTaskWithDetails(workspaceId: number, taskId: number): Promise<TaskWithDetails | null>

// Update a task with optimistic locking
updateTask(workspaceId: number, taskId: number, expectedVersion: number, data: TaskUpdate): Promise<Task>
// Throws ConflictError if version does not match

// Soft delete a task
softDeleteTask(workspaceId: number, taskId: number): Promise<boolean>

// Assign a user to a task
assignTask(workspaceId: number, taskId: number, assigneeId: number, assignedBy: number): Promise<TaskAssignment>

// Unassign a user from a task
unassignTask(workspaceId: number, taskId: number, assigneeId: number): Promise<boolean>
```

### Comments (`src/repositories/comments.ts`)

```typescript
// Add a comment to a task
createComment(workspaceId: number, taskId: number, authorId: number, body: string): Promise<Comment>

// Get all comments for a task (oldest first)
getComments(workspaceId: number, taskId: number): Promise<CommentWithAuthor[]>

// Update a comment body
updateComment(workspaceId: number, commentId: number, authorId: number, body: string): Promise<Comment | null>
// Only the original author can edit

// Soft delete a comment
softDeleteComment(workspaceId: number, commentId: number, requesterId: number): Promise<boolean>
// Author or workspace admin can delete
```

### File Attachments (`src/repositories/attachments.ts`)

```typescript
// Record a file upload (the file itself is stored in S3/cloud storage; this records metadata)
createAttachment(workspaceId: number, data: { taskId: number; commentId?: number; filename: string; mimeType: string; sizeBytes: number; storageUrl: string; uploadedBy: number }): Promise<FileAttachment>

// Get all attachments for a task
getTaskAttachments(workspaceId: number, taskId: number): Promise<FileAttachment[]>

// Delete an attachment record
deleteAttachment(workspaceId: number, attachmentId: number): Promise<boolean>
```

---

## Complex Query Requirements

These are the four reporting queries that are the real challenge of this project.

### Query 1: Tasks with Assignees and Comment Counts

Return a summary row for each task in a project, including the array of assignee names
and the comment count. This must be a single database query — no application-level
looping.

```typescript
// Expected return type:
type TaskSummary = {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  assignees: Array<{ id: number; displayName: string }>;
  commentCount: number;
  createdAt: Date;
};

getTaskSummaries(workspaceId: number, projectId: number): Promise<TaskSummary[]>
```

Hint: use PostgreSQL aggregate functions `json_agg` and `COUNT` with a GROUP BY.

### Query 2: Workspace Activity Feed

Return the 50 most recent "events" across a workspace. An event is any of:
- A task being created
- A task changing status
- A comment being posted
- A file being attached

Since these live in different tables, you will need a UNION query.

```typescript
type ActivityEvent = {
  eventType: "task_created" | "task_status_changed" | "comment_posted" | "file_attached";
  actorId: number;
  actorName: string;
  targetId: number;    // task ID or comment ID
  targetTitle: string; // task title or filename
  projectId: number;
  projectName: string;
  occurredAt: Date;
};

getActivityFeed(workspaceId: number, limit?: number): Promise<ActivityEvent[]>
```

### Query 3: Overdue Tasks Across All Projects

Return all tasks that are past their `due_date`, are not in a terminal status
(`done` or `cancelled`), and are not soft-deleted. Include the project name and
the list of assignees.

```typescript
type OverdueTask = {
  id: number;
  title: string;
  dueDate: Date;
  daysOverdue: number;
  projectId: number;
  projectName: string;
  assignees: Array<{ id: number; displayName: string }>;
};

getOverdueTasks(workspaceId: number): Promise<OverdueTask[]>
```

### Query 4: Member Workload Report

For each workspace member, return how many tasks they are currently assigned to,
broken down by status.

```typescript
type MemberWorkload = {
  userId: number;
  displayName: string;
  role: MemberRole;
  assignedTaskCounts: {
    todo: number;
    in_progress: number;
    in_review: number;
    total: number; // excludes done and cancelled
  };
};

getMemberWorkloadReport(workspaceId: number): Promise<MemberWorkload[]>
```

---

## Additional Requirements

### Soft Deletes
- `projects` and `tasks` support soft deletes via a `deleted_at` column.
- `comments` also support soft deletes (mark as deleted, content is replaced with
  `"[deleted]"` on read rather than truly hidden).
- All queries must filter out soft-deleted records by default.
- Soft-deleting a project must soft-delete all its tasks in the same transaction.

### Optimistic Locking
- `tasks` has a `version` column (integer, starts at 1).
- Every `updateTask` call must accept the caller's `expectedVersion`.
- If the row's current version does not match, throw a `ConflictError` with the
  current version number so the caller can show the user a meaningful error.
- Every successful update increments `version` by 1 atomically.

### Multi-Tenant Isolation
- All queries on workspace-scoped tables must include a `workspace_id` condition.
- Repository functions that look up by entity ID must also check `workspace_id`.
- The `createWorkspace` function must add the creator as a workspace member with
  the `owner` role in the same database transaction.

### Seed Script
Implement `src/seed.ts` that creates:
- 3 users: Alice (owner), Bob (admin), Carol (member)
- 1 workspace: "Acme Corp" with all three as members
- 3 projects: "Website Redesign", "API v2", "Marketing Site"
- 15 tasks spread across the projects in various statuses and priorities
- 5 tasks with due dates in the past (for overdue query testing)
- Comments on at least 5 tasks
- Task assignments for all three users

The seed script should be idempotent: running it twice should not create duplicate data.

---

## Expected Query Outputs

### Task Summaries Output (Sample)

```json
[
  {
    "id": 3,
    "title": "Implement authentication",
    "status": "in_progress",
    "priority": "high",
    "dueDate": "2024-03-01T00:00:00.000Z",
    "assignees": [
      { "id": 1, "displayName": "Alice Chen" },
      { "id": 2, "displayName": "Bob Smith" }
    ],
    "commentCount": 4,
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

### Activity Feed Output (Sample)

```json
[
  {
    "eventType": "comment_posted",
    "actorId": 2,
    "actorName": "Bob Smith",
    "targetId": 12,
    "targetTitle": "Implement authentication",
    "projectId": 2,
    "projectName": "API v2",
    "occurredAt": "2024-03-15T14:32:00.000Z"
  },
  {
    "eventType": "task_created",
    "actorId": 1,
    "actorName": "Alice Chen",
    "targetId": 15,
    "targetTitle": "Set up Redis caching",
    "projectId": 2,
    "projectName": "API v2",
    "occurredAt": "2024-03-15T09:00:00.000Z"
  }
]
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ running locally (or a connection string to a hosted instance)
- `npm` or `pnpm`

### Setup

```bash
# Install dependencies
npm install

# Copy and fill in the environment file
cp .env.example .env
# Set DATABASE_URL=postgresql://user:password@localhost:5432/platformdb

# Run migrations (creates all tables)
npm run db:migrate

# Seed the database with demo data
npm run db:seed

# Run the test suite
npm test
```

### Project Structure

```
src/
├── db/
│   ├── index.ts          # Drizzle instance
│   └── schema.ts         # All table and relation definitions
├── repositories/
│   ├── users.ts
│   ├── workspaces.ts
│   ├── projects.ts
│   ├── tasks.ts
│   ├── comments.ts
│   └── attachments.ts
├── queries/
│   ├── task-summaries.ts
│   ├── activity-feed.ts
│   ├── overdue-tasks.ts
│   └── workload-report.ts
├── errors.ts             # ConflictError, NotFoundError, etc.
└── seed.ts

drizzle/
└── migrations/           # Generated migration files

drizzle.config.ts
```

---

## Grading Criteria

| Area | Points | What is Evaluated |
|------|--------|-------------------|
| Schema correctness | 20 | All tables, columns, types, constraints, and relations defined correctly |
| Migrations run clean | 10 | `npm run db:migrate` succeeds on a blank database |
| Basic CRUD | 20 | All repository functions work correctly and are typed |
| Tenant isolation | 15 | No query returns cross-workspace data; test with two workspaces |
| Soft deletes | 10 | Delete + restore work; soft-deleted rows excluded from default queries |
| Optimistic locking | 10 | Concurrent updates throw `ConflictError` correctly |
| Complex queries | 25 | All four reporting queries return correct, well-typed results |
| Seed script | 5 | Runs without error and is idempotent |
| Code quality | 5 | Types are precise, no `any`, functions are clearly named |

**Total: 120 points**
