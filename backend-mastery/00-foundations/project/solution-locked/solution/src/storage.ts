// ============================================================================
// TaskForge Storage -- Complete Solution
// ============================================================================
// File-based JSON persistence with atomic writes and Result-type error handling.
// ============================================================================

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  Task,
  TaskId,
  Result,
  Ok,
  Err,
  UpdateTaskInput,
} from "./types.js";

// --- Constants ---
const TASKFORGE_DIR = path.join(os.homedir(), ".taskforge");
const TASKS_FILE = path.join(TASKFORGE_DIR, "tasks.json");
const TEMP_SUFFIX = ".tmp";

// --- Storage Initialization ---

export async function initStorage(): Promise<Result<void, "STORAGE_ERROR">> {
  try {
    // Create directory if it doesn't exist
    await fs.mkdir(TASKFORGE_DIR, { recursive: true });

    // Create tasks file if it doesn't exist
    try {
      await fs.access(TASKS_FILE);
    } catch {
      // File doesn't exist -- create it with an empty array
      await fs.writeFile(TASKS_FILE, "[]", "utf-8");
    }

    return Ok(undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Err("STORAGE_ERROR", `Failed to initialize storage: ${message}`);
  }
}

// --- Core Operations ---

export async function loadTasks(): Promise<Result<Task[], "STORAGE_ERROR">> {
  try {
    const raw = await fs.readFile(TASKS_FILE, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      return Err("STORAGE_ERROR", "Tasks file is corrupted: expected an array");
    }

    // Cast the loaded data -- in a production system you'd validate each task
    return Ok(data as Task[]);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      // File doesn't exist yet -- return empty array
      return Ok([]);
    }

    if (err instanceof SyntaxError) {
      return Err("STORAGE_ERROR", "Tasks file contains invalid JSON. It may be corrupted.");
    }

    const message = err instanceof Error ? err.message : String(err);
    return Err("STORAGE_ERROR", `Failed to read tasks: ${message}`);
  }
}

export async function saveTasks(tasks: Task[]): Promise<Result<void, "STORAGE_ERROR">> {
  const tempFile = TASKS_FILE + TEMP_SUFFIX;

  try {
    // Write to temp file first (atomic write pattern)
    const json = JSON.stringify(tasks, null, 2);
    await fs.writeFile(tempFile, json, "utf-8");

    // Rename temp file to actual file (atomic on most filesystems)
    await fs.rename(tempFile, TASKS_FILE);

    return Ok(undefined);
  } catch (err) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    const message = err instanceof Error ? err.message : String(err);
    return Err("STORAGE_ERROR", `Failed to save tasks: ${message}`);
  }
}

// --- Task Operations ---

export async function findTask(
  idPrefix: string
): Promise<Result<Task, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const loadResult = await loadTasks();
  if (!loadResult.ok) return loadResult;

  const tasks = loadResult.value;

  // Support partial ID matching
  const matches = tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    return Err("TASK_NOT_FOUND", `No task found matching ID "${idPrefix}"`);
  }

  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 12)).join(", ");
    return Err(
      "TASK_NOT_FOUND",
      `Multiple tasks match ID prefix "${idPrefix}": ${ids}. Please be more specific.`
    );
  }

  return Ok(matches[0]);
}

export async function addTask(
  task: Task
): Promise<Result<Task, "STORAGE_ERROR">> {
  const loadResult = await loadTasks();
  if (!loadResult.ok) return loadResult;

  const tasks = loadResult.value;
  tasks.push(task);

  const saveResult = await saveTasks(tasks);
  if (!saveResult.ok) return saveResult;

  return Ok(task);
}

export async function updateTask(
  idPrefix: string,
  updates: UpdateTaskInput
): Promise<Result<Task, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const loadResult = await loadTasks();
  if (!loadResult.ok) return loadResult;

  const tasks = loadResult.value;
  const matches = tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    return Err("TASK_NOT_FOUND", `No task found matching ID "${idPrefix}"`);
  }

  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 12)).join(", ");
    return Err(
      "TASK_NOT_FOUND",
      `Multiple tasks match ID prefix "${idPrefix}": ${ids}. Please be more specific.`
    );
  }

  const taskIndex = tasks.findIndex((t) => t.id === matches[0].id);
  const existingTask = tasks[taskIndex];

  // Apply updates
  const updatedTask: Task = {
    ...existingTask,
    ...updates,
    id: existingTask.id, // Never change ID
    createdAt: existingTask.createdAt, // Never change createdAt
    updatedAt: new Date().toISOString(),
  };

  tasks[taskIndex] = updatedTask;

  const saveResult = await saveTasks(tasks);
  if (!saveResult.ok) return saveResult;

  return Ok(updatedTask);
}

export async function deleteTask(
  idPrefix: string
): Promise<Result<Task, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const loadResult = await loadTasks();
  if (!loadResult.ok) return loadResult;

  const tasks = loadResult.value;
  const matches = tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    return Err("TASK_NOT_FOUND", `No task found matching ID "${idPrefix}"`);
  }

  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 12)).join(", ");
    return Err(
      "TASK_NOT_FOUND",
      `Multiple tasks match ID prefix "${idPrefix}": ${ids}. Please be more specific.`
    );
  }

  const deletedTask = matches[0];
  const remaining = tasks.filter((t) => t.id !== deletedTask.id);

  const saveResult = await saveTasks(remaining);
  if (!saveResult.ok) return saveResult;

  return Ok(deletedTask);
}

// --- Utility ---

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
