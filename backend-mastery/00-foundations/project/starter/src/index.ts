// ============================================================================
// TaskForge CLI -- Entry Point
// ============================================================================
// This is the main entry point for the TaskForge CLI.
// It parses command-line arguments and dispatches to the appropriate handler.
//
// Usage:
//   npx tsx src/index.ts <command> [options]
//
// Commands:
//   add      Create a new task
//   list     List tasks (with optional filters)
//   view     View a single task
//   update   Update a task
//   delete   Delete a task
//   search   Search tasks
//   export   Export tasks to CSV
// ============================================================================

import {
  handleAdd,
  handleList,
  handleView,
  handleUpdate,
  handleDelete,
  handleSearch,
  handleExport,
} from "./commands.js";
import { initStorage } from "./storage.js";

// --- Argument Parsing ---

/**
 * Parse command-line arguments into a structured format.
 *
 * Examples:
 *   ["add", "--title", "My Task", "--priority", "high"]
 *   => { command: "add", args: { title: "My Task", priority: "high" }, positional: [] }
 *
 *   ["view", "abc123"]
 *   => { command: "view", args: {}, positional: ["abc123"] }
 */
function parseArgs(argv: string[]): {
  command: string;
  args: Record<string, string>;
  positional: string[];
} {
  // Skip node and script path
  const rawArgs = argv.slice(2);

  if (rawArgs.length === 0) {
    return { command: "help", args: {}, positional: [] };
  }

  const command = rawArgs[0];
  const args: Record<string, string> = {};
  const positional: string[] = [];

  let i = 1;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--") ? rawArgs[i + 1] : "true";
      args[key] = value;
      i += value === "true" ? 1 : 2;
    } else if (arg.startsWith("-") && arg.length === 2) {
      // Short flags: -t, -p, -d, etc.
      const shortMap: Record<string, string> = {
        t: "title",
        p: "priority",
        d: "description",
        s: "status",
        o: "output",
      };
      const key = shortMap[arg.slice(1)] ?? arg.slice(1);
      const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-") ? rawArgs[i + 1] : "true";
      args[key] = value;
      i += value === "true" ? 1 : 2;
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
    taskforge <command> [options]

  Commands:
    add       Create a new task
    list      List tasks (with optional filters)
    view      View a single task
    update    Update a task
    delete    Delete a task
    search    Search tasks by keyword
    export    Export tasks to CSV

  Examples:
    taskforge add --title "My Task" --priority high --tags "work,urgent"
    taskforge list --status todo --sort priority
    taskforge view abc123
    taskforge update abc123 --status done
    taskforge delete abc123
    taskforge search "authentication"
    taskforge export --output tasks.csv

  Use --help with any command for more details.
  `);
}

// --- Main ---

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv);

  await initStorage();

  switch (command) {
    case "add":
      await handleAdd(args);
      break;

    case "list":
      await handleList(args);
      break;

    case "view":
      if (positional.length === 0) {
        console.error("Error: task ID is required. Usage: taskforge view <id>");
        process.exit(1);
      }
      await handleView(positional[0]);
      break;

    case "update":
      if (positional.length === 0) {
        console.error("Error: task ID is required. Usage: taskforge update <id> [options]");
        process.exit(1);
      }
      await handleUpdate(positional[0], args);
      break;

    case "delete":
      if (positional.length === 0) {
        console.error("Error: task ID is required. Usage: taskforge delete <id>");
        process.exit(1);
      }
      await handleDelete(positional[0], args.force === "true");
      break;

    case "search":
      if (positional.length === 0) {
        console.error("Error: search query is required. Usage: taskforge search <query>");
        process.exit(1);
      }
      await handleSearch(positional[0]);
      break;

    case "export":
      if (!args.output) {
        console.error("Error: --output path is required. Usage: taskforge export --output tasks.csv");
        process.exit(1);
      }
      await handleExport(args.output, args);
      break;

    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;

    default:
      console.error(`Unknown command: "${command}". Run "taskforge help" for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
