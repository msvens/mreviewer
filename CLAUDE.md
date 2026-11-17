# mreviewer — development instructions

These instructions are for building this repo. The runtime reviewer persona lives in
`agent/persona.md`. Never mix the two.

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
- All GitHub access is in `core`, with the reviewer's fine-grained PAT from the Keychain. Before a
  run, `core` prefetches the PR data into the run directory; the agent gets no token and no `gh`
  (Go programs cannot verify TLS inside the macOS sandbox).

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

## Checks on the PR head (phase 1, item B)

`core` runs install, typecheck, lint and tests itself, before the agent starts
(`core/src/checks/`), under Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, the same
Seatbelt engine as Claude Code; pinned version). The agent only reads `checks.json` and the logs.

- Only when the repo has `run_checks: true` and the PR author is in `trusted_authors` (default:
  the repo owner). Everyone else gets a static review.
- Writes: the worktree, `state/cache/<toolchain>/` and the run's `checks/tmp` only. Reads: all but
  the secret paths. Network: the install step reaches the toolchain's registries; checks get none
  (`allow_localhost` per repo for local test databases).
- Each package manager is an adapter in `core/src/checks/toolchains/`. A `prefetch` step runs on
  the host and must only download (Go: `go mod download` with `GOTOOLCHAIN=local`), because Go
  cannot verify TLS inside the sandbox.
- Tracked files the checks modify are restored before the agent runs.
- The sandbox proxy runs in core's process: spawn sandboxed commands asynchronously, never with
  `spawnSync`, or their network requests hang.

`core/__tests__/checks.lockdown.integration.test.ts` is the proof for this layer.

## Posting (phase 1, item C)

`core` posts drafts (`core/src/post/`); the agent never does. A posted review is a Comment review
(a PAT cannot approve or request changes on its own PRs) on the commit the draft reviewed:

- The body is `review.post_prefix` plus the whole draft, so every finding is in it. Findings on
  lines in the PR diff also get an inline comment, findings elsewhere in a changed file a
  file-level comment; findings on unchanged files stay in the body only.
- `mreviewer post <draft | owner/repo#N>` previews and asks first. Posting is refused when the PR
  has new commits since the review (`--allow-stale`) or the draft was posted before (`--force`);
  `<draft>.posted.json` records each post.
- `auto_post` (global in `review:`, overridable per repo; default false) lets `mreviewer review`
  post straight away, only after a clean run and only for PRs by `trusted_authors`. A failed post
  never fails the review; the draft stays for `mreviewer post`.
- Drafts are parsed from the review-pr skill's format: keep the skill's step 7 and
  `core/src/post/draft.ts` in step.
