import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function encodeProjectPath(projectPath: string): string {
  return Buffer.from(projectPath).toString("base64url");
}

export function getProjectMemoryPath(projectPath = process.cwd()): string {
  const key = encodeProjectPath(path.resolve(projectPath));
  return path.join(os.homedir(), ".minimax-tui", "projects", key, "memory", "MEMORY.md");
}

export async function loadProjectMemory(projectPath = process.cwd()): Promise<string> {
  const filePath = getProjectMemoryPath(projectPath);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function appendProjectMemory(note: string, projectPath = process.cwd()): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) {
    return;
  }

  const filePath = getProjectMemoryPath(projectPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n- ${trimmed.replace(/\n+/g, "\n- ")}\n`;
  await fs.appendFile(filePath, entry, "utf8");
}
