import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkspacePolicyContext } from "./workspace-policy.js";

export interface InitWorkspaceResult {
  path: string;
  created: boolean;
}

export async function initWorkspacePolicyFile(rootDir = process.cwd()): Promise<InitWorkspaceResult> {
  const policyPath = path.join(rootDir, "MINIMAX.md");
  await loadWorkspacePolicyContext(rootDir);

  try {
    const stat = await fs.stat(policyPath);
    if (stat.isFile()) {
      return {
        path: policyPath,
        created: false,
      };
    }
  } catch {
    // Fall through and create the file.
  }

  await fs.writeFile(policyPath, buildWorkspacePolicyTemplate(rootDir), "utf8");
  return {
    path: policyPath,
    created: true,
  };
}

function buildWorkspacePolicyTemplate(rootDir: string): string {
  const projectName = path.basename(rootDir) || "minimax-tui";
  return `# MINIMAX.md

This file defines the workspace rules for \`${projectName}\`.

## Goal

Build and ship \`${projectName}\` with small, reviewable changes and clear operational rules.

## Priority Order

1. Follow this file first.
2. Follow hook files under \`hooks/\` and \`.minimax/hooks/\`.
3. Preserve user changes and existing project conventions.
4. Prefer the smallest safe edit that solves the problem.

## Operating Rules

- Read this file before any file operation, skill install, plugin install, or agent tool use.
- Read hook files before taking actions that modify files or run workspace tools.
- Keep changes focused, narrow in scope, and easy to review.
- Prefer ASCII edits, TypeScript, and \`apply_patch\` for code changes.
- Do not overwrite user changes unless explicitly asked.
- When something is unclear, inspect the repository first instead of guessing.

## File Workflow

- Before editing, inspect the target file and nearby code paths.
- Before writing, confirm the target path still matches the current workspace rules.
- Before deleting or replacing files, verify the impact and prefer a reversible path.
- After making changes, validate with \`npm run build\` unless the task is documentation-only.

## Tooling Rules

- Treat agent file tools and shell commands as workspace actions that must respect this file.
- For command execution, prefer non-interactive commands and capture outputs in the workspace context.
- For file writes, keep generated content deterministic and easy to diff.

## Hooks

Store extra workflow constraints in one of these directories:

- \`hooks/\`
- \`.minimax/hooks/\`

Suggested hook usage:

- \`session-start\`: workspace reminders or setup checks
- \`pre-edit\`: extra safety checks before file changes
- \`pre-tool\`: constraints before commands or tool use
- \`post-tool\`: cleanup or verification after tools run

## Project Notes

- Use \`npm run build\` to verify changes before finishing.
- Keep session and workspace state aligned with this policy file.
- Add project-specific rules below this section.

## Project-Specific Rules

- If this project adds more constraints, put them here instead of overriding the general rules above.
`;
}
