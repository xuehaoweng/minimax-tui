import type { AppConfig, StoredConfig } from "./types.js";
import { loadStoredConfig } from "./storage.js";

export async function readAppConfig(argv: string[]): Promise<AppConfig | null> {
  const flags = parseFlags(argv);
  const stored = await loadStoredConfig();
  const apiKey = flags["api-key"] ?? stored.apiKey ?? "";
  if (!apiKey.trim()) {
    return null;
  }

  return {
    apiKey: apiKey.trim(),
    baseUrl: normalizeBaseUrl(
      flags["base-url"] ?? stored.baseUrl ?? "https://api.minimax.io",
    ),
    model: flags.model ?? stored.model ?? "MiniMax-M2.7",
    systemPrompt: flags.system ?? stored.systemPrompt ?? "You are a helpful assistant.",
    temperature: parseNumber(flags.temperature ?? stored.temperature?.toString(), 1),
    maxTokens: parseInteger(flags["max-tokens"] ?? stored.maxTokens?.toString(), 1024),
    mode: normalizeMode(flags.mode ?? stored.mode ?? "agent") ?? "agent",
  };
}

export function parseConfigAssignment(
  key: string,
  value: string,
): Partial<StoredConfig> | null {
  const normalizedKey = normalizeConfigKey(key);
  if (!normalizedKey || !value) {
    return null;
  }

  switch (normalizedKey) {
    case "api-key":
      return { apiKey: value };
    case "base-url":
      return { baseUrl: normalizeBaseUrl(value) };
    case "model":
      return { model: value };
    case "system-prompt":
      return { systemPrompt: value };
    case "temperature":
      return Number.isFinite(Number(value)) ? { temperature: Number(value) } : null;
    case "max-tokens":
      return Number.isFinite(Number.parseInt(value, 10))
        ? { maxTokens: Number.parseInt(value, 10) }
        : null;
    case "mode":
      return normalizeMode(value) ? { mode: normalizeMode(value)! } : null;
    default:
      return null;
  }
}

export function normalizeConfigKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[_\s]/g, "-")
    .replace(/^apikey$/, "api-key")
    .replace(/^baseurl$/, "base-url")
    .replace(/^systemprompt$/, "system-prompt")
    .replace(/^maxtokens$/, "max-tokens");
}

export function normalizeMode(value: string): "chat" | "plan" | "agent" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat" || normalized === "plan" || normalized === "agent") {
    return normalized;
  }
  return null;
}

function parseFlags(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [flag, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      result[flag] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[flag] = next;
      index += 1;
    } else {
      result[flag] = "true";
    }
  }

  return result;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
