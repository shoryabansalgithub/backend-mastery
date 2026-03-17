# Module 4, Lesson 2: Drizzle ORM

## Why Drizzle?

In the last lesson, we surveyed the ORM landscape. Now we're going deep on Drizzle
ORM — the TypeScript ORM that feels like writing SQL.

Drizzle's design philosophy can be summarized in three principles:

1. **If you know SQL, you know Drizzle.** The API mirrors SQL syntax so closely that
   you can almost read Drizzle code as SQL.

2. **Zero runtime overhead.** Drizzle doesn't ship a query engine, a WASM binary, or
   a proxy layer. It generates SQL strings and parameterized values — that's it.
   Your database driver (like `pg`) does the actual work.

3. **TypeScript-native schema.** Your schema is defined in `.ts` files using standard
   TypeScript. No custom DSL, no code generation step, no `.prisma` files. Your
   schema is just code.

### The Analogy

If Prisma is like using Google Translate (you describe what you want, it figures out
the translation), then Drizzle is like having a grammar checker while you write in
the foreign language yourself. You stay close to SQL, but Drizzle catches your
mistakes and fills in the type information.

---

## Setting Up Drizzle with PostgreSQL

Let's build from scratch. You'll need these packages:

```bash
# Core ORM
npm install drizzle-orm

# PostgreSQL driver
npm install pg
npm install -D @types/pg

# Drizzle Kit (CLI for migrations)
npm install -D drizzle-kit
```

### The Database Connection

```typescript
// src/db/index.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Example: "postgresql://postgres:password@localhost:5432/myapp"
});

export const db = drizzle(pool);
```

That's it. `db` is now your Drizzle instance. Every query goes through it.

You can also pass your schema for relation queries (we'll cover this in Lesson 4):

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
```

### Drizzle Configuration

Create a `drizzle.config.ts` at the project root:

```typescript
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",           // Where migration files go
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

---

## Schema Definition: Tables, Columns, Types

This is the heart of Drizzle. Your schema is TypeScript code that describes your
database tables:

```typescript
// src/db/schema.ts
import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

// Enums
export const roleEnum = pgEnum("role", ["admin", "member", "viewer"]);
export const statusEnum = pgEnum("status", ["todo", "in_progress", "done", "cancelled"]);

// Users table
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  role: roleEnum("role").default("member").notNull(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Projects table
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  ownerId: integer("owner_id")
    .references(() => users.id)
    .notNull(),
  isPublic: boolean("is_public").default(false).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Tasks table
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  status: statusEnum("status").default("todo").notNull(),
  priority: integer("priority").default(0).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id)
    .notNull(),
  assigneeId: integer("assignee_id").references(() => users.id),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### Column Types Reference

Here's a reference of the most common PostgreSQL column types in Drizzle:

```typescript
import {
  // Numeric
  serial,         // auto-incrementing integer (SERIAL)
  integer,        // INTEGER
  smallint,       // SMALLINT
  bigint,         // BIGINT (returns string by default due to JS number limits)
  real,           // REAL (float4)
  doublePrecision,// DOUBLE PRECISION (float8)
  numeric,        // NUMERIC(precision, scale) — exact decimal

  // String
  text,           // TEXT (unlimited length)
  varchar,        // VARCHAR(n)
  char,           // CHAR(n)

  // Boolean
  boolean,        // BOOLEAN

  // Date/Time
  timestamp,      // TIMESTAMP (without time zone by default)
  date,           // DATE
  time,           // TIME
  interval,       // INTERVAL

  // UUID
  uuid,           // UUID

  // JSON
  json,           // JSON (stored as text, parsed on read)
  jsonb,          // JSONB (stored as binary, indexable, recommended)

  // Other
  pgEnum,         // Custom ENUM type
} from "drizzle-orm/pg-core";
```

### Column Modifiers

Every column can be modified with these methods:

```typescript
const example = pgTable("example", {
  // Primary key
  id: serial("id").primaryKey(),

  // Not null (column cannot be NULL)
  name: text("name").notNull(),

  // Default value
  role: text("role").default("user"),

  // Default to current timestamp
  createdAt: timestamp("created_at").defaultNow(),

  // Unique constraint
  email: text("email").unique(),

  // Foreign key reference
  userId: integer("user_id").references(() => users.id),

  // Foreign key with cascade
  projectId: integer("project_id").references(() => projects.id, {
    onDelete: "cascade",  // When project is deleted, delete this row too
    onUpdate: "cascade",
  }),

  // UUID with auto-generation
  publicId: uuid("public_id").defaultRandom(),
});
```

### Why TypeScript Schema Matters

Here's the key insight: because your schema is TypeScript, the compiler knows
the exact shape of every table. This enables:

```typescript
// The compiler KNOWS that users.email is a non-null varchar
// and users.avatarUrl is a nullable text

const result = await db.select({
  email: users.email,
  avatar: users.avatarUrl,
}).from(users);

// result type is automatically inferred as:
// { email: string; avatar: string | null }[]
//
// Notice: email is `string` (not null), avatar is `string | null` (nullable)
```

No manual type annotations. No `as` casts. The types flow from the schema through
the query to the result.

---

## drizzle-kit: push, generate, migrate

Drizzle Kit is the CLI companion to Drizzle ORM. It manages your database schema.

### Three Workflows

#### 1. `drizzle-kit push` — Prototype Fast

Pushes your schema directly to the database. No migration files. Great for
prototyping:

```bash
npx drizzle-kit push
```

This compares your TypeScript schema to the actual database and applies the diff.
If you added a column, it adds it. If you removed one, it drops it.

**Use for:** Local development, prototyping, hackathons.
**Don't use for:** Production (no migration history, no rollback).

#### 2. `drizzle-kit generate` — Create Migration Files

Generates SQL migration files by diffing your schema:

```bash
npx drizzle-kit generate
```

This creates a file like `drizzle/0001_cool_migration.sql`:

```sql
CREATE TABLE "users" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "email" varchar(255) NOT NULL UNIQUE,
  "role" "role" DEFAULT 'member' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
```

#### 3. `drizzle-kit migrate` — Apply Migration Files

Applies pending migrations to the database:

```bash
npx drizzle-kit migrate
```

Or programmatically in your code:

```typescript
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db";

await migrate(db, { migrationsFolder: "./drizzle" });
```

**Use for:** Production deployments (gives you a migration history, rollback
capability, and audit trail).

### Typical Workflow

```
1. Edit src/db/schema.ts (add/change tables)
2. Run `npx drizzle-kit generate` (creates migration SQL)
3. Review the generated SQL file
4. Run `npx drizzle-kit migrate` (applies to database)
5. Commit both schema.ts and migration files to git
```

---

## Basic CRUD: Insert, Select, Update, Delete

Now the fun part. Let's see how Drizzle handles the four fundamental operations.

### INSERT

```typescript
import { db } from "./db";
import { users } from "./db/schema";

// Insert one row
const newUser = await db.insert(users).values({
  name: "Alice Chen",
  email: "alice@example.com",
  role: "admin",
});
// newUser has no return value by default

// Insert with RETURNING
const [insertedUser] = await db.insert(users).values({
  name: "Alice Chen",
  email: "alice@example.com",
  role: "admin",
}).returning();
// insertedUser: { id: 1, name: "Alice Chen", email: "alice@example.com", ... }

// Insert multiple rows
const insertedUsers = await db.insert(users).values([
  { name: "Bob", email: "bob@example.com" },
  { name: "Carol", email: "carol@example.com" },
  { name: "Dave", email: "dave@example.com" },
]).returning();

// Insert with conflict handling (upsert)
import { sql } from "drizzle-orm";

const upserted = await db.insert(users)
  .values({
    name: "Alice Chen",
    email: "alice@example.com",
    role: "admin",
  })
  .onConflictDoUpdate({
    target: users.email,
    set: { name: "Alice Chen", role: "admin" },
  })
  .returning();

// Insert with DO NOTHING on conflict
await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com" })
  .onConflictDoNothing({ target: users.email });
```

### SELECT

```typescript
import { db } from "./db";
import { users } from "./db/schema";
import { eq, ne, gt, lt, gte, lte, like, ilike, inArray, sql } from "drizzle-orm";

// Select all columns from all rows
const allUsers = await db.select().from(users);
// Type: { id: number; name: string; email: string; role: "admin" | "member" | "viewer"; ... }[]

// Select specific columns
const names = await db.select({
  id: users.id,
  name: users.name,
}).from(users);
// Type: { id: number; name: string }[]

// Select with alias
const result = await db.select({
  userName: users.name,
  userEmail: users.email,
}).from(users);
// Type: { userName: string; userEmail: string }[]

// Select first row
const firstUser = await db.select().from(users).limit(1);
// Still returns an array — use [0] to get the first element

// Count
const [{ count }] = await db
  .select({ count: sql<number>`count(*)` })
  .from(users);
```

### WHERE Clauses

This is where Drizzle shines — fully typed filter operators:

```typescript
import {
  eq,       // equals (=)
  ne,       // not equals (!=)
  gt,       // greater than (>)
  gte,      // greater than or equal (>=)
  lt,       // less than (<)
  lte,      // less than or equal (<=)
  like,     // LIKE (case-sensitive)
  ilike,    // ILIKE (case-insensitive, PostgreSQL only)
  inArray,  // IN (...)
  notInArray, // NOT IN (...)
  between,  // BETWEEN x AND y
  isNull,   // IS NULL
  isNotNull,// IS NOT NULL
  and,      // AND
  or,       // OR
  not,      // NOT
  sql,      // Raw SQL escape hatch
} from "drizzle-orm";

// Simple equality
const admins = await db.select().from(users).where(eq(users.role, "admin"));
// SELECT * FROM users WHERE role = 'admin'

// Not equal
const nonAdmins = await db.select().from(users).where(ne(users.role, "admin"));
// SELECT * FROM users WHERE role != 'admin'

// Greater than
const recentUsers = await db.select().from(users).where(
  gt(users.createdAt, new Date("2024-01-01"))
);
// SELECT * FROM users WHERE created_at > '2024-01-01'

// LIKE pattern matching
const aliceUsers = await db.select().from(users).where(
  ilike(users.name, "%alice%")
);
// SELECT * FROM users WHERE name ILIKE '%alice%'

// IN array
const specificUsers = await db.select().from(users).where(
  inArray(users.id, [1, 2, 3])
);
// SELECT * FROM users WHERE id IN (1, 2, 3)

// BETWEEN
const rangeUsers = await db.select().from(users).where(
  between(users.id, 10, 20)
);
// SELECT * FROM users WHERE id BETWEEN 10 AND 20

// IS NULL
const noAvatar = await db.select().from(users).where(
  isNull(users.avatarUrl)
);
// SELECT * FROM users WHERE avatar_url IS NULL

// Combining with AND
const activeAdmins = await db.select().from(users).where(
  and(
    eq(users.role, "admin"),
    eq(users.isActive, true)
  )
);
// SELECT * FROM users WHERE role = 'admin' AND is_active = true

// Combining with OR
const adminOrInactive = await db.select().from(users).where(
  or(
    eq(users.role, "admin"),
    eq(users.isActive, false)
  )
);
// SELECT * FROM users WHERE role = 'admin' OR is_active = false

// Complex nested conditions
const complex = await db.select().from(users).where(
  and(
    eq(users.isActive, true),
    or(
      eq(users.role, "admin"),
      and(
        eq(users.role, "member"),
        gt(users.createdAt, new Date("2024-06-01"))
      )
    )
  )
);
// SELECT * FROM users WHERE is_active = true AND (
//   role = 'admin' OR (role = 'member' AND created_at > '2024-06-01')
// )
```

### UPDATE

```typescript
// Update rows matching a condition
await db.update(users)
  .set({ role: "admin" })
  .where(eq(users.email, "alice@example.com"));
// UPDATE users SET role = 'admin' WHERE email = 'alice@example.com'

// Update with RETURNING
const [updated] = await db.update(users)
  .set({ role: "admin", updatedAt: new Date() })
  .where(eq(users.id, 1))
  .returning();
// updated: { id: 1, name: "Alice", role: "admin", ... }

// Update using current value (increment)
await db.update(tasks)
  .set({ priority: sql`${tasks.priority} + 1` })
  .where(eq(tasks.projectId, 5));
// UPDATE tasks SET priority = priority + 1 WHERE project_id = 5

// Update multiple fields
await db.update(tasks)
  .set({
    status: "done",
    updatedAt: new Date(),
  })
  .where(
    and(
      eq(tasks.projectId, 5),
      eq(tasks.status, "in_progress")
    )
  );
```

### DELETE

```typescript
// Delete rows matching a condition
await db.delete(users).where(eq(users.id, 1));
// DELETE FROM users WHERE id = 1

// Delete with RETURNING (get the deleted rows)
const [deleted] = await db.delete(users)
  .where(eq(users.id, 1))
  .returning();
// deleted: { id: 1, name: "Alice", ... }

// Delete all (careful!)
await db.delete(users);
// DELETE FROM users  — deletes everything!

// Soft delete pattern (common in production)
// Instead of DELETE, update a deletedAt column:
await db.update(users)
  .set({ deletedAt: new Date() })
  .where(eq(users.id, 1));
```

---

## Returning Clauses

The `.returning()` method is one of Drizzle's most useful features. It tells
PostgreSQL to return the affected rows, saving you a separate SELECT query.

```typescript
// Return all columns
const [user] = await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com" })
  .returning();
// user: full row with all columns including auto-generated id and timestamps

// Return specific columns only
const [{ id, email }] = await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com" })
  .returning({ id: users.id, email: users.email });
// Efficient: only returns what you need

// Works with UPDATE too
const updatedRows = await db.update(users)
  .set({ role: "admin" })
  .where(eq(users.isActive, true))
  .returning({ id: users.id, name: users.name, role: users.role });
// updatedRows: { id: number; name: string; role: string }[]

// And DELETE
const deletedRows = await db.delete(users)
  .where(lt(users.createdAt, new Date("2020-01-01")))
  .returning();
```

### Why RETURNING Matters

Without RETURNING, inserting a row and getting the auto-generated ID requires two
queries:

```typescript
// BAD: Two queries
await db.insert(users).values({ name: "Alice", email: "alice@example.com" });
const [user] = await db.select().from(users).where(eq(users.email, "alice@example.com"));

// GOOD: One query
const [user] = await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com" })
  .returning();
```

---

## Type Inference from Schema

One of Drizzle's most powerful features is automatic type inference from your schema
definitions.

### $inferSelect and $inferInsert

```typescript
import { users } from "./db/schema";

// Infer the SELECT type (what you get back from queries)
type User = typeof users.$inferSelect;
// Equivalent to:
// {
//   id: number;
//   name: string;
//   email: string;
//   role: "admin" | "member" | "viewer";
//   avatarUrl: string | null;
//   isActive: boolean;
//   createdAt: Date;
//   updatedAt: Date;
// }

// Infer the INSERT type (what you pass to insert)
type NewUser = typeof users.$inferInsert;
// Equivalent to:
// {
//   name: string;            // required (notNull, no default)
//   email: string;           // required (notNull, no default)
//   id?: number;             // optional (has default — serial)
//   role?: "admin" | "member" | "viewer";  // optional (has default)
//   avatarUrl?: string | null;             // optional (nullable)
//   isActive?: boolean;                    // optional (has default)
//   createdAt?: Date;                      // optional (has default)
//   updatedAt?: Date;                      // optional (has default)
// }
```

Notice the difference:

- `$inferSelect` makes everything required (you always get all columns back).
  Nullable columns become `T | null`.
- `$inferInsert` makes columns with defaults or nullable columns optional.
  This matches what you'd actually pass to an INSERT statement.

### Using Inferred Types in Your Application

```typescript
// src/types.ts
import { users, projects, tasks } from "./db/schema";

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

```typescript
// src/routes/users.ts
import { User, NewUser } from "../types";

async function createUser(data: NewUser): Promise<User> {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

async function getUserById(id: number): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}
```

### Partial Selects and Type Inference

When you select specific columns, the return type automatically narrows:

```typescript
// Full select
const fullUsers = await db.select().from(users);
// Type: { id: number; name: string; email: string; role: ...; ... }[]

// Partial select
const partialUsers = await db.select({
  id: users.id,
  name: users.name,
}).from(users);
// Type: { id: number; name: string }[]
// Only the selected columns appear in the type!

// Computed columns
const withCount = await db.select({
  name: users.name,
  nameLength: sql<number>`length(${users.name})`,
}).from(users);
// Type: { name: string; nameLength: number }[]
```

---

## Ordering, Limiting, and Offsetting

```typescript
import { asc, desc } from "drizzle-orm";

// Order by
const sorted = await db.select().from(users)
  .orderBy(asc(users.name));
// SELECT * FROM users ORDER BY name ASC

// Multiple order columns
const multiSorted = await db.select().from(users)
  .orderBy(desc(users.createdAt), asc(users.name));
// SELECT * FROM users ORDER BY created_at DESC, name ASC

// Limit and offset (for pagination)
const page2 = await db.select().from(users)
  .orderBy(asc(users.id))
  .limit(10)
  .offset(10);
// SELECT * FROM users ORDER BY id ASC LIMIT 10 OFFSET 10

// Combining everything
const result = await db.select({
  id: users.id,
  name: users.name,
  email: users.email,
})
  .from(users)
  .where(eq(users.isActive, true))
  .orderBy(desc(users.createdAt))
  .limit(20)
  .offset(0);
```

---

## Drizzle vs. Prisma: Side-by-Side Comparison

Let's compare the same operations in both ORMs so you can see the trade-offs
concretely.

### Schema Definition

**Drizzle (TypeScript):**
```typescript
// src/db/schema.ts
import { pgTable, serial, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  authorId: integer("author_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Prisma (Custom DSL):**
```prisma
// prisma/schema.prisma
model User {
  id        Int      @id @default(autoincrement())
  name      String
  email     String   @unique @db.VarChar(255)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]

  @@map("users")
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  authorId  Int      @map("author_id")
  createdAt DateTime @default(now()) @map("created_at")
  author    User     @relation(fields: [authorId], references: [id])

  @@map("posts")
}
```

**Verdict:** Drizzle's schema is standard TypeScript — you can import it, compose it,
use it in type utilities. Prisma's schema is a custom language that requires a
separate toolchain.

### Simple Query

**Drizzle:**
```typescript
const admins = await db.select().from(users).where(eq(users.role, "admin"));
```

**Prisma:**
```typescript
const admins = await prisma.user.findMany({ where: { role: "admin" } });
```

**Verdict:** Prisma is slightly more concise. Drizzle reads more like SQL.

### Insert with Return

**Drizzle:**
```typescript
const [user] = await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com" })
  .returning();
```

**Prisma:**
```typescript
const user = await prisma.user.create({
  data: { name: "Alice", email: "alice@example.com" },
});
```

**Verdict:** Nearly identical DX. Prisma always returns the created row; Drizzle
requires `.returning()`.

### Complex Where Clause

**Drizzle:**
```typescript
const result = await db.select().from(users).where(
  and(
    eq(users.isActive, true),
    or(
      eq(users.role, "admin"),
      gt(users.createdAt, new Date("2024-01-01"))
    )
  )
);
```

**Prisma:**
```typescript
const result = await prisma.user.findMany({
  where: {
    isActive: true,
    OR: [
      { role: "admin" },
      { createdAt: { gt: new Date("2024-01-01") } },
    ],
  },
});
```

**Verdict:** Prisma's object syntax is more readable for this case. Drizzle's
function composition is more explicit and closer to SQL.

### Relation Loading

**Drizzle:**
```typescript
// Requires relations to be defined in schema
const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
```

**Prisma:**
```typescript
const usersWithPosts = await prisma.user.findMany({
  include: {
    posts: true,
  },
});
```

**Verdict:** Very similar API. Both generate efficient queries under the hood.

### Raw SQL

**Drizzle:**
```typescript
const result = await db.execute(
  sql`SELECT * FROM users WHERE email LIKE ${`%${search}%`}`
);
```

**Prisma:**
```typescript
const result = await prisma.$queryRaw`
  SELECT * FROM users WHERE email LIKE ${`%${search}%`}
`;
```

**Verdict:** Both support tagged template literals for safe SQL interpolation.

### Overall Comparison

| Aspect            | Drizzle                    | Prisma                     |
|-------------------|----------------------------|----------------------------|
| Schema language   | TypeScript                 | Custom DSL (.prisma)       |
| API style         | SQL-like (select/from/where)| Object-based (findMany)   |
| Type generation   | Automatic (inference)      | Code generation step       |
| Runtime           | Zero overhead              | Prisma Engine binary       |
| Bundle size       | ~50KB                      | ~2-10MB (with engine)      |
| Relation loading  | Good (query API)           | Excellent (include/select) |
| Raw SQL           | First-class (sql``)        | Supported ($queryRaw)      |
| Migrations        | SQL files (drizzle-kit)    | Prisma Migrate             |
| Studio/GUI        | Drizzle Studio             | Prisma Studio              |
| Learning curve    | Know SQL = know Drizzle    | New mental model            |

---

## Setting Up a Complete Project

Let's put it all together with a complete, runnable example:

### Project Structure

```
my-app/
  src/
    db/
      index.ts      # Database connection
      schema.ts     # Table definitions
    routes/
      users.ts      # User endpoints
    index.ts        # Express app
  drizzle/
    0001_init.sql   # Generated migrations
  drizzle.config.ts
  package.json
  tsconfig.json
```

### package.json

```json
{
  "name": "drizzle-example",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "drizzle-orm": "^0.38.0",
    "express": "^4.21.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.30.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

### Full Example: User CRUD

```typescript
// src/routes/users.ts
import { Router, Request, Response } from "express";
import { eq, ilike, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

const router = Router();

// GET /users — List all users with optional search
router.get("/", async (req: Request, res: Response) => {
  const { search, role, page = "1", limit = "20" } = req.query;

  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (search) {
    conditions.push(ilike(users.name, `%${search}%`));
  }
  if (role) {
    conditions.push(eq(users.role, role as "admin" | "member" | "viewer"));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [results, [{ total }]] = await Promise.all([
    db.select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` })
      .from(users)
      .where(where),
  ]);

  res.json({
    data: results,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
});

// GET /users/:id — Get user by ID
router.get("/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const [user] = await db.select().from(users).where(eq(users.id, id));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

// POST /users — Create a new user
router.post("/", async (req: Request, res: Response) => {
  const { name, email, role } = req.body;

  try {
    const [user] = await db.insert(users)
      .values({ name, email, role })
      .returning();

    res.status(201).json(user);
  } catch (error: any) {
    if (error.code === "23505") {
      // Unique violation
      res.status(409).json({ error: "Email already exists" });
      return;
    }
    throw error;
  }
});

// PATCH /users/:id — Update a user
router.patch("/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { name, email, role } = req.body;

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) updates.role = role;
  updates.updatedAt = new Date();

  const [updated] = await db.update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(updated);
});

// DELETE /users/:id — Delete a user
router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const [deleted] = await db.delete(users)
    .where(eq(users.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.status(204).send();
});

export default router;
```

---

## Common Patterns and Tips

### Dynamic Where Clauses

```typescript
// Build conditions dynamically based on request parameters
function buildUserFilters(query: Record<string, string | undefined>) {
  const conditions = [];

  if (query.role) {
    conditions.push(eq(users.role, query.role as any));
  }
  if (query.isActive !== undefined) {
    conditions.push(eq(users.isActive, query.isActive === "true"));
  }
  if (query.search) {
    conditions.push(
      or(
        ilike(users.name, `%${query.search}%`),
        ilike(users.email, `%${query.search}%`)
      )
    );
  }
  if (query.createdAfter) {
    conditions.push(gt(users.createdAt, new Date(query.createdAfter)));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

// Usage
const where = buildUserFilters(req.query as Record<string, string>);
const results = await db.select().from(users).where(where);
```

### Transactions

```typescript
import { db } from "./db";
import { users, projects, tasks } from "./db/schema";

// Transaction ensures all-or-nothing
const result = await db.transaction(async (tx) => {
  // tx is a transaction-scoped db instance
  const [user] = await tx.insert(users)
    .values({ name: "Alice", email: "alice@example.com" })
    .returning();

  const [project] = await tx.insert(projects)
    .values({ name: "My Project", ownerId: user.id })
    .returning();

  await tx.insert(tasks).values([
    { title: "Task 1", projectId: project.id },
    { title: "Task 2", projectId: project.id },
    { title: "Task 3", projectId: project.id },
  ]);

  return { user, project };
});

// If any insert fails, ALL are rolled back
```

### Logging Queries

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, {
  logger: true, // Logs all SQL queries to console
});

// Or custom logger:
export const db = drizzle(pool, {
  logger: {
    logQuery(query: string, params: unknown[]) {
      console.log("SQL:", query);
      console.log("Params:", params);
    },
  },
});
```

---

## Summary

| Concept               | Key Takeaway                                                |
|-----------------------|-------------------------------------------------------------|
| Drizzle philosophy    | SQL-like API, zero overhead, TypeScript-native schema       |
| Schema definition     | `pgTable()` with column builders, modifiers chain           |
| drizzle-kit push      | Direct schema sync — for prototyping only                   |
| drizzle-kit generate  | Creates migration SQL files from schema diffs               |
| drizzle-kit migrate   | Applies pending migrations to the database                  |
| CRUD operations       | `insert`, `select`, `update`, `delete` — all chainable      |
| Where operators       | `eq`, `ne`, `gt`, `lt`, `like`, `and`, `or`, etc.           |
| `.returning()`        | Get affected rows back — saves a separate SELECT            |
| Type inference        | `$inferSelect`, `$inferInsert` — types flow from schema     |
| Drizzle vs Prisma     | Trade-off: SQL closeness vs. abstraction convenience        |

---

## Exercises

### Exercise 1: Schema Design

Design a Drizzle schema for a blog platform with these requirements:

- Users (id, username, email, bio, avatar URL, created at)
- Posts (id, title, slug, content, published boolean, author reference, created/updated at)
- Tags (id, name, slug)
- PostTags junction table (post id, tag id)
- Comments (id, content, author reference, post reference, parent comment reference for nested replies, created at)

Make sure to:
- Use appropriate column types (varchar with limits, text for long content)
- Add unique constraints where needed
- Set up foreign key references with appropriate cascade rules
- Add default values where they make sense

### Exercise 2: CRUD Operations

Given the blog schema from Exercise 1, write Drizzle queries for:

1. Create a new user and return the full row
2. Create a post with tags (hint: transaction)
3. Get all published posts ordered by newest first, with pagination (page 2, 10 per page)
4. Update a post's title and set updatedAt to now
5. Soft-delete a comment (add a `deletedAt` column to your schema first)
6. Get the count of published posts per user
7. Search posts where title or content contains a search term (case-insensitive)

### Exercise 3: Dynamic Query Builder

Write a function `searchPosts(filters)` that accepts an object like:

```typescript
interface PostFilters {
  authorId?: number;
  published?: boolean;
  search?: string;       // searches title and content
  tagIds?: number[];     // posts that have ANY of these tags
  createdAfter?: Date;
  createdBefore?: Date;
  sortBy?: "newest" | "oldest" | "title";
  page?: number;
  limit?: number;
}
```

The function should dynamically build the Drizzle query, only adding conditions for
provided filters. Return both the results and the total count (for pagination).

### Exercise 4: Prisma to Drizzle Migration

Convert this Prisma schema to Drizzle:

```prisma
model Product {
  id          String   @id @default(uuid())
  name        String
  description String?
  price       Decimal  @db.Decimal(10, 2)
  stock       Int      @default(0)
  categoryId  String   @map("category_id")
  category    Category @relation(fields: [categoryId], references: [id])
  reviews     Review[]
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("products")
}

model Category {
  id       String    @id @default(uuid())
  name     String    @unique
  parentId String?   @map("parent_id")
  parent   Category? @relation("CategoryTree", fields: [parentId], references: [id])
  children Category[] @relation("CategoryTree")
  products Product[]

  @@map("categories")
}

model Review {
  id        String   @id @default(uuid())
  rating    Int
  comment   String?
  productId String   @map("product_id")
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("reviews")
}
```

Then write the equivalent of these Prisma queries in Drizzle:

```typescript
// Prisma query 1
const products = await prisma.product.findMany({
  where: { category: { name: "Electronics" }, price: { gte: 100 } },
  include: { reviews: true, category: true },
  orderBy: { price: "desc" },
  take: 10,
});

// Prisma query 2
const avgRatings = await prisma.review.groupBy({
  by: ["productId"],
  _avg: { rating: true },
  having: { rating: { _avg: { gte: 4 } } },
});
```

### Exercise 5: Error Handling

Write a `createUser` function that handles these database errors gracefully:

1. Unique violation (duplicate email) — return a friendly error message
2. Foreign key violation — return a message about the invalid reference
3. Not null violation — return a message about the missing required field
4. Check constraint violation — return a message about the invalid value

Use PostgreSQL error codes (23505, 23503, 23502, 23514) to differentiate.
Wrap the logic in a reusable `handleDatabaseError` utility function.
