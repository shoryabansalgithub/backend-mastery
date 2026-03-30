// ============================================================================
// TaskForge Utilities -- Complete Solution
// ============================================================================
// Formatting helpers, date utilities, and display functions.
// ============================================================================

import { Task, TaskPriority, TaskStatus, PRIORITY_ORDER, ListFilters } from "./types.js";

// --- Date Utilities ---

export function isOverdue(dueDate: string | undefined): boolean {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  const now = new Date();
  // Compare dates only (not times)
  due.setHours(23, 59, 59, 999);
  return due < now;
}

export function formatRelativeDate(dateStr: string | undefined): string {
  if (!dateStr) return "--";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)} days ago`;
  if (diffDays === -1) return "yesterday";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays <= 7) return `in ${diffDays} days`;
  if (diffDays <= 30) return `in ${Math.ceil(diffDays / 7)} weeks`;
  return `in ${Math.ceil(diffDays / 30)} months`;
}

export function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "--";
  const date = new Date(dateStr);
  return date.toISOString().split("T")[0];
}

// --- Task Filtering ---

export function filterTasks(tasks: Task[], filters: ListFilters): Task[] {
  let filtered = [...tasks];

  if (filters.status) {
    filtered = filtered.filter((t) => t.status === filters.status);
  }

  if (filters.priority) {
    filtered = filtered.filter((t) => t.priority === filters.priority);
  }

  if (filters.tag) {
    const tagLower = filters.tag.toLowerCase();
    filtered = filtered.filter((t) =>
      t.tags.some((tag) => tag.toLowerCase() === tagLower)
    );
  }

  if (filters.overdue) {
    filtered = filtered.filter((t) => isOverdue(t.dueDate));
  }

  return filtered;
}

export function sortTasks(tasks: Task[], sortBy: ListFilters["sort"]): Task[] {
  const sorted = [...tasks];

  switch (sortBy) {
    case "priority":
      sorted.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      break;
    case "due":
      sorted.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1; // Tasks without due date go last
        if (!b.dueDate) return -1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      });
      break;
    case "created":
    default:
      sorted.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      break;
  }

  return sorted;
}

// --- Display Formatting ---

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

export function padRight(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

export function padLeft(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return " ".repeat(width - str.length) + str;
}

export function formatTaskDetail(task: Task): string {
  const overdueMarker = isOverdue(task.dueDate) ? " (OVERDUE)" : "";
  const dueDateDisplay = task.dueDate
    ? `${formatDate(task.dueDate)} (${formatRelativeDate(task.dueDate)})${overdueMarker}`
    : "(none)";

  return `
  Task Details:

  ID:          ${task.id}
  Title:       ${task.title}
  Description: ${task.description ?? "(none)"}
  Status:      ${task.status}
  Priority:    ${task.priority.toUpperCase()}
  Tags:        ${task.tags.length > 0 ? task.tags.join(", ") : "(none)"}
  Due Date:    ${dueDateDisplay}
  Created:     ${task.createdAt}
  Updated:     ${task.updatedAt}
`;
}

export function formatTaskCreated(task: Task): string {
  return `
  Created task:

  ID:       ${task.id.slice(0, 12)}
  Title:    ${task.title}
  Status:   ${task.status}
  Priority: ${task.priority}
  Tags:     ${task.tags.length > 0 ? task.tags.join(", ") : "(none)"}
  Due:      ${formatDate(task.dueDate)}
  Created:  ${task.createdAt}
`;
}

export function formatTaskTable(tasks: Task[], headerNote: string): string {
  if (tasks.length === 0) {
    return "\n  No tasks found.\n";
  }

  // Column widths
  const colId = 14;
  const colTitle = 24;
  const colPriority = 10;
  const colStatus = 12;
  const colDue = 12;

  const hr = (char: string, join: string, corners: [string, string]) =>
    corners[0] +
    char.repeat(colId) + join +
    char.repeat(colTitle) + join +
    char.repeat(colPriority) + join +
    char.repeat(colStatus) + join +
    char.repeat(colDue) +
    corners[1];

  const row = (id: string, title: string, priority: string, status: string, due: string) =>
    "\u2502" +
    padRight(" " + id, colId) + "\u2502" +
    padRight(" " + title, colTitle) + "\u2502" +
    padRight(" " + priority, colPriority) + "\u2502" +
    padRight(" " + status, colStatus) + "\u2502" +
    padRight(" " + due, colDue) + "\u2502";

  const lines: string[] = [];
  lines.push("");
  lines.push(`  Tasks (${tasks.length} ${headerNote}):`);
  lines.push("");
  lines.push("  " + hr("\u2500", "\u252C", ["\u250C", "\u2510"]));
  lines.push("  " + row("ID", "Title", "Priority", "Status", "Due"));
  lines.push("  " + hr("\u2500", "\u253C", ["\u251C", "\u2524"]));

  for (const task of tasks) {
    const overdueFlag = isOverdue(task.dueDate) ? " !" : "";
    lines.push(
      "  " +
        row(
          truncate(task.id.slice(0, 12), colId - 2),
          truncate(task.title, colTitle - 2),
          task.priority,
          task.status,
          formatDate(task.dueDate) + overdueFlag
        )
    );
  }

  lines.push("  " + hr("\u2500", "\u2534", ["\u2514", "\u2518"]));
  lines.push("");

  return lines.join("\n");
}

// --- CSV ---

export function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function taskToCSVRow(task: Task): string {
  return [
    escapeCSV(task.id),
    escapeCSV(task.title),
    escapeCSV(task.description ?? ""),
    escapeCSV(task.status),
    escapeCSV(task.priority),
    escapeCSV(task.tags.join(";")),
    escapeCSV(task.dueDate ?? ""),
    escapeCSV(task.createdAt),
    escapeCSV(task.updatedAt),
  ].join(",");
}

export const CSV_HEADER = "id,title,description,status,priority,tags,dueDate,createdAt,updatedAt";

// --- Search ---

export function searchTasks(tasks: Task[], query: string): Task[] {
  const lowerQuery = query.toLowerCase();

  return tasks.filter((task) => {
    const searchableText = [
      task.title,
      task.description ?? "",
      ...task.tags,
    ]
      .join(" ")
      .toLowerCase();

    return searchableText.includes(lowerQuery);
  });
}
