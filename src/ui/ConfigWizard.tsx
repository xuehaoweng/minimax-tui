import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useMemo, useState } from "react";
import { normalizeMode } from "../config.js";
import { getSettingPath, saveStoredConfig } from "../storage.js";
import type { StoredConfig } from "../types.js";

type FieldKey =
  | "apiKey"
  | "baseUrl"
  | "model"
  | "mode"
  | "systemPrompt"
  | "temperature"
  | "maxTokens";

interface Field {
  key: FieldKey;
  label: string;
  hint: string;
  placeholder: string;
}

const FIELDS: Field[] = [
  {
    key: "apiKey",
    label: "API key",
    hint: "Leave blank to keep the current value.",
    placeholder: "configured",
  },
  {
    key: "baseUrl",
    label: "Base URL",
    hint: "Default is https://api.minimax.io",
    placeholder: "https://api.minimax.io",
  },
  {
    key: "model",
    label: "Model",
    hint: "Default is MiniMax-M2.7",
    placeholder: "MiniMax-M2.7",
  },
  {
    key: "mode",
    label: "Mode",
    hint: "chat, plan, or agent",
    placeholder: "chat",
  },
  {
    key: "systemPrompt",
    label: "System prompt",
    hint: "Optional default instruction for every chat.",
    placeholder: "You are a helpful assistant.",
  },
  {
    key: "temperature",
    label: "Temperature",
    hint: "Number from 0 to 2.",
    placeholder: "1",
  },
  {
    key: "maxTokens",
    label: "Max tokens",
    hint: "Maximum completion tokens for a single reply.",
    placeholder: "1024",
  },
];

interface ConfigWizardProps {
  initialConfig: StoredConfig;
}

export function ConfigWizard({ initialConfig }: ConfigWizardProps) {
  const { exit } = useApp();
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<StoredConfig>(initialConfig);
  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState("Interactive settings");
  const [error, setError] = useState<string | null>(null);
  const currentField = FIELDS[stepIndex];
  const isApiKeyRequired = !initialConfig.apiKey;

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  useEffect(() => {
    if (!currentField) {
      return;
    }

    setError(null);
    setInputValue(getInitialValue(currentField.key, draft));
  }, [
    currentField,
    draft.apiKey,
    draft.baseUrl,
    draft.model,
    draft.mode,
    draft.systemPrompt,
    draft.temperature,
    draft.maxTokens,
  ]);

  const summary = useMemo(() => {
    return {
      apiKey: draft.apiKey ? "configured" : "not set",
      baseUrl: draft.baseUrl ?? "https://api.minimax.io",
      model: draft.model ?? "MiniMax-M2.7",
      mode: draft.mode ?? "chat",
      systemPrompt: draft.systemPrompt ? "configured" : "default",
      temperature: draft.temperature?.toString() ?? "1",
      maxTokens: draft.maxTokens?.toString() ?? "1024",
    };
  }, [
    draft.apiKey,
    draft.baseUrl,
    draft.model,
    draft.mode,
    draft.systemPrompt,
    draft.temperature,
    draft.maxTokens,
  ]);

  const submit = async (value: string) => {
    if (!currentField) {
      return;
    }

    const nextValue = value.trim();
    const nextDraft = { ...draft };

    if (currentField.key === "apiKey") {
      if (nextValue) {
        nextDraft.apiKey = nextValue;
      } else if (isApiKeyRequired) {
        setError("API key is required on first setup.");
        return;
      }
    } else if (currentField.key === "baseUrl") {
      nextDraft.baseUrl = normalizeBaseUrl(nextValue || "https://api.minimax.io");
    } else if (currentField.key === "model") {
      nextDraft.model = nextValue || "MiniMax-M2.7";
    } else if (currentField.key === "mode") {
      const mode = normalizeMode(nextValue || "chat");
      if (!mode) {
        setError("Mode must be chat, plan, or agent.");
        return;
      }
      nextDraft.mode = mode;
    } else if (currentField.key === "systemPrompt") {
      if (nextValue) {
        nextDraft.systemPrompt = nextValue;
      }
    } else if (currentField.key === "temperature") {
      const parsed = Number(nextValue);
      if (Number.isFinite(parsed)) {
        nextDraft.temperature = parsed;
      } else if (nextValue) {
        setError("Temperature must be a number.");
        return;
      }
    } else if (currentField.key === "maxTokens") {
      const parsed = Number.parseInt(nextValue, 10);
      if (Number.isFinite(parsed)) {
        nextDraft.maxTokens = parsed;
      } else if (nextValue) {
        setError("Max tokens must be an integer.");
        return;
      }
    }

    setDraft(nextDraft);

    if (stepIndex >= FIELDS.length - 1) {
      setStatus("Saving...");
      await saveStoredConfig(nextDraft);
      setStatus(`Saved to ${getSettingPath()}`);
      exit();
      return;
    }

    setStepIndex((current) => current + 1);
  };

  if (!currentField) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="green">{status}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright" bold>
          minimax-tui settings
        </Text>
        <Text dimColor>
          File: {getSettingPath()}
        </Text>
        <Text dimColor>
          Step {stepIndex + 1} of {FIELDS.length}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow" bold>
          {currentField.label}
        </Text>
        <Text dimColor>{currentField.hint}</Text>
      </Box>

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={submit}
          placeholder={currentField.placeholder}
          focus
          showCursor
        />
      </Box>

      <Box flexDirection="column">
        <Text dimColor>
          Current: apiKey={summary.apiKey}, baseUrl={summary.baseUrl}, model={summary.model}
        </Text>
        <Text dimColor>
          mode={summary.mode}, systemPrompt={summary.systemPrompt}, temperature={summary.temperature}, maxTokens={summary.maxTokens}
        </Text>
        <Text dimColor>
          Press Enter to continue, Ctrl+C to cancel.
        </Text>
      </Box>
    </Box>
  );
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function getInitialValue(key: FieldKey, draft: StoredConfig): string {
  switch (key) {
    case "apiKey":
      return "";
    case "baseUrl":
      return draft.baseUrl ?? "https://api.minimax.io";
    case "model":
      return draft.model ?? "MiniMax-M2.7";
    case "mode":
      return draft.mode ?? "chat";
    case "systemPrompt":
      return draft.systemPrompt ?? "You are a helpful assistant.";
    case "temperature":
      return draft.temperature?.toString() ?? "1";
    case "maxTokens":
      return draft.maxTokens?.toString() ?? "1024";
  }
}
