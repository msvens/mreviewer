# mreviewer — development instructions

These instructions are for building this repo. The runtime reviewer persona lives in
`agent/CLAUDE.md`. Never mix the two.

## What this is

A local PR review agent built on Claude Code. Design and checklist: `docs/runbook.md`, which links
to the full runbook. Follow the phases in order; each ends with a gate.

## Hard rules (from the design)

- **Review, never change.** The runtime agent never edits, commits to or pushes target repos.
- **Engine is public, instance is private.** No user-specific data (repo names, conventions,
  tokens, paths under a real home dir) in this repo. Examples go in `templates/`.
- **Agent writes only to `$MREVIEWER_HOME/state/`.** Changes to `config/` are proposals that a
  human approves (CLI or UI).
- **Files are the source of truth.** No database. Queue and lock live in `state/` so the CLI, the
  launchd scheduler and the UI all see the same state.
- **Use the user's repos in place.** No clones. PR heads go in detached worktrees
  (`git fetch origin pull/N/head` → `git worktree add --detach … FETCH_HEAD`), removed afterwards.
- **No quota of findings.** "Looks good, here is what I checked" is a valid review.

## Tech

- TypeScript throughout (`core`, `cli`, `ui`). SvelteKit for the UI, which imports `core` directly.
- The CLI calls `core` directly, not the UI's HTTP API.
- `core` spawns `claude -p` for reviews with `GH_TOKEN` set to the reviewer's fine-grained PAT.

## Agent isolation (resolved in phase 0)

`core` starts the agent as `claude -p --restricted` (`core/src/agent/launch.ts`). Verified with
real runs on Claude Code 2.1.318:

- `--restricted` ignores user, project and local settings, every `CLAUDE.md` (this file and
  `~/.claude/CLAUDE.md` included) and ambient MCP servers. The run sees only:
  - the per-run `--settings` file built by `core/src/agent/settings.ts`;
  - `agent/` loaded as a plugin (`--plugin-dir`), so the skills are `/mreviewer:review-pr` etc.;
  - the persona file (`--append-system-prompt-file`): `agent/persona.md` plus the instance's
    approved `config/` knowledge.
- `--add-dir` is never used: it would load `.claude/skills` from a PR's worktree. File access goes
  through `permissions.additionalDirectories` instead.
- The run directory is `$MREVIEWER_HOME/state/run/<id>/`, outside this repo.
- `core` strips `ANTHROPIC_*` from the agent's environment (an API key beats the subscription in
  `-p` mode) and stops any run whose init event reports an API key.

`pnpm test:integration` (`core/__tests__/lockdown.integration.test.ts`) is the proof. Rerun it
after changing the agent's settings, permissions, flags or environment, and after Claude Code
upgrades.
