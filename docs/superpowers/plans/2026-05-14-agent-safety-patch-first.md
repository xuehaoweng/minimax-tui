# Agent Safety And Patch-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `minimax-tui` safer for real coding-agent use by hardening workspace paths, gating command execution, changing writes to patch-first semantics, and reducing `App.tsx` helper weight.

**Architecture:** Add focused safety modules and keep `agent.ts` as the integration layer. Preserve existing CLI/UI behavior where possible while changing risky tool behavior to fail closed. Split only pure UI helpers from `App.tsx` in this pass to avoid mixing behavior changes with a large UI refactor.

**Tech Stack:** TypeScript, Node.js `fs/path/child_process`, Ink/React, `tsc`.

---

### Task 1: Workspace Path And Command Safety

**Files:**
- Create: `src/workspace-paths.ts`
- Create: `src/command-policy.ts`
- Modify: `src/agent.ts`
- Modify: `src/workspace-index.ts`

- [x] Add `resolveWorkspacePath`, `assertInsideWorkspace`, binary/size guards, and default ignored directory helpers.
- [x] Replace prefix-based path checks in `agent.ts` with strict relative-path validation.
- [x] Add `evaluateCommandPolicy(command, args, cwd)` returning allow/deny decisions.
- [x] Gate `execute` through policy before `execFileAsync`.
- [x] Ensure `npm run build` passes.

### Task 2: Patch-First Write Semantics

**Files:**
- Modify: `src/agent.ts`

- [x] Change existing-file `write` to return a unified diff preview instead of overwriting.
- [x] Keep new-file creation allowed through `write`.
- [x] Add `apply_patch` tool accepting `{ path, patch }`.
- [x] Implement simple unified patch application for single-file text patches.
- [x] Return clear tool messages for preview, applied, rejected, and invalid patch states.
- [x] Ensure `npm run build` passes.

### Task 3: Low-Risk App Helper Split

**Files:**
- Create: `src/ui/app-utils.ts`
- Create: `src/ui/app-formatters.ts`
- Modify: `src/ui/App.tsx`

- [x] Move pure helpers such as mode parsing, base URL normalization, draft sanitization, width measurement, viewport calculation, and think-block stripping to `app-utils.ts`.
- [ ] Move formatting helpers such as session status, index status, task parsing/formatting where practical to `app-formatters.ts`.
- [x] Keep React state and rendering behavior unchanged.
- [x] Ensure `npm run build` passes.

### Task 4: Integration Verification

**Files:**
- Modify if needed: `README.md`

- [x] Run `npm run build`.
- [x] Review `git diff` for accidental behavior changes.
- [x] Document any intentional changed tool semantics if needed.
