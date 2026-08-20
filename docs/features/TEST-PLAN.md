# Browser walkthrough test plan

Run after:

```sh
npm run build && npm start
```

Open `http://127.0.0.1:4400`. This plan is for a browser-interaction agent after the implementation packages land. Capture a short recording per domain, not per click, and screenshots only for states that a recording cannot show clearly.

## Test fixture

Prepare one temporary Git project through the UI with:

- `README.md` containing headings, math, a Mermaid block, an image, and file references.
- `src/app.ts`, `src/data.json`, `public/index.html`, one binary image, and one file larger than the edit limit.
- Two branches, a merge commit, staged and unstaged changes, an untracked file, and a nested changed folder.
- A dev script that serves a page with a button, input, console message, and one network request.
- `.agents/loops/daily.md` with a valid cron and a second malformed loop file.
- A GitHub test repository/PR when authenticated; otherwise run and record the fail-soft states.

Create two projects and at least six sessions: idle, working, waiting on question, waiting on permission, archived, and worktree-attached. Enable all first-party plugins.

## 1. Input, drafts, composer language

1. Open session A, type a multiline draft, switch to B, type another, return to A, reload, and verify both drafts independently.
2. Use a CJK IME to compose several candidates. During composition trigger a harmless rerender (open autocomplete or resize). Verify candidate/caret remain intact and Enter does not send.
3. Verify Shift+Enter creates a newline; Enter sends after composition commits.
4. Type text containing `/`, `#`, and `@` tokens in the middle of a sentence. Navigate autocomplete with arrows, complete with Tab, and verify only the active token changes.
5. Open composer focus mode, edit, close, and verify text/selection return inline. Switch wide chat on/off and verify transcript/composer alignment.
6. Paste text and an image; verify text stays intact and image preview/removal works.

Expected artifacts: one recording of IME + focus mode + token completion; one screenshot of restored per-session drafts only if needed.

## 2. Active-turn delivery and queue

1. Start a slow turn. With behavior Queue, send three follow-ups and verify numbered queue chips.
2. Reorder by drag, then by keyboard Move up/down. Remove one and verify accessible announcement.
3. Reload/server-reconnect and verify order survives. Allow the turn to finish and verify FIFO dispatch without overlap.
4. Repeat with Steer; verify live delivery indicator. Force/choose an unsupported provider and verify visible fallback to queue.
5. Repeat with Interrupt and verify the old turn stops before the new one begins.
6. While a permission/question is open, send a message. Verify only that session's request is rejected/denied before message admission.
7. Switch projects immediately after clicking Send and verify the message remains in its captured session.

## 3. Work status, tasks, profiles

1. Run a session that emits a task list and delegated agent. Verify task completed/total, current task, and delegated status update live.
2. Verify floating pills remain compact; selecting a pill opens the matching work-status section.
3. Toggle/hide sections, hide all, and use Restore sections. Verify context, cost, goal, changed-file, and MCP sections fail softly when capabilities are absent.
4. Create an agent profile with model/agent/thinking/color/icon, select it, send, and verify the resolved turn footer.
5. Edit the profile after the turn; reload old session and verify old resolved metadata did not change.
6. From model chooser, Pin a model, save without use, then Save and use. Verify row action does not accidentally select.
7. Disable/remove the profile's provider/model and verify repair guidance rather than an invalid send.

## 4. Rich messages and prompt navigation

Send or load one assistant message containing image links, Mermaid, inline/display math, JSON tool output, reasoning, plain and fenced file references, and long code.

1. Verify image thumbnails form one gallery; open fullscreen and keyboard next/previous/close.
2. Verify Mermaid pan/zoom/reset/source/fullscreen; test invalid Mermaid shows copyable source/error.
3. Verify LaTeX renders while escaped currency remains text.
4. Toggle JSON Tree/Raw; expand/collapse/copy path and navigate by keyboard.
5. Collapse merged thinking and verify tool-call ordering stays chronological.
6. Click `src/app.ts:2-4`; verify editor opens at selected centered range. Verify unsafe/nonexistent path does not open.
7. Use Copy Markdown, Copy JSON, and Save as image. Verify hidden reasoning is excluded by default.
8. On a long conversation, use prompt rail hover/focus preview and jump. Resize below threshold and verify rail hides.
9. Turn on reduced motion and repeat a jump/fullscreen open to verify no sliding animation.

## 5. Projects, sessions, folders, labels

1. Rename project and set token color/icon/default profile; reload and verify every picker.
2. Create parent/child folders, rename, collapse, drag and keyboard-move sessions, and create a session directly in a folder.
3. Attempt to move a folder into its child; verify rejection and unchanged tree.
4. Switch grouping among Flat, Worktree, Folder, and Status from sidebar and command palette.
5. Create/edit/reorder labels, assign to project/session, filter by one/multiple labels, then delete a label and verify targets remain.
6. Double-click session title, edit with IME, Enter commit, Escape cancel.
7. Verify question/permission/unread/goal badges and exact accessible count text.
8. Multi-select sessions, archive, open Archive, restore, and test partial failure without losing selection.
9. Search sidebar by title/branch/label/agent and open per-session timeline search with `Mod+T`.
10. Switch projects rapidly while drafts/working sessions exist; verify active ownership, no duplicate rows, no rerouted messages.

## 6. Pane host and files

1. Open files in main/right panes, move tabs, reorder, close others, reopen closed, and resize with mouse/keyboard.
2. Hide a keep-alive tab and return; verify scroll/draft remains and background polling did not continue visibly.
3. Edit a text file, wait for autosave state `saving → saved`, then use manual save.
4. Modify the same file externally/test fixture and edit again; verify conflict Compare/Overwrite/Reload and no silent loss.
5. Switch files before initial load finishes and verify no stale autosave writes.
6. Open binary/large file and verify read-only state.
7. Use context menus: create file/folder, rename tracked file, duplicate, copy relative path, add to chat, delete. Verify no desktop-only Reveal action.
8. Use Go to Line and chat line link; verify range selection/clamping.
9. Toggle Markdown Source/Preview, HTML Source/Preview, JSON Raw/Tree; verify HTML scripts/forms/network are blocked.
10. Search within editor with next/previous and match count. If Vim mode is enabled, toggle it and verify mode/status plus dirty-buffer continuity.
11. Drag file/folder from Files and Changes into chat; verify `@path`/`@folder` and large/binary references do not inline content.

## 7. Git and review

1. Verify staged, unstaged, untracked, conflicted groups and rail count.
2. Stage/unstage one file and a folder. Confirm/discard a folder and verify affected count.
3. Open a partially staged file and verify staged/unstaged variants remain distinct.
4. Open History, inspect graph lanes/merge parents/ref badges, paginate, and open a commit diff tab.
5. Exercise a safe commit action (create branch/checkout). Open destructive action and verify typed confirmation/dirty-worktree guard, then cancel.
6. Add an inline local review comment to added/deleted line, change the diff, and verify Outdated state.
7. Add review comment to chat and verify it appears in the session only after successful append.

## 8. Settings, MCP, plugins, shortcuts

1. Search a setting item by hint/keyword; Enter and verify exact row focus/highlight. Repeat for plugin-contributed page.
2. Change editor font size, density, width, reduced motion; reload and verify.
3. Edit global behavior instructions, save, create/send a session, then create a revision conflict in another tab and verify compare/reload.
4. Add stdio and HTTP MCP entries, edit/test/disable/authorize/remove. Verify secrets stay redacted and failed apply rolls back.
5. Install a trusted test plugin, inspect trust/capabilities, enable, open its panel/command, reload, disable, and verify contributions disappear. Re-enable/reload and inspect bounded logs.
6. Attempt malformed/untrusted plugin and verify atomic failure leaves no contribution.
7. Open Integrations and verify first-party/MCP/third-party grouping; coming-soon cards are non-interactive.
8. Open About and copy application URL; verify no secret/path leakage.
9. Search shortcuts, record a binding, trigger conflict, resolve/reset, and verify palette hints update.

## 9. Schedules, loops, and knowledge

1. Create Once, Interval, and Cron tasks. Change time zone and verify next five runs and description.
2. Choose new session per run, Run now, and follow the visible run-session link.
3. Pause/resume/edit/delete and verify run history/error.
4. Open loop tasks; valid file is marked file-managed/read-only, malformed file shows actionable parse error. Fix/rescan and verify reconciliation.
5. Trigger overlapping run and verify configured Skip/Queue/Parallel behavior.
6. Create knowledge note and plan, edit/search/filter/tag, and force revision conflict.
7. Attach a knowledge card to chat; verify exact revision appears and remains replayable after deleting source card.
8. Verify Agent memory is disabled by default; if enabled in test config, verify source, redaction, and delete/retention controls.

## 10. GitHub, checks, walkthrough, review

1. Open GitHub surface and PR detail; switch Overview/Files/Commits/Checks/Comments.
2. Verify check headline/count/ring and failure-first groups, including skipped names and running polling.
3. Start walkthrough for working tree, branch range, and PR. Verify logical stages/stops/explanations, source digest, cache reload, and stale banner after a source edit.
4. Approve/reject/skip existing session edit steps and verify restart replay.
5. Generate structured review; verify findings, risk/confidence, and source commit.
6. Draft inline PR comment, reload, submit a COMMENT review after confirmation; retry network response and verify no duplicate.
7. Publish risk labels only after explicit action. If unauthorized, verify review remains usable.
8. Start bounded auto-review, observe implement/review phase and iteration, pause on permission, resume, then stop. Verify it never publishes/merges/pushes automatically.
9. Without `gh` auth or on a non-GitHub project, verify honest fail-soft empty state.

## 11. Usage and quotas

1. Verify current session input/output/context/cost, turn footer, project Usage totals, and old replay.
2. Open quota cards with a configured test provider; verify multiple windows/reset times/progress.
3. Simulate provider failure and verify last-good Stale state plus error, not blank/zero data.
4. Refresh manually and verify in-flight deduplication.
5. Feed enough snapshots for pace/prediction, then a reset/counter decrease; verify prediction hides/resets correctly.

## 12. Palette and accessibility

1. Search/open command, project, session, archived session filter, workspace file, and folder.
2. Verify result subtitles/status/branch/labels and atomic project switch.
3. Use `Mod+P` file mode and composer `@` search; compare ordering.
4. Complete all domain recordings once keyboard-only: menus, dialogs, tabs, tree, drag alternatives, queue, question stepper.
5. Repeat key surfaces at 200% zoom and narrow viewport; verify no inaccessible clipped control.
6. Use a screen reader/accessibility tree inspection to verify button names, tab/tree roles, badge/ring text, live-region throttling, and focus return.

## 13. Notifications, questions, permissions

1. Configure kind filters/templates and hidden-only behavior. Hide tab and complete/fail a parent/delegated session; verify correct project/session attribution.
2. Trigger question and permission notifications; click and verify owning session opens.
3. Open multi-question card: radio, checkbox, Other text, Back/Next, final Submit; navigate away/back and verify answer draft.
4. Copy question as Markdown/JSON and compare content.
5. Inspect permission preview/risk, Allow once, scoped Always, Reject; verify unavailable scopes hidden.
6. Send while request is open and verify atomic dismissal ordering.
7. Deny browser Notification permission and verify in-app flow remains usable.

## 14. Browser panel

1. Start dev preview and open Browser. Use address/back/forward/reload, viewport selector, input/click/scroll, Console/Network.
2. Run an approved agent browser action; verify same session changes, visible highlight/activity, pause/resume/abort.
3. Disconnect/reconnect and verify latest frame/history resumes without duplicate action.
4. Attempt stale-frame click and verify rejection/retry.
5. Navigate to blocked scheme, metadata/private address, redirect/rebinding fixture, and external origin; verify denial/approval.
6. Enter password/secret fixture and inspect observation/activity; verify redaction.
7. Crash/close Chromium and verify honest fallback/restart plus context cleanup.

## 15. Streaming dictation and TTS

1. Enable voice, grant microphone, record, pause/stop, and verify indicator/meter.
2. Interrupt WebSocket during recording, continue, reconnect, and verify no missing/duplicate transcript.
3. Trigger auto-send; verify final transcript appears in composer before send. Disable auto-send and verify it persists as draft.
4. Reload/device-loss during recording and verify bounded recovery/error.
5. Switch to browser-speech fallback and verify dictation still inserts committed chunks.
6. Enable TTS, select language/voice/rate, test sample, speak newest completed reply, and Stop.
7. Verify raw audio/interim text never appears in Events view.

## Final regression and evidence

After domain walkthroughs:

1. Restart the server and reopen active projects/sessions.
2. Verify no duplicate/lost events, queues, folders, profiles, schedules, knowledge, review decisions, or settings.
3. Verify models can still stream, call tools, ask questions, request permission, abort, fork, archive, restore, and export.
4. Save the minimal successful artifact set: one recording per major domain and only essential final-state screenshots.
5. Do not save recordings of failed attempts; fix and rerun.

## Global implementation contract to verify

- Node 22 erasable TypeScript and explicit `.ts` local imports.
- Only `packages/backend-opencode` accesses OpenCode.
- Model-visible information appears in the event log before UI/model consumption.
- All routes/live traffic use `/api` and `/ws`.
- Plugin surfaces register/dispose through typed slots.
- Automated suites use `node --test` and plain `node:assert`.
