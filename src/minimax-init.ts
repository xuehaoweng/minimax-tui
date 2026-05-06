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

## Operating Rules

- Read this file before any file operation, skill install, plugin install, or agent tool use.
- Check \`hooks/\` and \`.minimax/hooks/\` for additional constraints before acting.
- Keep changes small, focused, and easy to review.
- Prefer ASCII edits, TypeScript, and \`apply_patch\` for code changes.
- Do not overwrite user changes unless explicitly asked.

## File Workflows

- Before editing files, confirm the workspace rules in this file and the hook directory rules.
- Before writing files with agents or tools, prefer to inspect the target path and current contents.
- Before destructive actions, verify the impact and use the safest available path.

## Hooks

Store extra workflow constraints in one of these directories:

- \`hooks/\`
- \`.minimax/hooks/\`

Common use cases:

- pre-edit checks
- pre-tool constraints
- post-tool cleanup
- session-start notes

## Project Notes

- Use \`npm run build\` to verify changes before finishing.
- Keep session and workspace state aligned with this policy file.
- Add project-specific rules below this section.
`;
}
