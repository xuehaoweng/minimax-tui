import type { AppConfig, ChatMessage, ToolCall } from "../types.js";

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
      role?: string;
    };
  }>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface StreamToolCallbacks {
  onText?: (token: string) => void;
  onReasoning?: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
}

export async function streamChatCompletion(
  config: AppConfig,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onReasoning?: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const anthropicMode = isAnthropicBaseUrl(config.baseUrl);
  const response = anthropicMode
    ? await fetch(buildApiUrl(config.baseUrl, "v1/messages"), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        system: collectSystemPrompt(messages),
        messages: toAnthropicMessages(messages),
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
      signal,
    })
    : await fetch(buildApiUrl(config.baseUrl, "v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
      signal,
    });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const json = (await response.json()) as ChatCompletionChunk;
    const token = json.choices?.[0]?.message?.content ?? "";
    if (token) {
      onToken(token);
    }
    return;
  }

  if (!response.body) {
    throw new Error("MiniMax returned an empty response body.");
  }

  for await (const event of readSseEvents(response.body)) {
    if (event === "[DONE]") {
      break;
    }

    if (anthropicMode) {
      const payload = JSON.parse(event) as {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
      const textToken = payload.delta?.text ?? "";
      if (textToken) {
        onToken(textToken);
      }
      const reasoningToken = payload.delta?.thinking ?? "";
      if (reasoningToken && onReasoning) {
        onReasoning(reasoningToken);
      }
    } else {
      const payload = JSON.parse(event) as ChatCompletionChunk;
      const choice = payload.choices?.[0];
      const reasoningToken = choice?.delta?.reasoning_content ?? "";
      if (reasoningToken && onReasoning) {
        onReasoning(reasoningToken);
      }
      const token = choice?.delta?.content ?? choice?.message?.content ?? "";
      if (token) {
        onToken(token);
      }
    }
  }
}

export async function streamChatCompletionWithTools(
  config: AppConfig,
  messages: ChatMessage[],
  extraBody: Record<string, unknown>,
  callbacks: StreamToolCallbacks = {},
  signal?: AbortSignal,
): Promise<{ content: string; reasoningContent: string; reasoningSignature?: string; toolCalls: ToolCall[] }> {
  const anthropicMode = isAnthropicBaseUrl(config.baseUrl);
  const anthropicTools = anthropicMode ? mapAnthropicTools(extraBody.tools) : [];
  const anthropicToolChoice = anthropicMode ? mapAnthropicToolChoice(extraBody.tool_choice) : undefined;

  const response = anthropicMode
    ? await fetch(buildApiUrl(config.baseUrl, "v1/messages"), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        system: collectSystemPrompt(messages),
        messages: toAnthropicMessages(messages),
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
      }),
      signal,
    })
    : await fetch(buildApiUrl(config.baseUrl, "v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...extraBody,
      }),
      signal,
    });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  if (!response.body) {
    throw new Error("MiniMax returned an empty response body.");
  }

  let content = "";
  let reasoningContent = "";
  let reasoningSignature: string | undefined;
  const toolCalls: ToolCall[] = [];
  const seenToolCalls = new Set<string>();
  const openaiToolCalls = new Map<number, { id: string; name: string; args: string }>();

  for await (const event of readSseEvents(response.body)) {
    if (event === "[DONE]") {
      break;
    }
    const payload = JSON.parse(event) as Record<string, unknown>;
    if (anthropicMode) {
      const type = typeof payload.type === "string" ? payload.type : "";
      if (type === "content_block_delta") {
        const delta = (payload.delta ?? {}) as { text?: string; thinking?: string; signature?: string };
        if (delta.text) {
          content += delta.text;
          callbacks.onText?.(delta.text);
        }
        if (delta.thinking) {
          reasoningContent += delta.thinking;
          callbacks.onReasoning?.(delta.thinking);
        }
        if (delta.signature) {
          reasoningSignature = delta.signature;
        }
      }
      if (type === "content_block_start") {
        const block = (payload.content_block ?? {}) as AnthropicContentBlock;
        if (block.type === "thinking") {
          if (typeof block.thinking === "string") {
            reasoningContent = block.thinking;
          }
          if (typeof block.signature === "string") {
            reasoningSignature = block.signature;
          }
        }
        if (block.type === "tool_use" && block.name) {
          const call: ToolCall = {
            id: block.id ?? cryptoRandomId(),
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          };
          toolCalls.push(call);
          if (!seenToolCalls.has(call.id)) {
            seenToolCalls.add(call.id);
            callbacks.onToolCall?.(call);
          }
        }
      }
      continue;
    }

    const chunk = payload as ChatCompletionChunk & {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
          content?: string;
          reasoning_content?: string;
        };
      }>;
    };
    const choice = chunk.choices?.[0];
    const textToken = choice?.delta?.content ?? "";
    if (textToken) {
      content += textToken;
      callbacks.onText?.(textToken);
    }
    const reasoning = choice?.delta?.reasoning_content ?? "";
    if (reasoning) {
      callbacks.onReasoning?.(reasoning);
    }
    const deltaToolCalls = choice?.delta?.tool_calls ?? [];
    for (const deltaCall of deltaToolCalls) {
      const idx = typeof deltaCall.index === "number" ? deltaCall.index : 0;
      const existing = openaiToolCalls.get(idx) ?? {
        id: deltaCall.id ?? cryptoRandomId(),
        name: "",
        args: "",
      };
      if (deltaCall.id) {
        existing.id = deltaCall.id;
      }
      if (deltaCall.function?.name) {
        existing.name = deltaCall.function.name;
      }
      if (deltaCall.function?.arguments) {
        existing.args += deltaCall.function.arguments;
      }
      openaiToolCalls.set(idx, existing);
      if (existing.name && isLikelyCompleteJson(existing.args) && !seenToolCalls.has(existing.id)) {
        const call: ToolCall = {
          id: existing.id,
          type: "function",
          function: {
            name: existing.name,
            arguments: existing.args,
          },
        };
        toolCalls.push(call);
        seenToolCalls.add(call.id);
        callbacks.onToolCall?.(call);
      }
    }
  }

  if (!anthropicMode) {
    for (const existing of openaiToolCalls.values()) {
      if (!existing.name) {
        continue;
      }
      if (seenToolCalls.has(existing.id)) {
        continue;
      }
      toolCalls.push({
        id: existing.id,
        type: "function",
        function: { name: existing.name, arguments: existing.args || "{}" },
      });
    }
  }

  return { content, reasoningContent, reasoningSignature, toolCalls };
}

export async function createChatCompletion(
  config: AppConfig,
  messages: ChatMessage[],
  extraBody: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const anthropicMode = isAnthropicBaseUrl(config.baseUrl);
  const anthropicTools = anthropicMode ? mapAnthropicTools(extraBody.tools) : [];
  const anthropicToolChoice = anthropicMode ? mapAnthropicToolChoice(extraBody.tool_choice) : undefined;

  const response = anthropicMode
    ? await fetch(buildApiUrl(config.baseUrl, "v1/messages"), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        system: collectSystemPrompt(messages),
        messages: toAnthropicMessages(messages),
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
      }),
      signal,
    })
    : await fetch(buildApiUrl(config.baseUrl, "v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...extraBody,
      }),
      signal,
    });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  if (!anthropicMode) {
    return (await response.json()) as ChatCompletionResponse;
  }

  const json = (await response.json()) as AnthropicResponse;
  const thinkingBlocks = (json.content ?? []).filter(
    (part): part is AnthropicContentBlock => part.type === "thinking" && typeof part.thinking === "string",
  );
  const content = (json.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
  const reasoningContent = thinkingBlocks.map((part) => part.thinking ?? "").join("");
  const toolCalls: ToolCall[] = (json.content ?? [])
    .filter((part) => part.type === "tool_use" && typeof part.name === "string")
    .map((part) => ({
      id: part.id ?? cryptoRandomId(),
      type: "function" as const,
      function: {
        name: part.name ?? "",
        arguments: JSON.stringify(part.input ?? {}),
      },
    }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function isAnthropicBaseUrl(baseUrl: string): boolean {
  return /anthropic/i.test(baseUrl);
}

function buildApiUrl(baseUrl: string, endpointPath: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = endpointPath.startsWith("/") ? endpointPath.slice(1) : endpointPath;
  return new URL(normalizedPath, normalizedBase);
}

function collectSystemPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const compacted: AnthropicMessage[] = [];
  const append = (role: "user" | "assistant", blocks: AnthropicContentBlock[]) => {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.role === role) {
      previous.content = [...previous.content, ...blocks];
      return;
    }
    compacted.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const reasoning = message.reasoningContent?.trim();
      if (reasoning) {
        blocks.push({
          type: "thinking",
          thinking: reasoning,
          ...(message.reasoningSignature ? { signature: message.reasoningSignature } : {}),
        });
      }
      const text = message.content.trim();
      if (text) {
        blocks.push({ type: "text", text });
      }
      for (const call of message.toolCalls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      if (blocks.length > 0) {
        append("assistant", blocks);
      }
      continue;
    }

    if (message.role === "tool") {
      const toolResultBlock: AnthropicContentBlock = message.toolCallId
        ? {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        }
        : {
          type: "text",
          text: `[tool:${message.name ?? "unknown"}]\n${message.content}`,
        };
      append("user", [toolResultBlock]);
      continue;
    }

    append("user", [{ type: "text", text: message.content }]);
  }

  return compacted;
}

function mapAnthropicTools(raw: unknown): AnthropicTool[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tools: AnthropicTool[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const fn = (item as { function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }).function;
    if (!fn?.name) {
      continue;
    }
    tools.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return tools;
}

function mapAnthropicToolChoice(raw: unknown): Record<string, unknown> | undefined {
  if (raw === "auto" || raw === undefined || raw === null) {
    return raw ? { type: "auto" } : undefined;
  }
  if (raw === "none") {
    return { type: "none" };
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function cryptoRandomId(): string {
  return `tool_${Math.random().toString(36).slice(2, 12)}`;
}

function isLikelyCompleteJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  return `MiniMax request failed with ${response.status} ${response.statusText}: ${body}`;
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (data.length > 0) {
          yield data;
        }
      }

      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  const tail = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  for (const data of tail) {
    if (data.length > 0) {
      yield data;
    }
  }
}
