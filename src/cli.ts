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
  getSettingPath,
  loadConversationState,
  loadStoredConfig,
  saveStoredConfig,
} from "./storage.js";
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
  minimax-tui history clear
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
  const session = await loadConversationState();
  render(
    React.createElement(App, {
      config,
      initialMessages: session.messages,
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
