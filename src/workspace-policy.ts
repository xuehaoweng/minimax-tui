import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspacePolicyContext } from "./types.js";

const HOOK_DIR_CANDIDATES = ["hooks", ".minimax/hooks"];
const HOOK_FILE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

export async function loadWorkspacePolicyContext(startDir = process.cwd()): Promise<WorkspacePolicyContext> {
  const sourcePath = await findPolicyPathUpward(startDir);
  if (!sourcePath) {
    return {
      sourcePath: null,
      content: "",
      hookFiles: [],
      hookSummaries: [],
    };
  }

  const policyRoot = path.dirname(sourcePath);
  const content = await fs.readFile(sourcePath, "utf8").catch(() => "");
  const hookFiles = await findHookFiles(policyRoot);
  const hookSummaries = await Promise.all(
    hookFiles.map(async (hookFile) => {
      const raw = await fs.readFile(hookFile, "utf8").catch(() => "");
      return `${path.relative(policyRoot, hookFile)}: ${summarizeText(raw)}`;
    }),
  );

  return {
    sourcePath,
    content: content.trim(),
    hookFiles,
    hookSummaries,
  };
}

export function buildWorkspacePolicyPrompt(policy: WorkspacePolicyContext): string {
  const sections: string[] = [];
  if (policy.sourcePath && policy.content.length > 0) {
    sections.push([
      "Workspace policy from MINIMAX.md:",
      `- Source: ${policy.sourcePath}`,
      policy.content,
    ].join("\n"));
  }

  if (policy.hookSummaries.length > 0) {
    sections.push([
      "Workspace hook constraints:",
      ...policy.hookSummaries.map((line) => `- ${line}`),
    ].join("\n"));
  }

  return sections.join("\n\n");
}

async function findPolicyPathUpward(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "MINIMAX.md");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // keep walking upward
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

async function findHookFiles(policyRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const candidate of HOOK_DIR_CANDIDATES) {
    const root = path.join(policyRoot, candidate);
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        continue;
      }
      files.push(...(await walkHookFiles(root)));
    } catch {
      // ignore missing hook dir
    }
  }
  return Array.from(new Set(files)).sort();
}

async function walkHookFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkHookFiles(child)));
      continue;
    }

    if (HOOK_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(child);
    }
  }
  return results;
}

function summarizeText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized || "(empty)";
  }

  return `${normalized.slice(0, maxLength)}...`;
}
