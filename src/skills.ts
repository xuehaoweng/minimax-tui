import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadWorkspacePolicyContext } from "./workspace-policy.js";
import type { SkillManifest, SkillSummary } from "./types.js";

const execFileAsync = promisify(execFile);

export function getSkillsDir(): string {
  return path.join(os.homedir(), ".minimax-tui", "skills");
}

export async function listInstalledSkills(): Promise<SkillSummary[]> {
  await fs.mkdir(getSkillsDir(), { recursive: true });
  const entries = await fs.readdir(getSkillsDir(), { withFileTypes: true });
  const results: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = path.join(getSkillsDir(), entry.name, "SKILL.md");
    try {
      const raw = await fs.readFile(skillPath, "utf8");
      results.push({
        name: entry.name,
        description: extractSkillDescription(raw) ?? "No description",
        installedAt: (await fs.stat(skillPath)).mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export async function installSkillFromPath(sourcePath: string): Promise<SkillManifest> {
  await loadWorkspacePolicyContext();
  const resolved = await resolveSkillSource(sourcePath);
  const skillFile = await findSkillFile(resolved.skillRoot);
  if (!skillFile) {
    throw new Error(`SKILL.md not found in ${sourcePath}`);
  }

  const skillRoot = path.dirname(skillFile);
  const raw = await fs.readFile(skillFile, "utf8");
  const name = sanitizeSkillName(extractSkillName(raw) ?? path.basename(skillRoot));
  const destinationDir = path.join(getSkillsDir(), name);

  await fs.mkdir(getSkillsDir(), { recursive: true });
  await fs.rm(destinationDir, { recursive: true, force: true });
  await copySkillTree(skillRoot, destinationDir);

  try {
    return await readInstalledSkill(name);
  } finally {
    await resolved.cleanup();
  }
}

export async function removeSkill(name: string): Promise<void> {
  await loadWorkspacePolicyContext();
  const normalized = sanitizeSkillName(name);
  await fs.rm(path.join(getSkillsDir(), normalized), { recursive: true, force: true });
}

export async function loadSkillManifest(name: string): Promise<SkillManifest | null> {
  const normalized = sanitizeSkillName(name);
  const skillFile = path.join(getSkillsDir(), normalized, "SKILL.md");
  try {
    const raw = await fs.readFile(skillFile, "utf8");
    const stat = await fs.stat(skillFile);
    return {
      name: normalized,
      description: extractSkillDescription(raw) ?? "No description",
      instructions: raw.trim(),
      sourcePath: skillFile,
      installedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function loadSkillManifests(names: string[]): Promise<SkillManifest[]> {
  const skills: SkillManifest[] = [];
  for (const name of names) {
    const manifest = await loadSkillManifest(name);
    if (manifest) {
      skills.push(manifest);
    }
  }
  return skills;
}

export async function loadSkillManifestsFromDirectory(rootDir: string): Promise<SkillManifest[]> {
  const manifestPaths = await findSkillFiles(rootDir);
  const manifests: SkillManifest[] = [];
  for (const skillFile of manifestPaths) {
    const raw = await fs.readFile(skillFile, "utf8");
    const stat = await fs.stat(skillFile);
    manifests.push({
      name: sanitizeSkillName(extractSkillName(raw) ?? path.basename(path.dirname(skillFile))),
      description: extractSkillDescription(raw) ?? "No description",
      instructions: raw.trim(),
      sourcePath: skillFile,
      installedAt: stat.mtime.toISOString(),
    });
  }

  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

async function readInstalledSkill(name: string): Promise<SkillManifest> {
  const manifest = await loadSkillManifest(name);
  if (!manifest) {
    throw new Error(`Failed to load installed skill: ${name}`);
  }
  return manifest;
}

async function copySkillTree(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.cp(sourceDir, destinationDir, { recursive: true });
}

async function findSkillFile(rootDir: string): Promise<string | null> {
  const direct = path.join(rootDir, "SKILL.md");
  try {
    const stat = await fs.stat(direct);
    if (stat.isFile()) {
      return direct;
    }
  } catch {
    // Fall through to recursive search.
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const nested = await findSkillFile(path.join(rootDir, entry.name));
    if (nested) {
      return nested;
    }
  }

  return null;
}

async function findSkillFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const direct = path.join(rootDir, "SKILL.md");
  try {
    const stat = await fs.stat(direct);
    if (stat.isFile()) {
      results.push(direct);
    }
  } catch {
    // Ignore missing direct file.
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    results.push(...(await findSkillFiles(path.join(rootDir, entry.name))));
  }

  return results;
}

async function resolveSkillSource(source: string): Promise<{ skillRoot: string; cleanup: () => Promise<void> }> {
  if (looksLikeGithubSource(source)) {
    return cloneGithubSource(source);
  }

  const resolved = path.resolve(source);
  const stat = await fs.stat(resolved);
  const skillRoot = stat.isDirectory() ? resolved : path.dirname(resolved);
  return {
    skillRoot,
    cleanup: async () => {
      return;
    },
  };
}

async function cloneGithubSource(source: string): Promise<{ skillRoot: string; cleanup: () => Promise<void> }> {
  const parsed = parseGithubSource(source);
  if (!parsed) {
    throw new Error(`Unsupported GitHub source: ${source}`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-tui-skill-"));
  const cloneDir = path.join(tempRoot, "repo");
  const cloneArgs = ["clone", "--depth", "1"];
  if (parsed.branch) {
    cloneArgs.push("--branch", parsed.branch);
  }
  cloneArgs.push(parsed.cloneUrl, cloneDir);

  try {
    await execFileAsync("git", cloneArgs, { maxBuffer: 1024 * 1024 });
  } catch (cause) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to clone GitHub repo: ${message}`);
  }

  const skillRoot = parsed.subdir ? path.join(cloneDir, parsed.subdir) : cloneDir;
  return {
    skillRoot,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function looksLikeGithubSource(source: string): boolean {
  return (
    source.startsWith("github:") ||
    source.startsWith("https://github.com/") ||
    source.startsWith("http://github.com/") ||
    source.startsWith("git@github.com:")
  );
}

function parseGithubSource(source: string): { cloneUrl: string; branch?: string; subdir?: string } | null {
  if (source.startsWith("git@github.com:")) {
    return { cloneUrl: source };
  }

  const normalized = source.startsWith("github:")
    ? `https://github.com/${source.slice("github:".length).replace(/^\/+/, "")}`
    : source;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repo = stripGitSuffix(segments[1]);
  let branch: string | undefined;
  let subdir: string | undefined;

  if (segments[2] === "tree" && segments.length >= 4) {
    branch = segments[3];
    const rest = segments.slice(4).join("/");
    subdir = rest.length > 0 ? rest : undefined;
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  return { cloneUrl, branch, subdir };
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function extractSkillName(raw: string): string | null {
  const match = raw.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSkillDescription(raw: string): string | null {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  const nextLine = lines[headingIndex + 1];
  if (!nextLine) {
    return null;
  }

  return nextLine.replace(/^[-*]\s*/, "").slice(0, 160);
}

function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
