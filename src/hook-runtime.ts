import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOOK_DIRS = ["hooks", ".minimax/hooks"];

interface HookConfig {
  preTool?: string[];
  postTool?: string[];
}

export async function runToolHooks(
  event: "preTool" | "postTool",
  context: { toolName: string; cwd: string },
): Promise<{ ok: boolean; logs: string[] }> {
  const commands = await collectHookCommands(event, context.cwd);
  if (commands.length === 0) {
    return { ok: true, logs: [] };
  }

  const logs: string[] = [];
  for (const command of commands) {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
        cwd: context.cwd,
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          MINIMAX_HOOK_EVENT: event,
          MINIMAX_TOOL_NAME: context.toolName,
        },
      });
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      logs.push(out ? `[ok] ${command}\n${out}` : `[ok] ${command}`);
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string; message?: string };
      const out = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ? `\n${error.message}` : ""}`.trim();
      logs.push(`[fail] ${command}${out ? `\n${out}` : ""}`);
      return { ok: false, logs };
    }
  }

  return { ok: true, logs };
}

async function collectHookCommands(event: "preTool" | "postTool", cwd: string): Promise<string[]> {
  const commands: string[] = [];
  for (const relative of HOOK_DIRS) {
    const dir = path.join(cwd, relative);
    const configPath = path.join(dir, "hooks.json");
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as HookConfig;
      const configured = event === "preTool" ? parsed.preTool ?? [] : parsed.postTool ?? [];
      commands.push(...configured.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0));
    } catch {
      // ignore missing or invalid config
    }

    const scriptCandidates = event === "preTool"
      ? ["pre-tool.sh", "pre_tool.sh", "pre-tool"]
      : ["post-tool.sh", "post_tool.sh", "post-tool"];
    for (const name of scriptCandidates) {
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          commands.push(full);
        }
      } catch {
        // ignore
      }
    }
  }

  return commands;
}
