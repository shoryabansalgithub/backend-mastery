// ============================================================================
// TaskForge Types -- Complete Solution
// ============================================================================

import { randomUUID } from "crypto";

// --- Branded Type Utility ---
type Brand<T, B extends string> = T & { readonly __brand: B };

// --- Branded Types ---
export type TaskId = Brand<string, "TaskId">;

export function TaskId(value?: string): TaskId {
  return (value ?? randomUUID()) as TaskId;
}

// Validate that a string looks like it could be a TaskId (or prefix of one)
export function isValidTaskIdPrefix(value: string): boolean {
  return /^[0-9a-f-]+$/i.test(value) && value.length >= 4;
}

// --- Result Type ---
export type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E extends string>(error: E, message: string): Result<never, E> {
  return { ok: false, error, message };
}

// --- Task Status and Priority ---
export type TaskStatus = "todo" | "in-progress" | "done";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export const VALID_STATUSES: readonly TaskStatus[] = ["todo", "in-progress", "done"];
export const VALID_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "critical"];

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// --- Task Interface ---
export interface Task {
  id: TaskId;
  title: string;
  description: string | undefined;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  dueDate: string | undefined;
  createdAt: string;
  updatedAt: string;
}

// --- Derived Types ---
export type CreateTaskInput = {
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueDate?: string;
};

export type UpdateTaskInput = Partial<
  Pick<Task, "title" | "description" | "status" | "priority" | "tags" | "dueDate">
>;

export type TaskSummary = Pick<Task, "id" | "title" | "status" | "priority" | "dueDate">;

// --- Error Types ---
export type TaskError = "TASK_NOT_FOUND" | "INVALID_INPUT" | "STORAGE_ERROR";

// --- List Filters ---
export interface ListFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string;
  overdue?: boolean;
  sort?: "priority" | "due" | "created";
}

// --- Type Guards ---
export function isValidStatus(value: string): value is TaskStatus {
  return VALID_STATUSES.includes(value as TaskStatus);
}

export function isValidPriority(value: string): value is TaskPriority {
  return VALID_PRIORITIES.includes(value as TaskPriority);
}

export function isValidISODate(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime());
}

// --- Validation ---
export function validateCreateInput(
  args: Record<string, string>
): Result<CreateTaskInput, "INVALID_INPUT"> {
  const title = args.title ?? args.t;
  if (!title || title.trim().length === 0) {
    return Err("INVALID_INPUT", "Title is required. Use --title or -t.");
  }

  const input: CreateTaskInput = {
    title: title.trim(),
  };

  if (args.description) {
    input.description = args.description;
  }

  if (args.priority) {
    if (!isValidPriority(args.priority)) {
      return Err(
        "INVALID_INPUT",
        `Invalid priority "${args.priority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`
      );
    }
    input.priority = args.priority;
  }

  if (args.tags) {
    input.tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (args.due) {
    if (!isValidISODate(args.due)) {
      return Err("INVALID_INPUT", `Invalid date "${args.due}". Use ISO 8601 format (YYYY-MM-DD).`);
    }
    input.dueDate = args.due;
  }

  return Ok(input);
}

export function validateUpdateInput(
  args: Record<string, string>
): Result<UpdateTaskInput, "INVALID_INPUT"> {
  const updates: UpdateTaskInput = {};
  let hasUpdates = false;

  if (args.title) {
    if (args.title.trim().length === 0) {
      return Err("INVALID_INPUT", "Title cannot be empty.");
    }
    updates.title = args.title.trim();
    hasUpdates = true;
  }

  if (args.description) {
    updates.description = args.description;
    hasUpdates = true;
  }

  if (args.status) {
    if (!isValidStatus(args.status)) {
      return Err(
        "INVALID_INPUT",
        `Invalid status "${args.status}". Must be one of: ${VALID_STATUSES.join(", ")}`
      );
    }
    updates.status = args.status;
    hasUpdates = true;
  }

  if (args.priority) {
    if (!isValidPriority(args.priority)) {
      return Err(
        "INVALID_INPUT",
        `Invalid priority "${args.priority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`
      );
    }
    updates.priority = args.priority;
    hasUpdates = true;
  }

  if (args.tags) {
    updates.tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean);
    hasUpdates = true;
  }

  if (args.due) {
    if (!isValidISODate(args.due)) {
      return Err("INVALID_INPUT", `Invalid date "${args.due}". Use ISO 8601 format (YYYY-MM-DD).`);
    }
    updates.dueDate = args.due;
    hasUpdates = true;
  }

  if (!hasUpdates) {
    return Err("INVALID_INPUT", "No update fields provided. Use --title, --status, --priority, --tags, or --due.");
  }

  return Ok(updates);
}

export function parseListFilters(args: Record<string, string>): Result<ListFilters, "INVALID_INPUT"> {
  const filters: ListFilters = {};

  if (args.status) {
    if (!isValidStatus(args.status)) {
      return Err(
        "INVALID_INPUT",
        `Invalid status "${args.status}". Must be one of: ${VALID_STATUSES.join(", ")}`
      );
    }
    filters.status = args.status;
  }

  if (args.priority) {
    if (!isValidPriority(args.priority)) {
      return Err(
        "INVALID_INPUT",
        `Invalid priority "${args.priority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`
      );
    }
    filters.priority = args.priority;
  }

  if (args.tag) {
    filters.tag = args.tag;
  }

  if (args.overdue === "true") {
    filters.overdue = true;
  }

  if (args.sort) {
    const validSorts = ["priority", "due", "created"];
    if (!validSorts.includes(args.sort)) {
      return Err(
        "INVALID_INPUT",
        `Invalid sort field "${args.sort}". Must be one of: ${validSorts.join(", ")}`
      );
    }
    filters.sort = args.sort as ListFilters["sort"];
  }

  return Ok(filters);
}
