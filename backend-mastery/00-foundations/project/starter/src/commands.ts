// ============================================================================
// TaskForge Commands
// ============================================================================

import * as fs from "fs";
import * as readline from "readline";
import {
  Task,
  TaskId,
  TaskPriority,
  TaskStatus,
  CreateTaskInput,
  UpdateTaskInput,
  ListFilters,
  createTaskId,
} from "./types.js";
import { addTask, findTask, loadTasks, updateTask, deleteTask } from "./storage.js";

// --- Display Helpers ---

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function shortId(id: TaskId): string {
  return id.substring(0, 8);
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "--";
  return iso.substring(0, 10);
}

function isOverdue(task: Task): boolean {
  if (!task.dueDate || task.status === "done") return false;
  return new Date(task.dueDate) < new Date();
}

function daysRelative(iso: string): string {
  const diff = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (diff === 0) return "today";
  if (diff > 0) return `in ${diff} day${diff === 1 ? "" : "s"}`;
  return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} ago`;
}

function printTask(task: Task): void {
  console.log();
  console.log("  Task Details:");
  console.log();
  console.log(`  ID:          ${task.id}`);
  console.log(`  Title:       ${task.title}`);
  console.log(`  Description: ${task.description ?? "(none)"}`);
  console.log(`  Status:      ${task.status}`);
  console.log(`  Priority:    ${task.priority.toUpperCase()}`);
  console.log(`  Tags:        ${task.tags.length > 0 ? task.tags.join(", ") : "(none)"}`);
  console.log(`  Due Date:    ${task.dueDate ? `${formatDate(task.dueDate)} (${daysRelative(task.dueDate)})` : "--"}`);
  console.log(`  Created:     ${task.createdAt}`);
  console.log(`  Updated:     ${task.updatedAt}`);
  console.log();
}

function printCreatedTask(task: Task): void {
  console.log();
  console.log("  Created task:");
  console.log();
  console.log(`  ID:       ${shortId(task.id)}-${task.id.substring(9, 13)}`);
  console.log(`  Title:    ${task.title}`);
  console.log(`  Status:   ${task.status}`);
  console.log(`  Priority: ${task.priority}`);
  console.log(`  Tags:     ${task.tags.length > 0 ? task.tags.join(", ") : "(none)"}`);
  if (task.dueDate) console.log(`  Due:      ${formatDate(task.dueDate)}`);
  console.log(`  Created:  ${task.createdAt}`);
  console.log();
}

function printTable(tasks: Task[], label: string): void {
  const colW = { id: 12, title: 24, priority: 10, status: 10, due: 12 };
  const pad = (s: string, w: number) => s.substring(0, w).padEnd(w);

  const border = (l: string, m: string, r: string, f: string) =>
    l +
    "─".repeat(colW.id + 2) +
    f +
    "─".repeat(colW.title + 2) +
    f +
    "─".repeat(colW.priority + 2) +
    f +
    "─".repeat(colW.status + 2) +
    f +
    "─".repeat(colW.due + 2) +
    r;

  console.log();
  console.log(`  ${label}`);
  console.log();
  console.log("  " + border("┌", "┬", "┐", "┬"));
  console.log(
    `  │ ${pad("ID", colW.id)} │ ${pad("Title", colW.title)} │ ${pad("Priority", colW.priority)} │ ${pad("Status", colW.status)} │ ${pad("Due", colW.due)} │`
  );
  console.log("  " + border("├", "┼", "┤", "┼"));

  for (const t of tasks) {
    const overdue = isOverdue(t) ? "!" : " ";
    console.log(
      `  │ ${pad(shortId(t.id), colW.id)} │ ${pad(t.title, colW.title)} │ ${pad(t.priority, colW.priority)} │ ${pad(t.status, colW.status)} │ ${pad(formatDate(t.dueDate) + overdue, colW.due)} │`
    );
  }

  console.log("  " + border("└", "┴", "┘", "┴"));
  console.log();
}

// --- Validation ---

function isValidStatus(s: string): s is TaskStatus {
  return ["todo", "in-progress", "done"].includes(s);
}

function isValidPriority(p: string): p is TaskPriority {
  return ["low", "medium", "high", "critical"].includes(p);
}

// --- Filter & Sort ---

function applyFilters(tasks: Task[], filters: ListFilters): Task[] {
  let result = tasks;

  if (filters.status) {
    result = result.filter((t) => t.status === filters.status);
  }
  if (filters.priority && filters.priority.length > 0) {
    result = result.filter((t) => filters.priority!.includes(t.priority));
  }
  if (filters.tag) {
    const tag = filters.tag.toLowerCase();
    result = result.filter((t) => t.tags.some((tg) => tg.toLowerCase() === tag));
  }
  if (filters.overdue) {
    result = result.filter(isOverdue);
  }

  if (filters.sort === "priority") {
    result = [...result].sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
  } else if (filters.sort === "due") {
    result = [...result].sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });
  } else {
    result = [...result].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return result;
}

// --- Commands ---

export async function handleAdd(args: Record<string, string>): Promise<void> {
  const title = args.title ?? args.t;
  if (!title || title.trim() === "") {
    console.error("  Error: --title is required.");
    process.exit(1);
  }

  const priority = args.priority ?? args.p ?? "medium";
  if (!isValidPriority(priority)) {
    console.error(`  Error: Invalid priority "${priority}". Use: low, medium, high, critical`);
    process.exit(1);
  }

  const tags = args.tags ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const now = new Date().toISOString();
  const task: Task = {
    id: createTaskId(),
    title: title.trim(),
    description: args.description ?? args.d ?? undefined,
    status: "todo",
    priority,
    tags,
    dueDate: args.due ?? undefined,
    createdAt: now,
    updatedAt: now,
  };

  const result = await addTask(task);
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  printCreatedTask(result.value);
}

export async function handleList(args: Record<string, string>): Promise<void> {
  const filters: ListFilters = {};

  if (args.status) {
    if (!isValidStatus(args.status)) {
      console.error(`  Error: Invalid status "${args.status}". Use: todo, in-progress, done`);
      process.exit(1);
    }
    filters.status = args.status;
  }

  if (args.priority) {
    const priorities = args.priority.split(",").map((p) => p.trim());
    for (const p of priorities) {
      if (!isValidPriority(p)) {
        console.error(`  Error: Invalid priority "${p}". Use: low, medium, high, critical`);
        process.exit(1);
      }
    }
    filters.priority = priorities as TaskPriority[];
  }

  if (args.tag) filters.tag = args.tag;
  if (args.overdue === "true") filters.overdue = true;

  if (args.sort) {
    if (!["priority", "due", "created"].includes(args.sort)) {
      console.error(`  Error: Invalid sort "${args.sort}". Use: priority, due, created`);
      process.exit(1);
    }
    filters.sort = args.sort as ListFilters["sort"];
  }

  const result = await loadTasks();
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  const tasks = applyFilters(result.value, filters);

  if (tasks.length === 0) {
    console.log("\n  No tasks found.\n");
    return;
  }

  const sortLabel = filters.sort ? `sorted by ${filters.sort}` : "sorted by created";
  printTable(tasks, `Tasks (${tasks.length} matching, ${sortLabel}):`);
}

export async function handleView(taskId: string): Promise<void> {
  const result = await findTask(taskId);
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }
  printTask(result.value);
}

export async function handleUpdate(taskId: string, args: Record<string, string>): Promise<void> {
  const updates: UpdateTaskInput = {};

  if (args.title) updates.title = args.title;
  if (args.description) updates.description = args.description;
  if (args.due) updates.dueDate = args.due;

  if (args.status) {
    if (!isValidStatus(args.status)) {
      console.error(`  Error: Invalid status "${args.status}". Use: todo, in-progress, done`);
      process.exit(1);
    }
    updates.status = args.status;
  }

  if (args.priority) {
    if (!isValidPriority(args.priority)) {
      console.error(`  Error: Invalid priority "${args.priority}". Use: low, medium, high, critical`);
      process.exit(1);
    }
    updates.priority = args.priority;
  }

  if (args.tags !== undefined) {
    updates.tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (Object.keys(updates).length === 0) {
    console.error("  Error: No fields to update provided.");
    process.exit(1);
  }

  const result = await updateTask(taskId, updates);
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  console.log("\n  Task updated:");
  printTask(result.value);
}

export async function handleDelete(taskId: string, force: boolean): Promise<void> {
  const findResult = await findTask(taskId);
  if (!findResult.ok) {
    console.error(`  Error: ${findResult.message}`);
    process.exit(1);
  }

  const task = findResult.value;

  if (!force) {
    printTask(task);
    const confirmed = await confirm("  Are you sure you want to delete this task? (y/n): ");
    if (!confirmed) {
      console.log("  Cancelled.\n");
      return;
    }
  }

  const result = await deleteTask(taskId);
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  console.log(`\n  Deleted task: ${task.title} (${shortId(task.id)})\n`);
}

export async function handleSearch(query: string): Promise<void> {
  const result = await loadTasks();
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  const q = query.toLowerCase();
  const tasks = result.value.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      (t.description ?? "").toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q))
  );

  if (tasks.length === 0) {
    console.log(`\n  No tasks found matching "${query}".\n`);
    return;
  }

  printTable(tasks, `Search results for "${query}" (${tasks.length} found):`);
}

export async function handleExport(outputPath: string, filters: Record<string, string>): Promise<void> {
  const listFilters: ListFilters = {};
  if (filters.status && isValidStatus(filters.status)) listFilters.status = filters.status;
  if (filters.tag) listFilters.tag = filters.tag;
  if (filters.overdue === "true") listFilters.overdue = true;

  const result = await loadTasks();
  if (!result.ok) {
    console.error(`  Error: ${result.message}`);
    process.exit(1);
  }

  const tasks = applyFilters(result.value, listFilters);
  const stream = fs.createWriteStream(outputPath, { encoding: "utf-8" });

  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);

    const header = "id,title,description,status,priority,tags,dueDate,createdAt,updatedAt\n";
    const canContinue = stream.write(header);

    const writeRows = (index: number) => {
      for (let i = index; i < tasks.length; i++) {
        const t = tasks[i];
        const row = [
          t.id,
          `"${t.title.replace(/"/g, '""')}"`,
          t.description ? `"${t.description.replace(/"/g, '""')}"` : "",
          t.status,
          t.priority,
          `"${t.tags.join(",")}"`,
          t.dueDate ?? "",
          t.createdAt,
          t.updatedAt,
        ].join(",") + "\n";

        const ok = stream.write(row);
        if (!ok) {
          stream.once("drain", () => writeRows(i + 1));
          return;
        }
      }
      stream.end();
    };

    if (canContinue) {
      writeRows(0);
    } else {
      stream.once("drain", () => writeRows(0));
    }
  });

  console.log(`\n  Exported ${tasks.length} task${tasks.length === 1 ? "" : "s"} to ${outputPath}\n`);
}

// --- Utility ---

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}
