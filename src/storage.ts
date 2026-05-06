import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ConversationSession,
  ConversationSessionSummary,
  ConversationState,
  ConversationStore,
  StoredConfig,
} from "./types.js";

export function getDataDir(): string {
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "minimax-tui")
    : path.join(os.homedir(), ".local", "share", "minimax-tui");
}

export function getSettingPath(): string {
  return path.join(os.homedir(), ".minimax-tui", "setting.json");
}

export function getConversationStorePath(): string {
  return path.join(getDataDir(), "sessions.json");
}

export function getLegacySessionPath(): string {
  return path.join(getDataDir(), "session.json");
}

export async function loadStoredConfig(): Promise<StoredConfig> {
  return (await readJson<StoredConfig>(getSettingPath(), {})) ?? {};
}

export async function saveStoredConfig(config: StoredConfig): Promise<void> {
  await writeJson(getSettingPath(), config);
}

export async function loadConversationStore(): Promise<ConversationStore> {
  const store = await readJson<ConversationStore | ConversationState>(getConversationStorePath(), null);
  if (store) {
    if (isConversationStore(store)) {
      return store;
    }

    return migrateLegacyState(store);
  }

  const legacy = await readJson<ConversationState>(getLegacySessionPath(), null);
  if (legacy) {
    return migrateLegacyState(legacy);
  }

  return {
    currentSessionId: "",
    sessions: [],
  };
}

export async function createConversationSession(): Promise<ConversationSession> {
  const store = await loadConversationStore();
  const session = makeConversationSession([]);
  const nextStore: ConversationStore = {
    currentSessionId: session.id,
    sessions: [session, ...store.sessions.filter((existing) => existing.id !== session.id)],
  };
  await saveConversationStore(nextStore);
  return session;
}

export async function loadConversationSession(sessionId?: string): Promise<ConversationSession | null> {
  const store = await loadConversationStore();
  if (store.sessions.length === 0) {
    return null;
  }

  const targetId = sessionId ?? store.currentSessionId ?? store.sessions[0]?.id;
  if (!targetId) {
    return null;
  }

  return store.sessions.find((session) => session.id === targetId) ?? null;
}

export async function saveConversationSession(session: ConversationSession, makeCurrent = true): Promise<void> {
  const store = await loadConversationStore();
  const nextSession = normalizeSession(session);
  const nextSessions = [nextSession, ...store.sessions.filter((existing) => existing.id !== nextSession.id)];
  await saveConversationStore({
    currentSessionId: makeCurrent ? nextSession.id : store.currentSessionId || nextSession.id,
    sessions: nextSessions,
  });
}

export async function listConversationSessions(): Promise<ConversationSessionSummary[]> {
  const store = await loadConversationStore();
  return store.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  }));
}

export async function clearConversationState(): Promise<void> {
  await removeFile(getConversationStorePath());
  await removeFile(getLegacySessionPath());
}

export async function saveConversationStore(store: ConversationStore): Promise<void> {
  await writeJson(getConversationStorePath(), store);
}

export async function resetConversationSession(sessionId: string): Promise<ConversationSession | null> {
  const store = await loadConversationStore();
  const target = store.sessions.find((session) => session.id === sessionId);
  if (!target) {
    return null;
  }

  const nextSession: ConversationSession = {
    ...target,
    title: "New session",
    updatedAt: new Date().toISOString(),
    messages: [],
  };

  await saveConversationSession(nextSession, true);
  return nextSession;
}

function makeConversationSession(messages: ConversationSession["messages"]): ConversationSession {
  const now = new Date().toISOString();
  const id = randomUUID();
  return {
    id,
    title: summarizeConversationTitle(messages),
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

function normalizeSession(session: ConversationSession): ConversationSession {
  return {
    ...session,
    title: session.title.trim() || "New session",
    messages: session.messages,
    updatedAt: new Date().toISOString(),
  };
}

function summarizeConversationTitle(messages: ConversationSession["messages"]): string {
  const firstUser = messages.find((message) => message.role === "user")?.content.trim();
  const firstMessage = firstUser ?? messages[0]?.content.trim();
  if (!firstMessage) {
    return "New session";
  }

  const normalized = firstMessage.replace(/\s+/g, " ");
  return Array.from(normalized).slice(0, 32).join("");
}

function migrateLegacyState(state: ConversationState): ConversationStore {
  const session = makeConversationSession(state.messages);
  return {
    currentSessionId: session.id,
    sessions: [session],
  };
}

function isConversationStore(value: unknown): value is ConversationStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessions" in value &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

async function readJson<T>(filePath: string, fallback: T | null): Promise<T | null> {
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
