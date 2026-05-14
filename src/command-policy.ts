import path from "node:path";
import { assertInsideWorkspace } from "./workspace-paths.js";

export interface CommandPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALWAYS_DENIED = new Set([
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "mount",
  "mv",
  "rm",
  "rmdir",
  "sudo",
  "su",
]);

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "tail",
  "wc",
]);

const ALLOWED_NPM_SCRIPTS = new Set([
  "build",
  "check",
  "lint",
  "test",
  "typecheck",
]);

const SHELL_METACHAR_PATTERN = /[;&|`$<>]/;

export function evaluateCommandPolicy(
  command: string,
  args: string[],
  cwd: string,
  rootDir = process.cwd(),
): CommandPolicyDecision {
  const normalizedCommand = path.basename(command.trim());
  if (!normalizedCommand) {
    return deny("Command is required.");
  }

  try {
    assertInsideWorkspace(cwd, rootDir);
  } catch {
    return deny("Command cwd escapes workspace root.");
  }

  if (containsShellMetacharacters(command) || args.some(containsShellMetacharacters)) {
    return deny("Shell metacharacters are not allowed in automatic command execution.");
  }

  if (ALWAYS_DENIED.has(normalizedCommand)) {
    return deny(`Command is blocked by policy: ${normalizedCommand}.`);
  }

  if (normalizedCommand === "git") {
    return evaluateGit(args);
  }

  if (normalizedCommand === "npm") {
    return evaluateNpm(args);
  }

  if (READ_ONLY_COMMANDS.has(normalizedCommand)) {
    return allow(`Allowed read-only command: ${normalizedCommand}.`);
  }

  return deny(`Command requires explicit support before automatic execution: ${normalizedCommand}.`);
}

function evaluateGit(args: string[]): CommandPolicyDecision {
  const subcommand = firstNonFlagArg(args);
  const allowed = new Set([
    "branch",
    "diff",
    "log",
    "rev-parse",
    "show",
    "status",
  ]);
  if (subcommand && allowed.has(subcommand)) {
    return allow(`Allowed git inspection command: git ${subcommand}.`);
  }
  return deny(`Git command is not allowed automatically: git ${subcommand || "(none)"}.`);
}

function evaluateNpm(args: string[]): CommandPolicyDecision {
  if (args[0] !== "run" || !args[1]) {
    return deny("Only npm run <safe-script> is allowed automatically.");
  }
  const script = args[1];
  if (ALLOWED_NPM_SCRIPTS.has(script)) {
    return allow(`Allowed npm script: ${script}.`);
  }
  return deny(`npm script is not allowed automatically: ${script}.`);
}

function firstNonFlagArg(args: string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "";
}

function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHAR_PATTERN.test(value);
}

function allow(reason: string): CommandPolicyDecision {
  return { allowed: true, reason };
}

function deny(reason: string): CommandPolicyDecision {
  return { allowed: false, reason };
}
