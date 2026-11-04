---
name: post-review
description: Post an approved draft review from the instance state directory to GitHub as a Comment review.
---

# Post a review

Argument: path to a draft in `$MREVIEWER_HOME/state/drafts/`.

<!-- TODO(phase 1): implement. -->

- Post as a **Comment** review (the PAT cannot request changes or approve on the user's own PRs).
- The review body contains every finding. Inline comments are anchors on top, not the only copy.
- Prefix the body so it is clear an agent wrote it.
- Only post drafts the user has approved.
