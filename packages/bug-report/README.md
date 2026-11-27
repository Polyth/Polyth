# Feedback (`@polyth/bug-report`)

The feedback sheet. ⌘⇧B / Ctrl+Shift+B (the `reportBug` shortcut), **Help → Send
Feedback…** on the desktop, or the command palette open it, on every channel. A person
picks a kind (Broken, Idea, Awkward, Like it) and writes a note in one large field that
carries the optional screenshot and diagnostics as attachments; a way to reply and "Who I
am" (role, AI experience) unfold under it. "What the team sees" lists every part in plain
words with the exact payload under a disclosure, and nothing is sent until Send. In the
desktop app the shell captures this window first and sends. In a
browser, the page captures this tab (desktop Chromium, after the browser's prompt) or
takes a pasted or attached image, and the Polyth server that served it sends. Behaviour,
limits and identity rules: [docs/dev/desktop.md#feedback](../../docs/dev/desktop.md#feedback).
The package and capability ids (`bug-report`) are legacy names kept for compatibility.

- `widgets/index.tsx` registers the `bug-report` capability (the
  `capability.bug-report` command) and one `app.layers` dialog. The capability is
  available when `window.polythDesktop.bugReport.state()` says feedback is on, or else
  when `GET /api/bug-report/state` on this page's server does.
- `widgets/bridge.ts` is a local structural type for the desktop API; the package
  never imports the host's bridge module. `widgets/serverBridge.ts` implements the same
  interface for a browser: the tab capture, `attach` for a pasted or attached image, and
  the calls to the server routes.
- `widgets/ReportSheet.tsx` is the sheet: the form, "What the team sees" and the outcome,
  in one dialog. `widgets/glyphs.tsx` holds its own line glyphs (Lucide paths) for meanings
  the host icon set does not carry.
- `widgets/ScreenshotEditor.tsx` marks up the screenshot (crop, pen, box, arrow, six
  colours, undo) over the unmarked original; `src/annotate.ts` holds the marks'
  geometry and drawing, and `bridge.annotate` swaps in the marked JPEG.
- `src/browserClient.ts` turns the user agent into the OS family and `Name major`, and
  decides whether this tab alone can be captured.
- `src/snapshot.ts` builds the page's part of a feedback: allowlisted `ui.*` settings
  (free text such as the product name or prompts is never included), the view name,
  the viewport, enabled package ids and the tab's recent error notices with home
  folders replaced by `~`, and the contact check. The whole feedback is validated against
  `@polyth/contracts/feedback` by the desktop shell and again by the intake.
- `src/serverEntry.ts` and `src/sender.ts` are the server sender for browsers:
  `GET /api/bug-report/state`, `POST /api/bug-report/send` and `POST /api/bug-report/forget`,
  the outbox, the daily and resettable pseudonyms and the saved profile. They are on only
  in the standard edition when it is not hosted multi-tenant. The package also ships in
  the workstation edition, where only the desktop shell sends.

Tests: `node --experimental-strip-types --test packages/bug-report/test/*.test.ts`.
