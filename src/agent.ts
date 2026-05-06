import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createChatCompletion } from "./api/minimax.js";
import { buildWorkspacePolicyPrompt, loadWorkspacePolicyContext } from "./workspace-policy.js";
import type { AppConfig, ChatMessage, ToolCall } from "./types.js";
import type { SkillManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AgentTurnResult {
  messages: ChatMessage[];
  finalText: string;
  toolCount: number;
}

export async function runAgentTurn(
  config: AppConfig,
  messages: ChatMessage[],
  skillManifests: SkillManifest[],
  signal?: AbortSignal,
): Promise<AgentTurnResult> {
  const toolDefinitions = getToolDefinitions();
  const workingMessages = [...messages];
  const workspacePolicy = await loadWorkspacePolicyContext();
  const policyPrompt = buildWorkspacePolicyPrompt(workspacePolicy);
  if (
    policyPrompt &&
    !workingMessages.some(
      (message) =>
        message.role === "system" && message.content.includes("Workspace policy from MINIMAX.md:"),
    )
  ) {
    workingMessages.unshift({
      role: "system",
      content: policyPrompt,
    });
  }
  let finalText = "";
  let toolCount = 0;

  for (let round = 0; round < 8; round += 1) {
    const response = await createChatCompletion(
      config,
      workingMessages,
      {
        tools: toolDefinitions,
        tool_choice: "auto",
      },
      signal,
    );

    const assistant = response.choices?.[0]?.message;
    if (!assistant) {
      break;
    }

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistant.content ?? "",
      toolCalls: assistant.tool_calls,
    };
    workingMessages.push(assistantMessage);
    finalText = assistant.content ?? finalText;

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      break;
    }

    for (const call of calls) {
      const toolResult = await executeToolCall(call, skillManifests);
      workingMessages.push(toolResult.message);
      toolCount += 1;
    }
  }

  return { messages: workingMessages, finalText, toolCount };
}

function getToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and folders in a workspace path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from the workspace root." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from the workspace root." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_text",
        description: "Search for text inside workspace files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path or directory to search." },
            query: { type: "string", description: "Text to search for." },
          },
          required: ["path", "query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a text file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from the workspace root." },
            content: { type: "string", description: "Text content to write." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a non-interactive shell command in the workspace.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute." },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Command arguments.",
            },
            cwd: { type: "string", description: "Workspace-relative working directory." },
            timeout_ms: {
              type: "number",
              description: "Timeout in milliseconds.",
            },
          },
          required: ["command"],
        },
      },
    },
  ];
}

async function executeToolCall(
  call: ToolCall,
  skillManifests: SkillManifest[],
): Promise<{ message: ChatMessage }> {
  const name = call.function.name;
  const args = parseToolArguments(call.function.arguments);

  switch (name) {
    case "list_dir": {
      const result = await listDirectory(toStringArg(args.path, "."));
      return makeToolMessage(call, result);
    }
    case "read_file": {
      const result = await readFileSafe(toStringArg(args.path, "."));
      return makeToolMessage(call, result);
    }
    case "search_text": {
      const result = await searchWorkspace(toStringArg(args.path, "."), toStringArg(args.query, ""));
      return makeToolMessage(call, result);
    }
    case "write_file": {
      const result = await writeWorkspaceFile(toStringArg(args.path, "."), toStringArg(args.content, ""));
      return makeToolMessage(call, result);
    }
    case "run_command": {
      const result = await runCommandTool(args);
      return makeToolMessage(call, result);
    }
    default:
      return makeToolMessage(call, `Unknown tool: ${name}`);
  }
}

async function listDirectory(relativePath: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return entries
    .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
    .join("\n");
}

async function readFileSafe(relativePath: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  return fs.readFile(resolved, "utf8");
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  return `Wrote ${relativePath}`;
}

async function searchWorkspace(relativePath: string, query: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  const results: string[] = [];
  await walkSearch(resolved, query, results);
  return results.length > 0 ? results.join("\n") : "No matches found.";
}

async function walkSearch(root: string, query: string, results: string[]): Promise<void> {
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    const text = await fs.readFile(root, "utf8").catch(() => "");
    if (text.includes(query)) {
      results.push(root);
    }
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkSearch(child, query, results);
      continue;
    }

    const text = await fs.readFile(child, "utf8").catch(() => "");
    if (text.includes(query)) {
      results.push(child);
    }
  }
}

function resolveWorkspacePath(relativePath: string): string {
  const root = process.cwd();
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root)) {
    throw new Error("Path escapes workspace root.");
  }
  return resolved;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toStringArg(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

async function runCommandTool(args: Record<string, unknown>): Promise<string> {
  await loadWorkspacePolicyContext();
  const command = toStringArg(args.command, "");
  if (!command) {
    throw new Error("Command is required.");
  }

  const commandArgs = Array.isArray(args.args)
    ? args.args.map((value) => toStringArg(value, "")).filter((value) => value.length > 0)
    : [];
  const timeoutMs = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) ? args.timeout_ms : 30_000;
  const cwd = args.cwd ? resolveWorkspacePath(toStringArg(args.cwd, ".")) : process.cwd();
  const shell = Boolean(args.shell);

  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      shell,
    });
    return formatCommandResult(command, commandArgs, cwd, 0, stdout, stderr);
  } catch (cause) {
    const error = cause as {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      message?: string;
    };
    return formatCommandResult(
      command,
      commandArgs,
      cwd,
      typeof error.code === "number" ? error.code : 1,
      error.stdout ?? "",
      `${error.stderr ?? ""}${error.message ? `\n${error.message}` : ""}`,
      error.killed ? "Command timed out or was killed." : undefined,
    );
  }
}

function formatCommandResult(
  command: string,
  args: string[],
  cwd: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  note?: string,
): string {
  const lines = [
    `Command: ${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
    `CWD: ${cwd}`,
    `Exit code: ${exitCode}`,
  ];

  if (note) {
    lines.push(`Note: ${note}`);
  }

  if (stdout.trim().length > 0) {
    lines.push("STDOUT:", limitText(stdout.trimEnd()));
  }

  if (stderr.trim().length > 0) {
    lines.push("STDERR:", limitText(stderr.trimEnd()));
  }

  if (stdout.trim().length === 0 && stderr.trim().length === 0) {
    lines.push("No output.");
  }

  return lines.join("\n");
}

function limitText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function makeToolMessage(call: ToolCall, output: string): { message: ChatMessage } {
  return {
    message: {
      role: "tool",
      name: call.function.name,
      toolCallId: call.id,
      content: output,
    },
  };
}
