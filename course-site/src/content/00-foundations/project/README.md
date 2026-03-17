# Project: TaskForge CLI

## Overview

Build a command-line task manager with file-based JSON persistence. This project
synthesizes everything from Module 0: TypeScript's type system, async patterns,
streams, and error handling.

TaskForge is not a toy. It's a real tool you could use daily. The requirements are
designed to push you into situations where good typing and error handling matter.

---

## Requirements

### Core Data Model

A **Task** has:
- `id` -- A branded `TaskId` type (UUID format)
- `title` -- Non-empty string
- `description` -- Optional string
- `status` -- One of: `todo`, `in-progress`, `done`
- `priority` -- One of: `low`, `medium`, `high`, `critical`
- `tags` -- Array of strings
- `dueDate` -- Optional ISO 8601 date string
- `createdAt` -- ISO 8601 date string (set on creation)
- `updatedAt` -- ISO 8601 date string (updated on every change)

### Commands

All commands follow the pattern: `taskforge <command> [options]`

#### `add` -- Create a new task
```bash
taskforge add --title "Implement auth" --priority high --tags "backend,security" --due 2024-12-31
taskforge add -t "Write tests" -p medium
```

**Required:** `--title` (or `-t`)
**Optional:** `--description` (`-d`), `--priority` (`-p`, default: `medium`),
`--tags` (comma-separated), `--due` (ISO date)

**Output:** The created task with its ID.

#### `list` -- List tasks
```bash
taskforge list
taskforge list --status todo
taskforge list --priority high --priority critical
taskforge list --tag backend
taskforge list --overdue
taskforge list --sort priority
taskforge list --sort due
```

**Filters:** `--status`, `--priority`, `--tag`, `--overdue` (past due date)
**Sort:** `--sort` (by `priority`, `due`, `created`, default: `created`)

**Output:** Formatted table of tasks.

#### `view` -- View a single task
```bash
taskforge view abc123
```

**Output:** Full task details in a readable format.

#### `update` -- Update a task
```bash
taskforge update abc123 --status in-progress
taskforge update abc123 --title "New title" --priority critical
taskforge update abc123 --tags "backend,api,urgent"
```

Only the specified fields are updated. `updatedAt` is always refreshed.

#### `delete` -- Delete a task
```bash
taskforge delete abc123
taskforge delete abc123 --force  # Skip confirmation
```

Without `--force`, display the task and ask "Are you sure? (y/n)".

#### `search` -- Full-text search
```bash
taskforge search "authentication"
```

Searches title, description, and tags. Case-insensitive.

#### `export` -- Export to CSV
```bash
taskforge export --output tasks.csv
taskforge export --status done --output completed.csv
```

Uses streams for the export (even though the data might be small, practice the pattern).
Accepts the same filters as `list`.

### Storage

- Tasks are stored in a JSON file at `~/.taskforge/tasks.json`
- The file is created automatically on first use
- All file operations use proper error handling (Result type)
- File writes should be atomic (write to temp file, then rename)

### Error Handling

- Use the Result type pattern for all operations that can fail
- Define specific error types for each failure mode:
  - `TASK_NOT_FOUND`
  - `INVALID_INPUT`
  - `STORAGE_ERROR`
  - `DUPLICATE_TITLE` (optional: warn if a task with the same title exists)
- Display user-friendly error messages
- Never crash on expected errors (invalid input, missing file, etc.)

### Type Safety

- Use branded types for `TaskId`
- Use discriminated unions for command parsing
- Use `Partial<Task>` for updates
- Use utility types (`Pick`, `Omit`) for different views of task data

---

## Expected Output Examples

### Adding a task
```
$ taskforge add --title "Set up CI pipeline" --priority high --tags "devops,ci" --due 2024-06-15

  Created task:

  ID:       f47ac10b-58cc
  Title:    Set up CI pipeline
  Status:   todo
  Priority: high
  Tags:     devops, ci
  Due:      2024-06-15
  Created:  2024-06-01T10:30:00.000Z
```

### Listing tasks
```
$ taskforge list --status todo --sort priority

  Tasks (3 matching, sorted by priority):

  ┌──────────────┬────────────────────────┬──────────┬──────────┬────────────┐
  │ ID           │ Title                  │ Priority │ Status   │ Due        │
  ├──────────────┼────────────────────────┼──────────┼──────────┼────────────┤
  │ f47ac10b     │ Set up CI pipeline     │ high     │ todo     │ 2024-06-15 │
  │ 7c9e6679     │ Write API docs         │ medium   │ todo     │ 2024-07-01 │
  │ 550e8400     │ Refactor utils         │ low      │ todo     │ --         │
  └──────────────┴────────────────────────┴──────────┴──────────┴────────────┘
```

### Viewing a task
```
$ taskforge view f47ac10b

  Task Details:

  ID:          f47ac10b-58cc-4372-a567-0e02b2c3d479
  Title:       Set up CI pipeline
  Description: (none)
  Status:      todo
  Priority:    HIGH
  Tags:        devops, ci
  Due Date:    2024-06-15 (in 14 days)
  Created:     2024-06-01T10:30:00.000Z
  Updated:     2024-06-01T10:30:00.000Z
```

### Export to CSV
```
$ taskforge export --output tasks.csv --status todo

  Exported 3 tasks to tasks.csv
```

---

## Getting Started

```bash
cd starter
npm install
npx tsx src/index.ts add --title "My first task"
```

The starter code has:
- `src/types.ts` -- Partially complete. Fill in the TODOs.
- `src/storage.ts` -- Empty implementations. Build the file storage.
- `src/commands.ts` -- Empty command handlers. Implement each command.
- `src/index.ts` -- CLI skeleton. Parse arguments and dispatch to commands.

---

## Grading Criteria

Your solution will be evaluated on:

1. **Type safety** (30%) -- Branded types, Result type, no `any`, strict mode
2. **Error handling** (25%) -- Result pattern, user-friendly messages, no crashes
3. **Correctness** (25%) -- All commands work as specified
4. **Code quality** (10%) -- Clean, readable, well-organized
5. **Streams usage** (10%) -- CSV export uses streams

---

## Hints

- Start with `types.ts`. Get your data model right first.
- Build `storage.ts` next. Test it independently with a simple script.
- Implement `add` and `list` first -- they're the most useful for testing.
- Use `crypto.randomUUID()` for generating task IDs.
- For atomic file writes: `fs.writeFile(tempPath, data)` then `fs.rename(tempPath, realPath)`.
- For date comparison: `new Date(dueDate) < new Date()` checks if overdue.
- For CSV export: use `createWriteStream` and `.write()` with backpressure handling.

---

## Stretch Goals (Optional)

- Add `stats` command showing task counts by status and priority
- Add `archive` command to move done tasks to a separate file
- Add colored output (green for done, yellow for in-progress, red for overdue)
- Add `undo` command that reverts the last operation (keep a history)
- Support Markdown in task descriptions
