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
  treeLines: string[];
  importLines: string[];
  signatureLines: string[];
}

export async function loadWorkspaceIndexContext(startDir = process.cwd()): Promise<WorkspaceIndexContext> {
  const policy = await loadWorkspacePolicyContext(startDir);
  const rootDir = policy.sourcePath ? path.dirname(policy.sourcePath) : path.resolve(startDir);
  const files = await collectWorkspaceFiles(rootDir);
  const codeFiles = files.filter((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const treeLines = buildTreeLines(rootDir, files);
  const [importLines, signatureLines] = await Promise.all([
    buildImportLines(rootDir, codeFiles),
    buildSignatureLines(rootDir, codeFiles),
  ]);

  return {
    rootDir,
    fileCount: files.length,
    codeFileCount: codeFiles.length,
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
  ].join("\n"));

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
