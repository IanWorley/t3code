# Appearance and themes

Per-device preference for color scheme (System / Light / Dark) and theme (T3 Code,
T3 Chat, Grove, Ocean, Ember, Iris, custom), plus contrast, motion, fonts. Stored in the
browser, not on the server. User doc: `docs/user/appearance.md`.

## Sub-features

- Color scheme: System, Light, Dark.
- Theme selection, separately for light and dark previews.
- Create / import / export custom theme.
- Interface sliders: contrast, glass opacity, panel animations, chat width, fonts.

## How to get to it (user POV)

- Settings (sidebar footer **Settings**) → **Appearance** (`/settings/appearance`).
- Command palette (`mod+k`) → **Change theme** / **Change appearance**.
- `mod+alt+a` opens the theme picker; `mod+alt+shift+a` cycles System/Light/Dark.

## Driving it with the Browser panel

1. `preview_click` `role=button[name='Settings']`, then `role=button[name='Appearance']`
   (or `preview_navigate` to `<web origin>/settings/appearance`).
2. Before: `preview_evaluate`
   `({cls: document.documentElement.className, scheme: getComputedStyle(document.documentElement).colorScheme, stored: localStorage.getItem('t3code:theme-appearance-mode')})`.
3. Act: `preview_click` `role=button[name='Use light mode']` (others: `Use dark mode`,
   `Follow the system appearance`; themes: `Use <Name> theme`, `Use <Name> light mode`).
4. Proof: the chosen button has `aria-pressed="true"`; `<html>` loses/gains the `dark`
   class; `color-scheme` matches; `localStorage['t3code:theme-appearance-mode']` is
   `light` / `dark` / `system`; reload `/settings/appearance` and the state holds.
5. Reverse: click `Follow the system appearance` and confirm `stored === "system"`.

## Gotchas

- Device-local: switching here does not change other browsers, mobile, or the server.
  Mobile has its own Appearance screen (test-t3-mobile).
- Right after a click `<html>` briefly carries `no-transitions`; match `dark` with
  `classList.contains`, not equality.
- Keybinding entry points need `preview_press` with modifiers (`Meta` on macOS
  clients); untested on a hidden panel.
