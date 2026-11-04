# Runbook

The full runbook (design, security model, review flow, rollout and implementation checklist) lives
in a Claude Doc: https://claude.ai/artifact/RhHaCDQW32ZGPhqu44VMg9

That doc is the source of truth while the design settles. Key decisions, for quick reference:

| Decision | Choice |
| --- | --- |
| Runtime | Claude Code (`claude -p`) on a subscription, no API key |
| Split | Public engine repo; private instance at `$MREVIEWER_HOME` (default `~/.mreviewer`) |
| Instance zones | `config/` approved by the user, read-only to the agent; `state/` agent-written |
| Repos | Reviewed in place via detached worktrees; never cloned |
| GitHub auth | Fine-grained PAT first (Comment reviews only); GitHub App in phase 5 |
| Language | TypeScript for core, CLI and UI |
| UI | SvelteKit on 127.0.0.1, imports core, optional |
| Scheduler | `scheduler: launchd \| ui`, same core code |
| Concurrency | File queue in `state/queue/`, one run at a time via `state/run.lock` |
| Review output | Text findings: where, problem, evidence, fix sketch, verify. All findings in the review body |
| Deferred | Suggestion blocks, request changes / approve (with the GitHub App, never auto-approve) |

## Phases

0. Setup: repos, PAT, sandbox and permissions
1. Review skill, run by hand
2. Bootstrap and conventions
3. Core, scheduler, web UI
4. Learning loop and tool proposals
5. Own identity, more autonomy
