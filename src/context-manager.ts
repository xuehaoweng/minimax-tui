import type { ChatMessage } from "./types.js";

const LIGHT_KEEP_RECENT = 16;
const HEAVY_KEEP_RECENT = 8;

export interface ContextPrepareResult {
  messages: ChatMessage[];
  stage: "none" | "light" | "heavy";
  droppedCount: number;
  tokenEstimate: number;
}

export function prepareContextForRequest(
  messages: ChatMessage[],
  tokenEstimate: number,
  maxTokens = 12_000,
): ContextPrepareResult {
  if (tokenEstimate <= maxTokens) {
    return { messages, stage: "none", droppedCount: 0, tokenEstimate };
  }

  const light = applyLightCompaction(messages);
  const lightEstimate = estimateTokens(light);
  if (lightEstimate <= maxTokens) {
    return {
      messages: light,
      stage: "light",
      droppedCount: Math.max(0, messages.length - light.length),
      tokenEstimate: lightEstimate,
    };
  }

  const heavy = applyHeavyCompaction(light);
  const heavyEstimate = estimateTokens(heavy);
  return {
    messages: heavy,
    stage: "heavy",
    droppedCount: Math.max(0, messages.length - heavy.length),
    tokenEstimate: heavyEstimate,
  };
}

function applyLightCompaction(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= LIGHT_KEEP_RECENT) {
    return messages;
  }

  const split = Math.max(0, messages.length - LIGHT_KEEP_RECENT);
  const older = messages.slice(0, split);
  const recent = messages.slice(split);
  const digest = buildDigest(older, 14, 180);

  return [
    {
      role: "system",
      content: [
        "Conversation digest (light compaction):",
        digest,
      ].join("\n"),
    },
    ...recent,
  ];
}

function applyHeavyCompaction(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HEAVY_KEEP_RECENT) {
    return messages;
  }

  const split = Math.max(0, messages.length - HEAVY_KEEP_RECENT);
  const older = messages.slice(0, split);
  const recent = messages.slice(split);
  const digest = buildDigest(older, 8, 120);

  return [
    {
      role: "system",
      content: [
        "Conversation digest (heavy compaction):",
        digest,
        "Prior low-value details were dropped to fit context budget.",
      ].join("\n"),
    },
    ...recent,
  ];
}

function buildDigest(messages: ChatMessage[], maxLines: number, maxLen: number): string {
  const lines = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .map((message) => {
      const role = message.role.toUpperCase();
      const clean = message.content.replace(/\s+/g, " ").trim();
      const clipped = clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
      return `- ${role}: ${clipped || "(empty)"}`;
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "- No historical content.";
  }

  if (lines.length <= maxLines) {
    return lines.join("\n");
  }

  const head = Math.max(2, Math.floor(maxLines / 2));
  const tail = Math.max(2, maxLines - head - 1);
  return [
    ...lines.slice(0, head),
    `- ... ${lines.length - head - tail} earlier items omitted ...`,
    ...lines.slice(-tail),
  ].join("\n");
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((acc, message) => acc + Math.ceil(message.content.length / 4) + 8, 0);
}
