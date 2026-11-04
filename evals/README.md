# evals

Eval harness. Cases live in the instance (`$MREVIEWER_HOME/state/evals/`):

- **Known-bug PRs**: merged PRs later followed by a "fix …" commit on the same code.
- **Clean PRs**: PRs considered fine as merged.
- **Seeded PRs**: optional, with one planted bug.

Metrics: recall on known bugs, false positives on clean PRs, precision from feedback, cost per review.
