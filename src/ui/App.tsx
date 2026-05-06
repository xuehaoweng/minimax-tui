import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { streamChatCompletion } from "../api/minimax.js";
import {
  getSettingPath,
  loadConversationState,
  saveConversationState,
} from "../storage.js";
import type { AppConfig, ChatMessage, StoredConfig } from "../types.js";

interface AppProps {
  config: AppConfig;
  initialMessages: ChatMessage[];
  onConfigChange: (patch: Partial<StoredConfig>) => Promise<void>;
}

interface PaletteAction {
  group: string;
  label: string;
  description: string;
  run: () => Promise<void>;
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
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const assistantIndex = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    return [
      {
        group: "Mode",
        label: "Switch to chat",
        description: "Set the session mode to chat.",
        run: async () => {
          await applyMode("chat");
        },
      },
      {
        group: "Mode",
        label: "Switch to plan",
        description: "Set the session mode to plan.",
        run: async () => {
          await applyMode("plan");
        },
      },
      {
        group: "Mode",
        label: "Switch to agent",
        description: "Set the session mode to agent.",
        run: async () => {
          await applyMode("agent");
        },
      },
      {
        group: "Session",
        label: "Clear conversation",
        description: "Remove the current session history.",
        run: async () => {
          abortRef.current?.abort();
          setMessages([]);
          await saveConversationState({
            messages: [],
            updatedAt: new Date().toISOString(),
          });
          setStatus("Conversation cleared");
          setNotice("History removed from local session file");
        },
      },
      {
        group: "Info",
        label: "Show config path",
        description: "Print ~/.minimax-tui/setting.json in the UI.",
        run: async () => {
          setStatus("Config path ready");
          setNotice(`Config file: ${getSettingPath()}`);
        },
      },
      {
        group: "Help",
        label: "Show help",
        description: "Display slash commands and shortcuts.",
        run: async () => {
          setStatus("Command help");
          setNotice(
            "Commands: /help /mode chat|plan|agent /model <name> /baseurl <url> /temperature <n> /max <n> /system <text> /clear",
          );
        },
      },
    ];
  }, [applyMode]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }

    if (key.ctrl && input === "k") {
      if (isPaletteOpen) {
        setIsPaletteOpen(false);
      } else {
        setIsPaletteOpen(true);
        setPaletteIndex(0);
        setPaletteQuery("");
      }
      return;
    }

    if (key.ctrl && input === "r") {
      void restoreConversation();
      return;
    }

    if (key.ctrl && input === "p") {
      recallPrompt(-1);
      return;
    }

    if (key.ctrl && input === "n") {
      recallPrompt(1);
      return;
    }

    if (isPaletteOpen) {
      if (key.escape) {
        setIsPaletteOpen(false);
        return;
      }

      if (key.backspace) {
        setPaletteQuery((current) => current.slice(0, -1));
        setPaletteIndex(0);
        return;
      }

      if (key.upArrow) {
        setPaletteIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setPaletteIndex((current) => Math.min(paletteActions.length - 1, current + 1));
        return;
      }

      if (key.return) {
        const action = filteredPaletteActions[paletteIndex];
        if (action) {
          setIsPaletteOpen(false);
          void action.run();
        }
        return;
      }

      if (input) {
        setPaletteQuery((current) => `${current}${input}`);
        setPaletteIndex(0);
      }

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
      if (historyCursor !== null) {
        setHistoryCursor(null);
      }
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
    setPromptHistory((current) => [...current, content]);
    setHistoryCursor(null);
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

  async function restoreConversation(): Promise<void> {
    setError(null);
    setNotice(null);
    const session = await loadConversationState();
    setMessages(session.messages);
    setStatus("Conversation restored");
    setNotice("Reloaded the last saved session from disk");
  }

  function recallPrompt(direction: -1 | 1): void {
    if (promptHistory.length === 0) {
      return;
    }

    setHistoryCursor((current) => {
      let nextIndex: number;
      if (current === null) {
        nextIndex = direction < 0 ? promptHistory.length - 1 : 0;
      } else {
        nextIndex = current + direction;
      }

      if (nextIndex < 0 || nextIndex >= promptHistory.length) {
        return current;
      }

      setDraft(promptHistory[nextIndex] ?? "");
      return nextIndex;
    });
  }

  const filteredPaletteActions = useMemo(() => {
    const normalizedQuery = paletteQuery.trim().toLowerCase();
    const filtered = normalizedQuery.length === 0
      ? paletteActions
      : paletteActions.filter((action) => {
          const haystack = `${action.group} ${action.label} ${action.description}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        });

    return filtered;
  }, [paletteActions, paletteQuery]);

  useEffect(() => {
    if (paletteIndex >= filteredPaletteActions.length) {
      setPaletteIndex(Math.max(0, filteredPaletteActions.length - 1));
    }
  }, [filteredPaletteActions.length, paletteIndex]);

  async function applyMode(mode: AppConfig["mode"]): Promise<void> {
    const nextConfig = { ...runtimeConfig, mode };
    setRuntimeConfig(nextConfig);
    await onConfigChange({ mode });
    setStatus(`Mode set to ${mode}`);
    setNotice("Mode updated and saved to setting.json");
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
          Enter to send, Shift+Enter for newline, Ctrl+P/Ctrl+N for history, /help for commands, Ctrl+C to exit
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

      {isPaletteOpen ? (
        <Box flexDirection="column" marginTop={1} borderStyle="double" borderColor="cyan">
          <Box paddingX={1}>
            <Text color="cyanBright" bold>
              Command Palette
            </Text>
          </Box>
          <Box paddingX={1} paddingBottom={1}>
            <Text color="yellow">Search: {paletteQuery || "all"}</Text>
          </Box>
          {renderPaletteGroups(filteredPaletteActions, paletteIndex)}
          <Box paddingX={1} paddingBottom={1}>
            <Text dimColor>
              Type to filter, Up/Down to move, Enter to run, Esc to close, Ctrl+K to toggle.
            </Text>
          </Box>
        </Box>
      ) : null}
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

function renderPaletteGroups(actions: PaletteAction[], selectedIndex: number): React.ReactNode {
  const groups = new Map<string, PaletteAction[]>();
  for (const action of actions) {
    const existing = groups.get(action.group) ?? [];
    existing.push(action);
    groups.set(action.group, existing);
  }

  let globalIndex = 0;
  const nodes: React.ReactNode[] = [];
  for (const [group, groupActions] of groups.entries()) {
    nodes.push(
      <Box key={group} flexDirection="column" paddingX={1}>
        <Text color="cyanBright" bold>
          {group}
        </Text>
        {groupActions.map((action) => {
          const selected = globalIndex === selectedIndex;
          const node = (
            <Box key={action.label} paddingLeft={1}>
              <Text
                color={selected ? "black" : "white"}
                backgroundColor={selected ? "cyan" : undefined}
                bold={selected}
              >
                {selected ? ">" : " "} {action.label}
              </Text>
              <Text dimColor> - {action.description}</Text>
            </Box>
          );
          globalIndex += 1;
          return node;
        })}
      </Box>,
    );
  }

  return nodes;
}
