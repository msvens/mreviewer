---
name: review-pr
description: Review a GitHub pull request with fresh eyes and write a draft review to the instance state directory. Use with an argument like owner/repo#123.
---

# Review a pull request

Arguments: `owner/repo#N` and the path of the PR head worktree. core (or the phase 1 script) has
already fetched the PR head and checked it out as a detached worktree under
`$MREVIEWER_HOME/state/worktrees/`, and removes it after the run. Do not fetch, check out or remove
worktrees yourself.

<!-- TODO(phase 1): flesh out each step; this is the outline from the runbook. -->

1. **Reconstruct intent** from the linked issue or title. Write down what the change should touch.
   Do not read the PR description yet.
2. **Read the diff**, then the surrounding code in the worktree: call sites, tests, similar code.
   Compare with the predicted footprint.
3. **Run checks** on the PR head: typecheck, lint, tests, approved tools.
4. **Check conventions** against the instance conventions and feedback rules.
5. **Read the PR description** and note claims the diff does not back up.
6. **Refute pass**: a separate subagent, given only the diff and findings, tries to disprove each
   finding. Drop what it disproves.
7. **Draft** to `$MREVIEWER_HOME/state/drafts/<repo>-<N>-<sha>.md`, ranked blocking /
   should-fix / nit, using the finding format below. Every finding goes in the review body.

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
