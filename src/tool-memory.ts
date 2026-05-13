import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChatMessage } from "./types.js";

const TOOL_PREVIEW_LIMIT = 2048;
const MAX_TOOL_MESSAGES = 8;

function getToolResultDir(projectPath = process.cwd()): string {
  const key = Buffer.from(path.resolve(projectPath)).toString("base64url");
  return path.join(os.homedir(), ".minimax-tui", "projects", key, "tool-results");
}

async function persistToolResult(content: string, projectPath = process.cwd()): Promise<string> {
  const hash = createHash("sha1").update(content).digest("hex");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${hash.slice(0, 12)}.txt`;
  const filePath = path.join(getToolResultDir(projectPath), fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

function previewToolResult(content: string): string {
  if (content.length <= TOOL_PREVIEW_LIMIT) {
    return content;
  }
  return `${content.slice(0, TOOL_PREVIEW_LIMIT)}\n...[truncated ${content.length - TOOL_PREVIEW_LIMIT} chars]`;
}

export async function compactToolMessages(messages: ChatMessage[], projectPath = process.cwd()): Promise<ChatMessage[]> {
  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");
  const keepSet = new Set(toolIndexes.slice(-MAX_TOOL_MESSAGES).map(({ index }) => index));

  const output: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "tool") {
      output.push(message);
      continue;
    }

    const content = message.content ?? "";
    if (!keepSet.has(i)) {
      output.push({
        ...message,
        content: "[tool output compacted: older result removed from active context]",
      });
      continue;
    }

    if (content.length <= TOOL_PREVIEW_LIMIT) {
      output.push(message);
      continue;
    }

    const storedAt = await persistToolResult(content, projectPath);
    output.push({
      ...message,
      content: `${previewToolResult(content)}\n\n[full tool output stored at ${storedAt}]`,
    });
  }

  return output;
}
