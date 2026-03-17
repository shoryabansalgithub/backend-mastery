# Module 4, Lesson 4: Advanced Patterns

## Beyond CRUD

The previous lessons covered Drizzle's fundamentals: schema definition, querying,
mutations, and migrations. If that were all there was to using an ORM, you could stop
here. But production applications have problems that basic CRUD cannot solve cleanly.

This lesson is about the patterns that separate functional code from robust code. We
will work through each problem from first principles — understanding why it is a problem
before reaching for a solution.

---

## The N+1 Query Problem

This is the single most common performance mistake people make with ORMs. It is so
common that it has its own name, and so insidious that it can exist in your codebase
for months before you notice.

### The Problem

Imagine you want to display a list of blog posts with their authors' names. Naively,
you might write:

```typescript
// Fetch all posts
const posts = await db.select().from(postsTable);

// For each post, fetch its author
for (const post of posts) {
  const [author] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, post.authorId));

  console.log(`"${post.title}" by ${author.name}`);
}
```

This code is correct. It produces the right output. And it is a disaster.

If you have 100 posts, you execute **101 queries**: 1 to get the posts, and 1 for each
post's author. If you have 1,000 posts, you execute 1,001 queries. The number of
queries grows linearly with the number of rows.

This is the **N+1 query problem**: 1 query to get N records, then N additional queries
to fetch related data. For N=100, you might not notice it. For N=10,000, your server
grinds to a halt.

### Detecting It

The N+1 problem is often invisible because each individual query is fast. The latency
is not in any single query — it is in the cumulative cost of thousands of round trips.

The easiest way to detect it is to **log your queries**. Enable query logging in
Drizzle:

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, {
  logger: {
    logQuery(query, params) {
      console.log("[SQL]", query, params);
    },
  },
});
```

Now run your code and count the log lines. If rendering a list of 50 items generates
51+ SQL log lines, you have an N+1 problem.

A more precise approach: use a query counter.

```typescript
let queryCount = 0;

export const db = drizzle(pool, {
  logger: {
    logQuery() {
      queryCount++;
    },
  },
});

// In a test:
queryCount = 0;
await renderPostList();
if (queryCount > 2) {
  throw new Error(`N+1 detected: ${queryCount} queries for post list`);
}
```

### Fix 1: Join Queries

The correct fix is to fetch everything you need in a single SQL query using a JOIN.

```typescript
// One query: posts joined with their authors
const postsWithAuthors = await db
  .select({
    postId: postsTable.id,
    postTitle: postsTable.title,
    postContent: postsTable.content,
    authorId: usersTable.id,
    authorName: usersTable.name,
    authorEmail: usersTable.email,
  })
  .from(postsTable)
  .innerJoin(usersTable, eq(postsTable.authorId, usersTable.id));
```

This executes exactly 1 query regardless of whether there are 10 posts or 10,000.

For optional relationships (where the author might not exist), use `leftJoin`:

```typescript
const postsWithAuthors = await db
  .select({
    postId: postsTable.id,
    postTitle: postsTable.title,
    authorName: usersTable.name, // may be null
  })
  .from(postsTable)
  .leftJoin(usersTable, eq(postsTable.authorId, usersTable.id));
```

### Fix 2: Drizzle Relational Queries (Eager Loading)

Joins work well but produce a flat result — you have to manually group `postsWithAuthors`
by post if each post can have multiple related records. Drizzle's relational query API
handles this automatically.

First, define relations in your schema:

```typescript
// schema.ts
import { relations } from "drizzle-orm";
import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
});

export const postsTable = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  authorId: integer("author_id")
    .notNull()
    .references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  body: text("body").notNull(),
  postId: integer("post_id")
    .notNull()
    .references(() => postsTable.id),
  authorId: integer("author_id")
    .notNull()
    .references(() => usersTable.id),
});

// Define the relation graph
export const usersRelations = relations(usersTable, ({ many }) => ({
  posts: many(postsTable),
  comments: many(commentsTable),
}));

export const postsRelations = relations(postsTable, ({ one, many }) => ({
  author: one(usersTable, {
    fields: [postsTable.authorId],
    references: [usersTable.id],
  }),
  comments: many(commentsTable),
}));

export const commentsRelations = relations(commentsTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [commentsTable.postId],
    references: [postsTable.id],
  }),
  author: one(usersTable, {
    fields: [commentsTable.authorId],
    references: [usersTable.id],
  }),
}));
```

Now pass the schema to Drizzle and use `query`:

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const db = drizzle(pool, { schema });

// Fetch posts with their author and comments — Drizzle handles the JOINs
const posts = await db.query.postsTable.findMany({
  with: {
    author: true,
    comments: {
      with: {
        author: true, // each comment's author too
      },
    },
  },
});

// posts is now properly nested:
// posts[0].author.name
// posts[0].comments[0].body
// posts[0].comments[0].author.name
```

Under the hood, Drizzle executes **2 queries**, not N+1: one for posts with their
authors (a join), and one for all comments for those posts, then assembles the result
in memory. Compare this to the N+1 approach which would execute 1 + N + (sum of
comments per post) queries.

### Fix 3: Batch Fetching (the DataLoader Pattern)

Sometimes you genuinely cannot do a single join — for example, when loading data across
an API boundary, or when the related data lives in a different table that you only know
about at query time. In these cases, you can batch the secondary queries.

Instead of:
```typescript
for (const post of posts) {
  const author = await fetchUser(post.authorId); // N queries
}
```

Collect all the IDs and fetch them in one query:

```typescript
// Extract all unique author IDs
const authorIds = [...new Set(posts.map((p) => p.authorId))];

// One query for all authors
const authors = await db
  .select()
  .from(usersTable)
  .where(inArray(usersTable.id, authorIds));

// Build a lookup map
const authorMap = new Map(authors.map((a) => [a.id, a]));

// Attach authors to posts in memory — no more queries
const postsWithAuthors = posts.map((post) => ({
  ...post,
  author: authorMap.get(post.authorId)!,
}));
```

This is 2 queries total regardless of N. The `inArray` helper generates a SQL
`WHERE id IN (1, 2, 3, ...)` clause.

---

## Batch Operations in Drizzle

Single-row operations are fine during development. In production, you regularly need
to insert, update, or delete hundreds or thousands of rows at once.

### Batch Insert

```typescript
const newUsers = [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
  // ... potentially thousands more
];

// Single INSERT with multiple value rows — one round trip
const inserted = await db.insert(usersTable).values(newUsers).returning();
```

Drizzle generates: `INSERT INTO users (name, email) VALUES ($1, $2), ($3, $4), ($5, $6)`

### Chunking Large Batches

PostgreSQL has limits on the number of parameters in a single statement (around 65,535).
For very large datasets, you need to chunk:

```typescript
async function batchInsert<T extends object>(
  table: any,
  rows: T[],
  chunkSize = 1000
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(table).values(chunk);
  }
}

await batchInsert(usersTable, tenThousandUsers);
```

### Batch Update with CASE WHEN

Updating multiple rows with different values is trickier. The naive approach is N
individual updates. The efficient approach uses a `CASE WHEN` expression or a `JOIN`
against a temporary values list.

In Drizzle, you can use the raw SQL escape hatch for this:

```typescript
import { sql } from "drizzle-orm";

// Update multiple tasks' statuses in one query
const updates = [
  { id: 1, status: "done" },
  { id: 2, status: "in_progress" },
  { id: 3, status: "cancelled" },
];

const ids = updates.map((u) => u.id);

await db.execute(sql`
  UPDATE tasks
  SET status = CASE id
    ${sql.join(
      updates.map((u) => sql`WHEN ${u.id} THEN ${u.status}`),
      sql` `
    )}
  END
  WHERE id IN ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}
`);
```

### Batch Delete

```typescript
const idsToDelete = [1, 2, 3, 4, 5];

await db.delete(postsTable).where(inArray(postsTable.id, idsToDelete));
```

### Upsert (Insert or Update)

Drizzle supports `ON CONFLICT DO UPDATE` (PostgreSQL's upsert):

```typescript
await db
  .insert(usersTable)
  .values({ id: 1, name: "Alice", email: "alice@example.com" })
  .onConflictDoUpdate({
    target: usersTable.email, // the unique constraint column
    set: {
      name: "Alice Updated", // what to update on conflict
      updatedAt: new Date(),
    },
  });
```

For "insert or ignore" (skip on conflict):

```typescript
await db
  .insert(tagsTable)
  .values({ name: "typescript" })
  .onConflictDoNothing();
```

---

## The Raw SQL Escape Hatch

No ORM can express every valid SQL query. Complex window functions, recursive CTEs,
full-text search configurations, lateral joins — these push the boundaries of what any
query builder can represent. When you hit that wall, reach for raw SQL.

Drizzle's philosophy here is refreshingly pragmatic: raw SQL is not a last resort to
be ashamed of. It is a first-class feature.

### The `sql` Template Tag

The `sql` tagged template literal lets you write raw SQL while keeping parameterized
values (preventing SQL injection):

```typescript
import { sql } from "drizzle-orm";

// A window function: running total of sales by date
const runningTotals = await db.execute(sql`
  SELECT
    date,
    amount,
    SUM(amount) OVER (ORDER BY date ASC) AS running_total
  FROM sales
  ORDER BY date ASC
`);
```

Values are automatically parameterized — never interpolated directly:

```typescript
const minAmount = 100;
const startDate = new Date("2024-01-01");

// $1 and $2 are parameterized — safe from SQL injection
const filtered = await db.execute(sql`
  SELECT *
  FROM sales
  WHERE amount > ${minAmount}
    AND date >= ${startDate}
`);
```

### Mixing Raw SQL with Drizzle Columns

You can embed Drizzle column references inside raw SQL snippets and vice versa:

```typescript
import { sql } from "drizzle-orm";

// Use a raw SQL expression inside a Drizzle select
const results = await db
  .select({
    id: postsTable.id,
    title: postsTable.title,
    // Raw expression: word count
    wordCount: sql<number>`array_length(string_to_array(${postsTable.content}, ' '), 1)`,
  })
  .from(postsTable);

// results[0].wordCount is typed as number
```

### Recursive CTEs

A classic example of a query that ORMs cannot express natively:

```typescript
// Fetch all descendants of a category in a category tree
async function getCategorySubtree(rootId: number) {
  return db.execute(sql`
    WITH RECURSIVE subtree AS (
      -- Base case: the root category itself
      SELECT id, name, parent_id, 0 AS depth
      FROM categories
      WHERE id = ${rootId}

      UNION ALL

      -- Recursive case: children of nodes already in the tree
      SELECT c.id, c.name, c.parent_id, s.depth + 1
      FROM categories c
      INNER JOIN subtree s ON c.parent_id = s.id
    )
    SELECT * FROM subtree ORDER BY depth, name
  `);
}
```

### Full-Text Search

PostgreSQL's full-text search is powerful but not expressible in most query builders:

```typescript
async function searchPosts(query: string) {
  // The double colon :: is PostgreSQL casting syntax
  return db.execute(sql`
    SELECT
      id,
      title,
      ts_rank(
        to_tsvector('english', title || ' ' || COALESCE(content, '')),
        plainto_tsquery('english', ${query})
      ) AS rank
    FROM posts
    WHERE to_tsvector('english', title || ' ' || COALESCE(content, ''))
          @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 20
  `);
}
```

The rule: **use the ORM when it makes your code clearer. Use raw SQL when the ORM
gets in the way.** These are not competing options — they are complementary tools.

---

## The Repository Pattern

As your application grows, you will find yourself writing the same query logic in
multiple places — in route handlers, in background jobs, in tests. When the schema
changes, you update ten files instead of one.

The repository pattern solves this by **centralizing all data access for an entity
behind a single interface**. A repository is just a class (or object) that owns every
query related to one table.

```typescript
// repositories/posts.repository.ts
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { postsTable, usersTable } from "../db/schema";

export type Post = typeof postsTable.$inferSelect;
export type NewPost = typeof postsTable.$inferInsert;
export type PostWithAuthor = Post & { author: { name: string; email: string } };

export class PostsRepository {
  async findById(id: number): Promise<Post | null> {
    const [post] = await db
      .select()
      .from(postsTable)
      .where(eq(postsTable.id, id));
    return post ?? null;
  }

  async findWithAuthor(id: number): Promise<PostWithAuthor | null> {
    const [row] = await db
      .select({
        id: postsTable.id,
        title: postsTable.title,
        content: postsTable.content,
        authorId: postsTable.authorId,
        createdAt: postsTable.createdAt,
        author: {
          name: usersTable.name,
          email: usersTable.email,
        },
      })
      .from(postsTable)
      .innerJoin(usersTable, eq(postsTable.authorId, usersTable.id))
      .where(eq(postsTable.id, id));

    return row ?? null;
  }

  async findByAuthor(authorId: number, limit = 20): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.authorId, authorId))
      .orderBy(desc(postsTable.createdAt))
      .limit(limit);
  }

  async create(data: NewPost): Promise<Post> {
    const [post] = await db.insert(postsTable).values(data).returning();
    return post;
  }

  async update(id: number, data: Partial<NewPost>): Promise<Post | null> {
    const [post] = await db
      .update(postsTable)
      .set(data)
      .where(eq(postsTable.id, id))
      .returning();
    return post ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await db
      .delete(postsTable)
      .where(eq(postsTable.id, id))
      .returning({ id: postsTable.id });
    return result.length > 0;
  }

  async countByAuthor(authorId: number): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(postsTable)
      .where(eq(postsTable.authorId, authorId));
    return count;
  }
}

// Export a singleton instance
export const postsRepository = new PostsRepository();
```

Now in your route handlers:

```typescript
// routes/posts.ts
import { postsRepository } from "../repositories/posts.repository";

app.get("/posts/:id", async (req, res) => {
  const post = await postsRepository.findWithAuthor(Number(req.params.id));
  if (!post) return res.status(404).json({ error: "Not found" });
  res.json(post);
});
```

The route handler does not know or care how posts are stored. If you later switch from
PostgreSQL to a different store, you change the repository, not every route.

### Typing Repository Results

The `$inferSelect` and `$inferInsert` types that Drizzle generates are your building
blocks. Build on them:

```typescript
export type Post = typeof postsTable.$inferSelect;
export type NewPost = typeof postsTable.$inferInsert;
export type PostUpdate = Partial<Pick<NewPost, "title" | "content" | "published">>;

// For complex query results, define explicit types
export type PostSummary = {
  id: number;
  title: string;
  authorName: string;
  commentCount: number;
  createdAt: Date;
};
```

---

## The Unit of Work Pattern

Sometimes you need to perform several database operations that must all succeed or all
fail together. A payment that debits one account and credits another. An order that
decrements inventory and creates a shipment record. If any step fails, all changes must
be rolled back.

This is what database transactions are for. Drizzle has first-class transaction support:

```typescript
import { db } from "./db";

async function transferFunds(
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  await db.transaction(async (tx) => {
    // tx is a transaction-scoped Drizzle instance
    // All queries through tx are part of the same transaction

    const [fromAccount] = await tx
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, fromAccountId))
      .for("update"); // row-level lock

    if (!fromAccount || fromAccount.balance < amount) {
      tx.rollback(); // explicitly abort
      throw new Error("Insufficient funds");
    }

    await tx
      .update(accountsTable)
      .set({ balance: sql`balance - ${amount}` })
      .where(eq(accountsTable.id, fromAccountId));

    await tx
      .update(accountsTable)
      .set({ balance: sql`balance + ${amount}` })
      .where(eq(accountsTable.id, toAccountId));

    await tx.insert(transactionsTable).values({
      fromAccountId,
      toAccountId,
      amount,
      type: "transfer",
      createdAt: new Date(),
    });
    // If any query throws, Drizzle automatically rolls back the transaction
  });
}
```

The Unit of Work pattern formalizes this: collect all pending changes, validate them,
then commit in a single transaction. Here is a simplified version:

```typescript
class UnitOfWork {
  private operations: Array<(tx: typeof db) => Promise<void>> = [];

  addOperation(op: (tx: typeof db) => Promise<void>) {
    this.operations.push(op);
    return this;
  }

  async commit(): Promise<void> {
    await db.transaction(async (tx) => {
      for (const op of this.operations) {
        await op(tx as typeof db);
      }
    });
  }
}

// Usage
const uow = new UnitOfWork();

uow
  .addOperation((tx) =>
    tx.insert(ordersTable).values({ userId, total }).then(() => undefined)
  )
  .addOperation((tx) =>
    tx
      .update(inventoryTable)
      .set({ quantity: sql`quantity - ${quantity}` })
      .where(eq(inventoryTable.productId, productId))
      .then(() => undefined)
  );

await uow.commit(); // all-or-nothing
```

---

## Soft Deletes

Hard deletion (`DELETE FROM ...`) destroys data permanently. For most applications,
this is wrong. You lose audit history. You cannot undo user mistakes. Referential
integrity breaks if other records point to the deleted row.

The solution: **soft deletes**. Instead of deleting a row, you mark it as deleted
with a timestamp column.

### Schema Setup

```typescript
export const postsTable = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  authorId: integer("author_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"), // null = active, non-null = soft-deleted
});
```

### Soft Delete Operation

```typescript
// "Delete" a post
async function softDeletePost(id: number): Promise<void> {
  await db
    .update(postsTable)
    .set({ deletedAt: new Date() })
    .where(eq(postsTable.id, id));
}

// Restore a soft-deleted post
async function restorePost(id: number): Promise<void> {
  await db
    .update(postsTable)
    .set({ deletedAt: null })
    .where(eq(postsTable.id, id));
}
```

### The Problem: Filtering Everywhere

Every query must now filter out soft-deleted records. Miss one `AND deleted_at IS NULL`
and you serve deleted data.

Centralize this in your repository:

```typescript
export class PostsRepository {
  // The base "active records" filter — use everywhere
  private get activeCondition() {
    return isNull(postsTable.deletedAt);
  }

  async findById(id: number): Promise<Post | null> {
    const [post] = await db
      .select()
      .from(postsTable)
      .where(and(eq(postsTable.id, id), this.activeCondition));
    return post ?? null;
  }

  async findAll(): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(this.activeCondition);
  }

  // Admin method — bypasses soft delete filter
  async findAllIncludingDeleted(): Promise<Post[]> {
    return db.select().from(postsTable);
  }

  async softDelete(id: number): Promise<void> {
    await db
      .update(postsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(postsTable.id, id), this.activeCondition));
  }
}
```

### Index Consideration

Add a partial index so queries on active records remain fast even as the soft-deleted
pile grows:

```sql
-- Only index active records (where deleted_at IS NULL)
CREATE INDEX idx_posts_active ON posts (created_at DESC)
WHERE deleted_at IS NULL;
```

In Drizzle migrations, you can add this with:

```typescript
// In your migration SQL
await sql`
  CREATE INDEX idx_posts_active ON posts (created_at DESC)
  WHERE deleted_at IS NULL
`.execute(db);
```

---

## Optimistic Locking with Version Columns

Here is a concurrency problem: two users open the same task and both start editing it.
User A saves first. Then User B saves — overwriting User A's changes silently. User A's
work is lost. This is called a **lost update**.

Pessimistic locking prevents this by locking the row when a user opens it (using
`SELECT FOR UPDATE`). This is safe but serializes access — User B cannot even read the
task while User A is editing it.

**Optimistic locking** takes a different approach: assume conflicts are rare. Allow
concurrent reads. Only check for conflicts at write time.

The mechanism: a `version` column (an integer) that increments every time the row is
updated. When saving, you include the version you read. If the version in the database
does not match, someone else updated the row since you read it — fail the update.

### Schema

```typescript
export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("todo"),
  assigneeId: integer("assignee_id").references(() => usersTable.id),
  version: integer("version").notNull().default(1), // the optimistic lock column
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### The Update Logic

```typescript
async function updateTask(
  id: number,
  expectedVersion: number,
  updates: Partial<NewTask>
): Promise<Task> {
  const [updated] = await db
    .update(tasksTable)
    .set({
      ...updates,
      version: sql`version + 1`, // atomically increment
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasksTable.id, id),
        eq(tasksTable.version, expectedVersion) // the optimistic lock check
      )
    )
    .returning();

  if (!updated) {
    // Either the task does not exist, or the version did not match
    const task = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .then((rows) => rows[0]);

    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    throw new Error(
      `Conflict: task ${id} was modified by another user. ` +
        `Expected version ${expectedVersion}, found version ${task.version}. ` +
        `Please refresh and try again.`
    );
  }

  return updated;
}
```

### Usage Flow

```typescript
// 1. User opens the task — fetch it and remember the version
const task = await tasksRepository.findById(taskId);
// task.version = 5

// 2. User edits and saves — send version back to server
const updated = await updateTask(taskId, task.version, {
  title: "Updated title",
  status: "in_progress",
});
// If another user saved between steps 1 and 2, this throws

// 3. Client handles the conflict error
try {
  await updateTask(taskId, staleVersion, changes);
} catch (err) {
  if (err.message.startsWith("Conflict:")) {
    showConflictDialog("Someone else updated this task. Please refresh.");
  }
}
```

The key insight: the `WHERE version = $expectedVersion` clause makes the update itself
the conflict check. If the version changed, zero rows are affected, and the `.returning()`
result is empty. No separate lock needed.

---

## Multi-Tenancy Row Isolation

A multi-tenant application serves multiple customers (tenants) from a single database.
The critical requirement: **tenant A's data must never be visible to tenant B**, under
any circumstances.

There are three main approaches to multi-tenancy at the database level:

| Approach | Description | Isolation | Complexity |
|----------|-------------|-----------|------------|
| Separate databases | Each tenant gets their own PostgreSQL database | Perfect | High (connection pooling, migrations) |
| Separate schemas | Each tenant gets their own PostgreSQL schema | Strong | Medium |
| Row-level isolation | All tenants share tables; a `workspace_id` column filters rows | Good | Low (but requires discipline) |

We will focus on row-level isolation, as it is the most common for SaaS applications
and the most relevant to your project.

### The Core Rule

**Every tenant-scoped table gets a `workspace_id` column. Every query filters by
`workspace_id`.** No exceptions.

```typescript
export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("todo"),
});
```

Note that `tasksTable` has `workspaceId` even though it also has `projectId` (and
projects already have a workspace). This is intentional — it avoids a JOIN when you
need to check workspace membership, and it makes partial indexes and partition pruning
more effective.

### Tenant-Scoped Repository

Instead of passing `workspaceId` to every method, create a tenant-scoped repository
factory:

```typescript
// repositories/tasks.repository.ts

export type TasksRepository = ReturnType<typeof createTasksRepository>;

export function createTasksRepository(workspaceId: number) {
  // workspaceId is closed over — every method automatically filters by it

  const tenantCondition = eq(tasksTable.workspaceId, workspaceId);

  return {
    async findAll(): Promise<Task[]> {
      return db
        .select()
        .from(tasksTable)
        .where(tenantCondition)
        .orderBy(desc(tasksTable.createdAt));
    },

    async findById(id: number): Promise<Task | null> {
      const [task] = await db
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.id, id), tenantCondition));
      return task ?? null;
    },

    async findByProject(projectId: number): Promise<Task[]> {
      return db
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.projectId, projectId), tenantCondition));
    },

    async create(data: Omit<NewTask, "workspaceId">): Promise<Task> {
      const [task] = await db
        .insert(tasksTable)
        .values({ ...data, workspaceId })
        .returning();
      return task;
    },

    async update(id: number, data: Partial<NewTask>): Promise<Task | null> {
      const [task] = await db
        .update(tasksTable)
        .set(data)
        .where(and(eq(tasksTable.id, id), tenantCondition))
        .returning();
      return task ?? null;
    },

    async delete(id: number): Promise<boolean> {
      const rows = await db
        .delete(tasksTable)
        .where(and(eq(tasksTable.id, id), tenantCondition))
        .returning({ id: tasksTable.id });
      return rows.length > 0;
    },
  };
}
```

In your request handler, create the repository with the authenticated workspace ID:

```typescript
// middleware extracts workspace from JWT
app.use((req, res, next) => {
  req.workspaceId = decodeJWT(req.headers.authorization).workspaceId;
  next();
});

app.get("/tasks", async (req, res) => {
  // Repository is scoped to the current tenant — cannot leak data
  const tasksRepo = createTasksRepository(req.workspaceId);
  const tasks = await tasksRepo.findAll();
  res.json(tasks);
});
```

### Indexes for Multi-Tenant Queries

Every table needs a composite index starting with `workspace_id`:

```sql
CREATE INDEX idx_tasks_workspace ON tasks (workspace_id, created_at DESC);
CREATE INDEX idx_tasks_project ON tasks (workspace_id, project_id);
CREATE INDEX idx_projects_workspace ON projects (workspace_id, created_at DESC);
```

Without these indexes, every query scans the entire table to filter by workspace — fine
for 1,000 rows, catastrophically slow for 10,000,000 rows spread across 10,000 tenants.

### Row-Level Security (Defense in Depth)

For extra safety, you can enable PostgreSQL Row-Level Security, which enforces tenant
isolation at the database engine level — even if your application code has a bug:

```sql
-- Enable RLS on a table
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Create a policy: users can only see rows for their workspace
CREATE POLICY tenant_isolation ON tasks
  USING (workspace_id = current_setting('app.current_workspace_id')::int);
```

Your application sets the configuration variable before each query:

```typescript
await db.execute(sql`SET LOCAL app.current_workspace_id = ${workspaceId}`);
```

RLS is a powerful last line of defense, though it adds overhead. It is not covered in
depth here, but worth knowing exists.

---

## Read Replicas with Drizzle

As your application grows, reads typically outnumber writes by 10:1 or more. A single
database handles both. Eventually reads saturate its CPU. The solution: **read replicas**.

A read replica is a continuously synchronized copy of your primary database. It is
read-only — any write must go to the primary, and the replica will eventually reflect
it (with a small delay, called replication lag).

### Why Not Just Use the Primary for Everything?

1. **CPU relief**: Analytics queries can run on the replica without slowing down
   user-facing writes on the primary.
2. **Geo-distribution**: Put replicas in different regions to serve nearby users
   faster.
3. **Resilience**: If the primary goes down, you can promote a replica.

### Setting Up Multiple Connections in Drizzle

```typescript
// db/index.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Primary: handles all writes
const primaryPool = new Pool({
  connectionString: process.env.DATABASE_PRIMARY_URL,
  max: 20,
});

// Replica: handles reads (possibly a different server)
const replicaPool = new Pool({
  connectionString: process.env.DATABASE_REPLICA_URL ?? process.env.DATABASE_PRIMARY_URL,
  max: 40, // more connections — reads are often more concurrent
});

export const db = drizzle(primaryPool, { schema });
export const dbRead = drizzle(replicaPool, { schema });
```

### Using the Right Connection

The discipline is straightforward:
- **Mutations** (INSERT, UPDATE, DELETE) always use `db` (primary)
- **Reads** use `dbRead` (replica) by default
- **Reads that must be immediately consistent** (e.g., reading data you just wrote)
  use `db` (primary)

```typescript
export class PostsRepository {
  async findById(id: number): Promise<Post | null> {
    // Use replica — eventual consistency is fine for a regular read
    const [post] = await dbRead
      .select()
      .from(postsTable)
      .where(eq(postsTable.id, id));
    return post ?? null;
  }

  async create(data: NewPost): Promise<Post> {
    // Write to primary
    const [post] = await db.insert(postsTable).values(data).returning();
    return post;
  }

  async createAndReturn(data: NewPost): Promise<Post> {
    // Write to primary, then immediately read from primary
    // (replica might not have caught up yet)
    const [post] = await db.insert(postsTable).values(data).returning();
    return post; // .returning() already gives us the data — no second query needed
  }
}
```

### Replication Lag: A Practical Concern

Replication is asynchronous. After a write, the replica might be 10ms, 500ms, or
several seconds behind. For most reads, this is acceptable. But some flows are
sensitive:

```
User changes their password → Success
User immediately tries to log in → Reads from replica → Old password → Login fails
```

For these flows, read from the primary:

```typescript
async function verifyUserAfterPasswordChange(userId: number): Promise<User> {
  // Must read from primary — user just changed their password
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user;
}
```

### Wrapping the Choice in a Repository Method

Rather than scattering `db` vs. `dbRead` decisions throughout your code, encapsulate
the choice:

```typescript
export class PostsRepository {
  constructor(
    private writer = db,
    private reader = dbRead
  ) {}

  async findById(id: number, { consistentRead = false } = {}): Promise<Post | null> {
    const connection = consistentRead ? this.writer : this.reader;
    const [post] = await connection
      .select()
      .from(postsTable)
      .where(eq(postsTable.id, id));
    return post ?? null;
  }

  async create(data: NewPost): Promise<Post> {
    const [post] = await this.writer.insert(postsTable).values(data).returning();
    return post;
  }
}

// Normal usage: reads go to replica
const post = await postsRepo.findById(id);

// Read-after-write: force primary
const freshPost = await postsRepo.findById(id, { consistentRead: true });
```

---

## Summary

| Pattern | Problem Solved | Key Mechanism |
|---------|---------------|---------------|
| Eager loading (joins) | N+1 query problem | Single JOIN query instead of per-row queries |
| Batch fetching | N+1 across API boundaries | `inArray` to bulk-load related records |
| Batch insert/upsert | Performance on bulk operations | Multi-row `VALUES`, `ON CONFLICT DO UPDATE` |
| Raw SQL escape hatch | Queries ORMs cannot express | `sql` tagged template literal |
| Repository pattern | Query logic scattered across app | Entity-scoped class owning all data access |
| Transactions (Unit of Work) | Multiple writes must be atomic | `db.transaction()` with automatic rollback |
| Soft deletes | Permanent deletion loses history | `deleted_at` timestamp, filter in all queries |
| Optimistic locking | Lost updates from concurrent edits | `version` column, `WHERE version = expected` |
| Multi-tenant row isolation | Tenant data leaks | `workspace_id` on every table, factory repositories |
| Read replicas | Read scalability, CPU relief | Separate `db` and `dbRead` connections |

---

## Exercises

### Exercise 1: Diagnose an N+1

You have a `getWorkspaceActivity` function that returns the last 50 events in a
workspace, each with the user's name who triggered it:

```typescript
async function getWorkspaceActivity(workspaceId: number) {
  const events = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.workspaceId, workspaceId))
    .orderBy(desc(eventsTable.createdAt))
    .limit(50);

  const result = [];
  for (const event of events) {
    const [user] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, event.userId));
    result.push({ ...event, userName: user.name });
  }
  return result;
}
```

1. Identify the N+1 problem.
2. Rewrite it using a JOIN to fix it.
3. Rewrite it again using the batch-fetch approach (collect IDs, fetch all at once).
4. Add query logging and verify both solutions produce exactly 1 query.

### Exercise 2: Soft Delete Repository

Add soft deletes to a `ProjectsRepository`:

1. Add a `deletedAt: timestamp("deleted_at")` column to `projectsTable`.
2. Write a migration to add the column.
3. Implement `softDelete(id)`, `restore(id)`, `findAll()` (active only), and
   `findAllIncludingDeleted()` methods.
4. Write a PostgreSQL partial index that covers only active projects.
5. Verify: soft-deleting a project should not affect counts in `findAll()`.

### Exercise 3: Optimistic Locking Under Load

Simulate two concurrent users editing the same task:

```typescript
// Simulate User A and User B both reading version 3 of a task
const [taskA] = await Promise.all([
  tasksRepo.findById(taskId),
  tasksRepo.findById(taskId),
]);

// Both try to save simultaneously
const [resultA, resultB] = await Promise.allSettled([
  updateTask(taskId, taskA.version, { title: "User A's changes" }),
  updateTask(taskId, taskA.version, { title: "User B's changes" }),
]);
```

1. Which save wins? Which throws?
2. Verify the winning version is `version + 1`.
3. Write a retry loop for the losing client: fetch the latest version, apply its
   changes on top, and retry the save.

### Exercise 4: Multi-Tenant Isolation Test

Write a test that proves tenant isolation:

1. Create two workspaces: `workspaceA` and `workspaceB`.
2. Create tasks in each workspace.
3. Use `createTasksRepository(workspaceA.id)` to query tasks.
4. Assert that tasks from `workspaceB` are never returned.
5. Write a test that tries to delete a task from `workspaceB` using
   `workspaceA`'s repository — assert it fails (returns `false`, not an error).

### Exercise 5: Read Replica Routing

Implement a `DatabaseRouter` class that:

1. Automatically routes `SELECT` queries to the replica and writes to the primary.
2. Accepts a `{ forcePrimary: true }` option to override replica routing.
3. Wraps `db.transaction()` to always use the primary.
4. Logs which connection was used for each query.

Then explain: why would reading inside a transaction always use the primary, even for
`SELECT` statements?
