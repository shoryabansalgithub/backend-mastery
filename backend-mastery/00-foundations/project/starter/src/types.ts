// ============================================================================
// TaskForge Types
// ============================================================================

// --- Branded Type Utility ---
type Brand<T, B extends string> = T & { readonly __brand: B };

// --- Branded Types ---
export type TaskId = Brand<string, "TaskId">;

export function createTaskId(): TaskId {
  return crypto.randomUUID() as TaskId;
}

// --- Result Type ---
export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

export function Ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function Err<E extends string>(error: E, message: string): { ok: false; error: E; message: string } {
  return { ok: false, error, message };
}

// --- Task Status and Priority ---
export type TaskStatus = "todo" | "in-progress" | "done";
export type TaskPriority = "low" | "medium" | "high" | "critical";

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
export type CreateTaskInput = Pick<Task, "title"> &
  Partial<Pick<Task, "description" | "priority" | "tags" | "dueDate">>;

export type UpdateTaskInput = Partial<Pick<Task, "title" | "description" | "status" | "priority" | "tags" | "dueDate">>;

export type TaskSummary = Pick<Task, "id" | "title" | "status" | "priority" | "dueDate">;

// --- Error Types ---
export type TaskError = "TASK_NOT_FOUND" | "INVALID_INPUT" | "STORAGE_ERROR";

// --- List Filters ---
export interface ListFilters {
  status?: TaskStatus;
  priority?: TaskPriority[];
  tag?: string;
  overdue?: boolean;
  sort?: "priority" | "due" | "created";
}

// --- Command Types ---
export type Command =
  | { type: "add"; input: CreateTaskInput }
  | { type: "list"; filters: ListFilters }
  | { type: "view"; id: string }
  | { type: "update"; id: string; updates: UpdateTaskInput }
  | { type: "delete"; id: string; force: boolean }
  | { type: "search"; query: string }
  | { type: "export"; outputPath: string; filters: ListFilters }
  | { type: "help" };
