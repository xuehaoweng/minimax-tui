import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
]);

export const DEFAULT_TEXT_FILE_LIMIT_BYTES = 1024 * 1024;

export function resolveWorkspacePath(relativePath: string, rootDir = process.cwd()): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath || ".");
  assertInsideWorkspace(resolved, root);
  return resolved;
}

export function assertInsideWorkspace(targetPath: string, rootDir = process.cwd()): void {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(targetPath);
  const relative = path.relative(root, resolved);
  if (relative === "") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes workspace root.");
  }
}

export function isIgnoredWorkspaceEntry(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name);
}

export async function readTextFileLimited(
  filePath: string,
  maxBytes = DEFAULT_TEXT_FILE_LIMIT_BYTES,
): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (stat.size > maxBytes) {
    throw new Error(`File too large to read safely (${stat.size} bytes, limit ${maxBytes}).`);
  }

  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    throw new Error("Refusing to read binary file.");
  }
  return buffer.toString("utf8");
}

export async function readTextFileLimitedOrEmpty(filePath: string): Promise<string> {
  try {
    return await readTextFileLimited(filePath);
  } catch {
    return "";
  }
}
