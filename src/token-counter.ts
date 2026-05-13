import type { AppConfig, ChatMessage } from "./types.js";

interface AnthropicCountResponse {
  input_tokens?: number;
}

export async function countContextTokens(
  config: AppConfig,
  messages: ChatMessage[],
): Promise<{ tokens: number; source: "provider" | "estimate" }> {
  if (isAnthropicBaseUrl(config.baseUrl)) {
    try {
      const response = await fetch(buildApiUrl(config.baseUrl, "v1/messages/count_tokens"), {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
          messages: toAnthropicMessages(messages),
        }),
      });
      if (response.ok) {
        const json = (await response.json()) as AnthropicCountResponse;
        if (typeof json.input_tokens === "number" && Number.isFinite(json.input_tokens)) {
          return { tokens: json.input_tokens, source: "provider" };
        }
      }
    } catch {
      // fallback to estimate
    }
  }

  return { tokens: estimateTokens(messages), source: "estimate" };
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const text = message.content ?? "";
    total += Math.ceil(text.length / 4) + 8;
    if (message.toolCalls?.length) {
      total += message.toolCalls.length * 24;
    }
  }
  return total;
}

function isAnthropicBaseUrl(baseUrl: string): boolean {
  return /anthropic/i.test(baseUrl);
}

function buildApiUrl(baseUrl: string, endpointPath: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = endpointPath.startsWith("/") ? endpointPath.slice(1) : endpointPath;
  return new URL(normalizedPath, normalizedBase);
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const mapped = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "assistant") {
        return { role: "assistant" as const, content: message.content };
      }
      if (message.role === "tool") {
        return { role: "user" as const, content: `[tool:${message.name ?? "unknown"}]\n${message.content}` };
      }
      return { role: "user" as const, content: message.content };
    });

  const compacted: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of mapped) {
    const prev = compacted[compacted.length - 1];
    if (prev && prev.role === item.role) {
      prev.content = `${prev.content}\n\n${item.content}`.trim();
    } else {
      compacted.push(item);
    }
  }
  return compacted;
}
