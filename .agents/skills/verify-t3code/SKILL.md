---
name: verify-t3code
description: Launch this worktree's isolated T3 Code dev stack (server + web), prove it is the right instance, drive web UI features through T3's Browser panel, and capture evidence. Use when you must show a web/desktop-UI change working in the real app, or when a dev instance looks wrong. Builds on test-t3-app; use test-t3-mobile for native mobile.
---

# Verify T3 Code (web UI)

Primary surface: the React web app served by `vp run dev`, driven through T3's
Browser panel (`preview_*` MCP tools). Desktop wraps the same web UI; mobile is
separate (see [test-t3-mobile](../test-t3-mobile/SKILL.md)). Feature-specific
recipes live in [features/README.md](features/README.md). A proof that drives one
entry point is incomplete when the feature file lists others.

Helpers (all executable, run from anywhere in the worktree):

```bash
S="$(git rev-parse --show-toplevel)/.agents/skills/verify-t3code/scripts"
"$S/start.sh" [--share]   # launch, wait for readiness, print ports + pairing URL
"$S/doctor.sh"            # read-only: is the running server ours and healthy?
"$S/stop.sh"              # stop only what start.sh launched; keeps evidence
```

## Hard rules

- Never run against `~/.t3/userdata` (the developer's live install). Everything here
  uses the worktree's gitignored `.t3/`. Never set `VITE_HTTP_URL`/`VITE_WS_URL`.
- Never kill by name or pattern. `stop.sh` kills the one process group it recorded.
- If `doctor.sh` says the server was **not** started by `start.sh`, another session
  owns it: you may drive it, but do not stop or reseed it.

## Launch

1. Deps: if `node_modules` is missing, run `vp i --frozen-lockfile -- --yes` (takes a
   few minutes in a fresh worktree; the t3.json setup script normally does this).
2. Data: an empty DB lands you in the welcome wizard. With **no server running**,
   seed real data once: `vp run migrate-dev-db` (read-only snapshot of the live DB
   into `.t3/userdata/statev2.sqlite`; drops scheduled tasks, pending work and auth).
3. Pick the mode. The Browser panel runs on the **client device**, not this machine.
   Call `preview_status`/`preview_open` and look at where it resolves: if the user is
   driving T3 remotely (tailnet host such as `*.ts.net`), plain dev binds Vite to
   `[::1]` and the panel shows `chrome-error://chromewebdata/`. Use `--share`.
   - Local client: `"$S/start.sh"`
   - Remote client: `"$S/start.sh" --share` (serves `https://<host>.ts.net:<webPort>`, bundled dev)
4. Ready when `start.sh` returns: it waited for the `pairingUrl:` log line and prints
   the `[dev-runner] ... serverPort=... webPort=...` line plus the pairing URL. Ports
   derive from the worktree path (here: server 15266, web 7226) but read them from output.
   Log: `.t3/verify/run/dev.log`.

## Doctor

Run `"$S/doctor.sh"` first, and again whenever anything looks off. Exit 0 means:
the pid in `.t3/userdata/server-runtime.json` is alive with its cwd inside this
worktree, `/.well-known/t3/environment` answers, its `environmentId` matches
`.t3/userdata/environment-id` (so it is not the live install), and the web dev URL
proxies to it. It also reports whether `start.sh` owns the instance. Any `FAIL:` line
says what is wrong; do not drive until it passes.

## Drive

1. `preview_status`; if no tab, `preview_open` with the full pairing URL. Otherwise
   `preview_navigate` to it once. Tokens are one-time: if consumed or expired, mint one
   with `node apps/server/src/bin.ts pair` (resolves to this worktree's `.t3`; standard
   scopes, while the startup URL carries the admin scopes Settings → Connections needs).
2. Paired = landing route `/<environmentId>/<threadId>` with sidebar rows
   (`[data-testid=sidebar-row-card]`). `/pair` still showing means the token failed.
3. Navigate by route (`/settings/appearance`, `/settings/keybindings`, `/usage`, ...;
   see `apps/web/src/routes/`) or by clicking ARIA-labelled controls, e.g.
   `preview_click` with `role=button[name='Settings']`. Prefer `role=…[name=…]`,
   `aria-label`, and `data-testid` over coordinates.
4. Read state with `preview_evaluate` (DOM attributes such as `aria-pressed`, computed
   styles, `localStorage` keys under `t3code:`). Wait for async UI inside the
   expression: `new Promise(r => setTimeout(() => r(...), 800))`.

Known client limits: on a hidden or remote panel (`preview_status` → `visible:false`),
`preview_snapshot`, `preview_type`, and `preview_recording_start` fail while
`preview_navigate`, `preview_click`, and `preview_evaluate` work. Ask the user to bring
the Browser panel into view if you need screenshots or typing; otherwise prove with
evaluate-captured state and say that screenshots were unavailable.

## Evidence

Write each proof to `.t3/verify/evidence/<YYYYMMDD-HHMMSS>-<feature>/` (gitignored,
never touched by `stop.sh`). Include `proof.md` with: doctor's OK line, the route, each
action with its locator, and the observed state **before and after**. Add screenshots
(`preview_snapshot` with `save: true`, then copy the returned `screenshotPath`) when the
client allows. `stop.sh` archives the dev log next to them as `dev-<timestamp>.log`.

Proof standards:

- Drive the real user path (clicks, routes, keybindings). Do not call internal setters,
  write `localStorage`, or seed projections to claim behavior works.
- Capture the action and the resulting state, not only the final screen.
- Verify side effects too: persisted keys, a reload that keeps the state, server state
  via `node apps/server/scripts/t3-sqlite-state.ts query --base-dir .t3 --sql "..."`
  (see [sqlite-fixtures](../test-t3-app/references/sqlite-fixtures.md)).
- Sending a message starts a **real provider turn** on the developer's subscription.
  Do it only when the change needs it and the user agreed; otherwise stop at the composer.
- Exercise the way back (reset what you changed) so you leave the instance as you found it.

## Cleanup

1. If the user is still inspecting, leave everything running; a turn ending is not
   teardown. Otherwise:
2. `"$S/stop.sh"`: SIGTERM to the recorded process group, SIGKILL after 10s, archives
   the log, removes `.t3/verify/run/`. Confirm with `"$S/doctor.sh"` (expects `FAIL: no ...
server-runtime.json: no server is running`) and `lsof -nP -iTCP:<port> -sTCP:LISTEN` showing nothing.
3. Close the Browser tab you opened with `t3_preview_close`.
4. Keep `.t3/userdata` (seeded data, reusable) and `.t3/verify/evidence/` (the proof).
   Reseed only by rerunning `migrate-dev-db` with the server stopped.
