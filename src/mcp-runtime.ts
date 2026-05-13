import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export async function listMcpTools(activePluginNames: string[] = []): Promise<string> {
  const servers = await loadMcpServers(activePluginNames);
  const names = Object.keys(servers);
  if (names.length === 0) {
    return "No MCP servers configured.";
  }

  const lines: string[] = [];
  for (const name of names) {
    try {
      const result = await mcpRequest(servers[name], "tools/list", {});
      const tools = Array.isArray((result as { tools?: unknown[] }).tools) ? (result as { tools?: Array<{ name?: string }> }).tools : [];
      const toolNames = tools?.map((tool) => tool.name ?? "(unnamed)").join(", ") || "(none)";
      lines.push(`${name}: ${toolNames}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      lines.push(`${name}: [error] ${message}`);
    }
  }
  return lines.join("\n");
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  activePluginNames: string[] = [],
): Promise<string> {
  const servers = await loadMcpServers(activePluginNames);
  const server = servers[serverName];
  if (!server) {
    return `MCP server not found: ${serverName}`;
  }

  const result = await mcpRequest(server, "tools/call", {
    name: toolName,
    arguments: args,
  });
  return JSON.stringify(result, null, 2);
}

async function loadMcpServers(activePluginNames: string[]): Promise<Record<string, McpServerConfig>> {
  const merged: Record<string, McpServerConfig> = {};
  const workspaceConfigs = [path.join(process.cwd(), ".mcp.json"), path.join(process.cwd(), "mcp.json")];
  for (const configPath of workspaceConfigs) {
    Object.assign(merged, await readMcpConfig(configPath));
  }

  const pluginRoot = path.join(os.homedir(), ".minimax-tui", "plugins");
  for (const plugin of activePluginNames) {
    const normalized = plugin.toLowerCase();
    const pluginConfigs = [
      path.join(pluginRoot, normalized, ".mcp.json"),
      path.join(pluginRoot, normalized, "mcp.json"),
    ];
    for (const configPath of pluginConfigs) {
      Object.assign(merged, await readMcpConfig(configPath));
    }
  }

  return merged;
}

async function readMcpConfig(filePath: string): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

async function mcpRequest(config: McpServerConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (config.url) {
    return mcpHttpRequest(config, method, params);
  }
  if (config.command) {
    return mcpStdioRequest(config, method, params);
  }
  throw new Error("Invalid MCP server config: requires url or command");
}

async function mcpHttpRequest(config: McpServerConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(config.url!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) {
    throw new Error(json.error.message ?? "MCP request failed");
  }
  return json.result;
}

async function mcpStdioRequest(config: McpServerConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command!, config.args ?? [], {
      cwd: process.cwd(),
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let nextId = 1;
    let stage: "init" | "call" = "init";

    const send = (id: number, m: string, p: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p })}\n`);
    };

    const onLine = (line: string) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return;
      }
      if (typeof msg.id !== "number") {
        return;
      }

      if (msg.error) {
        child.kill();
        reject(new Error(msg.error.message ?? "MCP stdio error"));
        return;
      }

      if (stage === "init" && msg.id === 1) {
        stage = "call";
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
        nextId = 2;
        send(nextId, method, params);
        return;
      }

      if (stage === "call" && msg.id === nextId) {
        resolve(msg.result);
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          onLine(line.trim());
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code !== 0 && stage !== "call") {
        reject(new Error(`MCP process exited with ${code}: ${stderr.trim()}`));
      }
    });

    send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "minimax-tui", version: "0.1.0" },
    });
  });
}
