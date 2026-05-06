import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkspacePolicyContext } from "./workspace-policy.js";

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);
const CODE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const INDEX_FILE_EXTENSIONS = new Set([...CODE_FILE_EXTENSIONS, ".md", ".json", ".yaml", ".yml", ".toml"]);

export interface WorkspaceIndexContext {
  rootDir: string;
  fileCount: number;
  codeFileCount: number;
  focusTerms: string[];
  recentFiles: string[];
  focusFiles: string[];
  grepLines: string[];
  treeLines: string[];
  importLines: string[];
  signatureLines: string[];
}

export async function loadWorkspaceIndexContext(
  startDir = process.cwd(),
  focusText = "",
): Promise<WorkspaceIndexContext> {
  const policy = await loadWorkspacePolicyContext(startDir);
  const rootDir = policy.sourcePath ? path.dirname(policy.sourcePath) : path.resolve(startDir);
  const files = await collectWorkspaceFiles(rootDir);
  const codeFiles = files.filter((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const focusTerms = extractFocusTerms(focusText);
  const treeLines = buildTreeLines(rootDir, files);
  const [importLines, signatureLines] = await Promise.all([
    buildImportLines(rootDir, codeFiles),
    buildSignatureLines(rootDir, codeFiles),
  ]);
  const [recentFiles, focusFiles, grepLines] = await Promise.all([
    buildRecentFiles(rootDir, files),
    buildFocusFiles(rootDir, files, focusTerms),
    buildGrepLines(rootDir, files, focusTerms),
  ]);

  return {
    rootDir,
    fileCount: files.length,
    codeFileCount: codeFiles.length,
    focusTerms,
    recentFiles,
    focusFiles,
    grepLines,
    treeLines,
    importLines,
    signatureLines,
  };
}

export function buildWorkspaceIndexPrompt(index: WorkspaceIndexContext): string {
  const sections: string[] = [];

  sections.push([
    "Workspace code index:",
    `- Root: ${index.rootDir}`,
    `- Files: ${index.fileCount}`,
    `- Code files: ${index.codeFileCount}`,
    `- Focus terms: ${index.focusTerms.length > 0 ? index.focusTerms.join(", ") : "none"}`,
  ].join("\n"));

  if (index.recentFiles.length > 0) {
    sections.push(["Recent files:", ...index.recentFiles.map((line) => `- ${line}`)].join("\n"));
  }

  if (index.focusFiles.length > 0) {
    sections.push(["Focus files:", ...index.focusFiles.map((line) => `- ${line}`)].join("\n"));
  }

  if (index.grepLines.length > 0) {
    sections.push(["Grep matches:", ...index.grepLines.map((line) => `- ${line}`)].join("\n"));
  }

  if (index.treeLines.length > 0) {
    sections.push(["File tree:", ...index.treeLines.map((line) => `- ${line}`)].join("\n"));
  }

  if (index.importLines.length > 0) {
    sections.push(["Import graph:", ...index.importLines.map((line) => `- ${line}`)].join("\n"));
  }

  if (index.signatureLines.length > 0) {
    sections.push(["Function signatures:", ...index.signatureLines.map((line) => `- ${line}`)].join("\n"));
  }

  return sections.join("\n\n");
}

function buildTreeLines(rootDir: string, files: string[], maxLines = 40): string[] {
  const treeLines: string[] = [];
  const seenDirs = new Set<string>();

  for (const file of files) {
    const relative = path.relative(rootDir, file);
    const parts = relative.split(path.sep);
    const depth = Math.max(0, parts.length - 1);
    const indent = "  ".repeat(depth);
    const label = parts[parts.length - 1] ?? relative;
    const dirKey = parts.slice(0, -1).join(path.sep);

    for (let index = 0; index < parts.length - 1; index += 1) {
      const segmentKey = parts.slice(0, index + 1).join(path.sep);
      if (seenDirs.has(segmentKey)) {
        continue;
      }
      seenDirs.add(segmentKey);
      const segmentIndent = "  ".repeat(index);
      treeLines.push(`${segmentIndent}${parts[index]}/`);
      if (treeLines.length >= maxLines) {
        return treeLines;
      }
    }

    treeLines.push(`${indent}${label}`);
    if (treeLines.length >= maxLines) {
      return treeLines;
    }

    if (dirKey.length > 0) {
      seenDirs.add(dirKey);
    }
  }

  return treeLines;
}

async function buildImportLines(rootDir: string, files: string[], maxLines = 30): Promise<string[]> {
  const lines: string[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const imports = extractImports(raw);
    if (imports.length === 0) {
      continue;
    }

    const relative = path.relative(rootDir, file);
    lines.push(`${relative} -> ${imports.join(", ")}`);
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines;
}

async function buildSignatureLines(rootDir: string, files: string[], maxLines = 30): Promise<string[]> {
  const lines: string[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const signatures = extractSignatures(raw);
    if (signatures.length === 0) {
      continue;
    }

    const relative = path.relative(rootDir, file);
    lines.push(`${relative}: ${signatures.join(" | ")}`);
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines;
}

async function buildRecentFiles(rootDir: string, files: string[], maxLines = 10): Promise<string[]> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat
        ? {
            file,
            mtime: stat.mtimeMs,
          }
        : null;
    }),
  );

  return entries
    .filter((entry): entry is { file: string; mtime: number } => entry !== null)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, maxLines)
    .map((entry) => `${path.relative(rootDir, entry.file)} (${new Date(entry.mtime).toISOString()})`);
}

async function buildFocusFiles(rootDir: string, files: string[], focusTerms: string[], maxLines = 12): Promise<string[]> {
  if (focusTerms.length === 0) {
    return [];
  }

  const matches: string[] = [];
  for (const file of files) {
    const relative = path.relative(rootDir, file);
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const haystack = `${relative}\n${raw}`.toLowerCase();
    if (focusTerms.some((term) => haystack.includes(term))) {
      matches.push(relative);
    }
    if (matches.length >= maxLines) {
      break;
    }
  }

  return matches;
}

async function buildGrepLines(rootDir: string, files: string[], focusTerms: string[], maxLines = 20): Promise<string[]> {
  if (focusTerms.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }

    const matches = extractLineMatches(raw, focusTerms);
    if (matches.length === 0) {
      continue;
    }

    const relative = path.relative(rootDir, file);
    for (const match of matches) {
      lines.push(`${relative}:${match.line} ${match.snippet}`);
      if (lines.length >= maxLines) {
        return lines;
      }
    }
  }

  return lines;
}

async function collectWorkspaceFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkWorkspace(rootDir, files);
  return files.sort();
}

async function walkWorkspace(rootDir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".minimax") {
      const policyDir = path.join(rootDir, entry.name);
      const nestedEntries = await fs.readdir(policyDir, { withFileTypes: true }).catch(() => []);
      for (const nested of nestedEntries) {
        const nestedPath = path.join(policyDir, nested.name);
        if (nested.isDirectory()) {
          await walkWorkspace(nestedPath, files);
          continue;
        }
        if (INDEX_FILE_EXTENSIONS.has(path.extname(nested.name).toLowerCase())) {
          files.push(nestedPath);
        }
      }
      continue;
    }

    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const child = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkWorkspace(child, files);
      continue;
    }

    if (INDEX_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
}

function extractImports(raw: string): string[] {
  const imports = new Set<string>();
  const importPattern = /^\s*import\s+.*?from\s+["']([^"']+)["']/gm;
  const exportPattern = /^\s*export\s+\*\s+from\s+["']([^"']+)["']/gm;
  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']/gm;

  for (const pattern of [importPattern, exportPattern, sideEffectPattern]) {
    for (const match of raw.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  }

  return Array.from(imports).slice(0, 8);
}

function extractSignatures(raw: string): string[] {
  const signatures = new Set<string>();
  const functionPattern = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm;
  const plainFunctionPattern = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm;
  const arrowPattern = /^\s*export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/gm;

  for (const pattern of [functionPattern, plainFunctionPattern, arrowPattern]) {
    for (const match of raw.matchAll(pattern)) {
      const name = match[1];
      const params = normalizeSignatureParams(match[2] ?? "");
      if (name) {
        signatures.add(`${name}(${params})`);
      }
    }
  }

  return Array.from(signatures).slice(0, 8);
}

function normalizeSignatureParams(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  return parts
    .map((part) => {
      const [name] = part.split(":", 1);
      return name.replace(/\?$/, "").trim();
    })
    .join(", ");
}

function extractFocusTerms(text: string): string[] {
  const rawTerms = text
    .split(/[^A-Za-z0-9_.\/-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  return Array.from(new Set(rawTerms.map((term) => term.toLowerCase()))).slice(0, 8);
}

function extractLineMatches(raw: string, focusTerms: string[]): Array<{ line: number; snippet: string }> {
  const matches: Array<{ line: number; snippet: string }> = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    if (!focusTerms.some((term) => lower.includes(term))) {
      continue;
    }

    const snippet = line.trim().slice(0, 140);
    matches.push({ line: index + 1, snippet: snippet.length > 0 ? snippet : "(empty)" });
    if (matches.length >= 3) {
      break;
    }
  }

  return matches;
}
