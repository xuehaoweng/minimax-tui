import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationState, StoredConfig } from "./types.js";

export function getDataDir(): string {
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "minimax-tui")
    : path.join(os.homedir(), ".local", "share", "minimax-tui");
}

export function getSettingPath(): string {
  return path.join(os.homedir(), ".minimax-tui", "setting.json");
}

export function getSessionPath(): string {
  return path.join(getDataDir(), "session.json");
}

export async function loadStoredConfig(): Promise<StoredConfig> {
  return readJson<StoredConfig>(getSettingPath(), {});
}

export async function saveStoredConfig(config: StoredConfig): Promise<void> {
  await writeJson(getSettingPath(), config);
}

export async function loadConversationState(): Promise<ConversationState> {
  return readJson<ConversationState>(getSessionPath(), {
    messages: [],
    updatedAt: new Date(0).toISOString(),
  });
}

export async function saveConversationState(
  state: ConversationState,
): Promise<void> {
  await writeJson(getSessionPath(), state);
}

export async function clearConversationState(): Promise<void> {
  await removeFile(getSessionPath());
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
