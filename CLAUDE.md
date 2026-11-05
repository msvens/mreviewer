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

## Open design issue: CLAUDE.md isolation

Claude Code loads `CLAUDE.md` files from the working directory _and its parents_. If `core` spawns
`claude -p` with cwd `agent/`, this file is loaded too and pollutes the reviewer persona. Resolve
this in phase 1, for example by:

- spawning from a directory outside the repo (such as `$MREVIEWER_HOME/state/run/`) and pointing
  Claude Code at `agent/`'s settings and skills, or
- packaging `agent/` as a Claude Code plugin.

Check the current Claude Code docs for the right flags before choosing.
