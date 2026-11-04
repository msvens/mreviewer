# ui

SvelteKit local web UI (phase 3). Imports `core`; API routes are thin calls into it.

- Bind to `127.0.0.1` only, with a per-session token and an `Origin` check.
- Approval queue (drafts, proposals), repos, conventions browser, run log.
