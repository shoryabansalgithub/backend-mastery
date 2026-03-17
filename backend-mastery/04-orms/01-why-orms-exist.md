# Module 4, Lesson 1: Why ORMs Exist

## The Fundamental Problem: Two Worlds That Don't Speak the Same Language

Before we write a single line of ORM code, we need to understand the problem that
ORMs were invented to solve. This isn't just historical trivia — understanding the
"why" will help you make better decisions about when to use an ORM, when to avoid
one, and which style of ORM fits your project.

### A Thought Experiment

Imagine you're building a project management app. In your TypeScript code, you think
in terms of **objects**:

```typescript
const user = {
  id: "u_abc123",
  name: "Alice Chen",
  email: "alice@example.com",
  role: "admin",
  projects: [
    {
      id: "p_xyz789",
      name: "Website Redesign",
      tasks: [
        { id: "t_1", title: "Design mockups", status: "done" },
        { id: "t_2", title: "Implement header", status: "in_progress" },
      ],
    },
  ],
  createdAt: new Date("2024-01-15"),
};

// You access data like this:
console.log(user.projects[0].tasks[1].title); // "Implement header"
```

This feels natural. Objects contain other objects. You navigate by following references.
It's a **graph** — a web of interconnected nodes.

Now look at how the same data lives in a relational database:

```
TABLE: users
| id       | name      | email             | role  | created_at          |
|----------|-----------|-------------------|-------|---------------------|
| u_abc123 | Alice Chen| alice@example.com | admin | 2024-01-15 00:00:00 |

TABLE: projects
| id       | name             | owner_id  |
|----------|------------------|-----------|
| p_xyz789 | Website Redesign | u_abc123  |

TABLE: tasks
| id  | title            | status      | project_id |
|-----|------------------|-------------|------------|
| t_1 | Design mockups   | done        | p_xyz789   |
| t_2 | Implement header | in_progress | p_xyz789   |
```

The data is **decomposed** across multiple flat tables. There are no nested objects —
only foreign keys that *refer* to rows in other tables. To reconstruct the object
graph you saw above, you need to write JOIN queries that stitch the tables back
together.

This fundamental tension — objects vs. tables — is called the **object-relational
impedance mismatch**.

---

## The Object-Relational Impedance Mismatch

The term "impedance mismatch" comes from electrical engineering, where it describes
what happens when two components have incompatible electrical properties, causing
signal loss. In our world, the two "components" are:

1. **Object-oriented / structured programming** (TypeScript, Java, Python, etc.)
2. **Relational databases** (PostgreSQL, MySQL, SQLite, etc.)

They disagree on almost everything:

| Aspect              | Objects (TypeScript)        | Relations (SQL)               |
|---------------------|-----------------------------|-------------------------------|
| **Identity**        | Reference equality (`===`)  | Primary key equality          |
| **Structure**       | Nested, hierarchical        | Flat tables with foreign keys |
| **Relationships**   | Direct references           | Foreign keys + JOINs          |
| **Inheritance**     | `class Admin extends User`  | No native inheritance         |
| **Encapsulation**   | Methods + data together     | Data only, no behavior        |
| **Collections**     | Arrays, Maps, Sets          | Result sets, no ordering      |
| **Types**           | `string`, `number`, `Date`  | `VARCHAR`, `INTEGER`, `TIMESTAMP` |
| **Navigation**      | `user.projects[0].tasks`    | Multi-table JOIN              |
| **Null handling**   | `undefined` vs `null`       | `NULL` (three-valued logic)   |

### Why This Matters in Practice

Without any abstraction layer, here's what "get a user with their projects and tasks"
looks like in raw SQL + TypeScript:

```typescript
// BAD: Manual SQL + manual mapping — tedious, error-prone, untyped
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  projects: Project[];
}

interface Project {
  id: string;
  name: string;
  tasks: Task[];
}

interface Task {
  id: string;
  title: string;
  status: string;
}

async function getUserWithProjectsAndTasks(userId: string): Promise<User | null> {
  // Step 1: Raw SQL with a multi-table JOIN
  const { rows } = await pool.query(
    `
    SELECT
      u.id AS user_id, u.name AS user_name, u.email, u.role, u.created_at,
      p.id AS project_id, p.name AS project_name,
      t.id AS task_id, t.title AS task_title, t.status AS task_status
    FROM users u
    LEFT JOIN projects p ON p.owner_id = u.id
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE u.id = $1
    `,
    [userId]
  );

  if (rows.length === 0) return null;

  // Step 2: Manually reconstruct the object graph from flat rows
  // This is the tedious part that ORMs automate
  const user: User = {
    id: rows[0].user_id,
    name: rows[0].user_name,
    email: rows[0].email,
    role: rows[0].role,
    createdAt: rows[0].created_at,
    projects: [],
  };

  const projectMap = new Map<string, Project>();

  for (const row of rows) {
    if (row.project_id && !projectMap.has(row.project_id)) {
      const project: Project = {
        id: row.project_id,
        name: row.project_name,
        tasks: [],
      };
      projectMap.set(row.project_id, project);
      user.projects.push(project);
    }

    if (row.task_id) {
      const project = projectMap.get(row.project_id);
      project?.tasks.push({
        id: row.task_id,
        title: row.task_title,
        status: row.task_status,
      });
    }
  }

  return user;
}
```

Count the problems:

1. **No type safety on the SQL** — you could mistype a column name and only find out
   at runtime.
2. **Manual mapping** — you wrote ~30 lines of tedious, brittle code to rebuild an
   object graph from flat rows.
3. **Column name conflicts** — you had to alias `u.name` as `user_name` and `p.name`
   as `project_name` because both tables have a `name` column.
4. **No compile-time validation** — if you add a column to the table and forget to
   update this function, TypeScript won't warn you.
5. **Repetitive** — you'll write this same mapping pattern for every query.

This is the pain that ORMs exist to solve.

---

## What ORMs Actually Do Under the Hood

An ORM (Object-Relational Mapper) is a layer that sits between your application code
and the database. At its core, every ORM does three things:

### 1. Schema Mapping

The ORM maintains a mapping between your programming language's types and the
database's tables/columns:

```
TypeScript type  ←→  Database table
─────────────────────────────────────
User.id          ←→  users.id
User.name        ←→  users.name
User.email       ←→  users.email
User.createdAt   ←→  users.created_at
```

### 2. Query Generation

Instead of writing raw SQL strings, you express queries using the language's native
constructs. The ORM translates them into SQL:

```typescript
// What you write (Drizzle example):
const result = await db.select().from(users).where(eq(users.role, "admin"));

// What the ORM generates:
// SELECT * FROM users WHERE role = 'admin'
```

### 3. Result Mapping (Hydration)

The ORM takes the flat rows returned by the database and "hydrates" them into
properly structured objects:

```
Database returns:
{ user_id: 1, user_name: "Alice", project_id: 5, project_name: "Redesign" }
{ user_id: 1, user_name: "Alice", project_id: 8, project_name: "Mobile App" }

ORM hydrates into:
{
  id: 1,
  name: "Alice",
  projects: [
    { id: 5, name: "Redesign" },
    { id: 8, name: "Mobile App" }
  ]
}
```

### The Analogy

Think of an ORM like a **translator at a diplomatic meeting**. Two diplomats speak
different languages (objects vs. relational). The translator:

1. Knows the vocabulary of both languages (schema mapping)
2. Translates requests from one language to the other (query generation)
3. Translates responses back (result mapping)

A good translator is invisible — the diplomats feel like they're speaking directly
to each other. A bad translator adds confusion, loses nuance, or is so slow that
the conversation becomes painful.

ORMs vary in quality the same way.

---

## The ORM Spectrum

Not all ORMs are created equal. They exist on a spectrum from "thin SQL wrapper" to
"full abstraction that hides SQL entirely."

```
Less Abstraction                                      More Abstraction
     │                                                       │
     ▼                                                       ▼
 Raw SQL → Query Builder → Data Mapper → Active Record → Full ORM
 (pg)      (Knex/Kysely)  (Drizzle)     (TypeORM)       (Prisma)
```

Let's walk through each level:

### Level 0: Raw SQL (pg, mysql2)

You write SQL strings directly. No abstraction.

```typescript
const result = await pool.query("SELECT * FROM users WHERE role = $1", ["admin"]);
// result.rows is Array<any> — no type safety
```

**Pros:** Full control, no learning curve beyond SQL, best performance.
**Cons:** No type safety, manual mapping, SQL injection risk if careless, verbose.

### Level 1: Query Builder (Knex.js, Kysely)

You build SQL using method chains. The library generates the SQL string for you.

```typescript
// Knex.js example
const admins = await knex("users").select("*").where("role", "admin");

// Kysely example (type-safe query builder)
const admins = await db
  .selectFrom("users")
  .selectAll()
  .where("role", "=", "admin")
  .execute();
```

**Pros:** SQL injection protection, composable queries, some type safety (Kysely).
**Cons:** Still requires you to think in SQL, no automatic relation loading.

### Level 2: Data Mapper (Drizzle ORM)

Schema is defined in code. The ORM maps between your TypeScript types and the
database schema, but you still write SQL-like queries:

```typescript
// Schema definition
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
});

// Query — looks like SQL, but fully typed
const admins = await db.select().from(users).where(eq(users.role, "admin"));
// Return type is automatically inferred as { id: number; name: string; role: string }[]
```

**Pros:** Full type safety, SQL-like (low learning curve), schema as code, migrations.
**Cons:** More setup than a query builder, some queries are verbose.

### Level 3: Active Record (TypeORM in Active Record mode)

Each model class has methods to save/load itself. The model IS the database row:

```typescript
// TypeORM Active Record
@Entity()
class User extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  role: string;
}

// Usage
const admin = new User();
admin.name = "Alice";
admin.role = "admin";
await admin.save(); // The object saves itself!

const admins = await User.find({ where: { role: "admin" } });
```

**Pros:** Very convenient for simple CRUD, feels "natural" in OOP.
**Cons:** Tight coupling (model = database row), hard to test, heavy decorators,
poor TypeScript inference (TypeORM's types are famously incomplete).

### Level 4: Full ORM / Schema-First (Prisma)

You define a schema in a custom DSL. The ORM generates a fully-typed client:

```prisma
// schema.prisma
model User {
  id    Int     @id @default(autoincrement())
  name  String
  role  String
  posts Post[]
}
```

```typescript
// Generated client — fully typed, auto-completed
const admins = await prisma.user.findMany({
  where: { role: "admin" },
  include: { posts: true },
});
// Type: (User & { posts: Post[] })[]
```

**Pros:** Incredible DX, auto-generated types, relation loading is trivial.
**Cons:** Custom DSL (not TypeScript), runtime overhead (Prisma Engine binary),
less control over generated SQL, harder to do complex queries.

### Choosing Your Level

There's no universally "best" level. The right choice depends on your project:

| Factor                  | Lower Abstraction | Higher Abstraction |
|-------------------------|-------------------|--------------------|
| Simple CRUD             | Overkill          | Perfect            |
| Complex queries         | Better control    | May fight the ORM  |
| Team SQL knowledge      | Required          | Optional           |
| Type safety             | Manual or Kysely  | Automatic          |
| Performance tuning      | Easier            | Harder             |
| Prototyping speed       | Slower            | Faster             |
| Large-scale refactoring | Harder            | Easier (schema)    |

---

## Knex.js: A Query Builder Example

Before we dive into full ORMs, let's see what a query builder gives us. Knex.js is
one of the most popular query builders for Node.js:

```typescript
import knex from "knex";

const db = knex({
  client: "pg",
  connection: {
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "password",
    database: "myapp",
  },
});

// Simple select
const users = await db("users").select("id", "name", "email").where("role", "admin");

// Insert
const [newUser] = await db("users")
  .insert({ name: "Bob", email: "bob@example.com", role: "user" })
  .returning("*");

// Update
await db("users").where("id", newUser.id).update({ role: "admin" });

// Delete
await db("users").where("id", newUser.id).del();

// Join
const usersWithProjects = await db("users")
  .join("projects", "projects.owner_id", "users.id")
  .select("users.name", "projects.name as project_name");

// Transaction
await db.transaction(async (trx) => {
  const [project] = await trx("projects")
    .insert({ name: "New Project", owner_id: 1 })
    .returning("*");

  await trx("tasks").insert([
    { title: "Task 1", project_id: project.id },
    { title: "Task 2", project_id: project.id },
  ]);
});
```

Knex is great because it's lightweight and SQL-literate developers can be productive
immediately. But notice the problem — **no type safety**:

```typescript
// Knex has no idea what columns 'users' has
const users = await db("users").select("naem"); // Typo! No error until runtime.
// users is typed as `any[]`

// You can pass the wrong types with no warning
await db("users").insert({ name: 123 }); // name should be a string!
```

This is where ORMs like Drizzle add value — they bring the schema into TypeScript so
the compiler catches these mistakes.

---

## Trade-offs: Productivity vs. Control vs. Performance

Every abstraction layer involves trade-offs. Here's an honest assessment:

### What You Gain

1. **Productivity** — Less boilerplate code. A Prisma `findMany` with `include` does
   in 3 lines what would take 40 lines of raw SQL + mapping.

2. **Type Safety** — The ORM knows your schema, so TypeScript can catch column
   name typos, type mismatches, and missing required fields at compile time.

3. **Database Portability** — Many ORMs can target multiple databases. Your Drizzle
   schema can work with PostgreSQL, MySQL, or SQLite with minimal changes.

4. **Migration Management** — ORMs provide tools to evolve your schema over time,
   generating migration files automatically.

5. **SQL Injection Protection** — ORMs parameterize queries by default, eliminating
   an entire class of security vulnerabilities.

### What You Lose

1. **SQL Knowledge Atrophy** — Teams that rely heavily on ORMs may never learn SQL
   well enough to debug performance problems.

2. **Performance Overhead** — ORMs generate SQL that may not be optimal. The
   abstraction layer itself adds latency (Prisma's engine layer is particularly
   notable here).

3. **Debugging Difficulty** — When something goes wrong, you now have to debug
   through an additional layer. "What SQL did the ORM actually generate?"

4. **Complex Query Limitations** — Every ORM has a ceiling. Complex CTEs, window
   functions, lateral joins, or recursive queries may be impossible or extremely
   awkward to express.

5. **Lock-in** — Your schema definitions, query patterns, and migration history are
   all tied to a specific ORM. Switching is expensive.

### The Pragmatic Approach

The best approach is **layered**:

- Use the ORM for **80% of queries** (simple CRUD, standard joins, basic
  aggregations).
- Drop to raw SQL (via the ORM's escape hatch) for the **20% of queries** that are
  complex, performance-critical, or impossible to express in the ORM's API.
- **Always log and review** the SQL your ORM generates. Trust but verify.

---

## When ORMs Help, When They Hurt

### ORMs Excel At

- **CRUD-heavy applications** (SaaS dashboards, admin panels, REST APIs)
- **Rapid prototyping** (get something working fast, optimize later)
- **Teams with mixed SQL skills** (the ORM provides guardrails)
- **Schema evolution** (migrations save enormous time)
- **TypeScript projects** (compile-time safety is the killer feature)

### ORMs Struggle With

- **Reporting and analytics** (complex aggregations, window functions)
- **Bulk data processing** (ETL pipelines, data migrations)
- **Highly optimized queries** (when you need exact control over query plans)
- **Non-standard SQL features** (PostGIS, full-text search, JSON operators)

### Preview: The N+1 Problem

This is such a common ORM pitfall that we'll dedicate significant time to it later.
But here's a preview:

```typescript
// N+1 PROBLEM — one of the most common ORM performance disasters

// Query 1: Get all users
const users = await db.select().from(usersTable);

// For EACH user, make another query (N queries)
for (const user of users) {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.ownerId, user.id));

  console.log(`${user.name} has ${projects.length} projects`);
}

// If you have 100 users, this makes 101 queries!
// 1 (get users) + 100 (get each user's projects) = 101 queries
```

The fix is to load related data in a single query using JOINs or subqueries —
which good ORMs make easy. We'll cover this thoroughly in Lesson 4.

---

## The TypeScript Advantage: Type-Safe Queries

TypeScript ORMs have a superpower that Ruby/Python ORMs don't: **compile-time
query validation**.

Consider this progression:

### Raw SQL (No Safety)

```typescript
// No errors at compile time — all errors are runtime surprises
const result = await pool.query("SELEC * FORM users WEHRE id = $1", [userId]);
// Three typos. You won't know until production.
```

### Knex (Partial Safety)

```typescript
// Knex catches syntax structure but not column names or types
const user = await db("users").where("id", userId).first();
// user: any — you have to cast it yourself
```

### Drizzle (Full Safety)

```typescript
// Drizzle knows the schema — everything is checked at compile time
const user = await db.select().from(users).where(eq(users.id, userId));
// user: { id: number; name: string; email: string; role: string; createdAt: Date }[]

// Typo in column name? Compile error!
const bad = await db.select().from(users).where(eq(users.naem, "x"));
//                                                     ^^^^
// Error: Property 'naem' does not exist on type ...

// Wrong type? Compile error!
const bad2 = await db.select().from(users).where(eq(users.id, "not-a-number"));
// Error: Argument of type 'string' is not assignable to parameter of type 'number'
```

This is a game-changer. The compiler becomes your pair programmer, catching mistakes
before they reach production. This is why we focus on Drizzle in this module — it
provides excellent type safety while staying close to SQL.

---

## Overview of the TypeScript ORM Landscape

Let's survey the major players as of 2025-2026:

### Prisma

- **Style:** Schema-first ORM with custom DSL (`.prisma` files)
- **Philosophy:** Best DX for common cases, hide complexity
- **Strengths:** Auto-generated typed client, incredible IntelliSense, Prisma Studio
  (GUI), mature ecosystem
- **Weaknesses:** Custom schema language (not TypeScript), Prisma Engine binary adds
  overhead and deployment complexity, limited raw SQL support, struggles with complex
  queries
- **Best for:** Teams that want maximum productivity for standard CRUD apps

### Drizzle ORM

- **Style:** TypeScript-first data mapper, SQL-like API
- **Philosophy:** If you know SQL, you know Drizzle
- **Strengths:** Zero runtime overhead (generates SQL, that's it), excellent type
  inference, schema defined in TypeScript, SQL-like API means no new DSL to learn,
  lightweight
- **Weaknesses:** Younger ecosystem, fewer resources/tutorials, relations API is
  newer and less polished than Prisma's
- **Best for:** Teams that know SQL and want type safety without abstraction overhead

### TypeORM

- **Style:** Active Record / Data Mapper with decorators
- **Philosophy:** Bring Java-style ORM (Hibernate) to TypeScript
- **Strengths:** Feature-rich, supports many databases, both Active Record and Data
  Mapper patterns
- **Weaknesses:** Buggy TypeScript types, slow development, many open issues,
  decorator-heavy syntax is polarizing, performance concerns
- **Best for:** Legacy projects already using it (not recommended for new projects)

### Kysely

- **Style:** Type-safe query builder (not a full ORM)
- **Philosophy:** Type-safe SQL without the ORM overhead
- **Strengths:** Excellent TypeScript inference, lightweight, close to SQL, no
  code generation step
- **Weaknesses:** Not a full ORM (no schema management, no migrations, no relation
  loading), requires you to define types manually or use a generator
- **Best for:** Teams that want type-safe query building without ORM overhead

### MikroORM

- **Style:** Data Mapper with Unit of Work pattern
- **Philosophy:** Proper data mapper implementation inspired by Doctrine (PHP)
- **Strengths:** True Unit of Work, identity map, good TypeScript support, proper
  change tracking
- **Weaknesses:** Smaller community, steeper learning curve, heavier than Drizzle
- **Best for:** Teams familiar with Doctrine/Hibernate who want similar patterns

### Quick Comparison Table

| Feature           | Prisma    | Drizzle   | TypeORM   | Kysely    |
|-------------------|-----------|-----------|-----------|-----------|
| Type Safety       | Excellent | Excellent | Poor      | Excellent |
| SQL Closeness     | Low       | High      | Medium    | High      |
| Schema in TS      | No (DSL)  | Yes       | Yes       | No        |
| Migrations        | Yes       | Yes       | Yes       | Plugin    |
| Relation Loading  | Excellent | Good      | Good      | Manual    |
| Runtime Overhead  | High      | Zero      | Medium    | Zero      |
| Learning Curve    | Low       | Low-Med   | Medium    | Low       |
| Maturity          | High      | Medium    | High      | Medium    |

### Why We're Teaching Drizzle

We chose Drizzle for this module because:

1. **Schema is TypeScript** — no custom DSL to learn. Your schema file is just a `.ts`
   file that you can import, extend, and refactor using standard TypeScript tools.

2. **SQL-like API** — if you learned SQL in Module 3, Drizzle will feel familiar.
   `db.select().from(users).where(eq(...))` reads almost like SQL.

3. **Zero overhead** — Drizzle generates SQL strings and parameterized values. There's
   no engine binary, no runtime proxy, no query parsing. It's the thinnest useful
   layer over your database driver.

4. **Excellent TypeScript inference** — return types are automatically inferred from
   your schema and query shape. No manual type annotations needed.

5. **Growing fast** — Drizzle has rapidly become one of the most popular TypeScript
   ORMs. Investing in it now is a good career bet.

That said, Prisma is a fine choice for many projects. We'll show side-by-side
comparisons so you can make informed decisions.

---

## Summary

| Concept                | Key Takeaway                                              |
|------------------------|-----------------------------------------------------------|
| Impedance mismatch     | Objects are graphs; relational data is flat tables.       |
| ORM purpose            | Map between objects and tables, generate SQL, hydrate.    |
| ORM spectrum           | Raw SQL → Query Builder → Data Mapper → Active Record     |
| Trade-offs             | Productivity and safety vs. control and performance.      |
| TypeScript advantage   | Compile-time query validation catches bugs early.         |
| When ORMs help         | CRUD apps, prototyping, schema evolution.                 |
| When ORMs hurt         | Complex analytics, bulk processing, exotic SQL features.  |
| Drizzle's niche        | SQL-like, zero overhead, TypeScript-first data mapper.    |

---

## Exercises

### Exercise 1: Impedance Mismatch Identification

Given this TypeScript type:

```typescript
interface BlogPost {
  id: string;
  title: string;
  content: string;
  author: {
    id: string;
    name: string;
    avatar: string;
  };
  tags: string[];
  comments: {
    id: string;
    text: string;
    author: { id: string; name: string };
    replies: { id: string; text: string; author: { id: string; name: string } }[];
  }[];
}
```

1. Design the relational tables needed to store this data. How many tables do you
   need? What are the foreign keys?
2. Write the SQL JOIN query that reconstructs a single `BlogPost` with all its
   nested data.
3. Write the TypeScript code that maps the flat JOIN result rows back into the
   nested `BlogPost` object.

### Exercise 2: Query Builder Practice

Using Knex.js syntax (or pseudocode), rewrite these raw SQL queries as query builder
calls:

```sql
-- Query A
SELECT u.name, COUNT(p.id) as project_count
FROM users u
LEFT JOIN projects p ON p.owner_id = u.id
GROUP BY u.id, u.name
HAVING COUNT(p.id) > 3
ORDER BY project_count DESC;

-- Query B
INSERT INTO tasks (title, status, project_id, assigned_to)
VALUES ('Design logo', 'todo', 5, 12)
RETURNING id, title, created_at;

-- Query C
UPDATE tasks
SET status = 'done', completed_at = NOW()
WHERE project_id = 5 AND status = 'in_progress';
```

### Exercise 3: ORM Selection

For each scenario below, recommend which level of the ORM spectrum (raw SQL, query
builder, data mapper, or full ORM) would be the best fit. Justify your answer.

1. A data analytics dashboard that runs complex aggregation queries with window
   functions, CTEs, and pivot tables.
2. A SaaS startup building a project management tool with standard CRUD operations
   and a small team of full-stack developers.
3. A high-frequency trading system where every microsecond of latency matters.
4. A content management system where a junior team needs to move fast and the queries
   are all straightforward CRUD.
5. A microservice that owns a small number of tables and needs to be as lightweight
   as possible.

### Exercise 4: Trade-off Analysis

Your team is starting a new project — an e-commerce platform. The tech lead wants
to use raw SQL everywhere for "maximum performance." The junior devs want Prisma for
"maximum productivity."

Write a 1-page technical memo that:

1. Acknowledges the valid concerns on both sides.
2. Proposes a pragmatic middle ground.
3. Defines criteria for when to use the ORM vs. when to drop to raw SQL.
4. Addresses the N+1 problem risk and how to mitigate it.

### Exercise 5: Type Safety Comparison

Consider this query: "Get all users who signed up in the last 30 days, along with
the count of projects they own."

Write this query three ways:
1. Raw SQL with `pg` (no type safety)
2. Knex.js (partial type safety)
3. Pseudocode showing what a type-safe ORM would check at compile time (what errors
   would it catch?)

For each approach, annotate where a developer could introduce a bug that would only
be caught at runtime (raw SQL) vs. compile time (type-safe ORM).
