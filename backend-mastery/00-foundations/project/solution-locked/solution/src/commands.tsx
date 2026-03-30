// ============================================================================
// TaskForge Commands -- Complete Solution
// ============================================================================
// Command handlers for the CLI. Each command validates input, interacts with
// storage, and formats output. Errors are handled with the Result type.
// ============================================================================

import { createWriteStream } from "fs";
import * as readline from "readline";
import {
  Task,
  TaskId,
  CreateTaskInput,
  Result,
  Ok,
  Err,
  validateCreateInput,
  validateUpdateInput,
  parseListFilters,
} from "./types.js";
import {
  addTask,
  findTask,
  loadTasks,
  updateTask,
  deleteTask,
} from "./storage.js";
import {
  formatTaskCreated,
  formatTaskDetail,
  formatTaskTable,
  filterTasks,
  sortTasks,
  searchTasks,
  CSV_HEADER,
  taskToCSVRow,
} from "./utils.js";

// --- Add Command ---

export async function handleAdd(args: Record<string, string>): Promise<void> {
  // Validate input
  const inputResult = validateCreateInput(args);
  if (!inputResult.ok) {
    console.error(`\n  Error: ${inputResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  const input: CreateTaskInput = inputResult.value;
  const now = new Date().toISOString();

  // Create the task object
  const task: Task = {
    id: TaskId(),
    title: input.title,
    description: input.description,
    status: "todo",
    priority: input.priority ?? "medium",
    tags: input.tags ?? [],
    dueDate: input.dueDate,
    createdAt: now,
    updatedAt: now,
  };

  // Save to storage
  const saveResult = await addTask(task);
  if (!saveResult.ok) {
    console.error(`\n  Error: ${saveResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(formatTaskCreated(task));
}

// --- List Command ---

export async function handleList(args: Record<string, string>): Promise<void> {
  // Parse filters
  const filtersResult = parseListFilters(args);
  if (!filtersResult.ok) {
    console.error(`\n  Error: ${filtersResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  const filters = filtersResult.value;

  // Load tasks
  const loadResult = await loadTasks();
  if (!loadResult.ok) {
    console.error(`\n  Error: ${loadResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Filter
  let tasks = filterTasks(loadResult.value, filters);

  // Sort
  tasks = sortTasks(tasks, filters.sort);

  // Build header note
  const parts: string[] = [];
  if (filters.status) parts.push(`status: ${filters.status}`);
  if (filters.priority) parts.push(`priority: ${filters.priority}`);
  if (filters.tag) parts.push(`tag: ${filters.tag}`);
  if (filters.overdue) parts.push("overdue");

  const headerNote = parts.length > 0
    ? `matching, filtered by ${parts.join(", ")}`
    : "total";

  // Display
  const sortLabel = filters.sort ? `, sorted by ${filters.sort}` : "";
  console.log(formatTaskTable(tasks, headerNote + sortLabel));
}

// --- View Command ---

export async function handleView(taskId: string): Promise<void> {
  const result = await findTask(taskId);
  if (!result.ok) {
    console.error(`\n  Error: ${result.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(formatTaskDetail(result.value));
}

// --- Update Command ---

export async function handleUpdate(
  taskId: string,
  args: Record<string, string>
): Promise<void> {
  // Validate updates
  const updatesResult = validateUpdateInput(args);
  if (!updatesResult.ok) {
    console.error(`\n  Error: ${updatesResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Apply updates
  const result = await updateTask(taskId, updatesResult.value);
  if (!result.ok) {
    console.error(`\n  Error: ${result.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Task updated successfully.\n`);
  console.log(formatTaskDetail(result.value));
}

// --- Delete Command ---

export async function handleDelete(
  taskId: string,
  force: boolean
): Promise<void> {
  // First, find the task to show it
  const findResult = await findTask(taskId);
  if (!findResult.ok) {
    console.error(`\n  Error: ${findResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  const task = findResult.value;

  // If not forced, ask for confirmation
  if (!force) {
    console.log(formatTaskDetail(task));

    const confirmed = await askConfirmation("  Are you sure you want to delete this task? (y/n) ");
    if (!confirmed) {
      console.log("\n  Cancelled.\n");
      return;
    }
  }

  // Delete the task
  const deleteResult = await deleteTask(taskId);
  if (!deleteResult.ok) {
    console.error(`\n  Error: ${deleteResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Task "${task.title}" deleted.\n`);
}

// --- Search Command ---

export async function handleSearch(query: string): Promise<void> {
  // Load all tasks
  const loadResult = await loadTasks();
  if (!loadResult.ok) {
    console.error(`\n  Error: ${loadResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Search
  const matches = searchTasks(loadResult.value, query);

  if (matches.length === 0) {
    console.log(`\n  No tasks matching "${query}".\n`);
    return;
  }

  console.log(formatTaskTable(matches, `matching "${query}"`));
}

// --- Export Command ---

export async function handleExport(
  outputPath: string,
  args: Record<string, string>
): Promise<void> {
  // Load tasks
  const loadResult = await loadTasks();
  if (!loadResult.ok) {
    console.error(`\n  Error: ${loadResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Parse and apply filters
  const filtersResult = parseListFilters(args);
  if (!filtersResult.ok) {
    console.error(`\n  Error: ${filtersResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  const tasks = filterTasks(loadResult.value, filtersResult.value);

  // Use streams for the export
  const writeStream = createWriteStream(outputPath, { encoding: "utf-8" });

  try {
    // Write header
    const headerWritten = writeStream.write(CSV_HEADER + "\n");
    if (!headerWritten) {
      await waitForDrain(writeStream);
    }

    // Write each task row with backpressure handling
    for (const task of tasks) {
      const row = taskToCSVRow(task) + "\n";
      const canContinue = writeStream.write(row);
      if (!canContinue) {
        await waitForDrain(writeStream);
      }
    }

    // End the stream and wait for finish
    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on("error", reject);
    });

    console.log(`\n  Exported ${tasks.length} task${tasks.length === 1 ? "" : "s"} to ${outputPath}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error writing CSV: ${message}\n`);
    process.exitCode = 1;
  }
}

// --- Helpers ---

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => stream.once("drain", resolve));
}

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
