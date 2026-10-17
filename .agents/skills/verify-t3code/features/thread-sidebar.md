# Thread sidebar

Lists threads across projects with search, project filter, pinning, snooze, and settle.
User doc: `docs/user/thread-sidebar.md`.

## Sub-features

- Search (`Search threads`) and project filter (`Filter threads by project`).
- New thread (`New thread`, `mod+alt+n` for no project), add project (`Add project`).
- Row actions: `Snooze thread`, `Settle thread`, pin from the row menu; settled shelf
  (`[data-testid=sidebar-settled-shelf-toggle]`).

## How to get to it (user POV)

Always visible on the left of the chat view; toggle with `Toggle main sidebar` (`mod+b`).

## Driving it with the Browser panel

1. Rows: `preview_evaluate`
   `[...document.querySelectorAll('[data-testid=sidebar-row-card]')].map(e => e.getAttribute('aria-label'))`
   (label = `"<title>, [status, ]<project>"`).
2. Open a thread: click its row; proof is `location.pathname` = `/<environmentId>/<threadId>`
   and the `Thread breadcrumb` nav shows the title.
3. Search: `preview_type` into `role=textbox[name='Search threads']`, then re-read rows.
4. Settle / Snooze: hover a row, `preview_click` `role=button[name='Settle thread']`;
   proof: row moves under the settled shelf. Reverse it (unsettle / unsnooze) afterwards.

## Gotchas

- `preview_type` failed on a hidden remote panel (2026-10-17); search needs a visible panel.
- Settle and snooze change server state in the seeded DB. Reverse them, and verify with
  `t3-sqlite-state.ts query` against `orchestration_v2_projection_threads`.
- Seeded data comes from `migrate-dev-db`: real titles, but stopped threads only.
