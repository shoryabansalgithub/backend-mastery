// ============================================================================
// TaskForge Storage
// ============================================================================

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { Task, TaskId, Result, Ok, Err, UpdateTaskInput } from "./types.js";

// --- Constants ---
const TASKFORGE_DIR = path.join(os.homedir(), ".taskforge");
const TASKS_FILE = path.join(TASKFORGE_DIR, "tasks.json");
const TASKS_TEMP = path.join(TASKFORGE_DIR, "tasks.json.tmp");

/**
 * Ensure the storage directory and file exist.
 */
export async function initStorage(): Promise<void> {
  await fs.mkdir(TASKFORGE_DIR, { recursive: true });
  try {
    await fs.access(TASKS_FILE);
  } catch {
    await fs.writeFile(TASKS_FILE, "[]", "utf-8");
  }
}

/**
 * Load all tasks from the JSON file.
 */
export async function loadTasks(): Promise<Result<Task[], "STORAGE_ERROR">> {
  try {
    const raw = await fs.readFile(TASKS_FILE, "utf-8");
    const tasks = JSON.parse(raw) as Task[];
    return Ok(tasks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Err("STORAGE_ERROR", `Failed to load tasks: ${msg}`);
  }
}

/**
 * Save all tasks to the JSON file using atomic write.
 */
export async function saveTasks(tasks: Task[]): Promise<Result<void, "STORAGE_ERROR">> {
  try {
    const data = JSON.stringify(tasks, null, 2);
    await fs.writeFile(TASKS_TEMP, data, "utf-8");
    await fs.rename(TASKS_TEMP, TASKS_FILE);
    return Ok(undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Err("STORAGE_ERROR", `Failed to save tasks: ${msg}`);
  }
}

/**
 * Find a task by ID (supports partial ID match).
 */
export async function findTask(id: string): Promise<Result<Task, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const result = await loadTasks();
  if (!result.ok) return result;

  const task = result.value.find((t) => t.id.startsWith(id));
  if (!task) return Err("TASK_NOT_FOUND", `No task found with ID starting with "${id}"`);
  return Ok(task);
}

/**
 * Add a new task.
 */
export async function addTask(task: Task): Promise<Result<Task, "STORAGE_ERROR">> {
  const result = await loadTasks();
  if (!result.ok) return result;

  const tasks = [...result.value, task];
  const saveResult = await saveTasks(tasks);
  if (!saveResult.ok) return saveResult;
  return Ok(task);
}

/**
 * Update an existing task.
 */
export async function updateTask(
  id: string,
  updates: UpdateTaskInput
): Promise<Result<Task, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const result = await loadTasks();
  if (!result.ok) return result;

  const index = result.value.findIndex((t) => t.id.startsWith(id));
  if (index === -1) return Err("TASK_NOT_FOUND", `No task found with ID starting with "${id}"`);

  const updated: Task = {
    ...result.value[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const tasks = [...result.value];
  tasks[index] = updated;

  const saveResult = await saveTasks(tasks);
  if (!saveResult.ok) return saveResult;
  return Ok(updated);
}

/**
 * Delete a task by ID.
 */
export async function deleteTask(id: string): Promise<Result<void, "TASK_NOT_FOUND" | "STORAGE_ERROR">> {
  const result = await loadTasks();
  if (!result.ok) return result;

  const index = result.value.findIndex((t) => t.id.startsWith(id));
  if (index === -1) return Err("TASK_NOT_FOUND", `No task found with ID starting with "${id}"`);

  const tasks = result.value.filter((_, i) => i !== index);
  const saveResult = await saveTasks(tasks);
  if (!saveResult.ok) return saveResult;
  return Ok(undefined);
}
