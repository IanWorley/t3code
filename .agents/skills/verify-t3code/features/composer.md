# Composer and turns

Where the user writes a message, picks model/runtime mode, attaches files, and sends a
turn to a provider. User doc: `docs/user/composer.md`.

## Sub-features

- Markdown editor (`[data-testid=composer-editor]`, aria-label `Message`).
- Model and effort picker, `Runtime mode`, `More composer controls`, `Attach files`.
- Send (`Submit message`, Enter); background start of a new thread (`mod+enter`).

## How to get to it (user POV)

Bottom of any thread view, or a new thread via sidebar `New thread`.

## Driving it with the Browser panel

1. Open a thread or click `role=button[name='New thread']`.
2. Focus the editor: `preview_click` `[data-testid=composer-editor]`, then `preview_type`.
3. Pre-send proof (no cost): editor text, `Submit message` enabled, draft persisted in
   `localStorage['t3code:composer-drafts:v1']` and restored after reload.
4. Sending (only with the user's consent, it runs a real turn): click
   `role=button[name='Submit message']`; proof is a new user message in the timeline,
   a run in `orchestration_v2_projection_runs`, and the turn reaching a terminal state.

## Gotchas

- Sending spends the developer's real provider subscription and runs an agent in a
  real project directory. Prefer a scratch thread ("start without a project").
- The editor is a contenteditable, not an `<input>`; `preview_type` needs focus first,
  and failed on a hidden remote panel.
