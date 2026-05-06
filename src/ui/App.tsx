import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { streamChatCompletion } from "../api/minimax.js";
import { runAgentTurn } from "../agent.js";
import {
  getSettingPath,
  listConversationSessions,
  loadConversationSession,
  resetConversationSession,
  saveConversationSession,
} from "../storage.js";
import { installSkillFromPath, listInstalledSkills, loadSkillManifests, removeSkill } from "../skills.js";
import {
  installPluginFromSource,
  listInstalledPlugins,
  loadPluginManifests,
  loadPluginRuntimeContext,
  removePlugin,
} from "../plugins.js";
import { initWorkspacePolicyFile } from "../minimax-init.js";
import {
  buildWorkspacePolicyPrompt,
  loadWorkspacePolicyContext,
} from "../workspace-policy.js";
import type {
  AppConfig,
  ChatMessage,
  ConversationSession,
  ConversationSessionSummary,
  PluginRuntimeContext,
  PluginSummary,
  SkillManifest,
  SkillSummary,
  StoredConfig,
  WorkspacePolicyContext,
} from "../types.js";

interface AppProps {
  config: AppConfig;
  initialSession: ConversationSession;
  onConfigChange: (patch: Partial<StoredConfig>) => Promise<void>;
}

interface PaletteAction {
  group: string;
  label: string;
  description: string;
  run: () => Promise<void>;
}

interface SlashCommand {
  name: string;
  description: string;
  template?: string;
  kind: "insert" | "picker" | "action";
}

export function App({ config, initialSession, onConfigChange }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [launchTime] = useState(() => formatTimestampWithOffset(new Date()));
  const [draft, setDraft] = useState("");
  const [activeSession, setActiveSession] = useState<ConversationSession>(initialSession);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSession.messages);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<AppConfig>(config);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteGroup, setPaletteGroup] = useState<string | null>(null);
  const [isSlashPickerOpen, setIsSlashPickerOpen] = useState(false);
  const [slashPickerIndex, setSlashPickerIndex] = useState(0);
  const [slashPickerSuppressed, setSlashPickerSuppressed] = useState(false);
  const [isSessionPickerOpen, setIsSessionPickerOpen] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessionSummaries, setSessionSummaries] = useState<ConversationSessionSummary[]>([]);
  const [sessionPickerLoading, setSessionPickerLoading] = useState(false);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [installedSkills, setInstalledSkills] = useState<SkillSummary[]>([]);
  const [activeSkillManifests, setActiveSkillManifests] = useState<SkillManifest[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([]);
  const [activePluginContexts, setActivePluginContexts] = useState<PluginRuntimeContext[]>([]);
  const [workspacePolicy, setWorkspacePolicy] = useState<WorkspacePolicyContext>({
    sourcePath: null,
    content: "",
    hookFiles: [],
    hookSummaries: [],
  });
  const assistantIndex = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sanitizedMessages = useMemo(() => sanitizeMessages(messages), [messages]);
  const activeSkillNames = useMemo(() => activeSession.activeSkills ?? [], [activeSession.activeSkills]);
  const activePluginNames = useMemo(() => activeSession.activePlugins ?? [], [activeSession.activePlugins]);
  const recentActivity = useMemo(() => buildRecentActivitySummary(sanitizedMessages), [sanitizedMessages]);

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
          await clearCurrentSession();
          setStatus("Conversation cleared");
          setNotice("Current session cleared");
        },
      },
      {
        group: "Session",
        label: "Show sessions",
        description: "Open the session picker.",
        run: async () => {
          await openSessionPicker();
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
        group: "Setup",
        label: "Initialize MINIMAX.md",
        description: "Create a workspace policy file in the current directory.",
        run: async () => {
          const result = await initWorkspacePolicyFile();
          const policy = await loadWorkspacePolicyContext();
          setWorkspacePolicy(policy);
          setStatus(result.created ? "MINIMAX.md created" : "MINIMAX.md already exists");
          setNotice(`${result.created ? "Created" : "Already exists"}: ${result.path}`);
        },
      },
      {
        group: "Help",
        label: "Show help",
        description: "Display slash commands and shortcuts.",
        run: async () => {
          setStatus("Command help");
          setNotice(
            "Slash commands: /help /status /mode /model /baseurl /temperature /max /system /clear /resume /sessions /config /skill /plugin /init",
          );
        },
      },
    ];
  }, [applyMode]);

  const slashCommands = useMemo<SlashCommand[]>(() => {
    return [
      {
        kind: "action",
        name: "help",
        description: "Show slash command help in the panel.",
      },
      {
        kind: "action",
        name: "status",
        description: "Show the current session status.",
      },
      {
        kind: "insert",
        name: "mode",
        template: "/mode ",
        description: "Switch conversation mode.",
      },
      {
        kind: "insert",
        name: "model",
        template: "/model ",
        description: "Set the model name.",
      },
      {
        kind: "insert",
        name: "baseurl",
        template: "/baseurl ",
        description: "Set the API base URL.",
      },
      {
        kind: "insert",
        name: "temperature",
        template: "/temperature ",
        description: "Set sampling temperature.",
      },
      {
        kind: "insert",
        name: "max",
        template: "/max ",
        description: "Set max tokens.",
      },
      {
        kind: "insert",
        name: "system",
        template: "/system ",
        description: "Set the system prompt.",
      },
      {
        kind: "action",
        name: "clear",
        description: "Clear the current session.",
      },
      {
        kind: "picker",
        name: "resume",
        template: "/resume ",
        description: "Pick a saved session to resume.",
      },
      {
        kind: "picker",
        name: "sessions",
        template: "/sessions",
        description: "Open the saved session picker.",
      },
      {
        kind: "action",
        name: "config",
        description: "Open the persistent settings wizard.",
      },
      {
        kind: "action",
        name: "init",
        description: "Create MINIMAX.md in the current workspace.",
      },
      {
        kind: "insert",
        name: "skill",
        template: "/skill ",
        description: "Install, activate, or list skills.",
      },
      {
        kind: "insert",
        name: "plugin",
        template: "/plugin ",
        description: "Install, activate, or list plugins.",
      },
    ];
  }, []);

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
        setPaletteGroup(null);
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

    if (isSlashPickerOpen) {
      if (key.escape) {
        setIsSlashPickerOpen(false);
        setSlashPickerSuppressed(true);
        setStatus("Slash command cancelled");
        return;
      }

      if (key.tab) {
        setSlashPickerIndex((current) =>
          (current + (key.shift ? -1 : 1) + Math.max(1, filteredSlashCommands.length)) %
          Math.max(1, filteredSlashCommands.length),
        );
        return;
      }

      if (key.pageUp) {
        setSlashPickerIndex((current) => Math.max(0, current - 5));
        return;
      }

      if (key.pageDown) {
        setSlashPickerIndex((current) => Math.min(filteredSlashCommands.length - 1, current + 5));
        return;
      }

      if (key.upArrow) {
        setSlashPickerIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setSlashPickerIndex((current) => Math.min(filteredSlashCommands.length - 1, current + 1));
        return;
      }

      if (key.return) {
        const selected = filteredSlashCommands[slashPickerIndex];
        if (selected) {
          void applySlashCommand(selected);
        } else {
          setIsSlashPickerOpen(false);
          setSlashPickerSuppressed(false);
          void submitDraft();
        }
        return;
      }
    }

    if (isSessionPickerOpen) {
      if (key.escape) {
        closeSessionPicker();
        setStatus("Resume cancelled");
        return;
      }

      if (key.pageUp) {
        setSessionPickerIndex((current) => Math.max(0, current - 5));
        return;
      }

      if (key.pageDown) {
        setSessionPickerIndex((current) => Math.min(sessionSummaries.length - 1, current + 5));
        return;
      }

      if (key.upArrow) {
        setSessionPickerIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setSessionPickerIndex((current) => Math.min(sessionSummaries.length - 1, current + 1));
        return;
      }

      if (key.return) {
        const selected = sessionSummaries[sessionPickerIndex];
        if (selected) {
          closeSessionPicker();
          void resumeSession(selected.id);
        }
        return;
      }

      return;
    }

    if (isPaletteOpen) {
      if (key.escape) {
        setIsPaletteOpen(false);
        return;
      }

      if (key.tab) {
        cyclePaletteGroup(key.shift ? -1 : 1);
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
        setPaletteIndex((current) => Math.min(filteredPaletteActions.length - 1, current + 1));
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

    if (key.pageUp) {
      scrollMessages(-1, true);
      return;
    }

    if (key.pageDown) {
      scrollMessages(1, true);
      return;
    }

    if (key.upArrow) {
      scrollMessages(-1);
      return;
    }

    if (key.downArrow) {
      scrollMessages(1);
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

    if (isBackspaceInput(input, key)) {
      setDraft((current) => removeLastGrapheme(current));
      return;
    }

    if (input) {
      if (historyCursor !== null) {
        setHistoryCursor(null);
      }
      const cleanInput = sanitizeDraftInput(input);
      if (cleanInput) {
        setDraft((current) => `${current}${cleanInput}`);
      }
    }
  });

  useEffect(() => {
    setRuntimeConfig(config);
  }, [config]);

  const sessionTitle = useMemo(() => buildSessionTitle(sanitizedMessages), [sanitizedMessages]);
  const slashSearch = useMemo(() => {
    if (!draft.startsWith("/")) {
      return "";
    }

    const token = draft.slice(1).trimStart().split(/\s+/)[0] ?? "";
    return token.toLowerCase();
  }, [draft]);

  const filteredSlashCommands = useMemo(() => {
    return slashCommands.filter((command) => {
      if (!slashSearch) {
        return true;
      }

      const haystack = `${command.name} ${command.description}`.toLowerCase();
      return haystack.includes(slashSearch);
    });
  }, [slashCommands, slashSearch]);

  useEffect(() => {
    if (filteredSlashCommands.length === 0) {
      if (slashPickerIndex !== 0) {
        setSlashPickerIndex(0);
      }
      return;
    }

    if (slashPickerIndex >= filteredSlashCommands.length) {
      setSlashPickerIndex(filteredSlashCommands.length - 1);
    }
  }, [filteredSlashCommands.length, slashPickerIndex]);

  const activeAssistantManifests = useMemo(() => {
    return dedupeSkillManifests([
      ...activeSkillManifests,
      ...activePluginContexts.flatMap((plugin) => plugin.skills),
    ]);
  }, [activePluginContexts, activeSkillManifests]);

  const viewport = useMemo(() => {
    return calculateViewport({
      rows: stdout.rows ?? 24,
      draft,
      paletteOpen: isPaletteOpen,
      slashPickerOpen: isSlashPickerOpen,
      sessionPickerOpen: isSessionPickerOpen,
    });
  }, [draft, isPaletteOpen, isSessionPickerOpen, isSlashPickerOpen, stdout.rows]);

  const visibleMessages = useMemo(() => {
    const maxOffset = Math.max(0, sanitizedMessages.length - viewport.pageSize);
    const start = Math.min(scrollOffset, maxOffset);
    const end = start + viewport.pageSize;
    return {
      start,
      end: Math.min(end, sanitizedMessages.length),
      items: sanitizedMessages.slice(start, end),
      maxOffset,
    };
  }, [sanitizedMessages, scrollOffset, viewport.pageSize]);

  useEffect(() => {
    if (!isSessionPickerOpen) {
      return;
    }

    void refreshSessionPicker();
  }, [isSessionPickerOpen]);

  useEffect(() => {
    void refreshInstalledSkills();
  }, []);

  useEffect(() => {
    void refreshActiveSkillManifests();
  }, [activeSkillNames, installedSkills]);

  useEffect(() => {
    void refreshInstalledPlugins();
  }, []);

  useEffect(() => {
    void refreshActivePluginManifests();
  }, [activePluginNames, installedPlugins]);

  useEffect(() => {
    let alive = true;
    void loadWorkspacePolicyContext()
      .then((policy) => {
        if (alive) {
          setWorkspacePolicy(policy);
        }
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`Failed to load workspace policy: ${message}`);
        setStatus("Policy load error");
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const draftIsSlashCommand = draft.startsWith("/");
    const draftHasArguments = /^\/\S+\s+/.test(draft);
    const shouldOpen =
      draftIsSlashCommand &&
      !draftHasArguments &&
      !isPaletteOpen &&
      !isSessionPickerOpen &&
      !isSending &&
      !slashPickerSuppressed;

    if (!draftIsSlashCommand && slashPickerSuppressed) {
      setSlashPickerSuppressed(false);
    }

    if (draftHasArguments && isSlashPickerOpen) {
      setIsSlashPickerOpen(false);
    }

    if (shouldOpen && !isSlashPickerOpen) {
      setIsSlashPickerOpen(true);
      setSlashPickerIndex(0);
      return;
    }

    if (!shouldOpen && isSlashPickerOpen) {
      setIsSlashPickerOpen(false);
    }
  }, [
    draft,
    isPaletteOpen,
    isSessionPickerOpen,
    isSending,
    isSlashPickerOpen,
    slashPickerSuppressed,
  ]);

  useEffect(() => {
    void saveConversationSession({
      ...activeSession,
      title: sessionTitle,
      messages: sanitizedMessages,
      updatedAt: new Date().toISOString(),
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to save session: ${message}`);
    });
  }, [activeSession, sanitizedMessages, sessionTitle]);

  useEffect(() => {
    const maxOffset = Math.max(0, sanitizedMessages.length - viewport.pageSize);
    if (isPinnedToBottom) {
      setScrollOffset(maxOffset);
      return;
    }

    if (scrollOffset > maxOffset) {
      setScrollOffset(maxOffset);
    }
  }, [isPinnedToBottom, sanitizedMessages.length, scrollOffset, viewport.pageSize]);

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
    setPromptHistory((current) => [...current, sanitizeDraftInput(content)]);
    setHistoryCursor(null);
    setDraft("");
    setIsPinnedToBottom(true);
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
      const freshPolicy = await loadWorkspacePolicyContext();
      setWorkspacePolicy(freshPolicy);
      const requestConversation = [
        {
          role: "system" as const,
          content: composeSystemPrompt(
            runtimeConfig,
            activeAssistantManifests,
            activePluginContexts,
            buildWorkspacePolicyPrompt(freshPolicy),
          ),
        },
        ...sanitizedMessages,
        { role: "user" as const, content },
      ];

      if (runtimeConfig.mode === "agent") {
        const result = await runAgentTurn(
          runtimeConfig,
          requestConversation,
          activeSkillManifests,
          controller.signal,
        );
        setMessages(result.messages);
      } else {
        await streamChatCompletion(
          runtimeConfig,
          requestConversation,
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
      }
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
            "Slash commands: /help /status /mode /model /baseurl /temperature /max /system /clear /resume /sessions /config /skill /plugin /init",
        );
        setStatus("Command help");
        return;
      case "status": {
        setStatus("Session status");
        setNotice(formatSessionStatus());
        return;
      }
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
        await clearCurrentSession();
        setStatus("Conversation cleared");
        setNotice("Current session cleared");
        return;
      case "resume":
        if (!argument) {
          await openSessionPicker();
          return;
        }

        await resumeSession(argument);
        return;
      case "sessions": {
        await openSessionPicker();
        return;
      }
      case "config":
        setStatus("Run `minimax-tui config` for interactive settings");
        setNotice("Use the config command to open the full settings wizard.");
        return;
      case "init": {
        const result = await initWorkspacePolicyFile();
        const policy = await loadWorkspacePolicyContext();
        setWorkspacePolicy(policy);
        setStatus(result.created ? "MINIMAX.md created" : "MINIMAX.md already exists");
        setNotice(`${result.created ? "Created" : "Already exists"}: ${result.path}`);
        return;
      }
      case "skill": {
        const [subcommand, ...skillRest] = argument.split(/\s+/);
        const skillArg = skillRest.join(" ").trim();
        if (!subcommand) {
          const installed = installedSkills.length === 0 ? "No installed skills yet." : formatSkillList(installedSkills);
          setStatus("Skill list");
          setNotice(
            [
              `Installed skills: ${installedSkills.length}`,
              installed,
              `Active skills: ${activeSkillNames.length === 0 ? "none" : activeSkillNames.join(", ")}`,
              "Use /skill install <path-or-github-url>, /skill use <name>, /skill remove <name>, /skill active.",
            ].join("\n"),
          );
          return;
        }

        if (subcommand === "list" || subcommand === "active") {
          const activeText = activeSkillNames.length === 0 ? "none" : activeSkillNames.join(", ");
          setStatus("Skill list");
          setNotice(
            [
              `Installed skills: ${installedSkills.length}`,
              installedSkills.length === 0 ? "No installed skills yet." : formatSkillList(installedSkills),
              `Active skills: ${activeText}`,
            ].join("\n"),
          );
          return;
        }

        if (subcommand === "install") {
          if (!skillArg) {
            setError("Usage: /skill install <path-or-github-url>");
            setStatus("Command error");
            return;
          }

          const manifest = await installSkillFromPath(skillArg);
          await refreshInstalledSkills();
          setStatus(`Installed skill ${manifest.name}`);
          setNotice(`Skill installed: ${manifest.name}`);
          return;
        }

        if (subcommand === "use") {
          if (!skillArg) {
            setError("Usage: /skill use <name>");
            setStatus("Command error");
            return;
          }

          const match = installedSkills.find((skill) => skill.name === skillArg.toLowerCase());
          if (!match) {
            setError(`Skill not installed: ${skillArg}`);
            setStatus("Command error");
            return;
          }

          const nextActive = Array.from(new Set([...(activeSession.activeSkills ?? []), match.name]));
          setActiveSession((current) => ({ ...current, activeSkills: nextActive }));
          setStatus(`Activated skill ${match.name}`);
          setNotice(`Active skills updated: ${nextActive.join(", ")}`);
          return;
        }

        if (subcommand === "remove") {
          if (!skillArg) {
            setError("Usage: /skill remove <name>");
            setStatus("Command error");
            return;
          }

          await removeSkill(skillArg);
          const nextActive = (activeSession.activeSkills ?? []).filter((name) => name !== skillArg.toLowerCase());
          setActiveSession((current) => ({ ...current, activeSkills: nextActive }));
          await refreshInstalledSkills();
          setStatus(`Removed skill ${skillArg}`);
          setNotice(`Active skills updated: ${nextActive.join(", ") || "none"}`);
          return;
        }

        setError("Usage: /skill [list|active|install <path-or-github-url>|use <name>|remove <name>]");
        setStatus("Command error");
        return;
      }
      case "plugin": {
        const [subcommand, ...pluginRest] = argument.split(/\s+/);
        const pluginArg = pluginRest.join(" ").trim();
        if (!subcommand) {
          const installed = installedPlugins.length === 0 ? "No installed plugins yet." : formatPluginList(installedPlugins);
          setStatus("Plugin list");
          setNotice(
            [
              `Installed plugins: ${installedPlugins.length}`,
              installed,
              `Active plugins: ${activePluginNames.length === 0 ? "none" : activePluginNames.join(", ")}`,
              "Use /plugin install <path-or-github-url>, /plugin use <name>, /plugin remove <name>, /plugin active.",
            ].join("\n"),
          );
          return;
        }

        if (subcommand === "list" || subcommand === "active") {
          const activeText = activePluginNames.length === 0 ? "none" : activePluginNames.join(", ");
          setStatus("Plugin list");
          setNotice(
            [
              `Installed plugins: ${installedPlugins.length}`,
              installedPlugins.length === 0 ? "No installed plugins yet." : formatPluginList(installedPlugins),
              `Active plugins: ${activeText}`,
            ].join("\n"),
          );
          return;
        }

        if (subcommand === "install") {
          if (!pluginArg) {
            setError("Usage: /plugin install <path-or-github-url>");
            setStatus("Command error");
            return;
          }

          const manifest = await installPluginFromSource(pluginArg);
          await refreshInstalledPlugins();
          setStatus(`Installed plugin ${manifest.name}`);
          setNotice(`Plugin installed: ${manifest.name}`);
          return;
        }

        if (subcommand === "use") {
          if (!pluginArg) {
            setError("Usage: /plugin use <name>");
            setStatus("Command error");
            return;
          }

          const match = installedPlugins.find((plugin) => plugin.name === pluginArg.toLowerCase());
          if (!match) {
            setError(`Plugin not installed: ${pluginArg}`);
            setStatus("Command error");
            return;
          }

          const nextActive = Array.from(new Set([...(activeSession.activePlugins ?? []), match.name]));
          setActiveSession((current) => ({ ...current, activePlugins: nextActive }));
          setStatus(`Activated plugin ${match.name}`);
          setNotice(`Active plugins updated: ${nextActive.join(", ")}`);
          return;
        }

        if (subcommand === "remove") {
          if (!pluginArg) {
            setError("Usage: /plugin remove <name>");
            setStatus("Command error");
            return;
          }

          await removePlugin(pluginArg);
          const nextActive = (activeSession.activePlugins ?? []).filter((name) => name !== pluginArg.toLowerCase());
          setActiveSession((current) => ({ ...current, activePlugins: nextActive }));
          await refreshInstalledPlugins();
          setStatus(`Removed plugin ${pluginArg}`);
          setNotice(`Active plugins updated: ${nextActive.join(", ") || "none"}`);
          return;
        }

        setError("Usage: /plugin [list|active|install <path-or-github-url>|use <name>|remove <name>]");
        setStatus("Command error");
        return;
      }
      default:
        setError(`Unknown command: /${name}. Try /help.`);
        setStatus("Command error");
    }
  }

  async function restoreConversation(): Promise<void> {
    setError(null);
    setNotice(null);
    const session = await loadConversationSession(activeSession.id);
    if (!session) {
      setError("Current session not found on disk.");
      setStatus("Session missing");
      return;
    }

    setActiveSession(session);
    const nextMessages = sanitizeMessages(session.messages);
    setMessages(nextMessages);
    setScrollOffset(Math.max(0, nextMessages.length - viewport.pageSize));
    setIsPinnedToBottom(true);
    setStatus("Conversation restored");
    setNotice(`Reloaded session ${session.id}`);
  }

  async function clearCurrentSession(): Promise<void> {
    abortRef.current?.abort();
    const cleared = await resetConversationSession(activeSession.id);
    if (!cleared) {
      setError("Current session not found on disk.");
      setStatus("Session missing");
      return;
    }

    setActiveSession(cleared);
    setMessages([]);
    setScrollOffset(0);
    setIsPinnedToBottom(true);
    setPromptHistory([]);
    setHistoryCursor(null);
    setDraft("");
  }

  async function openSessionPicker(): Promise<void> {
    setError(null);
    setNotice(null);
    setIsSlashPickerOpen(false);
    setSlashPickerSuppressed(true);
    setIsSessionPickerOpen(true);
    setSessionPickerLoading(true);
    setStatus("Choose a session");
    setNotice("Use Up/Down and Enter to resume.");
  }

  async function applySlashCommand(command: SlashCommand): Promise<void> {
    setError(null);
    setNotice(null);

    if (command.kind === "insert") {
      setDraft(command.template ?? `/${command.name} `);
      setIsSlashPickerOpen(false);
      setSlashPickerSuppressed(true);
      setStatus(`Inserted /${command.name}`);
      setNotice(`Command ready: ${command.template ?? `/${command.name}`}`);
      return;
    }

    if (command.kind === "picker") {
      setIsSlashPickerOpen(false);
      setSlashPickerSuppressed(true);
      setDraft("");
      await openSessionPicker();
      return;
    }

    setDraft(command.template ?? `/${command.name}`);
    setIsSlashPickerOpen(false);
    setSlashPickerSuppressed(true);
    setStatus(`Inserted /${command.name}`);
    setNotice(`Command ready: /${command.name}`);
  }

  async function refreshInstalledSkills(): Promise<void> {
    try {
      const skills = await listInstalledSkills();
      setInstalledSkills(skills);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to load skills: ${message}`);
      setStatus("Skill refresh error");
    }
  }

  async function refreshActiveSkillManifests(): Promise<void> {
    try {
      const manifests = await loadSkillManifests(activeSkillNames);
      setActiveSkillManifests(manifests);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to load active skills: ${message}`);
      setStatus("Skill load error");
      setActiveSkillManifests([]);
    }
  }

  async function refreshInstalledPlugins(): Promise<void> {
    try {
      const plugins = await listInstalledPlugins();
      setInstalledPlugins(plugins);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to load plugins: ${message}`);
      setStatus("Plugin refresh error");
    }
  }

  async function refreshActivePluginManifests(): Promise<void> {
    try {
      const manifests = await loadPluginManifests(activePluginNames);
      const contexts = await Promise.all(manifests.map((manifest) => loadPluginRuntimeContext(manifest)));
      setActivePluginContexts(contexts);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to load active plugins: ${message}`);
      setStatus("Plugin load error");
      setActivePluginContexts([]);
    }
  }

  async function resumeSession(sessionId: string): Promise<void> {
    abortRef.current?.abort();
    const session = await loadConversationSession(sessionId);
    if (!session) {
      setError(`Session not found: ${sessionId}`);
      setStatus("Resume failed");
      return;
    }

    setActiveSession(session);
    const nextMessages = sanitizeMessages(session.messages);
    setMessages(nextMessages);
    setScrollOffset(Math.max(0, nextMessages.length - viewport.pageSize));
    setIsPinnedToBottom(true);
    setPromptHistory([]);
    setHistoryCursor(null);
    setDraft("");
    setStatus(`Resumed ${session.id}`);
    setNotice(`Active session: ${session.title}`);
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

      setDraft(sanitizeDraftInput(promptHistory[nextIndex] ?? ""));
      return nextIndex;
    });
  }

  const filteredPaletteActions = useMemo(() => {
    const normalizedQuery = paletteQuery.trim().toLowerCase();
    const normalizedGroup = paletteGroup?.trim().toLowerCase() ?? "";
    return paletteActions.filter((action) => {
      const haystack = `${action.group} ${action.label} ${action.description}`.toLowerCase();
      const matchesQuery = normalizedQuery.length === 0 || haystack.includes(normalizedQuery);
      const matchesGroup =
        normalizedGroup.length === 0 ||
        normalizedGroup === "all" ||
        action.group.toLowerCase() === normalizedGroup;
      return matchesQuery && matchesGroup;
    });
  }, [paletteActions, paletteGroup, paletteQuery]);

  const paletteGroups = useMemo(() => {
    return ["All", ...new Set(paletteActions.map((action) => action.group))];
  }, [paletteActions]);

  useEffect(() => {
    if (paletteIndex >= filteredPaletteActions.length) {
      setPaletteIndex(Math.max(0, filteredPaletteActions.length - 1));
    }
  }, [filteredPaletteActions.length, paletteIndex]);

  useEffect(() => {
    if (paletteGroup && !paletteActions.some((action) => action.group === paletteGroup)) {
      setPaletteGroup(null);
    }
  }, [paletteActions, paletteGroup]);

  useEffect(() => {
    if (sessionSummaries.length === 0) {
      if (sessionPickerIndex !== 0) {
        setSessionPickerIndex(0);
      }
      return;
    }

    if (sessionPickerIndex >= sessionSummaries.length) {
      setSessionPickerIndex(sessionSummaries.length - 1);
    }
  }, [sessionPickerIndex, sessionSummaries.length]);

  async function applyMode(mode: AppConfig["mode"]): Promise<void> {
    const nextConfig = { ...runtimeConfig, mode };
    setRuntimeConfig(nextConfig);
    await onConfigChange({ mode });
    setStatus(`Mode set to ${mode}`);
    setNotice("Mode updated and saved to setting.json");
  }

  function scrollMessages(direction: -1 | 1, usePage = false): void {
    const step = usePage ? Math.max(1, viewport.pageSize - 1) : Math.max(1, Math.floor(viewport.pageSize / 2));
    const maxOffset = Math.max(0, sanitizedMessages.length - viewport.pageSize);
    setIsPinnedToBottom(false);
    setScrollOffset((current) => {
      const next = current + step * direction;
      if (next < 0) {
        return 0;
      }
      if (next > maxOffset) {
        setIsPinnedToBottom(true);
        return maxOffset;
      }
      return next;
    });
  }

  function cyclePaletteGroup(direction: -1 | 1): void {
    const currentName = paletteGroup ?? "All";
    const currentIndex = paletteGroups.findIndex((group) => group === currentName);
    const nextIndex = (currentIndex + direction + paletteGroups.length) % paletteGroups.length;
    const nextGroup = paletteGroups[nextIndex] ?? "All";
    setPaletteGroup(nextGroup === "All" ? null : nextGroup);
    setPaletteIndex(0);
    setPaletteQuery("");
  }

  function formatSessionList(
    sessions: Array<{ id: string; title: string; messageCount: number; updatedAt: string }>,
  ): string {
    return sessions
      .map((session) => `${session.id} | ${session.title} | ${session.messageCount} msgs | ${session.updatedAt}`)
      .join("\n");
  }

  async function refreshSessionPicker(): Promise<void> {
    setSessionPickerLoading(true);
    try {
      const sessions = await listConversationSessions();
      setSessionSummaries(sessions);
      if (sessions.length === 0) {
        setSessionPickerIndex(0);
        setStatus("No sessions yet");
        setNotice("No saved sessions yet.");
        return;
      }

      const currentIndex = sessions.findIndex((session) => session.id === activeSession.id);
      setSessionPickerIndex(currentIndex >= 0 ? currentIndex : 0);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus("Session picker error");
    } finally {
      setSessionPickerLoading(false);
    }
  }

  function closeSessionPicker(): void {
    setIsSessionPickerOpen(false);
    setSessionPickerLoading(false);
  }

  function buildSessionTitle(sessionMessages: ChatMessage[]): string {
    const firstUserMessage = sessionMessages.find((message) => message.role === "user")?.content.trim();
    const candidate = firstUserMessage ?? sessionMessages[0]?.content.trim() ?? "";
    if (!candidate) {
      return "New session";
    }

    const normalized = candidate.replace(/\s+/g, " ");
    return Array.from(normalized).slice(0, 32).join("");
  }

  function formatSkillList(skills: SkillSummary[]): string {
    return skills
      .map((skill) => `${skill.name} | ${skill.description} | ${skill.installedAt}`)
      .join("\n");
  }

  function formatPluginList(plugins: PluginSummary[]): string {
    return plugins
      .map(
        (plugin) =>
          `${plugin.name} | ${plugin.displayName} | ${plugin.skillCount} skills | ${plugin.hookCount} hooks | ${plugin.mcpServerCount} mcp | ${plugin.installedAt}`,
      )
      .join("\n");
  }

  function formatSessionStatus(): string {
    const activeSkills = activeSkillNames.length === 0 ? "none" : activeSkillNames.join(", ");
    const activePlugins = activePluginNames.length === 0 ? "none" : activePluginNames.join(", ");
    return [
      `Mode: ${runtimeConfig.mode}`,
      `Model: ${runtimeConfig.model}`,
      `Base URL: ${runtimeConfig.baseUrl}`,
      `Session: ${sessionTitle} (${activeSession.id})`,
      `Policy: ${workspacePolicy.sourcePath ?? "MINIMAX.md missing"}`,
      `Status: ${status}`,
      `Active skills: ${activeSkills}`,
      `Active plugins: ${activePlugins}`,
      `Messages: ${messages.length}`,
      `Pinned: ${isPinnedToBottom ? "bottom" : "free"}`,
    ].join("\n");
  }

  function buildRecentActivitySummary(sessionMessages: ChatMessage[]): string {
    const recent = [...sessionMessages].reverse().find((message) => message.content.trim().length > 0);
    if (!recent) {
      return "No recent activity";
    }

    const role = recent.role === "user" ? "You" : recent.role === "assistant" ? "Assistant" : recent.role;
    const content = sanitizeDisplayText(stripThinkBlocks(recent.content)).replace(/\s+/g, " ").trim();
    const snippet = Array.from(content).slice(0, 72).join("");
    return `${role}: ${snippet}${content.length > 72 ? "..." : ""}`;
  }

  function formatTimestampWithOffset(date: Date): string {
    const pad = (value: number) => String(Math.abs(Math.trunc(value))).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
    const offsetMins = pad(Math.abs(offsetMinutes) % 60);
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMins}`;
  }

function dedupeSkillManifests(manifests: SkillManifest[]): SkillManifest[] {
    const seen = new Set<string>();
    const deduped: SkillManifest[] = [];
    for (const manifest of manifests) {
      const key = manifest.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(manifest);
  }
  return deduped;
}

function pathBasename(value: string): string {
  return path.basename(value);
}

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright" bold>
          minimax-tui
        </Text>
        <Text dimColor>
          Mode: {runtimeConfig.mode} | Model: {runtimeConfig.model} | Session: {sessionTitle} ({activeSession.id.slice(0, 8)})
        </Text>
        <Text dimColor>
          Plugins: {activePluginNames.length === 0 ? "none" : activePluginNames.join(", ")}
        </Text>
        <Text dimColor>
          Policy: {workspacePolicy.sourcePath ?? "MINIMAX.md not found"}
        </Text>
        <Text dimColor>
          Status: {status}
        </Text>
        <Text dimColor>
          Slash: /help /status /mode /model /baseurl /temperature /max /system /clear /resume /sessions /config /skill /plugin
        </Text>
        <Text dimColor>
          Enter to send, Shift+Enter for newline, Ctrl+P/Ctrl+N for history, Ctrl+K for palette, type / to browse commands, Ctrl+C to exit
        </Text>
      </Box>

      <Box marginBottom={1} borderStyle="double" borderColor="cyan">
        <Box width={20} flexDirection="column" paddingX={1} paddingY={0}>
          <Text color="cyanBright" bold>
            ▐▛███▜▌
          </Text>
          <Text color="cyanBright" bold>
            ▝▜█████▛▘
          </Text>
          <Text color="cyanBright" bold>
            ▐▛███▜▌
          </Text>
          <Text color="magentaBright" bold>
            MINI MAX
          </Text>
          <Text color="magentaBright" bold>
            T U I
          </Text>
        </Box>
        <Box flexGrow={1} flexDirection="column" paddingX={1} paddingY={0}>
          <Text color="cyanBright" bold>
            Welcome back!
          </Text>
          <Text color="cyanBright">
            ╭────────────────────────────────────────────────────╮
          </Text>
          <Text color="white">
            Started: {launchTime}
          </Text>
          <Text color="white">
            Workspace: {process.cwd()}
          </Text>
          <Text color="white">
            Session: {sessionTitle} ({activeSession.id.slice(0, 8)})
          </Text>
          <Text color="white">
            Messages: {messages.length} | Status: {status}
          </Text>
          <Text color="white">
            Mode: {runtimeConfig.mode} | Model: {runtimeConfig.model}
          </Text>
          <Text color="white">
            Active skills: {activeSkillNames.length === 0 ? "none" : activeSkillNames.join(", ")}
          </Text>
          <Text color="white">
            Active plugins: {activePluginNames.length === 0 ? "none" : activePluginNames.join(", ")}
          </Text>
          <Text color="cyanBright">
            ╰────────────────────────────────────────────────────╯
          </Text>
        </Box>
        <Box width={40} flexDirection="column" paddingX={1} paddingY={0}>
          <Text color="yellowBright" bold>
            Tips
          </Text>
          <Text color="yellow">/status, /resume, /skill list, /plugin list, /init</Text>
          <Text color="yellow">/skill install {"<path-or-github-url>"}</Text>
          <Text color="yellow">/plugin install {"<path-or-github-url>"}</Text>
          <Text color="magentaBright" bold>
            Policy
          </Text>
          <Text color="magentaBright">
            {workspacePolicy.sourcePath ? pathBasename(workspacePolicy.sourcePath) : "MINIMAX.md missing"}
          </Text>
          <Text color="magentaBright">
            Hooks: {workspacePolicy.hookFiles.length === 0 ? "none" : `${workspacePolicy.hookFiles.length} file(s)`}
          </Text>
          <Text color="greenBright" bold>
            Recent activity
          </Text>
          <Text color="greenBright">{recentActivity}</Text>
        </Box>
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
        <Text dimColor>
          Follow: {isPinnedToBottom ? "on" : "off"} | Pinned: {isPinnedToBottom ? "bottom" : "free"} | View:{" "}
          {sanitizedMessages.length === 0
            ? "0-0"
            : `${visibleMessages.start + 1}-${visibleMessages.end}`} / {sanitizedMessages.length}
        </Text>
        <Text dimColor>
          {visibleMessages.end < sanitizedMessages.length ? "More below" : isPinnedToBottom ? "Pinned to latest" : "Manual scroll"}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {visibleMessages.items.map((message, index) => {
          const isAssistant = message.role === "assistant";
          const label = isAssistant ? "assistant" : "you";
          return (
            <Box key={`${label}-${visibleMessages.start + index}`} flexDirection="column">
              <Text color={isAssistant ? "green" : "yellow"} bold>
                {label}
              </Text>
              <Text wrap="wrap">
                {sanitizeDisplayText(message.content) || (isAssistant && isSending ? "..." : "")}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column">
        <Text color="magenta" bold>
          prompt
        </Text>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
          {renderDraft(draft, stdout.columns ?? 80)}
        </Box>
        <Text dimColor>
          PgUp/PgDn or Up/Down to scroll message history. Type /resume to pick a saved session.
        </Text>
      </Box>

      {isSlashPickerOpen ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="cyan">
          <Box paddingX={1}>
            <Text color="cyanBright" bold>
              Slash Commands
            </Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>
              {filteredSlashCommands.length === 0
                ? "No matching commands."
                : `${filteredSlashCommands.length} command(s) available`}
            </Text>
          </Box>
          {filteredSlashCommands.length === 0 ? (
            <Box paddingX={1} paddingBottom={1}>
              <Text dimColor>Try typing more of a command name.</Text>
            </Box>
          ) : (
            filteredSlashCommands.map((command, index) => {
              const selected = index === slashPickerIndex;
              return (
                <Box key={command.name} paddingX={1}>
                  <Text
                    color={selected ? "black" : "cyanBright"}
                    backgroundColor={selected ? "cyan" : undefined}
                    bold={selected}
                  >
                    {selected ? ">" : " "} /{command.name}
                  </Text>
                  <Text dimColor>
                    {" "}
                    {command.description}
                  </Text>
                </Box>
              );
            })
          )}
          <Box paddingX={1} paddingBottom={1}>
            <Text dimColor>
              Up/Down to choose, Enter to insert, Esc to cancel.
            </Text>
          </Box>
        </Box>
      ) : null}

      {isSessionPickerOpen ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="yellow">
          <Box paddingX={1}>
            <Text color="yellowBright" bold>
              Resume Session
            </Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>
              {sessionPickerLoading ? "Loading sessions..." : `${sessionSummaries.length} saved session(s)`}
            </Text>
          </Box>
          {sessionSummaries.length === 0 ? (
            <Box paddingX={1} paddingBottom={1}>
              <Text dimColor>No saved sessions yet.</Text>
            </Box>
          ) : (
            sessionSummaries.slice(0, 8).map((session, index) => {
              const selected = index === sessionPickerIndex;
              return (
                <Box key={session.id} paddingX={1}>
                  <Text
                    color={selected ? "black" : "yellowBright"}
                    backgroundColor={selected ? "yellow" : undefined}
                    bold={selected}
                  >
                    {selected ? ">" : " "} /resume {session.id.slice(0, 8)}
                  </Text>
                  <Text dimColor>
                    {" "}
                    {session.title} | {session.messageCount} msgs | {session.updatedAt}
                  </Text>
                </Box>
              );
            })
          )}
          <Box paddingX={1} paddingBottom={1}>
            <Text dimColor>
              Up/Down to choose, Enter to resume, Esc to cancel.
            </Text>
          </Box>
        </Box>
      ) : null}

      {isPaletteOpen ? (
        <Box flexDirection="column" marginTop={1} borderStyle="double" borderColor="cyan">
          <Box paddingX={1}>
            <Text color="cyanBright" bold>
              Command Palette
            </Text>
          </Box>
          <Box paddingX={1} paddingBottom={1}>
            {paletteGroups.map((group) => {
              const active = (paletteGroup ?? "All") === group;
              return (
                <Text
                  key={group}
                  color={active ? "black" : "cyanBright"}
                  backgroundColor={active ? "cyan" : undefined}
                  bold={active}
                >
                  {active ? `[${group}]` : ` ${group} `}
                </Text>
              );
            })}
          </Box>
          <Box paddingX={1} paddingBottom={1}>
            <Text color="yellow">Search: {paletteQuery || "all"}</Text>
          </Box>
          {renderPaletteGroups(filteredPaletteActions, paletteIndex)}
          <Box paddingX={1} paddingBottom={1}>
            <Text dimColor>
              Type to filter, Tab to switch groups, Up/Down to move, Enter to run, Esc to close, Ctrl+K to toggle.
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

interface ViewportArgs {
  rows: number;
  draft: string;
  paletteOpen: boolean;
  slashPickerOpen: boolean;
  sessionPickerOpen: boolean;
}

function calculateViewport({
  rows,
  draft,
  paletteOpen,
  slashPickerOpen,
  sessionPickerOpen,
}: ViewportArgs): { pageSize: number } {
  const draftLines = Math.max(1, draft.split("\n").length);
  const baseChrome = 20;
  const paletteChrome = paletteOpen ? 9 : 0;
  const slashPickerChrome = slashPickerOpen ? 8 : 0;
  const sessionPickerChrome = sessionPickerOpen ? 8 : 0;
  const available = rows - baseChrome - paletteChrome - slashPickerChrome - sessionPickerChrome - draftLines;
  return {
    pageSize: Math.max(3, Math.floor(available / 2)),
  };
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content:
      message.role === "assistant"
        ? sanitizeDisplayText(stripThinkBlocks(message.content))
        : sanitizeDisplayText(message.content),
  }));
}

function sanitizeDisplayText(text: string): string {
  return text.replace(/\uFFFD/g, "");
}

function isBackspaceInput(input: string, key: { backspace: boolean; delete: boolean }): boolean {
  return key.backspace || key.delete || input === "\u0008" || input === "\u007f";
}

function sanitizeDraftInput(input: string): string {
  return Array.from(input)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\t") {
        return true;
      }
      if (codePoint < 0x20 || codePoint === 0x7f) {
        return false;
      }
      if (codePoint === 0xfffd) {
        return false;
      }
      if (codePoint >= 0x2500 && codePoint <= 0x257f) {
        return false;
      }
      return true;
    })
    .join("")
    .replace(/\r\n/g, "\n");
}

function removeLastGrapheme(text: string): string {
  if (text.length === 0) {
    return text;
  }

  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "grapheme" });
    const segments = Array.from(segmenter.segment(text));
    segments.pop();
    return segments.map((segment) => segment.segment).join("");
  }

  return Array.from(text).slice(0, -1).join("");
}

function stripThinkBlocks(text: string): string {
  const openTag = "<think>";
  const closeTag = "</think>";
  let index = 0;
  let insideThink = false;
  let output = "";

  while (index < text.length) {
    if (!insideThink) {
      const nextOpen = text.indexOf(openTag, index);
      if (nextOpen === -1) {
        output += text.slice(index);
        break;
      }

      output += text.slice(index, nextOpen);
      index = nextOpen + openTag.length;
      insideThink = true;
      continue;
    }

    const nextClose = text.indexOf(closeTag, index);
    if (nextClose === -1) {
      break;
    }

    index = nextClose + closeTag.length;
    insideThink = false;
  }

  return output.replace(/<\/?think>/gi, "").trimEnd();
}

function composeSystemPrompt(
  config: AppConfig,
  skills: SkillManifest[],
  plugins: PluginRuntimeContext[],
  workspacePolicyPrompt = "",
): string {
  const policyPrompt = workspacePolicyPrompt.trim();
  const modePrompt = getModePrompt(config.mode);
  const pluginPrompt =
    plugins.length > 0
      ? [
          "Active plugins:",
          ...plugins.map((plugin) => {
            return [
              `- ${plugin.displayName} (${plugin.name})${plugin.description ? `: ${plugin.description}` : ""}`,
              ...(plugin.defaultPrompts.length > 0 ? plugin.defaultPrompts.map((prompt) => `  - ${prompt}`) : []),
              ...(plugin.hookSummaries.length > 0 ? ["  hooks:", ...plugin.hookSummaries.map((hook) => `    - ${hook}`)] : []),
              ...(plugin.mcpSummaries.length > 0 ? ["  mcp:", ...plugin.mcpSummaries.map((server) => `    - ${server}`)] : []),
            ].join("\n");
          }),
        ].join("\n")
      : "";
  const skillPrompt =
    skills.length > 0
      ? [
          "Active skills:",
          ...skills.map((skill) => `- ${skill.name}: ${skill.description}\n${skill.instructions}`),
        ].join("\n")
      : "";
  return [config.systemPrompt.trim(), policyPrompt, modePrompt, pluginPrompt, skillPrompt]
    .filter(Boolean)
    .join("\n\n");
}

function getModePrompt(mode: AppConfig["mode"]): string {
  switch (mode) {
    case "plan":
      return "Mode: plan. Focus on clarifying requirements, outlining steps, and avoiding premature implementation.";
    case "agent":
      return [
        "Mode: agent. Be concise, action-oriented, and treat the conversation like an execution workspace.",
        "You can inspect files, edit files, and run non-interactive workspace commands with tools.",
        "Prefer the smallest useful command, avoid destructive actions unless clearly requested, and report what changed.",
      ].join(" ");
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

function renderDraft(draft: string, columns: number): React.ReactNode {
  const cleanDraft = sanitizeDraftInput(draft);
  const innerWidth = Math.max(1, columns - 6);
  const lines = cleanDraft.length > 0 ? cleanDraft.split("\n") : [""];
  return lines.map((line, index) => (
    <Text key={`${index}-${line}`} wrap="truncate-end">
      {padDraftLine(index === lines.length - 1 ? `${line}█` : line, innerWidth)}
    </Text>
  ));
}

function padDraftLine(text: string, width: number): string {
  const clipped = sliceDraftLine(text, width);
  const padding = Math.max(0, width - measureDraftWidth(clipped));
  return `${clipped}${" ".repeat(padding)}`;
}

function sliceDraftLine(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let visibleWidth = 0;
  let output = "";
  for (const character of Array.from(text)) {
    const characterWidth = measureCharacterWidth(character);
    if (visibleWidth + characterWidth > width) {
      break;
    }
    visibleWidth += characterWidth;
    output += character;
  }

  return output;
}

function measureDraftWidth(text: string): number {
  let width = 0;
  for (const character of Array.from(text)) {
    width += measureCharacterWidth(character);
  }
  return width;
}

function measureCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0) {
    return 0;
  }

  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }

  return 1;
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
