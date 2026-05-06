import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SkillManifest, SkillSummary } from "./types.js";

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
  const resolved = path.resolve(sourcePath);
  const stat = await fs.stat(resolved);
  const skillRoot = stat.isDirectory() ? resolved : path.dirname(resolved);
  const skillFile = await findSkillFile(skillRoot);
  if (!skillFile) {
    throw new Error(`SKILL.md not found in ${resolved}`);
  }

  const raw = await fs.readFile(skillFile, "utf8");
  const name = sanitizeSkillName(extractSkillName(raw) ?? path.basename(skillRoot));
  const destinationDir = path.join(getSkillsDir(), name);

  await fs.mkdir(getSkillsDir(), { recursive: true });
  await fs.rm(destinationDir, { recursive: true, force: true });
  await copySkillTree(skillRoot, destinationDir);

  return readInstalledSkill(name);
}

export async function removeSkill(name: string): Promise<void> {
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
    return null;
  }
  return null;
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
