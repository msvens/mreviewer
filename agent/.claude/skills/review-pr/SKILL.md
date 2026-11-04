---
name: review-pr
description: Review a GitHub pull request with fresh eyes and write a draft review to the instance state directory. Use with an argument like owner/repo#123.
---

# Review a pull request

Argument: `owner/repo#N`.

<!-- TODO(phase 1): flesh out each step; this is the outline from the runbook. -->

1. **Locate** the local checkout of `owner/repo` under the projects root (from `config.yaml`).
2. **Checkout**: `git fetch origin pull/N/head`, then
   `git worktree add --detach $MREVIEWER_HOME/state/worktrees/<repo>-<N> FETCH_HEAD`.
3. **Reconstruct intent** from the linked issue or title. Write down what the change should touch.
   Do not read the PR description yet.
4. **Read the diff**, then the surrounding code: call sites, tests, similar code. Compare with the
   predicted footprint.
5. **Run checks** on the PR head: typecheck, lint, tests, approved tools.
6. **Check conventions** against the instance conventions and feedback rules.
7. **Read the PR description** and note claims the diff does not back up.
8. **Refute pass**: a separate subagent, given only the diff and findings, tries to disprove each
   finding. Drop what it disproves.
9. **Draft** to `$MREVIEWER_HOME/state/drafts/<repo>-<N>-<sha>.md`, ranked blocking /
   should-fix / nit, using the finding format below. Every finding goes in the review body.
10. **Clean up**: `git worktree remove` the checkout.

## Finding format

```
### [blocking|should-fix|nit] <short title>
Where: <file:line> (also <other sites>)
Problem: <what is wrong and why it matters>
Evidence: <command + relevant output, or reproduction>
Fix sketch: <short, optional>
Verify: <command that proves the fix>
```

End with a **Checked and ran** list. If there are no findings, the review is that list plus a
one-line verdict.
