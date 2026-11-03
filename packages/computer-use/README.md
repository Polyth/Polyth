# Computer Use

`@polyth/computer-use` lets an agent see and operate the real desktop of the
computer the Polyth server runs on — in practice the machine running Polyth
Desktop, whose server runs in-process. It takes screenshots and sends real
mouse and keyboard input, so an agent can work in native apps that no file,
shell, API or `polyth_browser` tool reaches.

The package ships **disabled**; turn it on in Packages. Enablement contributes
one deployment skill (`polyth-computer-use`) and one tool (`polyth_computer`);
disablement removes both and cancels running and queued actions. Like every
package tool it reaches every shipped harness through the generic
`polyth-agent-tools` MCP projection.

It is an original Polyth package. The idea came from
[pi-agent-computer-use](https://github.com/alexshpunt/pi-agent-computer-use),
a Windows-only Pi extension; no code or binaries are taken from it.

## Who may use it

- The tool is `trust: "device"`, `mutating: true`: every call goes through
  Polyth's package-tool permission flow (`package-tool` / `computer-use.computer`),
  and guarded Spaces never auto-approve it.
- Only the **instance owner's own turns** may drive the desktop. On canonical
  (multi-person) installs the actor's server-resolved context must carry
  `instanceOwner: true`; a single-person install accepts only its bootstrap
  owner. Other Space members, `system:` actors and turns with no person are
  refused with `forbidden`.
- Nothing is registered on `multi-tenant-sandboxed` deployments or where the
  server has no desktop (Linux without `DISPLAY`/`WAYLAND_DISPLAY`).
- No routes; paired devices stay default-deny (`localOnlyRemoteAccess`).

## Agent surface

`polyth_computer` (`computer-use.computer`) takes an `action`:

| Action | Fields | Effect |
|---|---|---|
| `screenshot` | `region?`, `label?` | Capture the primary display into `.polyth/screenshots/computer-*.png` in the session checkout and return its path. With `region` (in screenshot pixels) it returns a sharper crop for reading, with the formula back to screenshot coordinates. |
| `click`, `double_click`, `right_click` | `x`, `y`, `button?`, `count?`, `modifiers?` | Move to the point and click. |
| `move` | `x`, `y` | Move the pointer. |
| `drag` | `x`, `y`, `toX`, `toY` or `path` (2–200 points), `button?`, `modifiers?` | Press, move through the points, release. |
| `scroll` | `x`, `y`, `direction`, `amount?` (1–30 notches) | Wheel at the point. |
| `type` | `text` (≤ 4,000 chars; `\n` presses Enter) | Literal text at the keyboard focus. |
| `key` | `keys` (one chord: `enter`, `ctrl+s`, `cmd+shift+t`, `alt+f4`, `f5`…), `repeat?` | Press a chord. |
| `wait` | `ms?` (≤ 10,000) | Pause, then screenshot. |
| `cursor` | — | Pointer position. |
| `windows` | — | Visible top-level windows: id, title, app, pid, bounds, focused. |
| `focus` | `window` | Bring a window to the front. |

Any input action accepts `screenshot: true` to capture after it.

**Coordinates.** Screenshots are scaled (never enlarged) to fit 1280×800, the
range vision models handle without resizing them again. Those image pixels
are the coordinates every pointer action takes; the tool maps them to the
driver's space (X11 pixels, Windows physical pixels, macOS points). Pointer
actions are refused if the display changed size since the last full
screenshot. All calls run one at a time in arrival order: one desktop, one
pointer.

Screenshots land in the project and can show anything on the screen. The
skill tells agents not to commit them; the folder is created with symlink
checks so a project cannot redirect captures outside its checkout.

## Platforms

No third-party packages: each driver uses programs the OS already has.

| Platform | How | Needs | Verified |
|---|---|---|---|
| Linux (X11) | `xdotool` for input and windows, `xwd` for pixels; PNG encoding and area-average scaling are owned code (`src/image.ts`) | `sudo apt install xdotool x11-apps` (Fedora: `xdotool xwd`) | live on Xvfb 2026-11-03: screenshot, click, double click with shift, drag, scroll, Cyrillic text, Enter, `alt+f4`, `ctrl+T`, windows |
| macOS | JXA (`osascript -l JavaScript`) with CoreGraphics events, `screencapture` + `sips`; text through System Events `keystroke` | Polyth allowed in Privacy & Security → Accessibility and Screen & System Audio Recording (and Automation → System Events for `type`) | source and request shaping only |
| Windows | Windows PowerShell with an `Add-Type` C# helper: `SendInput`, `EnumWindows`, `CopyFromScreen`; per-monitor DPI aware | nothing extra | source and request shaping only |

Limits: the primary display only; Wayland sessions are refused (they do not
allow synthetic input from ordinary clients); Windows compiles its helper on
each call (roughly 1–2 s per action) and cannot send input to elevated
windows; macOS `type` uses the active keyboard layout. Requests reach the
JXA and PowerShell helpers through an environment variable, never spliced
into script source.

## Checks

```sh
node scripts/run-tests.mjs packages/computer-use/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/computer-use/tsconfig.json
```
