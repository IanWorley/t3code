# Pairing and sign-in

A browser earns a session on an environment by opening a one-time pairing URL
(`/pair#token=…`). Every other feature depends on it. User doc: `docs/user/remote-access.md`.

## Sub-features

- Startup pairing URL printed by the server (admin scopes).
- Fresh token from the CLI: `node apps/server/src/bin.ts pair` (standard scopes).
- Managing clients and sessions under Settings → Connections (`/settings/connections`).

## How to get to it (user POV)

Open the pairing URL in a browser. Remote users open the tailnet URL from
`start.sh --share`.

## Driving it with the Browser panel

1. `preview_navigate` to the full pairing URL printed by `start.sh`, exactly once.
2. Proof: `preview_evaluate` `location.href` moved from `/pair` to
   `/<environmentId>/<threadId>` (environmentId equals `.t3/userdata/environment-id`),
   and `document.querySelectorAll('[data-testid=sidebar-row-card]').length > 0`.
3. Server side: `node apps/server/scripts/t3-sqlite-state.ts query --base-dir .t3 --sql "SELECT COUNT(*) FROM auth_sessions"`
   increased (inspect only; use `bin.ts auth ...` for changes).

## Gotchas

- Tokens are one-time. Never consume a URL you were asked to hand to the user.
- `chrome-error://chromewebdata/` after navigating means the panel's client cannot reach
  the origin: the client is remote and dev was not started with `--share`.
- `--share` serves bundled dev; first load is still slow over the tailnet. Allow a
  `timeoutMs` of 60000 on the first navigate.
