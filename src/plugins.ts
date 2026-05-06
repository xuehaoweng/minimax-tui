import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadWorkspacePolicyContext } from "./workspace-policy.js";
import type { PluginManifest, PluginRuntimeContext, PluginSummary, SkillManifest } from "./types.js";
import { loadSkillManifestsFromDirectory } from "./skills.js";

const execFileAsync = promisify(execFile);

export function getPluginsDir(): string {
  return path.join(os.homedir(), ".minimax-tui", "plugins");
}

export async function listInstalledPlugins(): Promise<PluginSummary[]> {
  await fs.mkdir(getPluginsDir(), { recursive: true });
  const entries = await fs.readdir(getPluginsDir(), { withFileTypes: true });
  const results: PluginSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(getPluginsDir(), entry.name);
    const manifest = await loadPluginManifestFromDir(pluginDir);
    if (!manifest) {
      continue;
    }

    const skillCount = await countPluginSkills(pluginDir, manifest);
    const hookCount = await countPluginHooks(pluginDir, manifest);
    const mcpServerCount = await countPluginMcpServers(pluginDir, manifest);
    const stat = await fs.stat(path.join(pluginDir, ".codex-plugin", "plugin.json"));
    results.push({
      name: manifest.name,
      displayName: manifest.interface?.displayName ?? manifest.name,
      description: manifest.description ?? manifest.interface?.shortDescription ?? "No description",
      installedAt: stat.mtime.toISOString(),
      skillCount,
      hookCount,
      mcpServerCount,
    });
  }

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export async function installPluginFromSource(source: string): Promise<PluginManifest> {
  await loadWorkspacePolicyContext();
  const resolved = await resolvePluginSource(source);
  const manifestPath = await findPluginManifest(resolved.pluginRoot);
  if (!manifestPath) {
    throw new Error(`plugin.json not found in ${source}`);
  }

  const manifest = await readPluginManifest(manifestPath);
  const destinationDir = path.join(getPluginsDir(), manifest.name);

  await fs.mkdir(getPluginsDir(), { recursive: true });
  await fs.rm(destinationDir, { recursive: true, force: true });
  await copyPluginTree(resolved.pluginRoot, destinationDir);

  try {
    const installed = await readInstalledPlugin(manifest.name);
    return installed.manifest;
  } finally {
    await resolved.cleanup();
  }
}

export async function removePlugin(name: string): Promise<void> {
  await loadWorkspacePolicyContext();
  const normalized = sanitizePluginName(name);
  await fs.rm(path.join(getPluginsDir(), normalized), { recursive: true, force: true });
}

export async function loadPluginManifest(name: string): Promise<PluginManifest | null> {
  const normalized = sanitizePluginName(name);
  const pluginDir = path.join(getPluginsDir(), normalized);
  return loadPluginManifestFromDir(pluginDir);
}

export async function loadPluginManifests(names: string[]): Promise<PluginManifest[]> {
  const plugins: PluginManifest[] = [];
  for (const name of names) {
    const manifest = await loadPluginManifest(name);
    if (manifest) {
      plugins.push(manifest);
    }
  }
  return plugins;
}

export async function loadPluginSkillManifests(plugin: PluginManifest): Promise<SkillManifest[]> {
  const pluginDir = path.join(getPluginsDir(), plugin.name);
  const skillsPath = plugin.skills ?? "./skills";
  const skillRoot = path.resolve(pluginDir, skillsPath);
  try {
    return await loadSkillManifestsFromDirectory(skillRoot);
  } catch {
    return [];
  }
}

export async function loadPluginRuntimeContext(plugin: PluginManifest): Promise<PluginRuntimeContext> {
  const pluginDir = path.join(getPluginsDir(), plugin.name);
  const displayName = plugin.interface?.displayName ?? plugin.name;
  const description = plugin.description ?? plugin.interface?.shortDescription ?? "No description";
  const [skills, hookSummaries, mcpSummaries] = await Promise.all([
    loadPluginSkillManifests(plugin),
    loadPluginHookSummaries(pluginDir, plugin),
    loadPluginMcpSummaries(pluginDir, plugin),
  ]);

  return {
    name: plugin.name,
    displayName,
    description,
    skills,
    hookSummaries,
    mcpSummaries,
    defaultPrompts: plugin.interface?.defaultPrompt ?? [],
  };
}

async function loadPluginManifestFromDir(pluginDir: string): Promise<PluginManifest | null> {
  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  try {
    return await readPluginManifest(manifestPath);
  } catch {
    return null;
  }
}

async function readInstalledPlugin(name: string): Promise<{ manifest: PluginManifest }> {
  const manifest = await loadPluginManifest(name);
  if (!manifest) {
    throw new Error(`Failed to load installed plugin: ${name}`);
  }

  return { manifest };
}

async function readPluginManifest(manifestPath: string): Promise<PluginManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as PluginManifest;
  if (!parsed.name) {
    throw new Error(`Invalid plugin manifest at ${manifestPath}`);
  }
  return parsed;
}

async function countPluginSkills(pluginDir: string, manifest: PluginManifest): Promise<number> {
  const skillsPath = manifest.skills ?? "./skills";
  const skillRoot = path.resolve(pluginDir, skillsPath);
  try {
    const skills = await loadSkillManifestsFromDirectory(skillRoot);
    return skills.length;
  } catch {
    return 0;
  }
}

async function countPluginHooks(pluginDir: string, manifest: PluginManifest): Promise<number> {
  const hookRoot = await resolvePluginResourcePath(pluginDir, manifest.hooks, ["./hooks", "./hooks.json"]);
  if (!hookRoot) {
    return 0;
  }

  try {
    const stat = await fs.stat(hookRoot);
    if (stat.isFile()) {
      return 1;
    }

    return await countFiles(hookRoot);
  } catch {
    return 0;
  }
}

async function countPluginMcpServers(pluginDir: string, manifest: PluginManifest): Promise<number> {
  const mcpRoot = await resolvePluginResourcePath(pluginDir, manifest.mcpServers, ["./.mcp.json", "./mcp.json"]);
  if (!mcpRoot) {
    return 0;
  }

  try {
    const raw = await fs.readFile(mcpRoot, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {}).length;
  } catch {
    return 0;
  }
}

async function loadPluginHookSummaries(pluginDir: string, manifest: PluginManifest): Promise<string[]> {
  const hookRoot = await resolvePluginResourcePath(pluginDir, manifest.hooks, ["./hooks", "./hooks.json"]);
  if (!hookRoot) {
    return [];
  }

  try {
    const stat = await fs.stat(hookRoot);
    if (stat.isFile()) {
      return [`hooks: ${path.relative(pluginDir, hookRoot)}`];
    }

    const files = await listFilesRecursive(hookRoot);
    return files.length > 0 ? files.map((file) => `hooks: ${path.relative(pluginDir, file)}`) : [`hooks: ${path.relative(pluginDir, hookRoot)} (empty)`];
  } catch {
    return [];
  }
}

async function loadPluginMcpSummaries(pluginDir: string, manifest: PluginManifest): Promise<string[]> {
  const mcpRoot = await resolvePluginResourcePath(pluginDir, manifest.mcpServers, ["./.mcp.json", "./mcp.json"]);
  if (!mcpRoot) {
    return [];
  }

  try {
    const raw = await fs.readFile(mcpRoot, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const names = Object.keys(parsed.mcpServers ?? {});
    return names.length > 0 ? names.map((name) => `mcp: ${name}`) : [`mcp: ${path.relative(pluginDir, mcpRoot)} (empty)`];
  } catch {
    return [];
  }
}

async function countFiles(rootDir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(child);
      continue;
    }
    total += 1;
  }
  return total;
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(child)));
      continue;
    }
    files.push(child);
  }
  return files;
}

async function resolvePluginResourcePath(
  pluginDir: string,
  configuredPath: string | undefined,
  fallbackPaths: string[],
): Promise<string | null> {
  const candidates = [
    ...(configuredPath ? [configuredPath] : []),
    ...fallbackPaths,
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(pluginDir, candidate);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile() || stat.isDirectory()) {
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function copyPluginTree(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.cp(sourceDir, destinationDir, { recursive: true });
}

async function findPluginManifest(rootDir: string): Promise<string | null> {
  const direct = path.join(rootDir, ".codex-plugin", "plugin.json");
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

    const nested = await findPluginManifest(path.join(rootDir, entry.name));
    if (nested) {
      return nested;
    }
  }

  return null;
}

async function findPluginManifestUpward(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const direct = path.join(current, ".codex-plugin", "plugin.json");
    try {
      const stat = await fs.stat(direct);
      if (stat.isFile()) {
        return direct;
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

async function resolvePluginSource(source: string): Promise<{ pluginRoot: string; cleanup: () => Promise<void> }> {
  if (looksLikeGithubSource(source)) {
    return cloneGithubSource(source);
  }

  const resolved = path.resolve(source);
  const stat = await fs.stat(resolved);
  const rootDir = stat.isDirectory() ? resolved : path.dirname(resolved);
  const upwardManifest = await findPluginManifestUpward(rootDir);
  if (upwardManifest) {
    return {
      pluginRoot: path.dirname(path.dirname(upwardManifest)),
      cleanup: async () => {
        return;
      },
    };
  }

  const downwardManifest = await findPluginManifest(rootDir);
  if (downwardManifest) {
    return {
      pluginRoot: path.dirname(path.dirname(downwardManifest)),
      cleanup: async () => {
        return;
      },
    };
  }

  return {
    pluginRoot: rootDir,
    cleanup: async () => {
      return;
    },
  };
}

async function cloneGithubSource(source: string): Promise<{ pluginRoot: string; cleanup: () => Promise<void> }> {
  const parsed = parseGithubSource(source);
  if (!parsed) {
    throw new Error(`Unsupported GitHub source: ${source}`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-tui-plugin-"));
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

  const pluginRoot = parsed.subdir ? path.join(cloneDir, parsed.subdir) : cloneDir;
  return {
    pluginRoot,
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

function sanitizePluginName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
