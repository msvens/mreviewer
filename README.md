# mreviewer

A local, Claude Code based agent that watches your GitHub repos for new PRs and reviews them the way
you would: bugs, inconsistencies and drift from your own conventions, backed by evidence (typechecks,
tests, probes run on the PR head).

It **reviews, never changes** code. It runs on a Claude subscription via Claude Code, not an API key.

> Status: early scaffolding. See [docs/runbook.md](docs/runbook.md) for the design and the
> implementation checklist.

## How it fits together

- **Engine (this repo, public)**: generic behavior only — the runtime agent (`agent/`), a TypeScript
  `core` (poll, queue + lock, run, approve, post), a `cli`, an optional SvelteKit `ui`, templates and
  an eval harness. Nothing user-specific lives here.
- **Instance (private, yours)**: `$MREVIEWER_HOME` (default `~/.mreviewer`). Holds your repo list,
  conventions, feedback rules, approved tools and all runtime state. How you back it up or sync it
  is up to you.
  - `config/` — approved by you; the agent can only read it.
  - `state/` — written by the agent and core: queue, drafts, proposals, logs, worktrees.

Nothing reaches `config/` without your approval.

## Layout

```
agent/        runtime agent: CLAUDE.md (reviewer persona), .claude/ (skills, settings)
core/         TypeScript orchestration library
cli/          mreviewer command line
ui/           SvelteKit local web UI (imports core)
templates/    example instance (copy to $MREVIEWER_HOME)
evals/        eval harness; cases live in the instance
docs/         runbook and design notes
```

## Getting started

Not runnable yet. Phase 0 in the runbook covers setup: instance directory, fine-grained PAT,
sandbox and permissions.

## Development

Requires Node 24+ and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm check              # typecheck + lint + unit tests; CI runs the same steps
pnpm format             # apply Prettier formatting
pnpm test:integration   # local only: spawns real `claude -p` runs, needs a Claude login and macOS
```

Tests live in `__tests__/` as `*.test.ts`; integration tests are `*.integration.test.ts`. Work happens on
branches with a PR to `main`, and CI must pass before merging.

## License

MIT. See [LICENSE](LICENSE).
