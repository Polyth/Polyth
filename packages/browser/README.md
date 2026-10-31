# @polyth/browser

Shared embedded browser for users and agents. Canonical architecture, security
and tool contracts: `docs/dev/browser.md`.

## Chat-to-Browser helpers (web)

- **Open links in Browser** (`session.message.actions`, `browser.message-links`):
  a quick action on any message containing http(s) links. Pull/merge requests
  (GitHub, GitLab, Bitbucket) are listed first. It reuses the chat lane's live
  tab (or creates one scoped to that session), remembers it, and opens the
  Browser pane. Navigation uses the user route, so policy and origin approval
  still apply; a link needing approval is parked and replayed by the viewer's
  own approval card. Nothing is approved or typed on the user's behalf.
  On the bar it renders the host `ChatActionButton`; it is menu-capable
  (`meta.messageAction.menu`), so in the message "More" menu (the touch
  default) a selection opens the only link directly or the link list (a sheet
  on phones). A failed or policy-refused open is reported through the host
  error banner (`setUiError`), never only in a tooltip.
- **Reader view** (Browser "More" menu, `widgets/ReaderView.tsx`): plain-text
  skim of the page using the server's redacted observation text; follows
  navigation while open. Text only by design (no images/markup); tab-separated
  lines from page tables render as a column grid. Focus moves to the reader
  title on open, Escape returns to the page, a failed read offers Retry, and
  an empty extraction shows the shared empty state.

Pure logic lives in `widgets/messageLinks.ts` and `widgets/openInBrowser.ts`
(tests: `test/browserLinks.test.ts`; mounted UI: `test/browserLinksUi.test.ts`).
