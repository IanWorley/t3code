# Terminal drawer

A PTY on the environment's machine, scoped to the thread's workspace, with server-kept
scrollback. User doc: `docs/user/terminal.md`.

## Sub-features

- Toggle drawer, new terminal, split horizontal/vertical, close.
- Scrollback navigation and Select all from the context menu.

## How to get to it (user POV)

`Toggle terminal drawer` button in the thread toolbar, `mod+j`, or the command palette.

## Driving it with the Browser panel

1. In a thread view, `preview_click` `role=button[name='Toggle terminal drawer']`.
2. Proof the drawer opened: an xterm element exists
   (`!!document.querySelector('.xterm')`) and the button's pressed/expanded state flipped.
3. Running a command needs keyboard input (`preview_press` / `preview_type` into the
   focused terminal); read output via `document.querySelector('.xterm-rows').innerText`.
4. Reverse: toggle it closed.

## Gotchas

- Commands run for real on this machine in the thread's workspace. Use harmless ones
  (`pwd`, `echo`).
- Keyboard tools failed on a hidden remote panel; needs a visible panel to type.
