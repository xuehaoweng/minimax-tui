import type { AppConfig, ChatMessage } from "../types.js";

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

export async function streamChatCompletion(
  config: AppConfig,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(new URL("/v1/chat/completions", config.baseUrl), {
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

    const payload = JSON.parse(event) as ChatCompletionChunk;
    const choice = payload.choices?.[0];
    const token = choice?.delta?.content ?? choice?.message?.content ?? "";
    if (token) {
      onToken(token);
    }
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
