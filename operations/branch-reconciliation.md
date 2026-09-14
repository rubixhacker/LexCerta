# Branch reconciliation — September 14, 2026

The active implementation branch is `codex/lexcerta-integration`, based on Node checkpoint `65d5259929a7e862fb1f4a8b768d4964938af9f2`. The bounded connection preflight was carried from `9936c2c` as `2ce393f`; its fixture now uses the compiled Node MCP handler, matching this baseline's dependencies.

The confirmed product scope, ADRs, project instructions, and original product brief were recovered from the dirty checkout. The Node README's implementation details and its Wayfinder tracker conventions remain, with explicit precedence for the confirmed lawyer workflows. Earlier planning documents carry historical notices. The ADR history index explains that Worker-specific infrastructure choices describe the retained reference adapter, while the failed memory gate selected Node/Cloud Run.

## Recovery

The pre-cleanup checkout is retained locally in the named stash `LexCerta pre-cleanup Worker work and confirmed scope 2026-09-14`, also protected by branch `codex/archive-worker-work-2026-09-14`. The branch points to the stash commit, so its tracked snapshot and untracked-file parent remain reachable even if the stash list changes.

- `git show codex/archive-worker-work-2026-09-14:<path>` reads a tracked file from the saved working tree.
- `git show codex/archive-worker-work-2026-09-14^3:<path>` reads a formerly untracked file, including the old Cloudflare delivery workflow and scripts.
- Use a separate recovery worktree when resuming that implementation; applying the snapshot over the Node branch would mix incompatible delivery baselines again.

Local `.omo/`, `.opencode/`, and `.pi/` directories remain on disk. They are excluded through this checkout's `.git/info/exclude`, not deleted or committed. Their generated bundles, SQLite state, logs, and agent caches are local artifacts. Other ignored files, including environment files and build caches, also remain local.

Local `main` was not reset or rewritten. No remote branch was updated, no merge into main occurred, and no deployment was run. The integration branch has no upstream configured, avoiding an accidental push to the Node checkpoint branch. Source permission, OAuth and both-host qualification, Customer pilot participation, and release approval remain open gates.

## Validation

`npm ci` completed against the checkpoint lockfile. On pinned Node 24.21.0, `npm run check` passed formatting, lint, strict typechecks, and all 719 tests, including the CLI calling the compiled MCP handler over loopback HTTP. All 60 checked local Markdown links in changed documents resolved. Independent Standards and Spec reviews reported no remaining actionable findings. Separate PostgreSQL/container qualification and real AI-host workflows were not run as part of branch cleanup.
