# polyth merged PR classification index

Inventory snapshot: 1037 merged pull requests through 2026-08-19.

Classes are parity dispositions, not judgments about source quality. `implement-in-polyth` includes user-visible fixes that must be preserved during implementation. Detailed source designs are in the linked domain documents; low-level maintenance entries remain here for traceability.

Source titles are preserved except that one prohibited editor product name is rendered as `editor provider`.

## Summary

| Class | Count |
|---|---:|
| `already-in-polyth` | 7 |
| `implement-in-polyth` | 752 |
| `platform-na` | 226 |
| `skip-internal` | 52 |

## Pull requests

| PR | Title | Class | Disposition note |
|---:|---|---|---|
| #3002 | fix: settle busy sessions after managed OpenCode restart | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2991 | feat(ui): show session cost in VS Code context usage readout | `platform-na` | This PR changes only the VS Code extension readout; the reusable web cost behavior is already present in Polyth. |
| #2693 | fix(git): handle worktrees from forked PRs safely | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2914 | fix(ui): stop the context meter from counting every internal round-trip | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2973 | feat(knowledge): rebuild the project notes panel as Project knowledge | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2916 | fix(proxy): reuse upstream connections for OpenCode API requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2800 | fix(ui): stop sustained Shiki re-highlight of unchanged markdown (#2769) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2927 | fix(config): stop wiping opencode.jsonc with partial JSONC parses (#2923) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2691 | fix(chat): defer composer value writeback during IME composition (Fixes #2527) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2953 | Reduce anti-slop findings in Persistence | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2928 | fix(sessions): recover new chats from a deleted lastDirectory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2929 | fix(github): stop stale merged PRs from sticking in branch status | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2913 | fix(settings): persist sessionRetentionAction through the settings sanitizer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2920 | fix(ui): drop unused runtimeFetch import in gitApi | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2925 | fix(ui): restore embedded subagent history (#2892, #2903, #2919, #2922) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2924 | Fix ClawHub display name typo in Skills Catalog (#2895) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2910 | feat(settings): third-party Integrations dashboard | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2894 | fix(markdown): correct image gallery rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2883 | Replace the preview proxy with a real browser panel, and let agents drive it | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #2713 | fix(scheduled-tasks): prevent dual-server double dispatch of daily tasks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2714 | Remove verified dead declarations | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2874 | fix(desktop): keep minimize on the taskbar and send only close to the tray | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2792 | Fix/shell command entry caret | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2863 | feat: add assistant Markdown image galleries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2871 | fix(sessions): snapshot send target so a project switch cannot reroute a pending send | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2865 | fix(sessions): select the active project using session ownership | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2822 | fix(relay): never forward a tunneled body that lost frames | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2765 | feat(desktop): upgrade Electron to 43.3 for Linux frameless rounded corners | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2816 | fix(ui): mount only the active session chat iframe | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2719 | fix(ui): prevent code line numbers from wrapping | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2805 | fix: keep work-status panel reachable when all sections are hidden | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2794 | fix(telegram): collapse Owners & groups; last sync in Advanced | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2793 | fix(telegram): bind synced topics, pace rate limits, open chats | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2791 | fix(i18n): shorten pending-restart applying label across locales | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2790 | fix(ui): restore rail badge background via surface theme tokens | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2776 | feat(chat): in-chat work-status panel, and MCP authorization and settings fixes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2777 | feat(telegram): multi-owner security, group sync parity, and Discord command feature parity | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2628 | feat(usage): add xAI quota reporting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2585 | Defer OpenCode restarts with Apply & Restart accumulator | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2747 | fix(git): enable core.longpaths for worktree population (#2746) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2732 | fix(chat): do not replay entry animations for already-seen fresh messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2731 | fix(terminal): keep default terminal tab names unique after closing tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2742 | perf: cut cold-start download 58% and startup heap 22% via measured chunk-graph fixes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2722 | feat(messenger): Telegram integration alongside Discord | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2744 | fix(desktop): recover from macOS directory permission failures | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2721 | fix(git): run post-checkout hook after worktree creation bootstrap | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2424 | fix(chat): pin existing-session sends to captured target | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2669 | feat(ui,server): surface active instance service URLs in About settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2542 | fix(web): update foreground systemd services safely | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2708 | fix: wait for worktree bootstrap before prompt dispatch; resolve session directory for send/fork | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2490 | fix(files): handle reveal launcher failures | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2611 | fix(mobile): Add fallback parsing for pairing connection in old Android WebViews | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2643 | fix(deps): upgrade adm-zip to 0.6.0 to fix GHSA-xcpc-8h2w-3j85 | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2432 | fix(ui): cascade-remove extracted document attachments when parent is removed | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2642 | fix(ui): never auto-send the message queue into a streaming turn | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2373 | fix(vscode): open notebook links in notebook editor | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2300 | fix(settings): preserve notification template edits | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2581 | fix(ui): make overlay scrollbar persistent on desktop shells | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2494 | fix(desktop): preserve native taskbar minimize | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2492 | fix(chat): expand shell output by default | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2685 | fix(composer): restore Shift+Enter newline on iOS | `implement-in-polyth` | The source regression appeared on iOS, but preserving Shift+Enter and composition metadata is required in Polyth's web composer. |
| #2256 | fix(sync): route directory-less todo updates | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2682 | feat(sessions): show a pending-question indicator on sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2663 | fix(sync): route question/permission replies by the request's own session directory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2660 | fix(cli): generate a UI password for bare --ui-password in daemon/serve mode | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2695 | fix(server): rebind message-stream upstreams after a managed OpenCode restart (#2638) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2661 | feat(server): validate polyth_OPENCODE_HOSTNAME bind hostname | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2665 | fix(web): parse agent frontmatter as leniently as OpenCode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2698 | feat(tasks): support markdown scheduled-task loops in .agents/loops | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2699 | fix(sync): finalize tool parts orphaned by an interrupted turn after settlement (#2577) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2707 | fix(fs): keep file-tree list paths through symlinks (#2627) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2706 | fix(ui): Escape in terminal reaches PTY instead of closing panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2679 | feat(ui): show the changed-files count badge on the Git rail surface | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2678 | feat(chat): refocus composer after adding message to context | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2487 | fix(settings): persist collapsed message preference | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2629 | fix(walkthrough): use remote default branch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2617 | fix(walkthrough): replace raw provider-login error with a readiness blocker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2622 | fix(ui): persist manual model override across delegated subtask completion (#2404) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2621 | fix(providers): hide API key form for OAuth-only providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2616 | feat: add restore/unarchive for archived sessions | `already-in-polyth` | Archive and restore endpoints and row actions already ship; bulk/archive surfaces are still a follow-on. |
| #2595 | feat(ui): Ctrl/Cmd+L adds selected text to chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2600 | fix(electron): require TerminalEmulator category for terminal appId on Linux | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2603 | fix(sync): render sessions in worktrees created while the client is running | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2597 | fix(files): hide desktop-only reveal action in browser clients | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2598 | perf: fix directory cache thrashing and runtime-key derivation, add unattended profiling harness | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2594 | feat: add DeepSeek quota provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2596 | fix: Kimi for Coding usage showing 0% despite full consumption | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2589 | fix(desktop): strip AppImage ARGV0 leak corrupting zsh argv[0] (#2588) | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2586 | fix(skills): preserve SKILL.md content when renaming | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2571 | feat: add custom/other OpenAI-compatible LLM providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2590 | fix(ui): prevent status row controls from overlapping on narrow mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2554 | fix(chat): normalize bash output by stripping ANSI sequences and applying terminal control codes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2592 | fix(terminal): start PTY before viewport mounts without dropping output or replies | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2576 | fix: discover repository-local .agents skills (#1159) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2263 | feat(i18n): add German (de) locale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2584 | docs(changelog): credit @BestSithInEU for Linux desktop AppImage work | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1846 | perf: fix bundle chunking to slash initial load (~18.5 MB → ~0.44 MB eager) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2578 | fix(sync): guard delete actions by default | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2567 | fix(vscode): open apply_patch diffs at the correct path | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2573 | fix(sync): narrow the archived session query at the data boundary | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2574 | fix(sync): honor expectedRuntimeKey in archive actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2569 | feat(mobile): tablet layout pass and foldable-ready size class | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2572 | feat(walkthrough): guided AI walkthrough for diffs, branches, and PRs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2551 | fix(git): pin simple-git to opened project path for session discovery | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2561 | feat(mobile): mobile app navigation rework and beta-feedback closeout | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2545 | perf: optimize session loading and desktop startup | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2537 | feat: add Windows ARM64 support with x64-baseline CLI workaround | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2509 | fix(ui): paint the composer caret on the first padding click | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2528 | fix(ui): smooth desktop sidebar sticky transitions | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2534 | fix(files): stop autosave data loss on load lag and binary files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2536 | fix: eliminate terminal open/switch slowdown and crashes on Linux | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2498 | feat(desktop): gate traffic-lights behind window-controls style setting | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1608 | fix: dedupe skills shadowed by commands in the slash menu | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2116 | fix: show collapsed sidebar activity indicators | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2525 | fix: prevent bundled OpenCode self-upgrades | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2526 | fix(ui): remove desktop sidebar project header artifacts | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2403 | feat(quota): support OpenAI business-account spend_control in codex quota display | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2522 | fix: stream bash output and harden OpenCode connectivity | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2501 | fix(desktop): Linux AppImage tray Show/Hide/Close and system file-manager icons | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2520 | Fix/settings scrollbar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2056 | fix(discord): sync UI worktrees and sessions to Discord threads | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2445 | fix(ui): deny open permission prompts on send | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2480 | feat(ui): sidebar redesign — project zones, grouping modes, full-page surfaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2478 | fix(discord): show /model modalities from OpenCode capabilities | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2418 | feat(ui): context panel 2.0 — surface rail, changes-first git view, live PR surface | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2419 | Composer: CodeMirror editor, unified prompt language, ChatInput decomposition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2477 | fix(ui): keep long shell tools live past the 5m hang illusion | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2461 | feat(engines): full Claude slash commands, MCP bridge, and subagents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2473 | feat(engines): MultiRun, Goal, and polyth tool on Claude Code | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2466 | feat(engines): import Claude Code projects and chats | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2464 | feat(engines): Claude vs OpenCode agents mode for Claude Code | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2449 | fix(ui): preserve Markdown code selections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2454 | fix(engines): enable shell mode on Claude Code sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2459 | fix(desktop): dedupe Linux tray D-Bus calls to stop main-thread freeze | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2457 | feat(discord): Advanced settings accordion UI matching mock | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2458 | Simplify Discord reply modes; remove Listening pill | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2456 | Fix Discord settings layout: Enabled, sync panel, Add Server, Connected check | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2455 | Rebuild Discord settings UI 1:1 to connected-servers mock | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2452 | fix(quota): recover Claude limits on 429 and stop blank Settings Usage | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2450 | fix(quota): refresh Claude subscription OAuth so Usage limits display | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2444 | fix(ui): stabilize Markdown code block line layout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2415 | feat(quota): add Crof and NeuralWatt quota providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2440 | fix(engines): Claude Stop, Goal visibility, and queue auto-send | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2431 | fix(ui): compact embedded chat URLs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2439 | fix(engines): Claude queue, stop, catalog dedupe, handoff & session titles | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2436 | fix(engines): Claude tool/text order + full permissions & attachments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2437 | feat(discord): critique.work diff URLs and fix /undo /redo messageID | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2434 | fix(desktop): Linux window controls order and remove auto position | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2408 | feat: agent and CLI control plane for sessions, worktrees, and scheduled tasks | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2406 | fix(ui): move window controls position setting to Appearance | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2398 | feat(desktop): Linux AppImage releases and desktop feature parity | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2396 | fix(desktop): restore Linux AppImage auto-update feed handling | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2382 | fix(web): honor Copilot model endpoints for small models usage | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2392 | Linux desktop feature parity: Open in, background start, tray, multi-window | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2381 | fix: default APNs delivery to production | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2374 | fix: prevent automatic switch to main terminal tab when opening termi… | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2367 | fix: preserve plugin tool `state.attachments` in UI and materializer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2360 | Improve high-volume session performance and runtime correctness | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2352 | feat(discord): clearer onboarding + per-server response policies | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2351 | feat(discord): clearer onboarding + per-server response policies | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2335 | fix(vscode,ui): stop postMessage crash when opening chat in editor provider | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2329 | fix(terminal): auto-focus hidden input overlay on mobile web | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2336 | fix(discord): tear down on disconnect and sticky stop listening | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2334 | fix(discord): show Disconnect when connected | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2333 | fix(discord): keep Change token + Advanced when connected | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2332 | fix(discord): Settings/Advanced buttons when connected | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2331 | fix(discord): actually sync connection status after rebuild | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2330 | fix(discord): show correct connection status after server rebuild | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2326 | fix(discord): unify header buttons and hide when disconnected | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2322 | fix(discord): keep agent questions answerable instead of expiring | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2309 | feat(discord): polyth agent messenger parity (btw, queue, access, ops, CLI) | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2308 | feat(discord): show model modalities as emoji in /model select | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2306 | fix(discord): /model wizard back buttons + larger model pages | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2294 | Rename Otto branding to polyth agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2122 | Standardize Settings layout and save feedback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2285 | feat(otto): /permissions synonym and tool permission settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2280 | feat(terminal): refactor runtime and add mobile workspace | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2272 | fix(sessions): route new sessions to the correct project when server omits directory (#1637, #2270) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2199 | fix(chat): restore editor font size styling in chat input | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2213 | fix(chat): anchor prompt navigator to last turn at chat bottom | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2211 | feat(chat): prompt navigator list preview, prompt filtering, shell status fix | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2185 | fix(chat): rework prompt navigator rail into sliding tape with hover preview | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2054 | feat(chat): desktop prompt navigator rail | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2144 | feat(desktop): Linux AppImage polish — window controls, updater UX, docs | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2135 | Fix: small model dispatch fails for custom OpenAI-compatible providers (#2134) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2138 | Fix: enable in-place subtask navigation in embedded session-chat iframe | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2152 | feat(files): expose markdown preview toggle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2154 | fix(ui,server): normalize Windows drive letter casing for consistent path resolution | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2160 | refactor(quota): secure managed provider credentials | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2158 | feat: persist permission auto-accept on server | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2155 | feat(quota): add OpenCode Go usage tracking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2156 | fix(notifications): handle subagents and session errors | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1738 | fix(mobile): eliminate >10s sidebar open delay by always mounting SessionSidebar (#1695) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2148 | Session Goals: server-driven goal loop with independent small-model audit | `already-in-polyth` | The server-driven goal loop, independent small-model audit, durable goal events, budget, and continuation limits already ship. |
| #1978 | fix(ui): dispatch queued messages when session is already idle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1982 | SDK v1.17.12: session.permission — programmatic create/fetch, more reliable auto-accept | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1992 | perf(worktree): skip unchanged store updates and content-aware persist | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2004 | fix(agents): preserve YAML frontmatter fields when saving agent settings via UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2005 | fix(sync): restore pending questions after restart | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2017 | fix(sidebar): prevent home-project archived session overlap crash | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2030 | fix(worktree): restore last source branch reliably | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2035 | fix(auth): clarify LAN auth and mobile guidance | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2043 | fix(sync): keep session renames stable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2045 | fix(chat): enable draft auto-accept before first message | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2057 | fix(session): keep pinned sessions on refresh | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2058 | fix(vscode): allow Shiki module worker by adding worker-src to CSP | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2059 | fix(number-input): stepper drift on rapid clicks (closes #2053) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2063 | feat(command-palette): add projects to existing fuzzy search | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2065 | feat(settings): editor font size for chat input and code editor (#1325) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2067 | fix(sidebar): add project sort modes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2071 | fix(chat): harden tool output rendering against non-string fields (#2011) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2086 | fix(sync): commit first message page before expansion loop (#2084) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2089 | refactor(chat): simplify baseDisplayMessages dedup — remove unnecessary reverse() | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2091 | fix(ui): pass sourceRepo to PR/issue context calls for fork workflows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2092 | fix(sidebar): keep file tree expanded while refreshing root | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1993 | docs(agents): add step-by-step workflows with posting and label procedures | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1923 | fix(vscode): keep relative path in Add to Context attachment filename | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2112 | feat(electron): add Windows startup and system tray support | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2103 | feat: add pairing v2 trusted-device issuance | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2015 | Share project edit form; add per-project default model | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2111 | feat(ui): Discord onboarding wizard and messenger UX polish | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #1825 | fix(server): allow x-opencode-directory-encoding header in CORS | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2104 | feat: iPad split layout for the Capacitor app | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2100 | feat(chat): add Mermaid diagram zoom controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2099 | feat(ui): Discord onboarding wizard and messenger bash dedup fix | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2087 | Add polyth Relay (end-to-end-encrypted remote access) | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1995 | fix(vscode): persist model favorites | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1848 | fix(vscode): restore previous view when exiting settings (#1776) | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #2000 | feat(chat): support line ranges in clickable file references | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2046 | fix(auth): narrow mobile auth fallback | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2049 | Small model: direct utility-LLM calls on existing OpenCode logins, with recap/suggestion, notes distillation, and more | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2025 | feat(discord): /yolo permission modes, richer /model list, live verbosity, robust interrupts | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2018 | First-class voice: server-side streaming dictation + local TTS | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2013 | feat(sessions): cross-thread session references and share/unshare fixes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1836 | Simplify Discord integration page with advanced accordion | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #2008 | feat(skills): system "create-project" skill + agent API that links new projects to Discord | `platform-na` | Targets the messenger integration surface and has no required web/server port. |
| #1961 | feat(pr-review): apply risk and confidence score labels to reviewed PRs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1943 | feat(pr-review): add risk score to review comment output | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1954 | feat: native iOS & Android mobile apps (Capacitor) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1942 | ci: add merge-conflict label automation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1941 | perf(stores): defer safeStorage writes off the interaction path | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1781 | feat(#1766): support OpenCode steer delivery / follow-up behavior settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1806 | fix(worktree): subagent sessions kept when deleting worktree group from sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1785 | chore(deps): update cloudflare/cloudflared docker digest to 6d91c12 | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1786 | chore(deps): update oven/bun docker tag to v1.3.14 | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1789 | fix(deps): update dependency @pierre/diffs to v1.3.0-beta.6 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1829 | fix(sync): stop watchdog redundant resyncs on healthy event stream | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1813 | fix(sidebar): preserve explicit session selection on stale worktree data | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1791 | fix(ui): actually shrink typography classes on mobile viewports | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1810 | Add Japanese locale (ja) support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1838 | fix(providers): preserve add-provider form during background provider reload (#1765) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1839 | fix(agents): stop falsely reporting saved agent edits on external OpenCode; make model-selector shortcut customizable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1833 | feat: inherit model-picker reorder/accordion persistence and shift-delete from otto-ui | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1831 | feat(chat): drag to reorder queued messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1840 | feat: add automatic review loop | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1837 | Refactor web CLI into focused modules | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1835 | chore: remove dead code (59 unused files + ~125 unused exports) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1762 | fix(worktree): gate sessions on bootstrap readiness | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1761 | fix(git): materialize draft session for generate | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1740 | Dismiss open question prompt when sending a message | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1750 | fix(markdown): preserve user code block characters | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1730 | fix(chat): set scroll position before paint on session-switch replay | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1718 | fix(agents): send null to clear temperature/topP overrides on update | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1715 | feat(agents): expose thinking variant configuration in agent settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1714 | fix(providers): use correct endpoint for provider disconnect | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1713 | fix(agents): use isPrimaryMode consistently across all agent pickers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1712 | fix(chat): preserve tool duration across session switches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1711 | fix(sidebar): correct expansion-key format for virtualizer buffer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1709 | fix(sync): reflect share status from global store after cancel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1708 | fix(session): bind new sessions to selected project | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1706 | fix(sidebar): preserve pinned sessions and folder refs on empty session list | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1705 | fix(auth): honor OPENCODE_SERVER_USERNAME env var | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1700 | fix(settings): persist per-model visibility and sibling selector state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1687 | fix(mobile): use exact directory matching for session grouping | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1681 | fix(settings): refresh skills catalog after catalog changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1673 | fix: handle non-ISO-8859-1 characters in fetch headers and Content-Disposition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1663 | ci: skip stale workflow on forks | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1649 | fix: ignore pasted @ for file mentions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1643 | chore(deps): update development dependencies | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1639 | fix: preserve settings default thinking variant when switching agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1615 | test(git): assert relative URLs in gitApiHttp stage/unstage tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1607 | fix: invoke skills selected from the slash command menu | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1603 | fix(deps): update dependency katex to ^0.17.0 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1600 | fix(deps): update dependency @simplewebauthn/server to v13.3.1 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1595 | Fix font-size/padding not applying in VFix font-size/padding not applying in VS Code (#1261)S Code (#1261) | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1589 | fix(quota): handle MiniMax M3/Token Plan API changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1582 | fix(mobile): subagent chevron overlaps session title on mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1693 | fix(sync): treat part snapshot as a delta coalescing barrier | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1672 | perf(chat): race fix, narrow subs, projection cache, progressive load | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1674 | perf(right-sidebar): gate live effects, memoize lookups, always-mount tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1593 | feat(scheduled-tasks): add cron syntax support to task editor dialog | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #1660 | refactor(sidebar): remove dead directoryStatus probe artifact | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1658 | feat(vscode): startup parity + workspace-grouped session list | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1588 | fix: pass workspace directory in Files API requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1651 | perf: migrate chat rendering to virtua | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1650 | perf: instant startup via cache hydration + decoupled readiness | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1585 | fix: prevent worktree modal from disappearing after opening | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1572 | fix: auto-fetch branches when opening create worktree dialog | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1625 | chore: pin GitHub Actions to SHAs | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1614 | fix: stabilize question custom textarea resizing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1563 | feat: show previews in collapsed raw message headers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1562 | feat: add opt-in docked editor toolbar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1560 | feat: linkify file paths inside fenced code blocks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1557 | feat: Add delete session in the sessions menu. | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1555 | fix: prevent cascade rollback from restoring deleted session descendants | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1553 | fix: prevent blank chat viewport when switching sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1552 | fix: use effectiveDirectory in ToolPart to fix empty ContextPanel iframe for sub-tasks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1544 | fix: stop tab-complete from also swapping the selected agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1538 | fix: lighten session list payloads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1533 | fix(docker): stabilize workspace dependency install | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1532 | fix(mcp): import OpenCode MCP config snippets | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1525 | fix(ui): keep mobile changes empty states dismissible | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1524 | feat(ui): add cache hit rate to context sidebar last-message token breakdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1516 | Keep notification SSE stream alive behind proxies | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1515 | Fallback to gh CLI credentials if available | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1606 | fix(docker): update workspace path to packages/electron after Tauri removal | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1502 | fix: add hidden models state to ModelMultiSelect component | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1493 | feat: prompt for workspace folder in multi-root VS Code workspaces | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1482 | feat: add complete French localization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1471 | fix(opencode): accept non-2xx status codes in probe-url to support re… | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1590 | chore: bump better-sqlite3 from ^11.7.0 to ^12.10.0 | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1596 | chore(deps): update cloudflare/cloudflared docker digest to ba461b8 | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1597 | chore(deps): update development dependencies | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1592 | feat(settings): add item search | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1591 | feat: improve mobile UX | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1470 | fix(preview): rewrite inline module scripts in proxy HTML responses | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1453 | fix: atomic file writes to prevent concurrent read/write truncation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1450 | Fix mobile terminal touch scrolling | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1444 | feat: add markdown as copy-table format option (#1408) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1443 | feat(tts): add TTS buttons to PlanView and FilesView markdown preview with configurable input mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1439 | fix(tts): allow remote custom provider URLs on desktop runtime | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1437 | feat: add file editor vim mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1432 | Diagram editor pr | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1390 | Add folder-level revert action in Git changes tree | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1352 | feat: server-side GitHub search for issue/PR pickers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1262 | feat(vscode): add archive all sessions action | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1546 | Setup stale issue/pr cleanup workflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1541 | Create and push branches in reproduce-issue and update reproduction labels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1483 | fix: enable detached children for Linux in dev scripts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1514 | Fix concurrency in reproduce-issue | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1513 | Allow /tmp as external-directory in reproduce-issue | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1512 | Bun install in reproduce-issue | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1501 | feat: add dialog for "Start new session from this answer" | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1497 | Add reproduce-issue agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1498 | Improve triage agent definition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1228 | Draft: Decouple bundled UI from runtime API and add remote instance tooling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1468 | [codex] Fix session history loading | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1431 | feat(git-graph): VS Code-style git graph with commit actions in History modal | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1426 | fix: improve todo send dialog model picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1424 | fix(desktop): toggle browser icon and preserve webview state on coll… | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1093 | Add Windows Electron desktop support | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1429 | fix: session rename exits immediately due to focus race | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1430 | Keep completed project todos at the end of the list | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1360 | feat(i18n): add Traditional Chinese locale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1362 | fix: switch model when selecting an agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1420 | feat(usage): add toggle to hide prediction rows on usage cards | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1421 | feat: add startup launch support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1375 | feat: plugin settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1415 | feat: add Ngrok tunnel provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1386 | Fix (mobile) add long-press support to shared tooltips | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1402 | feat: add native macOS dynamic app icon | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1401 | feat(chat): live markdown source-mode highlighting in composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1391 | Fix mobile open file list behavior for deleted and long-named files | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1316 | fix: resolve symlinks in project directory paths | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1370 | fix(ui): keep PWA dialogs visible on Android | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1400 | docs: add polyth feature docs and translations | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1369 | feat: Show search match count in editor panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1366 | Fix mobile fullscreen panels and header active state | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1399 | perf(server): cache deterministic git rev-parse reads in fs exec route | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1398 | perf(git): cache project-root resolution to stop N² polling cascade | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1361 | feat(tts/stt): add API key support for OpenAI-compatible custom providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1359 | feat: Redesign git changes to split stage/unstaged files. | `already-in-polyth` | The Git service and UI already expose separate staged, unstaged, untracked, and conflicted groups with bulk operations. |
| #1355 | Add mobile context notes tab | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1351 | feat: add quick-add button to directory explorer rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1344 | Fix git operations from repository subdirectories | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1338 | fix: correct typos in CHANGELOG files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1320 | feat: rename sessions inline via double-click | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1318 | feat: widen chat input column with Wide Chat Layout setting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1296 | fix installed skills discovery and improve editor UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1382 | Update CHANGELOG with contributor name corrections | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1380 | fix: preserve canonical snippet names | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1379 | fix: handle git identity row keyboard activation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1378 | fix: clean up upstream reader abort listener | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1383 | Fix(mobile) terminal replay, reset artifacts, and preview detection | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1111 | Multi-run with configurable prompt templates | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1342 | fix(ui): revoke voice preview blob urls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1343 | fix(ui): avoid file search cache key collisions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1341 | chore: unify zh-CN translation terminology | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1331 | fix(ui): associate save plan title label | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1332 | fix: respect session prefetch page size | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1329 | fix(ui): ignore non-finite quota percentages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1330 | fix(ui): handle blocked storage getters | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1328 | fix(ui): keep generated copy feedback stable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1327 | fix: strip code before TTS markdown cleanup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1312 | feat(quota): add Wafer.ai quota provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1314 | fix(ui): update viewport height without visualViewport | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1319 | Fix/dismissible infinite toasts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1324 | Fix notification button text color in dark mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1297 | fix(status): pick latest assistant message in single pass | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1298 | fix(sessions): align archive-cascade count with executed list | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1300 | fix(.nvmrc): use 'lts/*' so nvm can resolve it | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1301 | perf(sidebar): virtualize archived bucket above 50 rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1303 | fix: prevent mobile keyboard from occluding terminal viewport | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1304 | feat: close sortable tabs with middle-click | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1302 | fix(sidebar): key parent-expansion per render context | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1307 | fix(mobile): sync project switch with draft target state | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1305 | feat: add copy-as-markdown and copy-as-json buttons to question card | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1308 | fix: resilient reconnect — preserve state on fetch fail, pause when offline | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1271 | Reduce React Doctor diagnostics in FilesView | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1269 | feat(ui): context panel enhancements — resizable panels, drag-and-drop todo ordering, and persistent sizes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1291 | feat(git): inline file diffs in commit history rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1284 | fix(git): use local-first base ref resolution in getLog, port to VS Code | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1288 | fix(chat): restore file attachments when reverting or forking messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1286 | fix(ui): prevent revert dock from occluding pending changes popover | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1273 | feat(ui): collapsible thinking blocks with merged per-turn view and user toggle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1274 | fix: match root project sessions in switcher | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1279 | feat(ui): revert indicator with undo/redo, message list, and attachment restore | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1270 | fix: display selected source label in skills catalog dropdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1265 | Reduce React Doctor diagnostics in ModelControls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1259 | fix(ui): preserve runtime worktree source | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1217 | Sync speech recognition settings across devices | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1219 | Adds an option to transcribe server STT audio when stopping voice input. | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1229 | fix(ui): persist selection-store state across reloads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1242 | fix(quota): guard remaining usage percent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1256 | Fix: archived session bulk delete for VS Code extension | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1254 | Fix(queue): auto-send queued messages FIFO | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1246 | fix(vscode): skip stale active editor broadcasts | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1252 | fix(ui): default Button type to button | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1243 | test(opencode): restore missing PATH cleanly | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1244 | fix(pwa): include root-scoped session shortcuts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1245 | fix(vscode): sync agent manager settings saves | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1248 | fix(vscode): abort SSE reconnect delays | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1249 | fix(opencode): broadcast activity idle after cooldown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1251 | fix(scheduled-tasks): skip scheduling after stop | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1241 | fix(quota): accept epoch reset timestamps | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1216 | fix: remove GitHub hardcoding and generalize for non-GitHub git providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1218 | Fix mobile keyboard resize closing right drawer | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1204 | fix(terminal): reject file cwd values | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1203 | fix(settings): constrain plan path remapping | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1201 | fix(vscode): clear activity snapshot on stop | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1200 | test(input): restore FileReader mock | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1199 | fix(git): label stash icon buttons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1198 | fix(tasks): preserve timestamps when listing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1197 | fix(projects): use fallback icon MIME | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1196 | fix(vscode): clean up disposed chat webviews | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1195 | fix(sessions): isolate folder save temp files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1194 | fix(vscode): cancel activity watcher retries on stop | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1193 | fix(sync): settle failed attachment reads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1192 | fix(ui): prevent duplicate long press timers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1191 | fix(opencode): unref provider tracker interval | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1190 | fix(ui): support legacy PWA media listeners | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1189 | fix(push): mark visibility hidden on pagehide | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1188 | fix(vscode): include mtime in fs stat proxy | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1187 | fix(tts): clamp generated summaries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1184 | fix(sessions): update changed share URLs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1183 | fix(sync): drop orphan session parts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1182 | fix(quota): ignore invalid reset timestamps | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1181 | fix(terminal): preserve UTF-8 replay chunks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1180 | fix(event-stream): clean up reconnect delay listeners | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1239 | fix(git): label branch rename buttons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1238 | fix(ui): label session rename buttons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1237 | fix(vscode): resolve chat view before commands | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1236 | fix(vscode): clear bridge request timeouts | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1235 | fix(event-stream): isolate subscriber failures | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1234 | fix(terminal): make SSE cleanup idempotent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1233 | fix(terminal): remove upgrade listener on shutdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1232 | fix(sync): advance sidebar recency after streams | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1231 | fix(sync): fetch sessions in active directory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1230 | fix(ui): recover from corrupt chunk reload markers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1224 | fix(opencode): clear server close timeout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1226 | fix(opencode): clear readiness probe timers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1225 | fix(tasks): avoid weekday checkbox double toggle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1221 | fix(ui): clamp text loop index | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #1223 | fix(electron): point issue links to current repo | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1222 | fix(desktop): finish empty app scans | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1220 | fix(updates): compare prerelease versions correctly | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1212 | test(opencode): avoid duplicate WSL env assertion | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1211 | test(sync): shorten websocket fallback test | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1210 | test(opencode): restore PATH after lifecycle tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1209 | fix(status): classify multiedit as editing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1208 | fix(files): match Windows prefixes case-insensitively | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1207 | fix(files): ignore tab paths outside root | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1206 | fix(i18n): retry failed locale loads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1205 | fix(pwa): keep scoped shortcuts isolated | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1172 | fix(files): guard pending navigation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1171 | fix(terminal): track SSE opens per attempt | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1170 | fix(terminal): clean up idle websocket | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1169 | fix(files): ignore stale text loads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1168 | fix(files): stop navigation when save fails | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1167 | fix(sync): preserve part update ordering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1166 | fix(git): dedupe status fetches by mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1165 | fix(settings): make nav resize keyboard accessible | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1164 | fix(settings): mark active nav page | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1163 | fix(ui): expose sidebar group collapse state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1137 | fix: use platform-aware UTF-8 locale fallback for PTY | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1158 | fix(skills): ignore stale repo scans | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1157 | fix(skills): ignore stale catalog scans | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1156 | fix(chat): make linked reference removal focusable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1155 | fix(chat): guard skill autocomplete tab | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1154 | fix(chat): clear text selection timer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1153 | fix(git): forward status mode to runtimes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1152 | fix(sync): skip duplicate status events | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1151 | fix(sync): track only trailing assistant streaming | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1150 | fix(input): ignore stale attachment reads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1149 | fix(queue): auto-send attachment-only messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1148 | fix(files): ignore stale directory refreshes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1147 | fix(chat): refresh memoized action handlers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1146 | fix(chat): make queued message removal focusable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1145 | fix(multirun): disable adding models at limit | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1144 | fix(ui): allow escape to close mobile settings | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1143 | fix(ui): ignore stale file search results | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1142 | fix(event-stream): cancel unavailable upstream bodies | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1141 | fix(sync): compare retry status metadata | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1140 | fix(git): load sandbox db dependency in esm | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1139 | fix(sync): update request arrays immutably | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1138 | fix(electron): preserve desktop hosts when saving SSH instances | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1161 | feat: add Electron Mini Chat windows | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1127 | fix(quota): stop showing misleading OpenRouter percentages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1133 | fix: handle terminal keyboard input on Android tablet | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1129 | fix: set LANG env for PTY to support UTF-8/Unicode in terminal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1132 | refactor: stabilize live chat sync materialization | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1125 | fix: align session status parsing and vscode reconnect reconcile | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1124 | Add quick archive action to session rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1123 | feat: add Polish localization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1122 | fix: redirect focus to hidden input after blurring Ghostty elements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1120 | fix: validate configured OpenCode binary | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1103 | fix(sync): preserve pending questions across session switch and directory eviction (closes #918) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1107 | fix(ui): add opt-in mobile keyboard resize mode and stabilize touch terminal input | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1104 | feat(ui): enable TimelineDialog with full-text search across all message roles in one session | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1106 | Feat/add ide opened file to chat context | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1069 | fix: add concurrency controls for multiple sessions using the same provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1087 | fix(ui): prevent queued message truncation from stale React closure | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1088 | fix(server): prevent streaming hang during long agent sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1083 | fix: preserve per-session scroll position on session switch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1082 | fix: cross-verify update API claims against npm registry | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1079 | feat: add Behavior settings page for global AGENTS.md | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1074 | fix: support slash-containing model IDs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1072 | fix(opencodeConfig): retain headers for remote MCP configurations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1065 | feat: refresh provider models on OpenCode reload | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1071 | :bug: fix: Use light blue to display light theme conversation text selections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1067 | fix(i18n): polish Korean localization copy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1062 | feat(preview): embedded dev-server preview pane + dev shutdown controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1064 | fix(ui): center skills empty state and fix terminal toolbar overlap | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1066 | fix: reconnect SSE immediately on OS wake-from-sleep | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1061 | feat: fork-aware issue/PR listing & OpenCode startup loading indicator | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1059 | fix: allow Enter/Ctrl+Enter to submit custom answer in QuestionCard | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1058 | fix(ui): keep settings sidebar open, center content, and fix worktree refresh | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1052 | Fix: normalize Windows drive letter in VS Code extension webview paths | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #1041 | fix: preserve lastEventId in SSE path and add proxy heartbeat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1035 | feat: make pinned folders expandable to browse subdirectories in project picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1038 | fix: resolve sidebar stale state after worktree, folder, project, and session mutations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1037 | Improve and unify the model picker across desktop and mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1034 | Prevent page overscroll in chat layout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1031 | fix(ui): preserve slash command message ids | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1032 | Improve assistant message action placement for split responses | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1040 | Add Korean locale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1029 | fix: expand mobile add project panel | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1028 | perf: reduce re-renders, fix mobile keyboard handling, add chunk load recovery, and improve PATH management | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #999 | fix: make todo list update dynamically when task status changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1027 | Add i18n foundation and translations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1026 | fix(ui): stabilize mobile keyboard viewport handling | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1025 | fix(web): support service worker notifications in PWAs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1011 | fix(sync): resync the active session after reconnect transitions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1006 | Fix SSE buffering headers for local streams | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #988 | feat: add 'Open files in preview mode' setting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1001 | feat: implement window controls overlay layout and styles | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1000 | perf: drastically improve cold-start, bundle size, and streaming performance | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #997 | perf: lazy-load heavy dependencies (MarkdownRenderer + CodeMirror languages) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #985 | fix: eliminate parent-child session desync across reconnect and navigation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #981 | fix(chat): restore desktop editor file-open in PendingChangesBar | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #978 | fix: surface disconnect reason, switch health probe to /global/health | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #900 | feat(pwa): add install orientation setting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #943 | fix: preserve pinned sessions until global sessions finish loading | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #944 | fix: allow loopback origins for push VAPID fallback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #945 | fix: remove over-aggressive check blocking git branch operations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #947 | fix: opencode process when exiting polyth (closes #927) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #948 | fix: add test notification button (closes #930) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #949 | Match Opencode Config Resolution Behavior | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #950 | feat: show file change summary bar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #953 | Improve MCP settings auth flow, remote config support, and diagnostics UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #958 | fix: only pre-fetch when branch prefix is a known remote name | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #963 | Chat input: drag-drop files and folders from file tree with @folder autocomplete | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #965 | Single select question radios | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #967 | fix(files): refresh open file content after external changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #972 | fix: preserve --host flag across update and restart | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #973 | fix: invalidate worktree list cache after create and remove | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #964 | Migrate desktop shell from Tauri to Electron | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #960 | UI refresh: Base UI migration + flat tinted button language + mobile polish | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #940 | fix: recover from sleep/wake disconnection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #939 | fix: harden SSE compression exclusion and add Caddy reverse proxy docs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #935 | feat: add response compression middleware to reduce bandwidth (#928) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #934 | feat(chat): add export session as markdown workflow | `already-in-polyth` | Session export as Markdown already ships in the web header flow. |
| #932 | feat(files): add Copy Relative Path to file context menu | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #933 | feat(files): add Go to Line workflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #764 | feat(web): add WebSocket transport for message event streaming with SSE fallback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #848 | Add save actions and cross-platform file manager support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #919 | feat(files): auto-refresh file tree on external changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #929 | feat: Latex support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #925 | feat: add desktop quick open workflow | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #913 | feat: session worktree isolation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #915 | Sort skills within groups | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #921 | fix(vscode): avoid POSIX login-shell opencode detection in code-server | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #920 | feat: add scheduled tasks with locale-aware scheduling and safer desktop quit flow | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #916 | fix(sync): deduplicate overlapping delta after coalesced part.updated | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #850 | feat: deliver polished desktop first-launch experience with smart recovery | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #903 | fix(task): prevent subagent silent failures in session resolution and polling lifecycle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #906 | Add tree view support for Git change history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #908 | perf(sync): optimize multi-session event pipeline with per-directory queues and delta coalescing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #909 | fix: question tool content disappears after refresh (#879) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #859 | feat(tts): add OpenAI-compatible custom server TTS provider with configurable model, pitch, and volume | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #871 | fix: restore variant restoration for OpenCode 1.4.0 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #888 | fix: remove shell-specific && operators for non-POSIX shell compat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #893 | fix(sidebar): auto-expand parent node when navigating to subagent session | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #889 | fix(sync): remove stale-delta skip and add parts-gap recovery | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #882 | Add Kiro as an 'Open in' app option | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #886 | fix(git): restore changes panel visibility and sidebar sync | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #885 | fix(chat): replace hover bridge with padding to unblock desktop interactions | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #872 | fix: hide empty archived section and folders | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #860 | feat(stt): add server-side STT provider via OpenAI-compatible Whisper endpoint | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #845 | Add passkey login for protected UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #853 | Adds 1w, 30d session token expirations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #844 | fix: improve Windows managed OpenCode shutdown and launch behavior | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #756 | Zhipu AI Coding Plan usage tracking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #826 | fix(chat): allow revert button hover on short user messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #835 | feat: expose Magic Prompts settings and stabilize session sync flows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #855 | fix: add defensive checks for missing model cost and capabilities fields | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #857 | fix: implement loading timeout, SSE reconnect, and message retry | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #864 | Update minimax-cn-coding-plan.js | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #837 | fix(chat): render LSP diagnostics in tool output | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #830 | fix: recover SSE directory routing in sync pipeline | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #817 | fix: resync session state after SSE reconnect to prevent stuck subagent UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #818 | fix(vscode): normalize Windows directory paths for SSE event store lookup | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #762 | feat(terminal): switch terminal transport to pure websocket with fallback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #767 | fix(chat): improve error message display with warning icon and styling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #779 | fix(worktree): fix worktree detection and state reset when switching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #786 | feat(json): add interactive JSON tree viewer with collapse/expand and rainbow colors | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #813 | fix(server): strip hop-by-hop proxy response headers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #769 | feat(chat): add arrow key navigation for thinking mode in model selector | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #772 | feat(files): add HTML preview support in file viewer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #770 | fix(mobile): close settings drawers and remove extra top spacing | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #774 | feat(fs): add stat API for markdown file validation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #777 | fix: sync draft chat config to draft target directory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #782 | Fix: Escape HTML tags in user messages to prevent parsing as actual elements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #793 | feat: add ZhipuAI provider to quota tracking system | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #795 | fix(server): strip compression headers in generic OpenCode proxy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #796 | fix(quota): correct minimax coding plan URL and usage calculation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #805 | fix(quota): show actual overusage percentage for GitHub Copilot | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #799 | Fix #755: [Bug] When the frontend requests session-related streaming/... | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #808 | fix(server): force identity encoding for OpenCode proxy requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #803 | perf: harden sync architecture and modularize runtimes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #798 | feat: add reusable fuzzy branch fuzzy-search helper and dialog integration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #695 | feat(cli): add --foreground flag for systemd and process manager deployments | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #754 | feat: improve VS Code dev flow and stabilize sidebar/chat behavior | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #599 | feat(server): support configurable hostname for managed OpenCode server spawn | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #751 | fix: Docker UID 1000 for polyth user and non-fatal SSH key generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #750 | fix: bind web server to 127.0.0.1 by default and add --host CLI flag | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #747 | feat: derive and cache model metadata from provider state for custom providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #734 | Enable cross-origin manifest to make PWA work behind Cloudflare Access | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #744 | fix: recognize host.docker.internal as localhost in Docker deployments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #743 | feat: Add opt-out setting for anonymous usage reporting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #741 | feat: instant draft-first worktree creation and multi-run launcher redesign | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #725 | fix: improve cross-runtime session UX and platform config handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #721 | fix(files): incremental directory refresh on create/rename/delete | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #722 | fix: resolve draft project for worktree paths | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #711 | fix(desktop): auto-cleanup stale server processes on startup | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #716 | fix: external links in desktop app - context menu and open behavior | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #719 | feat: minimax weekly | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #715 | fix(sidebar): show sessions in both Recent and Project sections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #706 | Major UI refresh: sidebar redesign, theme expansion, and chat performance optimizations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #699 | fix(desktop): lower macOS minimum version to 13.0 (Ventura) | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #694 | fix(updates): use host platform/arch for server update checks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #693 | fix: improve Windows UX and stabilize chat/session behavior across runtimes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #675 | fix(web): normalize Windows drive letter case for session path matching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #679 | fix: preserve manual agent selection during active runs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #681 | fix: prevent sidebar drag lock during inline rename | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #682 | feat(git): show current branch boundary in commit history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #684 | fix(ui): wrap 'Add to chat' selections in markdown fenced blocks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #660 | perf: batch mobile keyboard viewport handlers with rAF and debounce | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #671 | fix(macos): add audio-input entitlement for microphone access | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #657 | fix(web): restore terminal PTY spawn on macOS arm64 | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #672 | fix: unify update-check API flow across runtimes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #667 | ci: refresh release dispatch and publish updated docs source | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #666 | docs: bootstrap docs source pipeline and align CLI docs | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #661 | fix(docker): align container runtime with core tunnel flow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #649 | feat: auto-save file editor with 1.5s debounce | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #648 | fix: project label text hidden by selection overlay in dark mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #655 | feat(theme): port additional opencode presets | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #654 | fix: improve activity rendering, spacing, and path truncation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #653 | fix(web): hide Windows console popups from daemon/git subprocesses | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #652 | fix: detect symlinked CLI entrypoints | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #650 | fix: docker run | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #629 | refactor(chat): complete turn-based pipeline and stabilize streaming, scroll, and tool UX | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #644 | chore: update changelogs with recent enhancements and fixes across GitHub, Sessions, Chat, and Docs | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #640 | Epic: grand tunnel restructuring and CLI UX | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #637 | fix(ci): ensure sidecar architecture matches target in macOS releases | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #613 | refactor: make GitHub PR status more reliable and up to date | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #638 | feat: prioritize worktrees with active sessions in sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #626 | Feat: spell check toggle for desktop | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #631 | Allow Ctrl+Enter send in narrow desktop layouts | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #625 | fix: project actions on windows using \r input for enter | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #616 | fix: chat composer queue button and focus mode sizing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #610 | refactor: modularize session sidebar and add GitHub PR tracking | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #607 | fix: add orientation lock to dynamic PWA manifest | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #596 | perf: speed up desktop startup and unify theme-aware branding | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #600 | fix: remove orientation any to respect OS rotation lock | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #561 | fix(cli): surface tunnel bootstrap connect URL for --try-cf-tunnel | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #592 | feat(ui): add favorite-model cycling shortcuts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #593 | feat: massive chat reliability + UX pass (web/desktop/mobile/vscode) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #554 | feat(pwa): pre-install naming, install UX, and manifest shortcuts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #590 | fix(ui): make interactive controls show pointer editor provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #587 | feat: make chat file references clickable and responsive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #588 | fix(git): stop PR section refresh loop causing React #185 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #584 | feat(mobile): add project edit panel on long press | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #563 | fix(chat): show in-flight tools immediately and keep collapsed activity live | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #581 | Add OpenIn dropdown behavior to files editor OpenIn button | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #568 | feat(sidebar): add active-project session search | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #579 | Improve files view behavior and Open In integration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #578 | fix: restore worktree branch and PR source behavior | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #577 | feat: streamline worktree session flow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #575 | fix: harden terminal auth, skill file access, and sensitive request logging | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #569 | feat(ui): polish chat and git workflows with mobile UX and reliability fixes | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #564 | fix(chat): align code block actions and restore horizontal scrolling across desktop and mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #565 | fix(ui): prevent session title from overflowing into drawer controls on mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #562 | fix: harden self-update flow and improve chat message readability | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #560 | fix(cli): use pathToFileURL for dynamic imports on Windows | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #559 | feat(chat): show session and permission preview in desktop permission toasts | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #553 | feat: add share message as image functionality | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #557 | feat(chat): align activity timing UI with hover-only end timestamps | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #551 | refactor(tts): consolidate TTS services under lib/tts with stable entrypoint | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #552 | Fix Windows path/spawn regressions and session visibility | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #547 | fix: docker build | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #546 | feat: redesign remote tunnel settings and named tunnel workflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #545 | feat(chat): show dynamic subagent type in task tool button | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #544 | feat: add Ollama Cloud quota provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #542 | Project actions: run commands from header on web + mobile, with SSH-forward URL opening | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #531 | fix: enable markdown rendering for user messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #535 | feat(vscode): support drag-and-drop file attachments in chat | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #529 | feat(ui): add dynamic window title and sprite-based project/file icons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #537 | refactor(skills-catalog): formalize module entrypoint and consolidate server imports | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #532 | fix: docker support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #530 | fix(notification): cache parentID from session events to fix subtask notification detection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #515 | feat(remote): add desktop SSH remote instances lifecycle and UX | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #522 | fix(mobile): optimize usage rate limits tabs UI for mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #527 | Fix Windows compatibility: git status, OpenCode spawn, path normalization, session merge | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #520 | feat(container): add Docker deployment and terminal shell fallback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #524 | fix(mobile): restore MobileAgentButton to prevent soft keyboard dismissal | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #525 | feat(mobile): show child session indicators for current session | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #526 | fix(mobile): improve branch selection dropdown interaction in merge dialog | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #516 | feat: add MiniMax coding plan quota providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #519 | fix(ui): improve file mention autocomplete display for long filenames | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #517 | fix(mobile): expand clickable area for session status bar collapse | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #513 | Fix queued dispatch for inactive sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #511 | feat(nav-rail): add expand/collapse toggle with project names and settings control | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #499 | feat(server): add OPENCODE_HOST env var for external OpenCode connections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #508 | refactor(auth): migrate session storage to JWT with persistent secret | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #507 | fix: stabilize chat rendering after message optimization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #506 | feat: move projects to sidebar rail and speed up session switching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #497 | fix(mobile): recover pending permission prompts after reconnect and resume | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #496 | fix(chat): reduce user message padding and hide top scroll shadow on mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #487 | perf(streaming): buffer SSE parts via rAF to coalesce re-renders | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #494 | feat(mobile): refactor drawer system and session status bar | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #486 | Unify utility model settings and align git generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #491 | fix(vscode): enforce secure parity for /api/fs/read and /api/fs/raw | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #492 | fix(chat): persist default thinking variant selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #493 | feat: redesign settings pages to match canonical flat UI patterns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #490 | feat(chat): add Mermaid fullscreen preview and harden file preview paths | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #464 | feat(settings): group agents and skills sidebar by subfolder | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #483 | perf: fix streaming lag, memory leaks, stuck spinners, and proxy timeout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #482 | feat(files): add 'Reveal in Finder' to file tree context menus | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #484 | refactor(notifications): move notification helpers into dedicated module boundary | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #480 | feat(chat): per-session draft persistence + expandable input focus mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #473 | feat(mcp): add MCP Config Manager UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #469 | feat(session-folders): folder organization, sub-folders, delete confirmations, and UX improvements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #475 | refactor(terminal): move terminal input websocket protocol into terminal domain module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #472 | fix(desktop): preserve instance URL queries and host matching | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #463 | Add C,C++ and Go language support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #460 | feat(sessions): add custom folder grouping for sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #459 | fix(notifications): improve agent progress notifications and permission handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #461 | Refactor inline comment architecture across plan/files/diff and fix diff overlay rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #456 | Restore embedded inline comments in Plan/File/Diff views | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #455 | fix(env): harden login-shell env parsing for cross-platform | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #454 | refactor(server): split opencode config/auth/ui-auth into domain modules | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #457 | Add customizable keyboard shortcuts and new panel/service bindings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #458 | refactor: unify clipboard copy flow across desktop/web/vscode runtimes | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #452 | fix(terminal): restore terminal text copy behavior | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #451 | Fix session/tool-question UX regressions and stabilize streaming activity rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #450 | fix(auth): show actionable provider re-auth errors | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #447 | fix(chat): prevent auto-send during session change | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #446 | feat(context-panel): add plan view to sidebar panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #444 | feat(chat): align command, shell, and subtask UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #443 | Chore/Remove Actions Cloud Runtime | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #441 | feat: align skills with Opencode discovery + add Agents locations + improve skills editor UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #440 | fix(chat): prevent accidental abort after mobile send | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #439 | feat(ui): persist project icon and color with visual update | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #438 | feat: improve chat streaming UX and add Mermaid diagram rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #437 | fix(managed-runtime): secure auth and lifecycle control across runtimes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #436 | refactor(web/server): consolidate GitHub utilities into single module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #435 | refactor(server): consolidate git utilities into dedicated module with documentation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #433 | feat(ui): redesign workspace shell with context panel, tabbed sidebars, and faster diff UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #432 | feat(desktop): persist and restore main window geometry | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #427 | refactor(quota): modularize quota providers and add docs map | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #422 | fix(pwa): allow any screen orientation in PWA manifest | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #424 | feat(quota): add NanoGPT quota provider support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #425 | feat(model-cost-info): show compact price and capability icons in ModelControls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #388 | feat(GitView): normalize base branch and support PR base selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #416 | fix(mobile): simplify agent selection by removing long-press cycling | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #418 | feat(worktrees): ship upstream-first worktree flow across web + vscode | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #419 | perf(diff): Pierre diff optimizations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #415 | feat: add user-configurable zen model for lightweight AI tasks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #413 | fix(ContextUsageDisplay): Open tooltip on mobile tap and remove long-press timer | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #412 | feat(ui/chat): apply corner radius to MobileSessionStatusBar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #409 | refactor: message list optimizations and single messageLimit setting | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #402 | fix: auto-detect existing OpenCode server on startup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #405 | style: enhance CodeMirror search panel theming | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #401 | Fix/Autocorrect On Git And Message Overlap | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #393 | feat(project-notes): add panel to manage project notes and todos | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #392 | fix(ui): prevent header dropdown from cutting off content and adjust last-updated text | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #396 | fix(files): unify context menu trigger on mobile and desktop | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #398 | Fix/Terminal Mobile Viewpoint | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #399 | Fix/Notification {last_message} not working | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #400 | Fix/File Editor Not Usable On Mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #384 | feat(chat): auto-focus input on new session draft and enable double-click to switch tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #391 | fix(desktop): respect local-origin tauri shell for directory access | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #390 | feat(ui): enable drag-and-drop attachments and image previews in chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #385 | feat: invert quota usage markers when remaining mode enabled | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #379 | fix: Gemini/Antigravity quota sources and update labels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #377 | feat(desktop): enable multi-window support and new window action | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #281 | feat(voice): add voice input/output support with multiple providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #365 | feat(git): add multi-remote push with remote selection and fork-aware PR creation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #376 | fix(PierreDiffViewer): align diff viewer dark mode detection to use currentTheme | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #372 | feat: Add usage prediction and pace to usage dropdown and settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #369 | feat: Remove notifications when comments are added/edited/removed | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #370 | Fix: Resolve Comment Draft Collisions by Using Full File Path | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #371 | Consolidate multi-line comment inputs in Plan and File views* | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #317 | feat: Improve notifications with templates, summarization, and more | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #364 | fix: Usage drop down should be scrollable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #363 | Enhance FilesView with breadcrumbs, drafts, and editor UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #361 | fix: update OpenCode proxy to v3 API and dynamic env read | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #362 | feat(ui): add desktop git sidebar + terminal dock and improve in-app PR workflow | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #352 | feat: Add branch name under worktree in session list (if different than worktree name) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #360 | feat: improve session status handling and SSE batching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #357 | Update web app icons and manifest for PWA | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #356 | Opencode/daring jackal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #355 | Add per-model quotas with collapsible model groups in header | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #348 | feat(terminal): add persistent websocket transport for low-latency input | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #354 | Reorganize git view layout and add history/branch actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #350 | Feature/desktop open button | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #345 | Feat: add push to and pull from git with remote selection, along with rebase and merge options | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #347 | Fix: Opencode Auth not passing through properly | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #344 | Fix mobile chat input layout | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #342 | Enhance session sidebar with PR worktree support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #340 | feat(session-status): mobile session quick switch with running/unread indicators | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #339 | refactor(ui): unify primary agent filtering for mentions and UI | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #332 | fix: Make thinking/reasoning blocks display consistently and make the… | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #333 | fix: Allow removing a worktree that has been removed elsewhere | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #338 | feat: improve GitHub picker dialogs layout and mobile cleanup fixes #336 | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #330 | fix(web): update server port configuration to use environment variable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #335 | feat: Add ability to navigate through message history with arrows and persist message draft setting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #329 | fix(terminal): prevent native caret blink in terminal focus inputs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #328 | Add edit comment in plan and diff panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #327 | feat: improve mobile header layout and tab navigation | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #326 | feat: allow renaming projects from sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #325 | fix(terminal): stabilize Android mobile keyboard input | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #273 | refactor(desktop): make Tauri thin shell running web sidecar | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #293 | feat(mobile): split controls into separate Agent and Model buttons | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #294 | feat(settings): add terminal font size controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #282 | Feat/mobile quick actions | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #283 | feat(text-selection): add text selection menu with quick actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #284 | feat: extend quota providers and add usage dropdown (#254) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #280 | Fix: Android pwa app without logo | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #278 | feat(syntax): support phoenix file extensions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #277 | Introduce inline comment in plan and diff panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #275 | fix(git): handle launchd SSH agent socket | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #270 | Add optional context to PR description generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #271 | Add support for GitHub Copilot quota provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #269 | feat(auth): add login rate limit protection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #268 | fix(vscode): Change Health Check to Health API Endpoint and increase timeout | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #266 | Add quota providers API and Ul integration for VSCode and Desktop | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #265 | feature/multitab terminal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #259 | feat: Multi-provider Usage Dashboard & Quota Monitoring | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #264 | Migrate UI to token-based theme system and | `already-in-polyth` | Polyth already uses shared CSS variables and body data attributes as its theme-token seam. |
| #256 | Fix: Allow directory creation outside workspace in Add Project modal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #257 | feat: implement multi-file tabs (desktop) and dropdown (mobile) in FilesView | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #258 | Improve workspace path resolution by checking git worktrees | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #260 | Fixed OpenCode GitHub url | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #249 | Add terminal quick keys option and desktop toggle | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #227 | feat: add notifyOnSubtasks setting to control subtask notifications | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #248 | Refactor chat UI controls and overlays for mobile adjustments | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #247 | Add new mobile chat controls | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #245 | Adjust macOS traffic lights handling and header padding | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #246 | fix: improve event stream resilience with visibility handling and reconnects | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #244 | Adjust input area layout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #243 | feat: add kind metadata for worktrees and PR workflow support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #242 | fix: improve git diff --no-index error handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #241 | Chat input updates with Stop button and update dialog changelog UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #240 | Include Cargo.lock version update in release script | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #228 | feat: Fullscreen File | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #226 | Introduce useEffectiveDirectory hook and apply across UI views | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #224 | feat(ui): add markdown preview toggle for FilesView | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #223 | Improve VSCode bridge file search with gitignore filtering and time budget | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #221 | Refactor permission management across UI components and stores | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #219 | Multi-account GitHub auth + UI polish (model logos, markdown, scroll behavior) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #218 | fix(ui): improve mobile layout for attachments, git & permissions | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #217 | Enhance settings sanitization and text truncation handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #214 | Optimize chat rendering & add web session activity tracking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #212 | feat(ui): add configurable text justification activity setting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #213 | fix: Chrome diff scroll in All Files layout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #210 | Add plan mode and plan view with per-session agent context | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #207 | feat(git): improve PR panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #203 | Fix mobile scrolling for CommandAutocomplete dropdown | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #205 | Add GitHub integration for PRs, issues and AI PR description | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #199 | fix(ui): improve visibility condition and push notification handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #198 | fix: adopt plural config dirs for agents, commands, and skills | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #197 | feat: Add Routes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #196 | feat: add Apply Patch tool with patch input and diff view | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #188 | Fix subagent crash and add external OpenCode server support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #194 | 🚀 feat: Comprehensive OpenCode Ecosystem, persistence encryption & UX enhancements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #195 | feature: header layout changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #193 | Feature/provider config management | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #191 | feat(UI): Introduce new UI components for file attachments and related views | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #189 | feat: add Web Push API support and PWA integration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #186 | feat: lazy load large diffs to prevent page freeze | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #179 | feat: allow control over displaying hidden/dotfiles and .gitignore matches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #180 | fix: copy button not functional on Firefox/macOS | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #177 | refactor: replace 'sonner' toast import with local toast component | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #176 | Fix/active session tracking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #175 | feat(web): enable automatic port assignment if default is in use | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #174 | refactor(chat): enhance scroll management | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #172 | stability and performance improvements with some minor UI issues resolved | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #160 | feat: add branch picker dialog for creating worktree sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #165 | feat: Gitmojis | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #164 | refactor(git): update revert button icon | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #159 | feat(sidebar): add worktree session button to project header | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #158 | feat(sidebar): add grid loader indicator for active sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #157 | feat(sidebar): add right-click context menu support for sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #161 | feat: add --remote-url CLI option to connect to remote OpenCode instances | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #155 | fix: resolve heartbeat race condition causing session stalls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #154 | feat: add Files tab for browsing workspace files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #153 | feat: enhance DiffViewer with asking agent for comment functionality | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #147 | feat: Update author name in changelog | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #146 | feat(vscode): add session editor panel | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #145 | feat(vscode): enhance server readiness with multiple URL candidates | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #142 | feat: Add stacked diff mode controls and mobile dropdown mode selector | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #141 | fix(mobile): add iOS keyboard home indicator safe area | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #144 | fix(upload): increase attachment size limit to 50mb | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #140 | feat: Add Nerd Fonts support for terminal icons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #135 | feat: Display default model in dropdowns and consolidate Git settings menu | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #129 | fix: preserve projects on validation failures and add error logging | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #127 | feat: sort chat sidebar by last updated date | `already-in-polyth` | The sidebar already sorts project sessions by descending `updatedAt`. |
| #126 | fix: settings and model selection not persisting across browser reloads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #125 | Fix/sigint graceful shutdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #124 | fix: hide todo list/status when all todos complete, fix notifications | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #123 | feat: add configurable web native notifications for assistant completion | `already-in-polyth` | Basic hidden-tab completion notifications and sound preferences already ship; richer templates remain specified separately. |
| #118 | Windows Git Paths fixes | `platform-na` | Targets the platform-specific shell surface and has no required web/server port. |
| #113 | feat: add unified dev script for concurrent development | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #112 | feat: add QR code and password URL for Cloudflare tunnel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #115 | Add Copy Worktree Path in 3 dot More Icon for Agent Manager Detail Page | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #110 | feat: add multi-project support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #107 | fix(chat): prevent message send during IME composition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #109 | feat(vscode): Delete Agent Group | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #103 | feat(multi-run): Agent Selector | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #87 | feat(vscode) Agent Manager | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #101 | Add permission asking UI and subAgent session navigation footer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #100 | refactor: update keyboard shortcuts to prevent conflicts | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #96 | Update the shortcuts in the desktop app for macOS | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #99 | Implement Undo/Redo/Timeline and Fork Features and fixed opencode.json reading issue on broken json | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #98 | feat(terminal) refactoring and stability improvements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #92 | feat(vscode): Implement Git Backend via VS Code Git extension | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #91 | feat: add ability to run multiple agents from one prompt in isolated worktrees | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #89 | Add input bar offset setting for curved screen devices | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #88 | feat(vscode): Move Navigation into the title bar | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #85 | feat(web): add Cloudflare Quick Tunnel support for remote access | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #86 | Fix inconsistent mobile keyboard input bar positioning on Android | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #84 | doc: Update Changelog | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #83 | feat: Add Context Menu Commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #80 | Feature/add intel mac support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #76 | feat: added providers management settings with ability to add or remove providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #60 | feat: add UI customization and model management features | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #59 | feat: vscode extension | `platform-na` | Targets the VS Code extension surface and has no required web/server port. |
| #58 | Auto scroll of user message | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #57 | feat: ppencode config fix for desktop | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #56 | Sessions redesign | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #55 | Improve button transition animations and add WebKit-specific CSS fixes for SVG icons within buttons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #54 | Monorepo refactoring | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #53 | docs: add monorepo refactoring planning documentation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #52 | Complete Phosphor to Remix Icons migration with contamination fixes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #51 | chore: standardize phosphor icon imports across components | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #50 | feat: add feature to optionaly hide reasoning parts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #49 | compaction-feature | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #48 | feat: adjusted prompt enhancer config | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #47 | Fix SSE focus visibility regression | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #46 | feat: reasoning visual refactoring | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #45 | feat: improve auto-scroll controls for animated messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #44 | Visual tool adjustments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #43 | feat: add filesystem search for file mentions and picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #42 | UI tweaks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #41 | Fix SSE focus visibility regression | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #40 | Implement worktree session management UI and remote cleanup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #39 | Add session date group bulk deletion controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #38 | UI ux tweaks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #37 | Improve streaming resilience and desktop SSE bridge | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #36 | Temporarily disable empty response detection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #35 | feat(terminal): add mobile quick keys and modifier handling | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #34 | Input fields redesign | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #33 | Investigate inter font weight customization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #32 | Remove header logo and synchronize tool rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #31 | fix(terminal): stability improvements with auto-reconnect | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #30 | Add Cascadia Code font and update defaults to Inter/Cascadia | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #29 | Read number offset | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #28 | Chat redesign | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #27 | Visual improvements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #26 | Perf/streaming fixes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #25 | Refactor: Consolidate navigation into Settings dialog with mobile optimization | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #24 | feat: implement right sidebar with Git, Diff, and Terminal tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #23 | Improve UI consistency and markdown rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #22 | Persist appearance preferences across Electron sessions | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #21 | Refine layout header integration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #20 | Add Electron desktop application support | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #19 | feat: Update SDK to 0.15.0 and fix Claude empty response issue | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #18 | refactor: Remove custom theme support and retain only built-in themes | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #17 | feat: Add Git identity management with comprehensive Git operations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #16 | feat: Add directory creation UI in DirectoryTree picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #15 | feat: Add complete slash commands management system | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #14 | feat: Add full OpenCode restart to header config reload button | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #13 | Fix tool card layout shift and improve UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #12 | Fix assistant text animation and add streaming placeholder | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #11 | Btriapitsyn/agents config | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #10 | feat: Implement modular multi-section navigation architecture | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #9 | Improve tool card UI with hover chevron and inline metadata | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #8 | Migrate icon library from Iconoir to Phosphor Icons (Duotone) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #7 | Migrate typography to IBM Plex Mono | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #6 | Migrate icon library from Lucide to Iconoir | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #5 | feat: implement full-height sidebar layout with improved mobile UX | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #4 | feat: add diff view toggle and message grouping improvements | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3 | feat: enhance chat UI with model names, agent colors, and improved UX | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2 | feat: redesign tool cards with single-line collapsed view | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1 | Add Conductor deployment configuration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
