# Bug reports

The nightly bug-report sheet. On nightly desktop builds ⌘⇧B / Ctrl+Shift+B (the
`reportBug` shortcut), **Help → Report a Bug…** or the command palette open it; the
desktop shell captures this window first, the sheet shows what will be sent, and the
shell sends it to the report relay. Behaviour, limits and the password rules:
[docs/dev/desktop.md#bug-reports-nightly](../../docs/dev/desktop.md#bug-reports-nightly).

- `widgets/index.tsx` registers the `bug-report` capability (the
  `capability.bug-report` command) and one `app.layers` dialog. It registers nothing
  outside the desktop app, and the capability is available only when
  `window.polythDesktop.bugReport.state()` says reports are on.
- `widgets/bridge.ts` is a local structural type for the desktop API; the package
  never imports the host's bridge module.
- `src/snapshot.ts` builds the page's part of a report: allowlisted `ui.*` settings
  (free text such as the product name or prompts is never included), the view name,
  the viewport, enabled package ids and the tab's recent error notices with home
  folders replaced by `~`. The whole report is validated against
  `@polyth/contracts/bug-report` by the desktop shell and again by the relay.
- `src/serverEntry.ts` adds no routes; it lets the package be discovered and turned
  off in Settings → Packages.

Tests: `node --experimental-strip-types --test packages/bug-report/test/*.test.ts`.
