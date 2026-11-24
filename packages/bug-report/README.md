# Bug reports

The nightly bug-report sheet. ⌘⇧B / Ctrl+Shift+B (the `reportBug` shortcut), **Help →
Report a Bug…** on the desktop, or the command palette open it. In the nightly desktop
app the shell captures this window first and sends the report. In a browser, the page
captures this tab (desktop Chromium, after the browser's prompt) or takes a pasted or
attached image, and the nightly Polyth server that served it sends the report. Either
way the sheet shows exactly what will be sent first. Behaviour, limits and the
password rules: [docs/dev/desktop.md#bug-reports-nightly](../../docs/dev/desktop.md#bug-reports-nightly).

- `widgets/index.tsx` registers the `bug-report` capability (the
  `capability.bug-report` command) and one `app.layers` dialog. The capability is
  available when `window.polythDesktop.bugReport.state()` says reports are on, or else
  when `GET /api/bug-report/state` on this page's server does.
- `widgets/bridge.ts` is a local structural type for the desktop API; the package
  never imports the host's bridge module. `widgets/serverBridge.ts` implements the same
  interface for a browser: the tab capture, `attach` for a pasted or attached image, and
  the calls to the server routes.
- `widgets/ScreenshotEditor.tsx` marks up the screenshot (crop, pen, box, arrow, six
  colours, undo) over the unmarked original; `src/annotate.ts` holds the marks'
  geometry and drawing, and `bridge.annotate` swaps in the marked JPEG.
- `src/browserClient.ts` turns the user agent into the OS family and `Name major`, and
  decides whether this tab alone can be captured.
- `src/snapshot.ts` builds the page's part of a report: allowlisted `ui.*` settings
  (free text such as the product name or prompts is never included), the view name,
  the viewport, enabled package ids and the tab's recent error notices with home
  folders replaced by `~`. The whole report is validated against
  `@polyth/contracts/bug-report` by the desktop shell and again by the relay.
- `src/serverEntry.ts` and `src/sender.ts` are the server sender for browsers:
  `GET /api/bug-report/state` and `POST /api/bug-report/send`, the tester password kept
  on the server, the outbox and the daily install id. They are on only on a nightly server
  of the standard edition that is not hosted multi-tenant. The package also ships in
  the workstation edition, where only the desktop shell sends (nightly builds only).

Tests: `node --experimental-strip-types --test packages/bug-report/test/*.test.ts`.
