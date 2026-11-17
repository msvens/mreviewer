# core

TypeScript orchestration library, imported by `cli` (and later `ui`).

| Module        | What it does                                                                        |
| ------------- | ----------------------------------------------------------------------------------- |
| `home.ts`     | Resolve `$MREVIEWER_HOME` and the instance layout                                   |
| `config.ts`   | Load and validate `config/config.yaml` (yaml + zod)                                 |
| `pr-ref.ts`   | Parse `owner/repo#N` and PR URLs                                                    |
| `worktree.ts` | Check out a PR head as a detached worktree; remove it and verify refs are unchanged |
| `lock.ts`     | `state/run.lock`: one review at a time                                              |
| `github.ts`   | The few GitHub calls core makes itself, with the reviewer token                     |
| `prefetch.ts` | Write the PR's GitHub data into the run directory for the agent                     |
| `checks/`     | Run install and checks on the PR head in the sandbox; one adapter per toolchain     |
| `review.ts`   | One review end to end: lock, worktree, checks, agent run, cleanup, run record       |
| `agent/`      | Launch the locked-down agent: settings, environment, persona, token, stream parsing |

Planned (phase 3): `poll`, queue, `approve`, `post`, `notify`.
