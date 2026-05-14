import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createChatCompletion, streamChatCompletionWithTools } from "./api/minimax.js";
import { buildWorkspacePolicyPrompt, loadWorkspacePolicyContext } from "./workspace-policy.js";
import { buildWorkspaceIndexPrompt, loadWorkspaceIndexContext } from "./workspace-index.js";
import { webFetch, webSearch } from "./workspace-web.js";
import { runToolHooks } from "./hook-runtime.js";
import { callMcpTool, listMcpTools } from "./mcp-runtime.js";
import { evaluateCommandPolicy } from "./command-policy.js";
import {
  isIgnoredWorkspaceEntry,
  readTextFileLimited,
  readTextFileLimitedOrEmpty,
  resolveWorkspacePath,
} from "./workspace-paths.js";
import type { AppConfig, ChatMessage, ToolCall } from "./types.js";
import type { SkillManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AgentTurnResult {
  messages: ChatMessage[];
  finalText: string;
  toolCount: number;
}

export interface AgentTurnOptions {
  allowSubagents?: boolean;
  readOnly?: boolean;
  activePluginNames?: string[];
}

export async function runAgentTurn(
  config: AppConfig,
  messages: ChatMessage[],
  skillManifests: SkillManifest[],
  signal?: AbortSignal,
  options: AgentTurnOptions = {},
): Promise<AgentTurnResult> {
  const toolDefinitions = getToolDefinitions(options);
  const workingMessages = [...messages];
  const workspacePolicy = await loadWorkspacePolicyContext();
  const workspaceIndex = await loadWorkspaceIndexContext();
  const policyPrompt = buildWorkspacePolicyPrompt(workspacePolicy);
  const indexPrompt = buildWorkspaceIndexPrompt(workspaceIndex);
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
  if (
    indexPrompt &&
    !workingMessages.some(
      (message) =>
        message.role === "system" && message.content.includes("Workspace code index:"),
    )
  ) {
    workingMessages.unshift({
      role: "system",
      content: indexPrompt,
    });
  }
  let finalText = "";
  let toolCount = 0;

  for (let round = 0; round < 8; round += 1) {
    const inFlightToolRuns = new Map<string, Promise<{ message: ChatMessage }>>();
    const streamed = await streamChatCompletionWithTools(
      config,
      workingMessages,
      {
        tools: toolDefinitions,
        tool_choice: "auto",
      },
      {
        onToolCall: (call) => {
          if (inFlightToolRuns.has(call.id)) {
            return;
          }
          const promise = executeToolCall(call, config, skillManifests, signal, options);
          inFlightToolRuns.set(call.id, promise);
        },
      },
      signal,
    );

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: streamed.content ?? "",
      reasoningContent: streamed.reasoningContent || undefined,
      reasoningSignature: streamed.reasoningSignature,
      toolCalls: streamed.toolCalls,
    };
    workingMessages.push(assistantMessage);
    finalText = streamed.content ?? finalText;

    const calls = streamed.toolCalls ?? [];
    const latestUserQuery =
      [...workingMessages]
        .reverse()
        .find((message) => message.role === "user")
        ?.content
        ?.trim() ?? "";
    const fallbackCalls = calls.length === 0
      ? [
        ...parseInlineSendBlocks(streamed.content ?? ""),
        ...parseMiniMaxToolCallBlocks(streamed.content ?? "", latestUserQuery),
      ]
      : [];
    const allCalls = [...calls, ...fallbackCalls];
    if (allCalls.length === 0) {
      break;
    }

    for (const call of allCalls) {
      const toolResult = inFlightToolRuns.get(call.id)
        ? await inFlightToolRuns.get(call.id)!
        : await executeToolCall(call, config, skillManifests, signal, options);
      workingMessages.push(toolResult.message);
      toolCount += 1;
    }
  }

  if (!finalText.trim()) {
    const fallback = await createChatCompletion(
      config,
      [
        ...workingMessages,
        {
          role: "system",
          content: "Provide a direct final answer for the user based on the available tool outputs. Do not call tools.",
        },
      ],
      {},
      signal,
    );
    const content = fallback.choices?.[0]?.message?.content ?? "";
    if (content.trim()) {
      workingMessages.push({
        role: "assistant",
        content,
      });
      finalText = content;
    }
  }

  if (!finalText.trim()) {
    finalText = "I could not produce a final response this turn. Please retry with a more specific request.";
    workingMessages.push({
      role: "assistant",
      content: finalText,
    });
  }

  return { messages: workingMessages, finalText, toolCount };
}

function getToolDefinitions(options: AgentTurnOptions): Array<Record<string, unknown>> {
  const readOnly = options.readOnly === true;
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read primitive: list files, glob files, read a file, or grep text in workspace.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["list", "glob", "file", "grep"] },
            path: { type: "string", description: "Relative path. Defaults to workspace root." },
            pattern: { type: "string", description: "Glob pattern when kind=glob." },
            query: { type: "string", description: "Search query when kind=grep." },
          },
          required: ["kind"],
        },
      },
    },
  ];

  if (!readOnly) {
    tools.push(
      {
        type: "function",
        function: {
          name: "write",
          description: "Write primitive: create a UTF-8 text file in workspace. Existing files return a unified diff preview instead of overwriting.",
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
          name: "apply_patch",
          description: "Apply a single-file unified text patch in workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path from the workspace root." },
              patch: { type: "string", description: "Unified diff patch to apply." },
            },
            required: ["path", "patch"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "execute",
          description: "Execute primitive: run non-interactive command in workspace.",
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
      {
        type: "function",
        function: {
          name: "connect",
          description: "Connect primitive: access external sources such as web search/fetch.",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["web_search", "web_fetch"] },
              query: { type: "string", description: "Search query when kind=web_search." },
              url: { type: "string", description: "URL when kind=web_fetch." },
              server: { type: "string", description: "MCP server name when kind=mcp_call_tool." },
              tool: { type: "string", description: "MCP tool name when kind=mcp_call_tool." },
              arguments: { type: "object", description: "MCP tool arguments when kind=mcp_call_tool." },
            },
            required: ["kind"],
          },
        },
      },
    );
  }

  if (!readOnly && options.allowSubagents !== false) {
    tools.push({
      type: "function",
      function: {
        name: "spawn_subagent",
        description: "Delegate a focused task to a subagent.",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "Task goal for the subagent." },
            context: { type: "string", description: "Optional extra context for the subagent." },
          },
          required: ["goal"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "spawn_subagents",
        description: "Run multiple subagent tasks in parallel; failures are isolated per task.",
        parameters: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  goal: { type: "string" },
                  context: { type: "string" },
                },
                required: ["goal"],
              },
            },
          },
          required: ["tasks"],
        },
      },
    });
  }

  return tools;
}

async function executeToolCall(
  call: ToolCall,
  config: AppConfig,
  skillManifests: SkillManifest[],
  signal?: AbortSignal,
  options: AgentTurnOptions = {},
): Promise<{ message: ChatMessage }> {
  const name = call.function.name;
  const args = parseToolArguments(call.function.arguments);
  const preHook = await runToolHooks("preTool", { toolName: name, cwd: process.cwd() });
  if (!preHook.ok) {
    return makeToolMessage(call, `Hook blocked tool execution.\n${preHook.logs.join("\n")}`);
  }

  let output = "";
  switch (name) {
  case "read":
    output = await readPrimitive(args);
    break;
  case "write":
    if (options.readOnly) {
      output = "write is disabled in read-only mode.";
      break;
    }
    output = await writeWorkspaceFile(toStringArg(args.path, "."), toStringArg(args.content, ""));
    break;
  case "apply_patch":
    if (options.readOnly) {
      output = "apply_patch is disabled in read-only mode.";
      break;
    }
    output = await applyWorkspacePatch(toStringArg(args.path, "."), toStringArg(args.patch, ""));
    break;
  case "execute":
    if (options.readOnly) {
      output = "execute is disabled in read-only mode.";
      break;
    }
    output = await runCommandTool(args);
    break;
  case "connect":
    if (options.readOnly) {
      output = "connect is disabled in read-only mode.";
      break;
    }
    output = await connectPrimitive(args, options.activePluginNames ?? []);
    break;
  case "spawn_subagent":
    if (options.readOnly) {
      output = "spawn_subagent is disabled in read-only mode.";
      break;
    }
    if (options.allowSubagents === false) {
      output = "Subagents are disabled in this context.";
      break;
    }
    output = await runSubagentTask(config, args, skillManifests, signal);
    break;
  case "spawn_subagents":
    if (options.readOnly) {
      output = "spawn_subagents is disabled in read-only mode.";
      break;
    }
    if (options.allowSubagents === false) {
      output = "Subagents are disabled in this context.";
      break;
    }
    output = await runSubagentTasks(config, args, skillManifests, signal);
    break;
  default:
    output = `Unknown tool: ${name}`;
    break;
  }

  const postHook = await runToolHooks("postTool", { toolName: name, cwd: process.cwd() });
  if (postHook.logs.length > 0) {
    output = `${output}\n\n[hooks]\n${postHook.logs.join("\n")}`;
  }
  return makeToolMessage(call, output);
}

async function readPrimitive(args: Record<string, unknown>): Promise<string> {
  const kind = toStringArg(args.kind, "list");
  const relativePath = toStringArg(args.path, ".");
  if (kind === "list") {
    return listDirectory(relativePath);
  }
  if (kind === "glob") {
    return globFiles(toStringArg(args.pattern, ""), relativePath);
  }
  if (kind === "file") {
    return readFileSafe(relativePath);
  }
  if (kind === "grep") {
    return searchWorkspace(relativePath, toStringArg(args.query, ""));
  }
  return `Unsupported read kind: ${kind}`;
}

async function connectPrimitive(args: Record<string, unknown>, activePluginNames: string[]): Promise<string> {
  let kind = toStringArg(args.kind, "");
  if (!kind) {
    const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
    const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
    const hasMcp = typeof args.server === "string" && args.server.trim().length > 0
      && typeof args.tool === "string" && args.tool.trim().length > 0;
    if (hasMcp) {
      kind = "mcp_call_tool";
    } else if (hasUrl) {
      kind = "web_fetch";
    } else if (hasQuery) {
      kind = "web_search";
    }
  }

  if (kind === "web_search") {
    const query = toStringArg(args.query, "");
    if (!query.trim()) {
      return "web_search requires a non-empty query.";
    }
    return webSearch(query);
  }
  if (kind === "web_fetch") {
    const url = toStringArg(args.url, "");
    if (!url.trim()) {
      return "web_fetch requires a non-empty url.";
    }
    return webFetch(url);
  }
  if (kind === "mcp_list_tools") {
    return listMcpTools(activePluginNames);
  }
  if (kind === "mcp_call_tool") {
    return callMcpTool(
      toStringArg(args.server, ""),
      toStringArg(args.tool, ""),
      (typeof args.arguments === "object" && args.arguments !== null ? args.arguments : {}) as Record<string, unknown>,
      activePluginNames,
    );
  }
  return `Unsupported connect kind: ${kind || "(empty)"}. Use one of: web_search, web_fetch, mcp_list_tools, mcp_call_tool.`;
}

async function globFiles(pattern: string, relativePath: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const globPattern = pattern.trim();
  if (!globPattern) {
    return "Pattern is required.";
  }

  const cwd = resolveWorkspacePath(relativePath || ".");
  try {
    const { stdout } = await execFileAsync("rg", ["--files", "-g", globPattern], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : "No files matched.";
  } catch {
    return "No files matched.";
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
  return readTextFileLimited(resolved);
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  const existing = await readTextFileLimited(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (existing !== undefined) {
    const patch = createUnifiedDiff(relativePath, existing, content);
    return [
      `Refused to overwrite existing file: ${relativePath}`,
      "Preview the unified diff below. Call apply_patch with this path and patch to apply it.",
      "",
      patch,
    ].join("\n");
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  return `Wrote ${relativePath}`;
}

async function applyWorkspacePatch(relativePath: string, patch: string): Promise<string> {
  await loadWorkspacePolicyContext();
  const resolved = resolveWorkspacePath(relativePath);
  if (!patch.trim()) {
    return "Invalid patch: patch is empty.";
  }

  const current = await readTextFileLimited(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`Cannot apply patch: file does not exist: ${relativePath}`);
    }
    throw error;
  });
  const result = applyUnifiedPatchToText(current, patch);
  if (!result.ok) {
    return result.message;
  }

  await fs.writeFile(resolved, result.text, "utf8");
  return `Applied patch to ${relativePath}`;
}

function createUnifiedDiff(relativePath: string, oldText: string, newText: string): string {
  const oldLines = splitPatchLines(oldText);
  const newLines = splitPatchLines(newText);
  const lines = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  for (const line of oldLines) {
    lines.push(`-${line.text}`);
    if (line.noNewline) {
      lines.push("\\ No newline at end of file");
    }
  }
  for (const line of newLines) {
    lines.push(`+${line.text}`);
    if (line.noNewline) {
      lines.push("\\ No newline at end of file");
    }
  }

  return lines.join("\n");
}

type PatchTextLine = {
  text: string;
  noNewline: boolean;
};

type PatchApplyResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

function applyUnifiedPatchToText(currentText: string, patch: string): PatchApplyResult {
  const patchLines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  if (patchLines[index]?.startsWith("--- ")) {
    index += 1;
  }
  if (patchLines[index]?.startsWith("+++ ")) {
    index += 1;
  }

  const currentLines = splitPatchLines(currentText);
  const output: PatchTextLine[] = [];
  let currentIndex = 0;
  let appliedHunks = 0;

  while (index < patchLines.length) {
    const header = patchLines[index];
    if (header === "") {
      index += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) {
      return { ok: false, message: `Invalid patch: expected hunk header at line ${index + 1}.` };
    }
    index += 1;
    appliedHunks += 1;

    const oldStart = Number.parseInt(match[1], 10);
    if (!Number.isFinite(oldStart) || oldStart < 1) {
      return { ok: false, message: `Invalid patch: invalid hunk start at line ${index}.` };
    }

    const targetIndex = oldStart - 1;
    if (targetIndex < currentIndex || targetIndex > currentLines.length) {
      return { ok: false, message: `Patch mismatch: hunk starts outside current file at line ${oldStart}.` };
    }
    output.push(...currentLines.slice(currentIndex, targetIndex));
    currentIndex = targetIndex;
    let lastOutputLineForMarker: PatchTextLine | undefined;

    while (index < patchLines.length && !patchLines[index].startsWith("@@ ")) {
      const raw = patchLines[index];
      if (raw === "\\ No newline at end of file") {
        if (lastOutputLineForMarker) {
          lastOutputLineForMarker.noNewline = true;
        }
        index += 1;
        continue;
      }
      if (raw.length === 0) {
        return { ok: false, message: `Invalid patch: empty patch line at line ${index + 1}.` };
      }

      const op = raw[0];
      const text = raw.slice(1);
      if (op === " ") {
        if (!samePatchLine(currentLines[currentIndex], text)) {
          return { ok: false, message: `Patch mismatch: context did not match at file line ${currentIndex + 1}.` };
        }
        lastOutputLineForMarker = { ...currentLines[currentIndex], noNewline: false };
        output.push(lastOutputLineForMarker);
        currentIndex += 1;
      } else if (op === "-") {
        if (!samePatchLine(currentLines[currentIndex], text)) {
          return { ok: false, message: `Patch mismatch: removal did not match at file line ${currentIndex + 1}.` };
        }
        lastOutputLineForMarker = undefined;
        currentIndex += 1;
      } else if (op === "+") {
        lastOutputLineForMarker = { text, noNewline: false };
        output.push(lastOutputLineForMarker);
      } else {
        return { ok: false, message: `Invalid patch: unsupported line prefix "${op}" at line ${index + 1}.` };
      }
      index += 1;
    }
  }

  if (appliedHunks === 0) {
    return { ok: false, message: "Invalid patch: no hunks found." };
  }

  output.push(...currentLines.slice(currentIndex));
  return { ok: true, text: joinPatchLines(output) };
}

function splitPatchLines(text: string): PatchTextLine[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  const rawLines = normalized.split("\n");
  const endsWithNewline = normalized.endsWith("\n");
  if (endsWithNewline) {
    rawLines.pop();
  }

  return rawLines.map((line, index) => ({
    text: line,
    noNewline: !endsWithNewline && index === rawLines.length - 1,
  }));
}

function joinPatchLines(lines: PatchTextLine[]): string {
  if (lines.length === 0) {
    return "";
  }

  return lines.map((line) => line.text).join("\n") + (lines.at(-1)?.noNewline ? "" : "\n");
}

function samePatchLine(line: PatchTextLine | undefined, text: string): boolean {
  return line !== undefined && line.text === text;
}

async function searchWorkspace(relativePath: string, query: string): Promise<string> {
  await loadWorkspacePolicyContext();
  if (!query.trim()) {
    return "grep query is required.";
  }
  const resolved = resolveWorkspacePath(relativePath);
  const results: string[] = [];
  await walkSearch(resolved, query, results);
  return results.length > 0 ? results.join("\n") : "No matches found.";
}

async function walkSearch(root: string, query: string, results: string[]): Promise<void> {
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    const text = await readTextFileLimitedOrEmpty(root);
    if (text.includes(query)) {
      results.push(root);
    }
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && isIgnoredWorkspaceEntry(entry.name)) {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkSearch(child, query, results);
      continue;
    }

    const text = await readTextFileLimitedOrEmpty(child);
    if (text.includes(query)) {
      results.push(child);
    }
  }
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
  const policy = evaluateCommandPolicy(command, commandArgs, cwd);
  if (!policy.allowed) {
    return [
      "Command blocked by policy.",
      `Reason: ${policy.reason}`,
      `Command: ${command}${commandArgs.length > 0 ? ` ${commandArgs.join(" ")}` : ""}`,
      "Use a supported inspection/build/test command or ask the user to run this manually.",
    ].join("\n");
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      shell: false,
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

async function runSubagentTask(
  config: AppConfig,
  args: Record<string, unknown>,
  skillManifests: SkillManifest[],
  signal?: AbortSignal,
): Promise<string> {
  const goal = toStringArg(args.goal, "");
  if (!goal) {
    throw new Error("Goal is required.");
  }

  const context = toStringArg(args.context, "");
  const planResponse = await createChatCompletion(
    config,
    [
      {
        role: "system",
        content: [
          "You are the planning stage of a delegated subagent inside minimax-tui.",
          "Return a concise implementation plan only.",
          "Use 3 to 5 bullet points.",
          "Do not use tools.",
          "Do not mention hidden reasoning.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          context ? `Context: ${context}` : "",
        ].filter(Boolean).join("\n"),
      },
    ],
    {},
    signal,
  );

  const planText = sanitizeSubagentSection(planResponse.choices?.[0]?.message?.content ?? "");
  const executionMessages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the execution stage of a delegated subagent inside minimax-tui.",
        "Follow the plan and use the available tools to complete the task.",
        "Do not spawn further subagents.",
        "Return concise updates and a compact final answer.",
        "Do not spawn further subagents.",
      ].join(" "),
    },
    {
      role: "system",
      content: `Plan:\n${planText || "(no plan provided)"}`,
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        context ? `Context: ${context}` : "",
      ].filter(Boolean).join("\n"),
    },
  ];

  const result = await runAgentTurn(config, executionMessages, skillManifests, signal, {
    allowSubagents: false,
  });

  const reportResponse = await createChatCompletion(
    config,
    [
      {
        role: "system",
        content: [
          "You are the reporting stage of a delegated subagent inside minimax-tui.",
          "Summarize the outcome in 3 concise bullets.",
          "Do not mention hidden reasoning.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Plan:\n${planText || "(no plan provided)"}`,
          `Execution final:\n${result.finalText || "(no final text)"}`,
          `Tools used: ${result.toolCount}`,
        ].join("\n\n"),
      },
    ],
    {},
    signal,
  );

  const reportText = sanitizeSubagentSection(reportResponse.choices?.[0]?.message?.content ?? "");
  return [
    "TASK STATUS: done",
    `GOAL: ${goal}`,
    "PLAN:",
    planText || "(no plan provided)",
    "EXECUTION:",
    `Tools used: ${result.toolCount}`,
    result.finalText ? `Final: ${result.finalText}` : "Final: (no final text)",
    "REPORT:",
    reportText || "(no report provided)",
  ].join("\n");
}

async function runSubagentTasks(
  config: AppConfig,
  args: Record<string, unknown>,
  skillManifests: SkillManifest[],
  signal?: AbortSignal,
): Promise<string> {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 0) {
    return "No tasks provided.";
  }

  const work = tasks.map(async (item, index) => {
    const payload = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const goal = toStringArg(payload.goal, "");
    const context = toStringArg(payload.context, "");
    if (!goal) {
      return { index, ok: false, output: "Missing goal." };
    }
    try {
      const output = await runSubagentTask(config, { goal, context }, skillManifests, signal);
      return { index, ok: true, output };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { index, ok: false, output: message };
    }
  });

  const results = await Promise.all(work);
  return results
    .map((result) => {
      const status = result.ok ? "done" : "failed";
      return `TASK ${result.index + 1} [${status}]\n${result.output}`;
    })
    .join("\n\n");
}

function sanitizeSubagentSection(text: string): string {
  return text.replace(/\r/g, "").trim();
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

function parseInlineSendBlocks(content: string): ToolCall[] {
  const text = content.trim();
  if (!text) {
    return [];
  }
  const blocks = Array.from(text.matchAll(/<send>([\s\S]*?)<\/send>/gi));
  const calls: ToolCall[] = [];
  for (const block of blocks) {
    const body = block[1] ?? "";
    const kind = extractKv(body, "kind");
    if (!kind) {
      continue;
    }
    const args: Record<string, unknown> = { kind };
    const query = extractKv(body, "query");
    const url = extractKv(body, "url");
    const server = extractKv(body, "server");
    const tool = extractKv(body, "tool");
    if (query) args.query = query;
    if (url) args.url = url;
    if (server) args.server = server;
    if (tool) args.tool = tool;
    calls.push({
      id: `inline_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: {
        name: "connect",
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

function extractKv(text: string, key: string): string {
  const pattern = new RegExp(`${key}\\s*=\\s*(.+)`, "i");
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => pattern.test(value));
  if (!line) {
    return "";
  }
  const match = line.match(pattern);
  return (match?.[1] ?? "").trim();
}

function parseMiniMaxToolCallBlocks(content: string, fallbackUserQuery: string): ToolCall[] {
  const text = content.trim();
  if (!text) {
    return [];
  }
  const blocks = Array.from(text.matchAll(/<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/gi));
  const calls: ToolCall[] = [];
  for (const block of blocks) {
    const body = block[1] ?? "";
    const invokeMatch = body.match(/<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/i);
    if (!invokeMatch) {
      continue;
    }
    const toolName = (invokeMatch[1] ?? "").trim();
    const parameterBody = invokeMatch[2] ?? "";
    if (!toolName) {
      continue;
    }

    const args: Record<string, unknown> = {};
    const parameterMatches = Array.from(parameterBody.matchAll(/<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi));
    for (const parameter of parameterMatches) {
      const key = (parameter[1] ?? "").trim();
      const value = (parameter[2] ?? "").trim();
      if (!key) {
        continue;
      }
      args[key] = value;
    }
    if (toolName === "connect" && args.kind === "web_search" && typeof args.query !== "string") {
      if (fallbackUserQuery.trim()) {
        args.query = fallbackUserQuery;
      }
    }

    calls.push({
      id: `xml_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}
