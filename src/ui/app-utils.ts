import { Text } from "ink";
import React from "react";
import type { AppConfig, ChatMessage } from "../types.js";

export interface ViewportArgs {
  rows: number;
  draft: string;
  paletteOpen: boolean;
  slashPickerOpen: boolean;
  sessionPickerOpen: boolean;
  taskPanelOpen: boolean;
}

export function calculateViewport({
  rows,
  draft,
  paletteOpen,
  slashPickerOpen,
  sessionPickerOpen,
  taskPanelOpen,
}: ViewportArgs): { pageSize: number } {
  const draftLines = Math.max(1, draft.split("\n").length);
  const baseChrome = 20;
  const paletteChrome = paletteOpen ? 9 : 0;
  const slashPickerChrome = slashPickerOpen ? 8 : 0;
  const sessionPickerChrome = sessionPickerOpen ? 8 : 0;
  const taskPanelChrome = taskPanelOpen ? 15 : 0;
  const available = rows - baseChrome - paletteChrome - slashPickerChrome - sessionPickerChrome - taskPanelChrome - draftLines;
  return {
    pageSize: Math.max(3, Math.floor(available / 2)),
  };
}

export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content:
      message.role === "assistant"
        ? sanitizeDisplayText(stripThinkBlocks(message.content))
        : sanitizeDisplayText(message.content),
  }));
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(/\uFFFD/g, "");
}

export function isBackspaceInput(input: string, key: { backspace: boolean; delete: boolean }): boolean {
  return key.backspace || key.delete || input === "\u0008" || input === "\u007f";
}

export function sanitizeDraftInput(input: string): string {
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

export function removeLastGrapheme(text: string): string {
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

export function stripThinkBlocks(text: string): string {
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

export function parseMode(value: string): AppConfig["mode"] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat" || normalized === "plan" || normalized === "agent") {
    return normalized;
  }
  return null;
}

export function shouldUseAgentForWorkspaceTask(input: string): boolean {
  const text = input.toLowerCase().trim();
  if (!text) {
    return false;
  }

  const workspaceIntentPatterns = [
    /创建.*文件/,
    /新建.*文件/,
    /写入.*文件/,
    /修改.*文件/,
    /编辑.*文件/,
    /更新.*文件/,
    /在当前目录.*(创建|新建|写入|修改|编辑)/,
    /\bcreate\b.*\bfile\b/,
    /\bnew\b.*\bfile\b/,
    /\bwrite\b.*\bfile\b/,
    /\bmodify\b.*\bfile\b/,
    /\bedit\b.*\bfile\b/,
    /\bupdate\b.*\bfile\b/,
  ];

  return workspaceIntentPatterns.some((pattern) => pattern.test(text));
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function renderDraft(draft: string, columns: number): React.ReactNode {
  const cleanDraft = sanitizeDraftInput(draft);
  const innerWidth = Math.max(1, columns - 6);
  const lines = cleanDraft.length > 0 ? cleanDraft.split("\n") : [""];
  return lines.map((line, index) =>
    React.createElement(
      Text,
      { key: `${index}-${line}`, wrap: "truncate-end" },
      padDraftLine(index === lines.length - 1 ? `${line}█` : line, innerWidth),
    ),
  );
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
