import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitStatus(cwd = process.cwd()): Promise<string> {
  return runGit(["status", "--short", "--branch"], cwd);
}

export async function gitDiff(cwd = process.cwd(), staged = false, paths: string[] = []): Promise<string> {
  const args = ["diff"];
  if (staged) {
    args.push("--staged");
  }
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  return runGit(args, cwd);
}

export async function gitLog(cwd = process.cwd(), count = 10): Promise<string> {
  return runGit(["log", `--max-count=${Math.max(1, Math.min(count, 50))}`, "--oneline", "--decorate"], cwd);
}

export async function gitBranch(cwd = process.cwd()): Promise<string> {
  return runGit(["branch", "--all", "--verbose", "--no-abbrev"], cwd);
}

export async function gitAdd(cwd = process.cwd(), paths: string[]): Promise<string> {
  if (paths.length === 0) {
    throw new Error("At least one path is required.");
  }
  await runGit(["add", "--", ...paths], cwd);
  return `Staged ${paths.join(", ")}`;
}

export async function gitCommit(cwd = process.cwd(), message: string, all = false): Promise<string> {
  if (!message.trim()) {
    throw new Error("Commit message is required.");
  }

  const args = ["commit", "-m", message];
  if (all) {
    args.splice(1, 0, "-a");
  }

  return runGit(args, cwd);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: normalizeCwd(cwd),
    maxBuffer: 1024 * 1024,
  });
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}
