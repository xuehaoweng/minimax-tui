#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import {
  normalizeConfigKey,
  parseConfigAssignment,
  readAppConfig,
} from "./config.js";
import { App } from "./ui/App.js";
import { ConfigWizard } from "./ui/ConfigWizard.js";
import {
  clearConversationState,
  createConversationSession,
  getSettingPath,
  listConversationSessions,
  loadConversationSession,
  loadStoredConfig,
  saveStoredConfig,
  saveConversationSession,
} from "./storage.js";
import { installSkillFromPath, listInstalledSkills, removeSkill } from "./skills.js";
import { installPluginFromSource, listInstalledPlugins, removePlugin } from "./plugins.js";
import type { AppConfig } from "./types.js";

function printHelp() {
  process.stdout.write(`minimax-tui

Usage:
  minimax-tui [--api-key KEY] [--base-url URL] [--model MODEL]
  minimax-tui config
  minimax-tui config path
  minimax-tui config list
  minimax-tui config get <key>
  minimax-tui config set <key> <value>
  minimax-tui sessions list
  minimax-tui sessions resume <session-id>
  minimax-tui history clear
  minimax-tui skills list
  minimax-tui skills install <path>
  minimax-tui skills remove <name>
  minimax-tui plugins list
  minimax-tui plugins install <path-or-github-url>
  minimax-tui plugins remove <name>
  minimax-tui plugins active
  minimax-tui plugins use <name>
`);
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const command = argv[0];
  if (command === "config") {
    await handleConfigCommand(argv.slice(1));
    return;
  }

  if (command === "history") {
    await handleHistoryCommand(argv.slice(1));
    return;
  }

  if (command === "sessions") {
    await handleSessionsCommand(argv.slice(1));
    return;
  }

  if (command === "skills") {
    await handleSkillsCommand(argv.slice(1));
    return;
  }

  if (command === "plugins") {
    await handlePluginsCommand(argv.slice(1));
    return;
  }

  const config = await readAppConfig(argv);
  if (!config) {
    const stored = await loadStoredConfig();
    const wizard = render(
      React.createElement(ConfigWizard, {
        initialConfig: stored,
      }),
    );
    await wizard.waitUntilExit();

    const retryConfig = await readAppConfig(argv);
    if (!retryConfig) {
      process.stderr.write(
        "Missing API key. Run `minimax-tui config` or `minimax-tui config set apikey <value>`.\n",
      );
      process.exitCode = 1;
      return;
    }

    await startChat(retryConfig);
    return;
  }

  await startChat(config);
}

async function startChat(config: AppConfig) {
  const session = await createConversationSession();
  render(
    React.createElement(App, {
      config,
      initialSession: session,
      onConfigChange: async (patch) => {
        const current = await loadStoredConfig();
        await saveStoredConfig({ ...current, ...patch });
      },
    }),
  );
}

async function handleConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const stored = await loadStoredConfig();

  if (!subcommand || subcommand === "edit" || subcommand === "interactive") {
    render(
      React.createElement(ConfigWizard, {
        initialConfig: stored,
      }),
    );
    return;
  }

  if (subcommand === "path") {
    process.stdout.write(`${getSettingPath()}\n`);
    return;
  }

  if (subcommand === "list") {
    const entries = Object.entries(stored).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      process.stdout.write("No saved config yet.\n");
      return;
    }

    for (const [key, value] of entries) {
      process.stdout.write(`${key}: ${String(value)}\n`);
    }
    return;
  }

  if (subcommand === "get") {
    const key = normalizeConfigKey(args[1] ?? "");
    if (!key) {
      throw new Error("Usage: minimax-tui config get <key>");
    }

    const value = stored[key as keyof typeof stored];
    if (value === undefined) {
      process.stdout.write("\n");
      return;
    }

    process.stdout.write(`${String(value)}\n`);
    return;
  }

  if (subcommand === "set") {
    const key = normalizeConfigKey(args[1] ?? "");
    const value = args[2];
    if (!key || value === undefined) {
      throw new Error("Usage: minimax-tui config set <key> <value>");
    }

    const patch = parseConfigAssignment(key, value);
    if (!patch) {
      throw new Error(`Unsupported config key: ${key}`);
    }

    await saveStoredConfig({ ...stored, ...patch });
    process.stdout.write(`Saved ${key}.\n`);
    return;
  }

  throw new Error(`Unknown config subcommand: ${subcommand}`);
}

async function handleHistoryCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "clear") {
    await clearConversationState();
    process.stdout.write("History cleared.\n");
    return;
  }

  throw new Error("Usage: minimax-tui history clear");
}

async function handleSessionsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "list") {
    const sessions = await listConversationSessions();
    if (sessions.length === 0) {
      process.stdout.write("No saved sessions yet.\n");
      return;
    }

    for (const session of sessions) {
      process.stdout.write(
        `${session.id}\t${session.title}\t${session.messageCount} messages\t${session.updatedAt}\n`,
      );
    }
    return;
  }

  if (subcommand === "resume") {
    const sessionId = args[1];
    if (!sessionId) {
      throw new Error("Usage: minimax-tui sessions resume <session-id>");
    }

    const session = await loadConversationSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    process.stdout.write(
      `${session.id}\t${session.title}\t${session.messages.length} messages\t${session.updatedAt}\n`,
    );
    return;
  }

  throw new Error("Usage: minimax-tui sessions [list|resume <session-id>]");
}

async function handleSkillsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "list") {
    const skills = await listInstalledSkills();
    if (skills.length === 0) {
      process.stdout.write("No installed skills yet.\n");
      return;
    }

    for (const skill of skills) {
      process.stdout.write(`${skill.name}\t${skill.description}\t${skill.installedAt}\n`);
    }
    return;
  }

  if (subcommand === "install") {
    const sourcePath = args[1];
    if (!sourcePath) {
      throw new Error("Usage: minimax-tui skills install <path>");
    }

    const skill = await installSkillFromPath(sourcePath);
    process.stdout.write(`Installed ${skill.name}.\n`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: minimax-tui skills remove <name>");
    }

    await removeSkill(name);
    process.stdout.write(`Removed ${name}.\n`);
    return;
  }

  throw new Error("Usage: minimax-tui skills [list|install <path>|remove <name>]");
}

async function handlePluginsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "list") {
    const plugins = await listInstalledPlugins();
    if (plugins.length === 0) {
      process.stdout.write("No installed plugins yet.\n");
      return;
    }

    for (const plugin of plugins) {
      process.stdout.write(
        `${plugin.name}\t${plugin.displayName}\t${plugin.skillCount} skills\t${plugin.installedAt}\n`,
      );
    }
    return;
  }

  if (subcommand === "install") {
    const sourcePath = args[1];
    if (!sourcePath) {
      throw new Error("Usage: minimax-tui plugins install <path-or-github-url>");
    }

    const plugin = await installPluginFromSource(sourcePath);
    process.stdout.write(`Installed ${plugin.name}.\n`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: minimax-tui plugins remove <name>");
    }

    await removePlugin(name);
    const session = await loadConversationSession();
    if (session) {
      const nextActive = (session.activePlugins ?? []).filter((pluginName) => pluginName !== name.toLowerCase());
      await saveConversationSession({ ...session, activePlugins: nextActive }, true);
    }
    process.stdout.write(`Removed ${name}.\n`);
    return;
  }

  if (subcommand === "active") {
    const session = await loadConversationSession();
    const active = session?.activePlugins ?? [];
    process.stdout.write(`${active.length === 0 ? "No active plugins." : active.join("\n")}\n`);
    return;
  }

  if (subcommand === "use") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: minimax-tui plugins use <name>");
    }

    const plugin = await loadConversationSession();
    if (!plugin) {
      throw new Error("No current session found.");
    }

    const nextActive = Array.from(new Set([...(plugin.activePlugins ?? []), name.toLowerCase()]));
    await saveConversationSession({ ...plugin, activePlugins: nextActive }, true);
    process.stdout.write(`Activated ${name} in current session.\n`);
    return;
  }

  throw new Error("Usage: minimax-tui plugins [list|install <path-or-github-url>|remove <name>|active|use <name>]");
}
