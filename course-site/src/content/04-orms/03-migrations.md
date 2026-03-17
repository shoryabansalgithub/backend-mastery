# Module 4, Lesson 3: Migrations

## Why Migrations Exist

Here's a thought experiment. You're building an app. On day 1, your users table looks
like this:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
```

On day 30, you need to add a `role` column. On day 60, you need to rename `name` to
`display_name`. On day 90, you need to add an `avatar_url` column. On day 120, you
realize `email` should be case-insensitive and add a unique index on `LOWER(email)`.

Your database schema **evolves over time**, just like your application code. And just
like code, you need:

1. **Version control** — what changed, when, and why?
2. **Reproducibility** — given a fresh database, recreate the exact schema
3. **Collaboration** — multiple developers changing the schema without conflicts
4. **Rollback** — undo a change that broke something

This is exactly what **database migrations** provide.

### The Analogy

Think of migrations like **git commits for your database schema**. Each migration is
a small, incremental change. The full history of migrations recreates the current
schema from scratch — just like replaying git history recreates the current codebase.

```
Migration 0001: Create users table
Migration 0002: Add role column to users
Migration 0003: Rename name to display_name
Migration 0004: Add avatar_url column
Migration 0005: Add case-insensitive email index
```

Applying all five migrations to an empty database produces the exact same schema as
your current production database.

---

## Migration Files: Up and Down

Each migration has two parts:

### Up (Apply)

The forward change. Creates tables, adds columns, modifies constraints.

### Down (Rollback)

The reverse change. Undoes what "up" did. Drops tables, removes columns, restores
old constraints.

```sql
-- 0002_add_role_column.sql

-- UP
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- DOWN (in a separate file or section)
ALTER TABLE users DROP COLUMN role;
```

### Not All Migrations Are Reversible

Some changes can't be undone without data loss:

```sql
-- UP: Drop the legacy_notes column
ALTER TABLE users DROP COLUMN legacy_notes;

-- DOWN: ??? We can add the column back, but the DATA is gone forever
ALTER TABLE users ADD COLUMN legacy_notes TEXT;
-- The column is back, but it's empty. The original data is lost.
```

This is why you should always **back up your database before running destructive
migrations** in production.

---

## drizzle-kit generate: Diffing Schema Changes

Drizzle Kit's `generate` command compares your current TypeScript schema against
the previous schema snapshot and generates a SQL migration file containing only the
differences.

### Step-by-Step Workflow

#### Step 1: Start with a Schema

```typescript
// src/db/schema.ts
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

#### Step 2: Generate the Initial Migration

```bash
npx drizzle-kit generate
```

This creates:

```
drizzle/
  0000_init.sql
  meta/
    0000_snapshot.json
    _journal.json
```

The migration file (`0000_init.sql`):

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);
```

The snapshot (`meta/0000_snapshot.json`) records the schema state after this
migration.

The journal (`meta/_journal.json`) tracks the order of migrations:

```json
{
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1700000000000,
      "tag": "0000_init",
      "breakpoints": true
    }
  ]
}
```

#### Step 3: Modify the Schema

```typescript
// Add a role column and an isActive column
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").default("member").notNull(),         // NEW
  isActive: boolean("is_active").default(true).notNull(), // NEW
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

#### Step 4: Generate the Diff Migration

```bash
npx drizzle-kit generate
```

This creates `drizzle/0001_add_user_fields.sql`:

```sql
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;
ALTER TABLE "users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
```

Drizzle Kit detected exactly what changed and generated the minimal SQL to apply it.

#### Step 5: Apply the Migration

```bash
npx drizzle-kit migrate
```

---

## drizzle-kit migrate: Applying Migrations

The `migrate` command applies all pending migrations in order. It tracks which
migrations have been applied using a `__drizzle_migrations` table in your database.

```sql
-- Drizzle creates this table automatically
CREATE TABLE __drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
```

### Programmatic Migration

For production deployments, you often want to run migrations as part of your
application startup:

```typescript
// src/migrate.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const db = drizzle(pool);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  await pool.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

### Migration in CI/CD

Typical deployment pipeline:

```
1. Push code to main branch
2. CI builds the application
3. CI runs migrations against staging database
4. Integration tests run against staging
5. If tests pass, deploy to production
6. Run migrations against production database
7. Start the new application version
```

---

## Migration Best Practices

### 1. Never Edit Old Migrations

Once a migration has been applied to any environment (staging, production, a
colleague's local database), treat it as **immutable**. If you need to change
something, create a new migration.

```
BAD:  Edit 0003_add_role.sql to change the default value
GOOD: Create 0005_change_role_default.sql with ALTER TABLE ... ALTER COLUMN ...
```

Why? Because other databases have already applied the old version. Editing it
creates a divergence between environments.

### 2. Keep Migrations Small and Focused

Each migration should do one logical thing:

```
BAD:  One migration that adds 5 tables, 3 indexes, and modifies 2 existing tables
GOOD: Separate migrations for each logical change
```

Small migrations are easier to review, debug, and roll back.

### 3. Always Test Migrations Against a Copy of Production

Your local database might have 100 rows. Production has 10 million. That
`ALTER TABLE` that runs instantly locally might lock the table for 30 minutes in
production.

```bash
# Dump production schema (no data)
pg_dump --schema-only production_db > schema.sql

# Create a test database
createdb migration_test
psql migration_test < schema.sql

# Run your migration against it
npx drizzle-kit migrate
```

### 4. Handle Data Migrations Separately

Schema migrations (DDL) and data migrations (DML) should be separate:

```sql
-- 0010_add_status_column.sql (Schema migration)
ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'todo' NOT NULL;

-- 0011_backfill_status.sql (Data migration)
UPDATE tasks SET status = 'done' WHERE completed_at IS NOT NULL;
UPDATE tasks SET status = 'in_progress' WHERE started_at IS NOT NULL AND completed_at IS NULL;
```

Why separate? Because schema migrations are usually fast (metadata changes), but
data migrations scan every row and can be slow.

### 5. Use Transactions Where Possible

PostgreSQL supports transactional DDL, meaning schema changes can be wrapped in a
transaction and rolled back if something fails:

```sql
BEGIN;
  ALTER TABLE users ADD COLUMN phone TEXT;
  ALTER TABLE users ADD CONSTRAINT phone_format CHECK (phone ~ '^\+[0-9]{10,15}$');
COMMIT;
-- If the CHECK constraint fails, the column addition is also rolled back
```

Not all databases support this. MySQL, for example, auto-commits DDL statements.

---

## Zero-Downtime Migrations

This is where migrations get serious. In production, you can't just shut down the
app, run migrations, and restart. Users are actively using the system.

### The Problem

Consider adding a NOT NULL column:

```sql
-- This LOCKS the table and fails if any rows exist (no default!)
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL;
```

This will:
1. Lock the entire `users` table
2. Fail because existing rows don't have a phone value

### The Solution: Multi-Step Migration

Break the change into safe, incremental steps:

```
Step 1 (Migration): Add column as NULLABLE
Step 2 (Code):      Deploy code that writes to the new column
Step 3 (Migration): Backfill existing rows with a default value
Step 4 (Migration): Add NOT NULL constraint
Step 5 (Code):      Deploy code that relies on the column being NOT NULL
```

In SQL:

```sql
-- Migration 0020: Add nullable phone column (safe, no lock)
ALTER TABLE users ADD COLUMN phone TEXT;

-- Deploy code that starts writing phone numbers...

-- Migration 0021: Backfill existing rows (may be slow, but doesn't lock)
UPDATE users SET phone = 'unknown' WHERE phone IS NULL;

-- Migration 0022: Add NOT NULL constraint
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
```

### Common Zero-Downtime Patterns

#### Adding a Column

```sql
-- Safe: Add nullable column with a default
ALTER TABLE users ADD COLUMN phone TEXT DEFAULT 'N/A';
```

#### Removing a Column

```
Step 1: Deploy code that stops reading the column
Step 2: Deploy code that stops writing the column
Step 3: Migration to drop the column
```

Never drop a column while running code still references it!

#### Renaming a Column

```
Step 1: Add new column
Step 2: Deploy code that writes to both old and new columns
Step 3: Backfill new column from old column
Step 4: Deploy code that reads from new column
Step 5: Deploy code that stops writing to old column
Step 6: Drop old column
```

Yes, renaming a column safely requires **six steps**. This is why many teams avoid
column renames in production and instead add new columns.

#### Changing a Column Type

```sql
-- DANGEROUS: This rewrites the entire table
ALTER TABLE users ALTER COLUMN age TYPE bigint;

-- SAFE: Add a new column, backfill, swap
ALTER TABLE users ADD COLUMN age_new BIGINT;
UPDATE users SET age_new = age;
-- Deploy code to use age_new...
ALTER TABLE users DROP COLUMN age;
ALTER TABLE users RENAME COLUMN age_new TO age;
```

---

## Rolling Back Safely

### When to Roll Back

- Migration introduced a bug that's causing errors
- Performance degradation after migration
- Data corruption discovered after migration

### How to Roll Back

Drizzle Kit doesn't have a built-in rollback command, but you can manage rollbacks
manually:

#### Option 1: Write Reverse Migrations

For every migration, keep a corresponding rollback script:

```
drizzle/
  0010_add_phone_column.sql        # Forward
  rollback/
    0010_rollback.sql              # Reverse
```

```sql
-- rollback/0010_rollback.sql
ALTER TABLE users DROP COLUMN phone;
DELETE FROM __drizzle_migrations WHERE hash = '<hash-of-0010>';
```

#### Option 2: Point-in-Time Recovery

If you have database backups with point-in-time recovery (PITR), you can restore
the database to a state before the migration:

```bash
# PostgreSQL PITR (if configured)
pg_restore --target-time="2024-03-15 14:30:00" -d myapp /backups/latest
```

This is the nuclear option — it also reverts any data changes made after that point.

#### Option 3: Forward-Fix

Instead of rolling back, create a new migration that fixes the problem:

```sql
-- 0011_fix_phone_column.sql
-- The original migration set the wrong default
ALTER TABLE users ALTER COLUMN phone SET DEFAULT 'N/A';
UPDATE users SET phone = 'N/A' WHERE phone = 'WRONG_DEFAULT';
```

Forward-fixing is usually safer than rolling back because it preserves the
migration history.

---

## Schema Snapshots and Drift Detection

### What is Schema Drift?

Schema drift occurs when the actual database schema doesn't match what your code
expects. This happens when:

1. Someone manually runs SQL against the database (a "cowboy migration")
2. A migration was applied to production but not committed to git
3. Different environments have different migration histories

### Detecting Drift

Drizzle Kit stores schema snapshots in the `meta/` directory. You can detect drift
by comparing:

```bash
# Check if your schema matches the database
npx drizzle-kit check
```

If there's drift, you'll see a diff showing what's different.

### Preventing Drift

1. **Never run manual DDL in production.** All schema changes go through migrations.

2. **Include migration files in code review.** Every PR that changes `schema.ts`
   should also include the generated migration file.

3. **Automate migration checks in CI.**

```bash
# In your CI pipeline:
# 1. Generate migrations from current schema
npx drizzle-kit generate

# 2. Check if any new files were generated
# If yes, the developer forgot to generate/commit the migration
git diff --exit-code drizzle/
```

4. **Use the same migration path for all environments.** Local, staging, and
   production should all apply the same migration files in the same order.

---

## Practical Migration Scenarios

### Scenario 1: Adding a Full-Text Search Index

```typescript
// schema.ts change: No change needed (it's an index, not a column)

// Manual migration file:
// drizzle/0015_add_search_index.sql
```

```sql
-- Add pg_trgm extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add GIN index for fast text search on tasks
CREATE INDEX idx_tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX idx_tasks_description_trgm ON tasks USING gin (description gin_trgm_ops);
```

Some migrations (like adding extensions or custom indexes) can't be auto-generated
by Drizzle Kit. You create them manually and place them in the `drizzle/` directory.

### Scenario 2: Adding a Junction Table for Many-to-Many

```typescript
// schema.ts
export const projectMembers = pgTable("project_members", {
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.userId] }),
}));
```

```bash
npx drizzle-kit generate
# Generates: drizzle/0016_add_project_members.sql
```

### Scenario 3: Splitting a Table

Sometimes you realize a table has too many columns and want to split it:

```sql
-- Migration 1: Create the new table
CREATE TABLE user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio TEXT,
  avatar_url TEXT,
  website TEXT,
  location TEXT
);

-- Migration 2: Copy data from users to user_profiles
INSERT INTO user_profiles (user_id, bio, avatar_url, website, location)
SELECT id, bio, avatar_url, website, location FROM users;

-- Migration 3: Drop columns from users (after code is updated)
ALTER TABLE users DROP COLUMN bio;
ALTER TABLE users DROP COLUMN avatar_url;
ALTER TABLE users DROP COLUMN website;
ALTER TABLE users DROP COLUMN location;
```

---

## Summary

| Concept                | Key Takeaway                                                    |
|------------------------|-----------------------------------------------------------------|
| Why migrations exist   | Schema evolves over time; migrations version-control changes.   |
| Up and down            | Up applies a change; down reverses it. Not always reversible.   |
| drizzle-kit generate   | Diffs your schema and creates SQL migration files.              |
| drizzle-kit migrate    | Applies pending migrations in order.                            |
| Never edit old ones    | Treat applied migrations as immutable. Make new ones instead.   |
| Zero-downtime          | Multi-step: nullable → backfill → add constraint.              |
| Rolling back           | Forward-fix is usually safer than rollback.                     |
| Schema drift           | Prevent with CI checks and no manual DDL in production.         |

---

## Exercises

### Exercise 1: Migration Sequence

You have an existing `products` table:

```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price INTEGER NOT NULL, -- stored in cents
  category TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Write the migration SQL files (just the SQL, not the Drizzle schema) for each of
these changes, in order:

1. Add a `description TEXT` column
2. Add a `stock INTEGER NOT NULL DEFAULT 0` column
3. Change `category` from a free-text column to a foreign key referencing a new
   `categories` table
4. Add a `deleted_at TIMESTAMP` column for soft deletes
5. Add a unique constraint on `(name, category_id)`

### Exercise 2: Zero-Downtime Migration Plan

You need to rename the `users.name` column to `users.display_name` in a production
database that serves 10,000 requests per minute. Write a detailed migration plan
including:

1. Each migration file (SQL)
2. Each code deployment between migrations
3. The order of operations
4. What happens if you need to roll back at each step
5. How you'd verify each step succeeded

### Exercise 3: Drift Detection Script

Write a Node.js script that:

1. Connects to a PostgreSQL database
2. Queries `information_schema.columns` to get the actual table structure
3. Compares it against your Drizzle schema definition
4. Reports any differences (extra columns, missing columns, type mismatches)

Hint: You can introspect your Drizzle schema using the table's column definitions.

### Exercise 4: Data Migration

You have a `users` table with a `full_name` TEXT column. You need to split it into
`first_name` and `last_name` columns. Write:

1. The migration SQL to add the new columns
2. A data migration script (TypeScript using Drizzle) that:
   - Reads all users
   - Splits `full_name` on the first space
   - Updates `first_name` and `last_name`
   - Handles edge cases (no space, multiple spaces, empty names)
3. The migration SQL to drop the `full_name` column and add NOT NULL constraints

### Exercise 5: Migration CI Pipeline

Design a GitHub Actions workflow (YAML) that:

1. Checks out the code
2. Starts a PostgreSQL container
3. Runs all existing migrations
4. Runs `drizzle-kit generate` and checks for uncommitted migration files
5. Runs the application's test suite
6. Fails the build if any step fails

Include comments explaining why each step is necessary.
