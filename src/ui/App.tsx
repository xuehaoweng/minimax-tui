import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { streamChatCompletion } from "../api/minimax.js";
import { saveConversationState } from "../storage.js";
import type { AppConfig, ChatMessage, StoredConfig } from "../types.js";

interface AppProps {
  config: AppConfig;
  initialMessages: ChatMessage[];
  onConfigChange: (patch: Partial<StoredConfig>) => Promise<void>;
}

export function App({ config, initialMessages, onConfigChange }: AppProps) {
  const { exit } = useApp();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<AppConfig>(config);
  const assistantIndex = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }

    if (isSending) {
      return;
    }

    if (key.return) {
      if (key.shift) {
        setDraft((current) => `${current}\n`);
      } else {
        void submitDraft();
      }
      return;
    }

    if (key.backspace) {
      setDraft((current) => current.slice(0, -1));
      return;
    }

    if (input) {
      setDraft((current) => `${current}${input}`);
    }
  });

  useEffect(() => {
    setRuntimeConfig(config);
  }, [config]);

  const conversation = useMemo(() => {
    return [
      {
        role: "system" as const,
        content: composeSystemPrompt(runtimeConfig),
      },
      ...messages,
    ];
  }, [messages, runtimeConfig]);

  useEffect(() => {
    void saveConversationState({
      messages,
      updatedAt: new Date().toISOString(),
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to save session: ${message}`);
    });
  }, [messages]);

  const submitDraft = async () => {
    const content = draft.trim();
    if (!content || isSending) {
      return;
    }

    if (content.startsWith("/")) {
      setDraft("");
      await handleCommand(content.slice(1).trim());
      return;
    }

    setError(null);
    setNotice(null);
    setIsSending(true);
    setStatus(`Sending request in ${runtimeConfig.mode} mode...`);
    setDraft("");
    setMessages((current) => {
      const next = [
        ...current,
        { role: "user" as const, content },
        { role: "assistant" as const, content: "" },
      ];
      assistantIndex.current = next.length - 1;
      return next;
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatCompletion(
        runtimeConfig,
        [...conversation, { role: "user", content }],
        (token) => {
          setMessages((current) => {
            const index = assistantIndex.current;
            if (index === null || !current[index]) {
              return current;
            }

            const next = [...current];
            next[index] = {
              ...next[index],
              content: `${next[index].content}${token}`,
            };
            return next;
          });
        },
        controller.signal,
      );
      setStatus("Ready");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus("Error");
      setMessages((current) => {
        const index = assistantIndex.current;
        if (index === null || !current[index]) {
          return current;
        }

        const next = [...current];
        const existing = next[index].content.trim();
        next[index] = {
          ...next[index],
          content: existing.length > 0 ? existing : `[error] ${message}`,
        };
        return next;
      });
    } finally {
      assistantIndex.current = null;
      abortRef.current = null;
      setIsSending(false);
    }
  };

  async function handleCommand(rawCommand: string): Promise<void> {
    const [name, ...rest] = rawCommand.split(/\s+/);
    const argument = rest.join(" ").trim();

    setError(null);
    setNotice(null);

    switch (name) {
      case "help":
        setNotice(
          "Commands: /help /mode chat|plan|agent /model <name> /baseurl <url> /temperature <n> /max <n> /system <text> /clear",
        );
        setStatus("Command help");
        return;
      case "mode": {
        const nextMode = parseMode(argument);
        if (!nextMode) {
          setError("Usage: /mode chat|plan|agent");
          setStatus("Command error");
          return;
        }

        const nextConfig = { ...runtimeConfig, mode: nextMode };
        setRuntimeConfig(nextConfig);
        await onConfigChange({ mode: nextMode });
        setStatus(`Mode set to ${nextMode}`);
        setNotice("Mode updated and saved to setting.json");
        return;
      }
      case "model":
        if (!argument) {
          setError("Usage: /model <name>");
          setStatus("Command error");
          return;
        }
        setRuntimeConfig((current) => ({ ...current, model: argument }));
        await onConfigChange({ model: argument });
        setStatus(`Model set to ${argument}`);
        setNotice("Model updated and saved to setting.json");
        return;
      case "baseurl":
        if (!argument) {
          setError("Usage: /baseurl <url>");
          setStatus("Command error");
          return;
        }
        setRuntimeConfig((current) => ({
          ...current,
          baseUrl: normalizeBaseUrl(argument),
        }));
        await onConfigChange({ baseUrl: normalizeBaseUrl(argument) });
        setStatus(`Base URL set to ${normalizeBaseUrl(argument)}`);
        setNotice("Base URL updated and saved to setting.json");
        return;
      case "temperature": {
        const parsed = Number(argument);
        if (!Number.isFinite(parsed)) {
          setError("Usage: /temperature <number>");
          setStatus("Command error");
          return;
        }
        setRuntimeConfig((current) => ({ ...current, temperature: parsed }));
        await onConfigChange({ temperature: parsed });
        setStatus(`Temperature set to ${parsed}`);
        setNotice("Temperature updated and saved to setting.json");
        return;
      }
      case "max": {
        const parsed = Number.parseInt(argument, 10);
        if (!Number.isFinite(parsed)) {
          setError("Usage: /max <integer>");
          setStatus("Command error");
          return;
        }
        setRuntimeConfig((current) => ({ ...current, maxTokens: parsed }));
        await onConfigChange({ maxTokens: parsed });
        setStatus(`Max tokens set to ${parsed}`);
        setNotice("Max tokens updated and saved to setting.json");
        return;
      }
      case "system":
        if (!argument) {
          setError("Usage: /system <text>");
          setStatus("Command error");
          return;
        }
        setRuntimeConfig((current) => ({ ...current, systemPrompt: argument }));
        await onConfigChange({ systemPrompt: argument });
        setStatus("System prompt updated");
        setNotice("System prompt updated and saved to setting.json");
        return;
      case "clear":
        abortRef.current?.abort();
        setMessages([]);
        await saveConversationState({
          messages: [],
          updatedAt: new Date().toISOString(),
        });
        setStatus("Conversation cleared");
        setNotice("History removed from local session file");
        return;
      case "config":
        setStatus("Run `minimax-tui config` for interactive settings");
        setNotice("Use the config command to open the full settings wizard.");
        return;
      default:
        setError(`Unknown command: /${name}. Try /help.`);
        setStatus("Command error");
    }
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright" bold>
          minimax-tui
        </Text>
        <Text dimColor>
          Mode: {runtimeConfig.mode} | Model: {runtimeConfig.model} | {status}
        </Text>
        <Text dimColor>
          Enter to send, Shift+Enter for newline, /help for commands, Ctrl+C to exit
        </Text>
      </Box>

      {notice ? (
        <Box marginBottom={1}>
          <Text color="blueBright">{notice}</Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        {messages.map((message, index) => {
          const isAssistant = message.role === "assistant";
          const label = isAssistant ? "assistant" : "you";
          return (
            <Box key={`${label}-${index}`} flexDirection="column">
              <Text color={isAssistant ? "green" : "yellow"} bold>
                {label}
              </Text>
              <Text wrap="wrap">{message.content || (isAssistant && isSending ? "..." : "")}</Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column">
        <Text color="magenta" bold>
          prompt
        </Text>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
          {renderDraft(draft)}
        </Box>
      </Box>
    </Box>
  );
}

function composeSystemPrompt(config: AppConfig): string {
  const modePrompt = getModePrompt(config.mode);
  return [config.systemPrompt.trim(), modePrompt].filter(Boolean).join("\n\n");
}

function getModePrompt(mode: AppConfig["mode"]): string {
  switch (mode) {
    case "plan":
      return "Mode: plan. Focus on clarifying requirements, outlining steps, and avoiding premature implementation.";
    case "agent":
      return "Mode: agent. Be concise, action-oriented, and treat the conversation like an execution workspace.";
    case "chat":
    default:
      return "Mode: chat. Provide direct conversational answers.";
  }
}

function parseMode(value: string): AppConfig["mode"] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat" || normalized === "plan" || normalized === "agent") {
    return normalized;
  }
  return null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function renderDraft(draft: string): React.ReactNode {
  const lines = draft.length > 0 ? draft.split("\n") : [""];
  return lines.map((line, index) => (
    <Text key={`${index}-${line}`}>
      {line}
      {index === lines.length - 1 ? "█" : ""}
    </Text>
  ));
}
