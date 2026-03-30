// ============================================================================
// TaskForge CLI -- Complete Solution
// ============================================================================
// Entry point: parses CLI arguments and dispatches to command handlers.
// Demonstrates proper error handling, graceful startup, and clean architecture.
// ============================================================================

import { initStorage } from "./storage.js";
import {
  handleAdd,
  handleList,
  handleView,
  handleUpdate,
  handleDelete,
  handleSearch,
  handleExport,
} from "./commands.js";

// --- Argument Parsing ---

interface ParsedArgs {
  command: string;
  args: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // Skip node and script path
  const rawArgs = argv.slice(2);

  if (rawArgs.length === 0) {
    return { command: "help", args: {}, positional: [] };
  }

  const command = rawArgs[0];
  const args: Record<string, string> = {};
  const positional: string[] = [];

  // Short flag to long flag mapping
  const shortMap: Record<string, string> = {
    t: "title",
    p: "priority",
    d: "description",
    s: "status",
    o: "output",
    f: "force",
  };

  let i = 1;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === "--") {
      // Everything after -- is positional
      positional.push(...rawArgs.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      // Boolean flags (no value)
      if (key === "force" || key === "overdue" || key === "help") {
        args[key] = "true";
        i++;
        continue;
      }

      // Key-value flags
      const value = rawArgs[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        i += 2;
      } else {
        args[key] = "true";
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const shortKey = arg.slice(1);
      const longKey = shortMap[shortKey] ?? shortKey;

      // Boolean short flags
      if (longKey === "force") {
        args[longKey] = "true";
        i++;
        continue;
      }

      const value = rawArgs[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        args[longKey] = value;
        i += 2;
      } else {
        args[longKey] = "true";
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { command, args, positional };
}

// --- Help Text ---

function showHelp(): void {
  console.log(`
  TaskForge CLI - A command-line task manager

  Usage:
    npx tsx src/index.ts <command> [options]

  Commands:
    add       Create a new task
              --title, -t     Task title (required)
              --description, -d  Task description
              --priority, -p  Priority: low, medium, high, critical (default: medium)
              --tags          Comma-separated tags
              --due           Due date (YYYY-MM-DD)

    list      List tasks
              --status, -s    Filter by status: todo, in-progress, done
              --priority, -p  Filter by priority
              --tag           Filter by tag
              --overdue       Show only overdue tasks
              --sort          Sort by: priority, due, created (default: created)

    view      View task details
              <id>            Task ID (or prefix)

    update    Update a task
              <id>            Task ID (or prefix)
              --title, -t     New title
              --status, -s    New status
              --priority, -p  New priority
              --tags          New tags (replaces existing)
              --due           New due date
              --description   New description

    delete    Delete a task
              <id>            Task ID (or prefix)
              --force, -f     Skip confirmation

    search    Search tasks
              <query>         Search term

    export    Export tasks to CSV
              --output, -o    Output file path (required)
              (supports same filters as list)

  Examples:
    npx tsx src/index.ts add --title "Fix login bug" --priority high --tags "bug,auth"
    npx tsx src/index.ts list --status todo --sort priority
    npx tsx src/index.ts view abc123
    npx tsx src/index.ts update abc123 --status done
    npx tsx src/index.ts delete abc123 --force
    npx tsx src/index.ts search "authentication"
    npx tsx src/index.ts export --output tasks.csv --status done
  `);
}

// --- Main ---

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv);

  // Show help if requested
  if (command === "help" || command === "--help" || command === "-h") {
    showHelp();
    return;
  }

  // Initialize storage before any command
  const initResult = await initStorage();
  if (!initResult.ok) {
    console.error(`\n  Fatal: ${initResult.message}\n`);
    process.exit(1);
  }

  switch (command) {
    case "add":
      await handleAdd(args);
      break;

    case "list":
    case "ls":
      await handleList(args);
      break;

    case "view":
    case "show":
      if (positional.length === 0) {
        console.error("\n  Error: Task ID is required.\n  Usage: taskforge view <id>\n");
        process.exitCode = 1;
        return;
      }
      await handleView(positional[0]);
      break;

    case "update":
    case "edit":
      if (positional.length === 0) {
        console.error("\n  Error: Task ID is required.\n  Usage: taskforge update <id> [options]\n");
        process.exitCode = 1;
        return;
      }
      await handleUpdate(positional[0], args);
      break;

    case "delete":
    case "rm":
      if (positional.length === 0) {
        console.error("\n  Error: Task ID is required.\n  Usage: taskforge delete <id>\n");
        process.exitCode = 1;
        return;
      }
      await handleDelete(positional[0], args.force === "true");
      break;

    case "search":
    case "find":
      if (positional.length === 0) {
        console.error("\n  Error: Search query is required.\n  Usage: taskforge search <query>\n");
        process.exitCode = 1;
        return;
      }
      await handleSearch(positional.join(" "));
      break;

    case "export":
      if (!args.output) {
        console.error(
          "\n  Error: Output path is required.\n  Usage: taskforge export --output tasks.csv\n"
        );
        process.exitCode = 1;
        return;
      }
      await handleExport(args.output, args);
      break;

    default:
      console.error(`\n  Unknown command: "${command}"\n  Run with --help for usage.\n`);
      process.exitCode = 1;
  }
}

// --- Entry Point ---

main().catch((err) => {
  // This should only fire for programmer errors -- operational errors
  // are handled via Result types within command handlers.
  console.error("\n  Fatal error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error("\n  Stack trace:", err.stack);
  }
  process.exit(1);
});
