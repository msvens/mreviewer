# cli

The `mreviewer` command line. Calls `core` directly, so it works whether or not the UI is running.

```sh
pnpm mreviewer review msvens/chess#12      # or a GitHub PR URL
pnpm mreviewer review <ref> --model claude-sonnet-5-5 --keep-worktree
```

`review` checks out the PR head as a detached worktree, runs the locked-down agent and writes a
draft to `$MREVIEWER_HOME/state/drafts/`. Nothing is posted.

Planned (phase 3): `poll`, `queue`, `approve <id>`, `post <draft>`.
