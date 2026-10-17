# T3 Code feature map (web UI)

One file per user-facing feature: what it is, how a user reaches it, how to drive it
through the Browser panel, and what end state proves it. Keep entries honest: when a
route, label, or shortcut changes, update the file in the same change.

| Feature               | File                                   | Entry points                                        | Last driven               |
| --------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------- |
| Pairing and sign-in   | [pairing.md](pairing.md)               | pairing URL, `t3 pair` CLI, Settings → Connections  | 2026-10-17                |
| Appearance and themes | [appearance.md](appearance.md)         | Settings → Appearance, command palette, keybindings | 2026-10-17 (color scheme) |
| Thread sidebar        | [thread-sidebar.md](thread-sidebar.md) | sidebar, command palette, `mod+alt+n`               | not yet                   |
| Composer and turns    | [composer.md](composer.md)             | thread view, new thread, `mod+enter`                | not yet                   |
| Terminal drawer       | [terminal.md](terminal.md)             | toolbar button, `mod+j`, command palette            | not yet                   |

Shortcuts come from the seeded `.t3/userdata/keybindings.json`; `mod` is Cmd on
macOS and Ctrl elsewhere. The command palette is `mod+k` (`commandPalette.toggle`).
