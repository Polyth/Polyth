# Paseo merged PR classification index

Inventory snapshot: 1090 merged pull requests through 2026-08-19.

Classes are parity dispositions, not judgments about source quality. `implement-in-polyth` includes user-visible fixes that must be preserved during implementation. Detailed source designs are in the linked domain documents; low-level maintenance entries remain here for traceability.

Source titles are preserved except that one prohibited editor product name is rendered as `editor provider`.

## Summary

| Class | Count |
|---|---:|
| `already-in-polyth` | 4 |
| `implement-in-polyth` | 802 |
| `platform-na` | 191 |
| `skip-internal` | 93 |

## Pull requests

| PR | Title | Class | Disposition note |
|---:|---|---|---|
| #3531 | feat(desktop): add Android Studio editor target | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #3533 | feat(app): create agent profiles from the model chooser | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3532 | Update Pi usage and context meter during turns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3534 | fix(highlight): vendor pure-Lezer Svelte parser | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3510 | feat(workspaces): add workspace labels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `18-paseo-workspace-ux.md`. |
| #3517 | fix(app): preserve IME composition across text fields | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3391 | fix(terminal): support CJK IME composition on mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2811 | fix(app): preserve IME composition in web overlays | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3462 | fix(app): defer composer updates during IME composition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3486 | fix(usage): read editor provider plan usage from editor provider-agent auth.json | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3451 | Manage orchestration skills per host | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3465 | Let plugins add contextual workspace tools | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `18-paseo-workspace-ux.md`. |
| #3483 | Summarize pull request checks and group them by status | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #3487 | fix(highlight): highlight Svelte components | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3484 | Keep heartbeat updates in one visible response | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3110 | feat: add Nix syntax highlighting | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #3482 | Show composer trackers as floating pills | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3460 | Manage projects from the CLI | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #3287 | Make the workspace right pane a first-class tab host | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `18-paseo-workspace-ux.md`. |
| #3450 | perf(app): keep composer typing within the frame budget | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3394 | Add active-turn steering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3446 | Make local plugins manageable and debuggable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3447 | perf(app): keep warm workspace switching responsive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3445 | Show branch and project context in workspace rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3395 | fix(opencode): recover turns after event stream drops | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3425 | Prevent unrelated PR merges from archiving workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3424 | Simplify mobile agent configuration | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #3422 | Keep large diff reviews responsive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3365 | Reload daemon configuration without restarting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3368 | Archive finished subagents across the whole track | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3222 | Add managed local plugin lifecycle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3329 | Resume cached timelines without replaying their tail | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3343 | fix(app): make composer input IME-safe and paste-aware | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3187 | fix(desktop): keep element selectors available on loaded pages | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #3341 | Make pinned workspaces sortable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3259 | Restore host directories instantly before reconnect | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3337 | Stabilize live relay status coverage | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3300 | fix(app): support copying Hermes resume commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3331 | Keep agent profile settings valid across providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3318 | Add guided Hub setup | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3323 | Stop idle workspace Git refreshes from starving daemon requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3322 | Make provider catalog refresh deadlines configurable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3321 | Disconnect daemons locally when Hub is unreachable | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3315 | Let Claude apply its native MCP timeouts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3289 | fix(app): validate persisted client state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3311 | Keep new worktrees clean when setup changes are uncommitted | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3279 | Preserve opened subagents when parents are archived | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3281 | Restore model-default variant selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3188 | fix: stop completed Codex subagents appearing active | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3268 | Shut down desktop cleanly with workspace terminals | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2704 | fix(usage): read editor provider token from modern state.vscdb key via node:sqlite | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3267 | Document per-execution Hub worktree branch names | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3263 | Preserve daemon sessions when workers stall | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3243 | Help agents diagnose Paseo provider problems | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3241 | Keep Android workspace selection from crashing across hosts | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #3240 | Improve Markdown file preview readability | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3234 | Prevent Android local storage exhaustion | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #3235 | Keep terminal sessions alive across host sleep | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3233 | Use saved Project Settings for new worktree setup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3232 | Reduce storage writes during agent streaming | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3231 | Remove unused session message processing | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #3184 | fix(omp): negotiate RPC protocol v2 so large model catalogs don't overflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3192 | Notify callers when watched children close and cap responses | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3211 | fix: terminalize Codex compaction on turn end | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3209 | feat: Implement workspace rename cli | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #3227 | Show live task progress while agents work | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3224 | Always create a fresh worktree | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3208 | Add reusable agent profiles | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3063 | feat(app): switch sidebar Group by from the command center | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #3153 | docs: fix typos across contributing, product, and skill docs | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #3216 | Show the source branch on development builds | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3214 | Keep theme choices consistent across settings and shortcuts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3215 | Let users choose the metadata generation model | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3212 | Make large diffs open quickly and scroll as one surface | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2306 | feat(app): render mermaid diagrams in agent chat with pan/zoom | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3177 | Keep delegated-agent notifications alive through permission prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #3176 | Stop notifications after removing a host | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3173 | Show tooltips for all composer controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3172 | Use daemon hostnames for initial Hub slugs | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3053 | Remove chat rooms and agent loops before storage migration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #3159 | Preserve dictation recordings across WebSocket interruptions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #3027 | feat: add file manager context actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3059 | Search workspace files from the command center | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #3152 | docs(hub): align public docs with v0.3 | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3107 | Replace Parcel Watcher with Custom Watcher | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3141 | Publish the TypeScript SDK and integration guides | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3128 | Deploy multi-file Hub workflows | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2579 | Render SVG project icons on native and fall back for ICO | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3099 | Keep Add Project method selection path-free | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3086 | Rework Hub workflow docs around explicit delivery and GitHub authority | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3078 | Keep shared-worktree fetches proportional to ref changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3076 | Treat unpublished desktop updates as unavailable | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #3071 | Restore macOS direct LAN connections | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #3060 | Stabilize async server lifecycle tests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3033 | Recover daemon workers stalled by workspace Git pressure | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #3055 | Keep copied lists intact across selection boundaries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3056 | Keep the daemon responsive when file watching fails | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2985 | fix(shortcuts): show real bindings in the cheat sheet | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2510 | feat(shortcuts): unassign a shortcut, allow bindings with no default | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #3012 | feat(app): add Pure black theme | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3051 | Keep the active project when switching workspace hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #3045 | Give every Hub execution its own workspace lifecycle | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3050 | Keep New workspace metadata inside the composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2924 | fix(app): make session rename reachable in the mobile sessions dropdown | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2953 | Make the sidebar resize handle usable by touch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2582 | fix(desktop): restore notification sounds | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2925 | fix(server): summarise Claude AskUserQuestion permission notifications | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2743 | Fix Kimi usage refresh, 5 hour session limit, and reasoning levels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #3043 | fix(app): keep the crash screen readable and its retry reachable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3042 | fix(server): resolve exact file paths that git ignores | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2759 | fix(codex): omit disabled skills from slash commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #3032 | docs(hub): document workflow security boundaries | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #3025 | feat(providers): add native options and exact MCP grants | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #3022 | Add durable Paseo Hub CLI login | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2995 | Search History by workspace, agent, and branch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2978 | fix(pi): stream assistant deltas when pi omits the cumulative message | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2987 | Make workspace archive self-healing during setup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2979 | Keep workspace Git refreshes responsive at scale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2976 | fix(app): keep browser relay WebSockets protocol-neutral | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2955 | Deploy Hub configurations from the CLI | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2941 | Launch a terminal instead of a chat from New workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2947 | docs: add Korean README translation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2939 | fix(claude): show the Fast toggle on Opus 5 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2948 | docs(hub): document required output contracts | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2952 | Document normalized daemon slugs in Hub | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2942 | Stop terminal activity after interrupted turns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2943 | docs(hub): document durable workflow routing | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2933 | Show workflows in the subagent track | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2931 | Improve reconnect status feedback | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2935 | fix(app): keep line breaks and indentation in copied code | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2937 | Fix composer toolbar collapse flicker on tab switch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2912 | Preserve Claude model and thinking preferences | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2922 | Add custom headers to direct connections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2930 | Keep copied assistant selections within their visible boundaries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2909 | Fill OpenCode subagent info: task, type, model, and tokens | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2911 | fix(app): emit transform-origin as x-then-y for native menu popovers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2910 | fix(server): report Claude runtime death instead of sitting idle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2907 | Keep desktop browser tabs stable across focus and automation | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2876 | fix(server): stop Claude replay from accumulating running subagents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2866 | Release the audio session when voice capture and playback go idle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2895 | Add Korean UI localization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2891 | Show Pi delegated task progress | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2905 | Keep host choices stable across Settings and desktop refresh | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2902 | Prevent ignored workspace data from stalling suggestions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2896 | Keep terminal output live after returning to Paseo | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2864 | Document Hub and let docs pages nest | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2868 | Make Hub worktree archive coverage deterministic | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2858 | Prevent workspace file watching from stalling the daemon | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2850 | Fix the CI failures on main | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #2848 | Default new worktrees to the upstream branch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2842 | Keep recently viewed chats current | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2838 | Preserve chat scroll position across workspace switches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2830 | Keep Android terminal keyboard input stable | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2813 | feat(hub): pass execution MCP servers to agents | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2808 | Preserve assistant selection formatting when copying | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1607 | Improve mobile terminal input, selection, and resizing | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2503 | feat(omp): update context usage during active turns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2506 | fix(nix): restore desktop app icon matching | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2783 | Fix Darwin Nix desktop app icon | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2797 | Limit daemon-wide Git process pressure | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2794 | Keep background composer work out of creation progress | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2790 | Improve sidebar workspace readability and host identity | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2792 | feat(app): add chat outline navigation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2793 | Paste images from the mobile clipboard | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2791 | Keep workspaces responsive across app-wide routes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2789 | Keep timeline history duplicate-free across daemon upgrades | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2775 | Keep Git status and diffs current across platforms | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2777 | Keep workspaces active while native subagents run | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2762 | Preserve interactive ACP permission choices | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2768 | Restore browser test routing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #2757 | Fail active agents when their provider process exits | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2760 | Show complete native subagent conversations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2542 | Skip unrelated required checks without losing their names | `skip-internal` | CI path-routing and skipped-check naming are repository automation, not Polyth product behavior. |
| #2340 | Add collapsed-project status badge to the sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2328 | Fix/local branch worktree base | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2752 | Add shared auto-accept controls to ACP sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2638 | Fork an agent session mid-run from the in-flight turn footer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2712 | feat(app): preview HTML files in the file pane | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2755 | Keep generated workspace titles task-shaped | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2749 | Make the command center stable and workspace-aware | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2750 | Stabilize Hub worktree archive coverage on Windows | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2718 | Keep agent timelines stable from submission through resume | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2714 | Keep restored merged workspaces active | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2745 | Keep dictation prompts visible during submission | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2717 | Make sidebar shortcuts leave focus mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2556 | Build Paseo Desktop from the Nix flake on macOS | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2550 | fix(nix): shrink desktop runtime output | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2715 | Stop terminal environment tests failing intermittently on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2536 | Use portable Bash shebangs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2652 | fix(nix): keep docs and CI out of the derivation sources | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #2697 | fix(nix): keep runtime mode out of agent environment | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #2711 | Show worktree names in workspace hover cards | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2706 | Make relay opt-in when pairing devices | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2709 | Fix mobile sidebar swipe and drag failures | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2708 | Ship mobile updates through the app stores only | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2707 | Stop commit history tests timing out on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2335 | feat: add host-local custom project icons | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2498 | Read Claude subagents from the SDK task protocol | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2702 | Show New Workspace isolation controls immediately | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2274 | Switch reasoning, mode, plan, and fast from the Command Center | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2699 | Show the current pull request after switching branches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2700 | Keep selected projects when switching hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2416 | Show project icons in status-grouped sidebar rows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2696 | Use OpenCode busy status for background activity | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2694 | Stop transient file conflict callouts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2680 | Choose which orchestration skills get installed | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2662 | Stop OpenCode cancels from killing the next turn | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2670 | Clarify changed and deleted files in the file viewer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2654 | fix(desktop): restore Linux package startup | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2565 | Restore project grouping across hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2488 | fix: reject oversized checkout diffs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2613 | Stop Windows server CI from flaking on stderr timeouts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2611 | Support repository search on older GitHub CLI versions | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2563 | Let provider processes identify their assigned workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2595 | Prevent restored file trees from crashing desktop startup | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2494 | fix: preserve context window data when turn_completed lacks usage | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2596 | Revert the timeline optimistic and pagination rework | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2311 | fix(server): suppress Pi interruption stream error | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2590 | Keep idle agents and their background work alive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2490 | Keep older chat history and image previews stable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2534 | Keep plan approval focused on the latest proposal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2533 | Configure agent thinking from the CLI | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2417 | feat(app): dismiss the chat keyboard on a fast upward flick | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2537 | Speed up server CI tests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2439 | Fix AppImage launches from Linux desktops | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2500 | Run only relevant CI checks for each pull request | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2353 | fix(quota): restore Grok Settings usage for current CLI auth/billing | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2497 | Show a single 1M-context Claude Opus 5 model | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2419 | Carry local files and shared state into new worktrees | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2491 | Open project and workspace folders from the sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2110 | Switch projects from New Workspace with ⌘P/Ctrl+P | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2406 | fix(omp): accept nullable model context windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2343 | List paseo-skins as a community project | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2418 | Expose injected Paseo tools directly in OMP | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2434 | perf(build): parallelize server dependencies | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2423 | Show project-local Codex skills in Paseo | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2432 | fix(app): render HTML in PR comments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2478 | fix(forge): preserve non-default port in forge web URLs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2431 | fix(dev): make worktree setup run on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2484 | Stop completed turns from appearing stuck | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2476 | Keep provider settings above the model selector | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2482 | Keep large file views from disconnecting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2481 | Load complete chat history when reaching the top | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2458 | Keep parent agents alive while child work runs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2480 | Reduce relay overhead for binary terminal and file traffic | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2459 | Wrap long Markdown lines in the file editor | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2457 | Focus the file pane when clicking its editor | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2455 | Explain how to recover from an expired Claude login | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2454 | Stop the daemon when you quit the desktop app | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2433 | Fix Claude 5 context window selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2425 | test(cli): include Opus 5 in provider expectations | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2395 | Let Hub finish the executions it starts | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2233 | fix(server): retry hub test temp cleanup on Linux ENOTEMPTY | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1848 | fix: prevent Shift+Tab from changing a backgrounded agent's mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2171 | fix(omp): limit thinking levels to model's reported efforts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2161 | fix(server): name both refs in the base ref mismatch error | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2288 | fix(server): keep the client port in X-Forwarded-Host | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2299 | fix(app): pin the active workspace from a collapsed sidebar section | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2303 | fix(server): read Claude model-scoped weekly limits from limits[] - Shows weekly Fable usage | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2345 | fix(app): show project name in command center workspace search | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2169 | Stop stale client sockets from exhausting daemon memory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2371 | Copy terminal IDs from tab menus | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1992 | feat(cli): manage workspace scripts | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2380 | Fix image uploads using the wrong format | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2208 | Connect daemons to Hub through browser approval | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2394 | Give Android store builds more memory | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2392 | Keep Pi users on the native provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2381 | Keep terminal pairing QR codes scannable | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2390 | Keep development tool versions consistent across version managers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2382 | Hide Markdown source controls on read-only hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2389 | Document how to set up Codex in Paseo | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2218 | Render live omp system-notices as synthetic tool calls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2379 | Stop workspace updates from stalling workspace creation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2366 | Make Git slowdowns visible in daemon metrics | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2369 | Fix slow grouped tool-call loading animations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2368 | Fix web chat stickiness at non-default zoom | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2363 | Prevent duplicate ACP image prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2277 | fix(app): preserve file line endings and UTF-8 BOM | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2348 | fix(server): clean up failed provider session initialization | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2355 | Stop archived workspaces from running background Git checks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #2349 | Publish smaller Android APKs for each architecture | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2360 | fix(app): size iPad selector popovers | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2280 | fix(omp): honor hidden custom messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2361 | Fix compact composer controls and native scrolling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2350 | Show workspace commits clearly in Changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2336 | Keep completed OpenCode turns idle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2282 | fix(omp): complete delayed model turns after local-only results | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2228 | feat(omp): add write approval mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2175 | fix(omp): accept all command source types in slash command schema | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2261 | fix(omp): complete turns when agent_end omits messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2331 | Fix notifications opening the wrong workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2322 | fix(server): tone usage bars by how full they are | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2219 | Improve OMP state compatibility and advisor rendering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2298 | feat: open Changes as a workspace tab | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2324 | Open existing agents from links and the CLI | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2317 | fix: stop stale checkout diff subscriptions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2275 | feat: add workspace files to chat from Files and Changes | `already-in-polyth` | Files and changed paths can already be inserted into the composer as `@path` context through drag/drop and file actions. |
| #2316 | Restore archived agents from History | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2315 | Make CLI workspace creation explicit | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #2313 | Keep Pi message IDs stable after agent resume | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2312 | Show recent commit history in the explorer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2309 | Open chat file links at the referenced line | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2290 | Start new workspaces from pasted pull requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2252 | Fix renaming projects before their first workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2267 | feat(pi): add 'max' thinking level support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2265 | fix: workspace-scoped session imports across Claude Code, OpenCode, Pi, and OMP | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2257 | Allow turning thinking off | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1749 | Fix settings host sections showing "host not found" when the local daemon is stopped | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2270 | Edit workspace files directly on web | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2165 | feat(server): configure workspace service port allocation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2268 | Keep dictation shortcuts working after recording | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2258 | Show OpenCode follow-ups after background work | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2259 | Keep submitted prompts in their correct chat position | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2263 | Load complete workspace lists and agent history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1587 | fix(nix): package local speech worker | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #2214 | Stop phantom Codex subagents from lingering | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2213 | Use safer automatic approval modes by default | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2210 | Keep sidebar pins visible while reopening | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2209 | Resume collected agents before pane actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2203 | Free resources from idle agents automatically | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2206 | Show recent chat immediately on app launch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2201 | Make next-turn setting changes harder to miss | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2147 | Switch models from the Command Center | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2196 | Keep focused agent timelines live and catch up instantly | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2191 | fix(omp): accept thinkingLevel "max" when importing OMP sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2181 | fix(server): remove wall-clock timeout for Pi compact RPC | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2192 | Document workspace-first agent automation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2194 | Keep the composer visible after voice dictation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #2172 | Fix commit-aware PR resolution across forges | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2186 | Make workspace, agent, and schedule automation consistent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2185 | Fix duplicated and out-of-order agent chat messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2189 | Refresh Claude provider compatibility | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2160 | Make keyboard shortcuts searchable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2187 | Add non-Git projects across filesystem mounts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1884 | fix(app): align thinking section scroll layout with other detail sections | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2035 | Connect your Paseo daemon to Hub | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2098 | Treat every added folder as an independent project | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2028 | Reduce workspace, agent, and chat sync traffic | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2156 | Keep agent browser tabs connected across workspace switches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #2155 | Include the daemon version in every log entry | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2154 | Keep terminal sizing reliable through focus changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2149 | Always install the newest eligible desktop update | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1913 | feat(forge): pluggable forge abstraction + GitLab and Gitea/Forgejo/Codeberg | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1982 | Keep browser input from submitting Paseo prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #2059 | Terminal resize race | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2151 | Keep workspace focus mode scoped and easy to exit | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2067 | feat(omp): add native OMP provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2150 | Record the 0.1.110 ACP hotfix release | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2146 | Make commit history easier to scan and review | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2148 | Keep ACP agents running during foreground turns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2123 | Reimport archived sessions into the current workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2137 | Fix sign-in popups in the desktop browser | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1534 | Git commit history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2002 | Improve the archived workspace restore flow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2124 | Show agent history errors without a one-minute wait | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1951 | Remove custom providers from settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #2120 | Make remote daemon update failures actionable | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #2119 | Open files in more installed editors | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2116 | Hide browser shortcuts outside the desktop app | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2114 | Catch broken desktop packages before release | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2111 | fix(desktop): stop sandboxed preload from requiring a local module | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2097 | Add a keyboard-driven project setup flow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2096 | Find and open workspaces from the command center | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2091 | Simplify assistant fork boundary handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2092 | Document iOS/Android local dev setup and fix the mise Android toolchain | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2058 | fix(server): create autonomous turns for spontaneous ACP session updates | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2089 | Keep browser sign-ins across tabs and restarts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #2090 | Keep tool call summaries neutral | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2063 | Allow failed agent turns to be forked | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1962 | Recover desktop startup from stale daemon locks | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2086 | Reduce composer overhead while typing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2085 | Publish the latest Android version code | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2073 | Show friendly native subagent names and hide finished work | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2078 | Keep desktop sidebar controls stable across panel changes | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2074 | Render provider images from paths with spaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2068 | Fix hidden Codex subagents and stuck parent sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1983 | Fix desktop layout and window controls at half-screen width | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #2069 | Refine tool call summaries and scrolling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2070 | Polish release notes and in-app help | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #2066 | Fix Pi slash commands hanging after local completion | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2061 | Surface cross-workspace subagents in their workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2047 | Fix shortcut capture ignoring - = ; ' keys | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #2027 | fix(server): stop OpenCode daemon crash on session close, fix #2014 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2062 | Explain cross-provider orchestration workflows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2031 | feat(app): add tool call detail levels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1978 | Serve the daemon web UI from Nix packages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1979 | Fix Codebuddy Code model discovery | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2049 | Find .opencode files in workspace search | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2045 | Make help easier to find and cloned workspaces open reliably | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2039 | Keep CI moving through transient npm failures | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2038 | Keep forked chats focused in new tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2037 | Show every Codex terminal command in agent timelines | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2036 | Keep New Workspace prompts when switching projects or hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1331 | feat: clone GitHub repo into a workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1980 | feat(app): give each permission mode a distinct icon | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1768 | Support F-Droid Android builds | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #2030 | Keep attachments visible after creating an agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1981 | feat(app): pin chats to the top of the sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2000 | fix(agent): allow cross-provider creation for modeless providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1999 | Stop Pi metadata tasks from cluttering session history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2029 | Show only commands in Codex shell tool calls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2007 | Keep agent stream controls clickable under the scroll button | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2023 | fix(terminal): create PTYs at the client viewport size, not 80x24 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2026 | Make adding projects discoverable in new workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2013 | Show provider subagents in the subagents track | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2022 | Show Fork chat for every agent provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #2024 | Keep ACP tool execution in the agent environment | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2025 | Show tooltips for sidebar footer actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #2011 | feat(acp): configure generic client capabilities | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2020 | Keep oversized tool output out of chat timelines | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #2019 | Keep Pi chats usable after canceling extension commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1637 | Fix Paseo repo worktrees without global cross-env | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2015 | fix(server): await OpenCode event stream shutdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2003 | Archive any workspace from the app | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1990 | fix(server): preserve Pi MCP config during injection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1977 | Stop reconnects from reviving agents during shutdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #2001 | Allow Codex MCP approval prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1996 | Preserve loader behavior while reducing hidden work | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1998 | Verify real agent workflows through the hosted relay | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1997 | Stop app tests failing after chat teardown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1989 | Prevent Android chats from freezing or going blank | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1968 | Restore fuzzy project folder search and desktop browsing | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1976 | Restore the mobile left sidebar swipe | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1967 | Fix Codex status and streaming during sub-agent work | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1964 | Hide keyboard shortcut badges in workspace menu on native | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1966 | Keep large sidebars responsive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1952 | Choose non-fast variants for ACP models | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1953 | Stop mobile sidebars getting stuck out of sync | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1955 | Update MiniMax metadata model to M3 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1960 | Keep Pi text-only sessions from bricking on images | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1943 | Show reasoning output automatically when enabled | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1945 | Restore compact Changes diff controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1885 | fix(app): handle CancelledError from cancelled provider usage queries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1886 | fix(pi): add get_session_stats fallback from get_state for old OMP binaries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1918 | feat(app): folder tree in the Changes view | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1924 | Show a recovery screen for app render errors | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1941 | Stop Android audio interruptions crashing voice mode | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1940 | Keep renamed host names after reconnect | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1939 | Cut the context cost of Paseo's agent tools | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1938 | Manage the built-in daemon from one place in settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1934 | Scheduled runs each get their own workspace in the sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1909 | Scheduled and loop agents get workspaces; schedules UI speaks the user's timezone | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #1919 | Mark bundled-CLI daemons as desktop managed | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1915 | Fix desktop-managed daemon restart from settings | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1914 | Include desktop app logs in diagnostics | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1916 | Fix desktop PATH resolution when shell startup fails | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1899 | Fix default bundled web UI path in packaged desktop CLI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1908 | Fix worktree setup scripts losing PATH | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1896 | fix(server): surface TRAE CLI slash commands and skills over ACP | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1903 | Hide browser tools unless enabled | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #1895 | Speed up inbound WebSocket validation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1887 | Auto-title workspaces created by agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1881 | Browser tools: full accessibility snapshot, trusted input, dialogs, evaluate, and tab controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #1878 | Generalize browser automation hosting beyond the desktop app | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1877 | Build Docker images from source | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1876 | Let agents rename workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1875 | Stop new browser tabs from an agent stealing your focus | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #1872 | Show Claude Ultra Code where supported | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1857 | fix(app): show New workspace action on non-git sidebar projects | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1860 | Polish schedules list and editing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1855 | Fix Claude quota panel erroring when a usage window has no reset time | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1831 | feat(app): add ByteDance TRAE CLI to the ACP provider catalog | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1851 | Keep composer autocomplete visible after route hops | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1838 | Keep New Workspace drafts when archiving a workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1849 | Open a project with Cmd+O | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1246 | Add a Schedules screen to manage recurring agents | `already-in-polyth` | A schedules surface already lists, creates, edits, pauses, runs, and deletes tasks; cron/time-zone parity remains. |
| #1708 | feat(browser): inspect, annotate, and grab page elements for the agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #1643 | feat(app): clearer interactive question card | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1359 | Add opt-in browser tools for desktop tabs | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1830 | Speed up app Playwright CI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1827 | Place turn footers after trailing tools | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1823 | Use separate OpenAI endpoints for speech-to-text and text-to-speech | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1825 | Show host in search results and filter sidebar by multiple hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1792 | fix(server): surface Kiro CLI slash commands and skills over ACP | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1815 | Show found desktop updates after manual checks | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1812 | Keep agent lists working when project records go stale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1811 | Fix Windows image previews | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1810 | Make daemon status report health without loading agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1808 | Show desktop update check feedback | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1759 | Fix macOS packaged CLI daemon Dock icons | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1806 | Keep New Workspace on the current project | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1804 | Fix pushed state for checked-out PR worktrees | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1807 | Fix Claude subagent narration leaking into chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1805 | Keep streamed chat images in order | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1788 | Fork assistant turns into new drafts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1790 | Make daemon shutdowns easier to diagnose | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1789 | Default client RPC waits to 60 seconds | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1801 | Restore the "Drop files here" backdrop when dragging files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1771 | fix(windows): resolve past .cmd wrapper to kill opencode.exe process … | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1779 | Stop agent prompts renaming existing workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1777 | Fix mobile launch with a saved workspace | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1776 | Preserve chat scroll-away after delayed history | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1760 | Keep slash commands visible after New Workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1775 | Show host names on every sidebar row when you have multiple hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1762 | Show Add Project search loading state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1761 | fix(projects): make a freshly-added project editable without a restart | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1624 | fix(acp): add tests asserting cwd and mcpServers are always passed to session/load (#1593) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1732 | feat(pi): make extension result timeout configurable via provider params and increase default to 30s | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1750 | Attach dropped files in every composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1540 | fix(server): use terminateWithTreeKill in Claude Code provider close() | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1704 | fix(opencode): prevent indexing the entire home directory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1622 | Fix web terminal scroll lag | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1651 | feat: add C# syntax highlighting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1620 | Fix project picker timeouts in large repos | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1699 | Refresh open file tabs when revisited (#445) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1667 | fix(server): no-op agent hooks when PASEO_TERMINAL_ID is unset | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1513 | feat: add remote daemon self-update from client | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1746 | Make New Workspace an app-wide screen | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1740 | Run Paseo from an official Docker image | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1741 | Fix desktop file uploads with extensions | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1662 | feat: add MiniMax quota fetcher and brand icon | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1739 | fix(server): honor X-Forwarded-Proto so daemon web UI auto-connects behind HTTPS reverse proxy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1538 | Merge sidebar workspaces across all connected hosts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1635 | Serve the web client from the daemon | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1728 | Add app diagnostic report | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1727 | Speed up new Pi agent startup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1724 | Keep provider diagnostics useful when discovery is slow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1725 | Fix Windows daemon status output | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1723 | Keep liveness pings responsive during slow requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1653 | feat: add Brazilian Portuguese locale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1707 | Prepare providers for direct Paseo tools | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1718 | Link worktrees to PRs from differently named tracked branches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1716 | refactor(server): extract the workspace-scripts feature into a deep module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1715 | refactor(server): extract the agent-update subscription stream into a deep module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1714 | refactor(server): extract workspace git-observer into a deep module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1717 | Render images from Claude Code tool results in chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1712 | refactor(server): extract workspace provisioning into a deep module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1711 | refactor(server): extract git-mutation primitives into git-mutation module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1709 | Improve workspace names for slash-command prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1702 | refactor(server): extract git-metadata generators into a checkout module | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1694 | feat(i18n): add Japanese (ja) locale | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1701 | Stop Claude context meter from doubling requests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1700 | Expose Copilot custom agent selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1698 | Fix OMP slash commands and skills loading | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1697 | Stop OpenCode helper servers from leaking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1660 | Keep provider diagnostics and model lists in sync | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1664 | Improve GitHub panel toolbar and loading states | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1658 | Keep composer mode preferences stable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1661 | Keep compact file explorer visible while open | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1646 | refactor(server): decompose session.ts into per-domain subsystems | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1645 | Move voice subsystem under session/ to match checkout | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1644 | refactor(server): extract checkout read subsystem into CheckoutSession | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1641 | refactor(app): move workspace setup-status fetch into the setup store | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1640 | refactor(server): extract voice mode subsystem into VoiceSession | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1636 | Fix Windows Kimi usage test isolation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1632 | Clean up owned helper processes on daemon startup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1631 | Keep projects visible after archiving workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1627 | Fix Playwright workspace isolation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1626 | fix(server): set opencode serve cwd to home dir to stop full-filesystem scan | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1278 | feat: live multi-provider quota panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1625 | Add Claude Ultracode with setting-change notices | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1612 | Detach subagents without archiving them | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1611 | Make provider diagnostics easier to share | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1608 | Clarify PR merge action labels | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1609 | Fix hidden workspace file links | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1366 | fix(opencode): trust discovered modes, don't inject hardcoded defaults | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1368 | fix: daemon warns instead of crashing on missing OpenAI speech credentials | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1560 | Document filename:line:column file link parsing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1585 | Fix markdown rendering hang on unmatched backticks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1580 | fix(app): reveal workspace-jump numbers only for the active modifier | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1581 | Keep connections alive through brief daemon slowdowns | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1576 | Migrate monorepo to Zod 4 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1568 | Restore changelog entries for betas | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1567 | Show prompt titles immediately for new workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1565 | Fix New Workspace PR worktree creation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1485 | fix(desktop): stop AppImage updates hanging on quit and deleting the app | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1566 | Fix Agent MCP redaction smoke test | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1563 | Name agents by their first prompt line instead of an LLM summary | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1562 | Remove a worktree when its last workspace is archived | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1561 | Fix pending permission MCP listing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1558 | Include child results in finish notifications | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1556 | Use only selectable ACP models | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1539 | Run multiple independent workspaces per directory | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1516 | feat: hide dotfiles in file explorer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1537 | fix(app): prevent Android crash when opening Providers settings | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1187 | fix: pass appBaseUrl to generateLocalPairingOffer in daemon pair RPC | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1460 | Use terminateWithTreeKill for ACP agent child process cleanup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1507 | Show activity indicators for terminals and their workspaces | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1503 | Make workspace IDs opaque, independent of the filesystem path | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1509 | Fix coding-agent terminal shortcuts not working on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1510 | fix(acp): make ACP/Kimi sessions importable again | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1500 | Eliminate spiky terminal lag under load | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1501 | Fix attachment size mismatch and enable file uploads on mobile | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1502 | Show clean prompts in session imports | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1491 | Refresh stale GitHub data after reconnect | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1490 | Show an error for missing project paths | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1488 | Make git actions follow the safe workflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1474 | Add drag-and-drop file upload and file picker to composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1489 | Fix new workspace keyboard overlap | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1487 | Rework docs navigation and move alternatives to top-level pages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1486 | Fix uploaded images in pull request comments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1484 | Improve terminal profile modal and fix zinc primary button contrast | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1400 | Attach pull request feedback to chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1478 | fix(app): add missing i18n keys for host settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1452 | Authenticate injected agent MCP when daemon password is set | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1473 | Add Copy file path to file preview tab menus | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1472 | Bound retained workspace screens | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1464 | Accept inline skill autocomplete in the composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1282 | Complete client UI i18n migration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1455 | Keep PR status current after agent merges | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1462 | Let multi-question prompts advance one answer at a time | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1441 | Preserve Pi import model and thinking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1422 | fix(server): show Other input for Claude questions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1424 | feat: add Antigravity as an "Open in editor" target | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1443 | Add Claude Fable 5 to the model catalog | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1412 | Fix Windows Explorer opening Documents instead of the workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1387 | Prefer Windows editor command shims | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1409 | ci: stabilize Electron dependency installs | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1423 | Inline provider catalog in settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1420 | Restore global agent listing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1403 | fix(catalog): point Kimi entry at Kimi Code CLI | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1388 | Add OMP as a built-in importable provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1338 | Fix Pi compaction slash commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1379 | Show useful local speech crash details | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1378 | Archive merged PR worktrees after branch deletion | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1377 | Keep Codex usage logs on Codex identity | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1376 | Prepare prompt file attachments for future UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1375 | Open browser links in workspace tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #1358 | Fix worktree checkout validation for existing git branch refs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1333 | fix(claude): preserve alwaysLoad on MCP server configs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1356 | Keep virtualenvs out of project picker results | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1351 | Authenticate file downloads with their capability token alone | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1355 | feat(desktop): support multiple windows | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1311 | fix(claude): respect profile models for built-in claude provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1334 | fix(app): make markdown links tappable on iOS | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1346 | feat(server): make provider refresh timeout configurable via PASEO_PROVIDER_REFRESH_TIMEOUT_MS | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1329 | Fix Windows workspace provider loading | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1297 | Stop local daemon when removing localhost | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1326 | Highlight Dart code blocks and diffs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1324 | Add a global New workspace picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1317 | Group and clear workspace status in the sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1316 | Prioritize ready actions and scheduled agent prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1315 | Keep child agents unattended across providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1313 | Archive merged PR workspaces from settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1310 | Show question prompts one at a time | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1285 | feat: open active files in editors and file managers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1309 | Keep desktop skills up to date automatically | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1303 | Open workspace files in desktop targets | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1293 | Keep delegated agents out of workspace alerts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1288 | Unify workspace service URLs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1290 | Fix Pi extension command output hangs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1280 | Add configurable service proxy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1270 | Make composer controls fit narrow panes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1224 | feat(desktop): persist and restore window size, position, and maximized state | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1230 | Add configurable worktree root | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1254 | fix(app): render bold/italic/strikethrough and line breaks via UITextView span on iOS | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1260 | fix: archive worktrees even when teardown fails | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1261 | Fix split-pane right-edge resize clipping | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1266 | Separate handoffs, subagents, and heartbeats | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1242 | fix(desktop): stop pinning macOS displays at max refresh rate | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1257 | fix(app): stop iOS dropping inline links/URLs in assistant messages | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1232 | Add timezone-aware cron schedules | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #1236 | Add appearance settings for theme, fonts, and syntax highlighting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1251 | Make workspace tab switching faster | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1249 | Fix terminal resize after splitting panes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1247 | Fix chat history paging around tool updates | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1241 | Flatten settings sidebar with a host picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1245 | Show agent terminals created in workspace subdirectories | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1238 | Fix flaky mobile bottom-sheet reopen e2e test | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1220 | Show connected host daemon versions on the About page | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1218 | Syntax-highlight code in Edit, Write, and Read tool calls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1219 | Prefer configured provider fallbacks for metadata generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1216 | Add manual refresh button to git diff controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1217 | Keep local voice memory out of the daemon | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1214 | Allow previews to open readable files | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1210 | Improve Playwright E2E test quality | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1206 | Archive agents on worktree archive; clean up schedules on archive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1188 | Fix/pi ask user submit | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1198 | Make MCP provider controls match the app | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1200 | Fix unbounded growth in daemon workspace git caches | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1197 | Improve app tests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1052 | Extract client SDK package | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1191 | Fix provider binary diagnostics for command overrides | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #893 | refactor(server): integrate session MCP command stack | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1153 | fix(app): native iOS text selection in assistant messages via UITextView | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1175 | Keep draft composer permission mode selected | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #1173 | Accept dropped files in the terminal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1174 | Open terminal file links in workspace previews | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1172 | Allow PR merge when GitHub reports it ready | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1149 | fix(app): swallow URIError in assistant file link parser on bare '%' | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1171 | Show OpenCode tool activity consistently | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1170 | Clean up settings latency readouts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1093 | Show workspace scripts in mobile header | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1165 | Add Devin CLI to the ACP provider catalog | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1167 | Fix provider models per workspace | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1168 | Add allow-always actions for OpenCode permissions | `already-in-polyth` | Permission replies already support one-time approval, persistent approval, and rejection. |
| #1169 | Interrupting an OpenCode agent should return to idle, not error | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1154 | Rewind chat or files from any user message | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1163 | Show cumulative session cost | `already-in-polyth` | Cumulative session cost is already projected from `usage/recorded` and shown in the context rail and turn footer. |
| #1158 | Fix false unpushed commit warnings for worktree archive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1156 | Preserve assistant message formatting on copy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1147 | Make mobile terminals load faster | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1144 | Make the web app installable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1134 | Bridge Pi extension UI dialogs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1124 | Recover stale host connections automatically | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1120 | Create agents in worktrees with auto-archive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1121 | fix(server): launch Pi through the Windows-aware spawn helper | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1091 | chore: upgrade vitest | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1105 | docs: update built-in provider references | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #1113 | Fix Dvorak paste shortcut handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #1103 | fix: stop leaking CSS rules from dynamic UI styles (#1084) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1112 | Pass custom env into agent processes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1106 | fix: add publicUseTls option to NixOS module | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #1111 | Fix startup workspace restore | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1099 | Wait for editor provider ACP slash commands before listing in the UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1097 | Run Pi agents through the installed Pi CLI | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1102 | Reduce workspace git refresh polling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1101 | Restore the previous workspace on app start | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1100 | Add daemon-wide system prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1096 | Add DeepSeek TUI to the ACP catalog | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1098 | Show icons for catalog providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #531 | Add rename for workspaces, terminals, and agent tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1095 | Fix duplicate Claude Code responses | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1088 | Show resolved file paths in agent file-link tooltips | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1087 | feat(server): upgrade embedded Pi SDK | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1020 | Fix Codex Microsoft Store binary detection on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1011 | feat(mcp): consolidate provider settings tools | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #1037 | Reject relay re-handshake key changes | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1064 | Add Kiro CLI to ACP provider catalog | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1082 | Fix CLI/daemon environment inconsistency in `daemon status` and `daemon pair` commands | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1072 | Fix Codex sub-agent failure projection from child state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #745 | fix: prevent macOS desktop unlock freeze after display sleep | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #1077 | fix(server): render non-ASCII filenames in git output | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1076 | fix(terminal): send SIGINT for hardware Ctrl+C on iPad (#1049) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1079 | Stop OpenCode probes from creating empty sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1045 | feat: add independent TLS control for relay public endpoint | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #1067 | Support line ranges in assistant file links | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1012 | Fix Windows import session path matching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1065 | Stabilize mobile sidebar close test | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1021 | Make terminal scrollback configurable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1063 | Fix OpenCode custom command hangs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #940 | Fix native diff row expansion | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #981 | fix(app): widen host switcher popover | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1061 | Show diff file paths in a tooltip | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1062 | Syntax highlighting and copy button for chat code blocks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1058 | Fix Windows Android app scripts | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1059 | fix(app): avoid Android white screen in permission mode menu (#1053) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1032 | fix(mcp): add missing schedule tools (update, logs, run-once) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #1055 | Fix OpenCode session imports | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1050 | Fix composer resize flicker with long prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1038 | Refactor chat file-link opens to a single disposition seam | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1034 | Add slash commands for ending and restarting agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1048 | Fix mobile web gestures, DnD activation, iOS zoom, and Enter behavior | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #1040 | nix: include home-manager profile paths when inheriting user PATH | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #1043 | fix(cli): mention remote daemon host on ls connect failure | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #900 | fix (app): mobile sidebar web interactions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #966 | nix: shrink daemon install with @vercel/nft tracing | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #1033 | Show chat timestamps and turn durations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1028 | Fix default thinking option selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #1024 | Fix duplicate project worktree registration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1025 | Fix assistant file link resolution | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1026 | Fix OpenCode retry timeout handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1023 | Fix upstream-gone ahead count | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1004 | Auto-archive worktrees after PR merge | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #1006 | Auto-attach pasted GitHub PR/issue URLs in the composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #1003 | Project rename: distinguishable names for duplicate projects | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #999 | Fix Shift+Enter in terminal input modes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #1001 | Surface GitHub auto-merge actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #908 | fix: honor current branch in new workspace flow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #1002 | Fix branch-off worktree upstream tracking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #994 | Confirm risky worktree archive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #996 | Avoid probing extra executable candidates | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #995 | Recover Pi sessions after Copilot 413 | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #993 | Show all PR check counts in hover card | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #992 | Deduplicate Codex skill commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #991 | Fix ACP diagnostic model counting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #990 | Add Codex context compaction support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #989 | Preserve Codex assistant message ids | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #988 | Make provider snapshot refresh explicit | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #910 | Add MCP provider feature discovery | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #909 | Add MCP provider feature controls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #917 | fix(server): include OpenCode console subscription providers in model list | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #924 | Patch compatible transitive advisories | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #979 | feat(claude): discover models from ~/.claude/settings.json | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #919 | Fix iPad hardware Enter submit in composer | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #932 | Fix/pr status fallback with fine grained tokens | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #978 | Show upstream ACP JSON-RPC errors instead of [object Object] | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #958 | fix(editor provider): discover models via editor provider ACP client | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #977 | Support local Claude settings configuration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #975 | fix(server): reconcile workspace kind alongside project kind | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #976 | Fix zsh integration runtime modes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #928 | Add Auto Review permission mode for Claude Code | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #963 | feat(codex): implement Auto-review permission mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #973 | Fix relay E2EE reconnect races | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #911 | Refresh MCP worktree cache after create/archive | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #955 | Add diagnostics for generic ACP providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #951 | fix(app): auto-set ref picker from a single attached PR | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #947 | Fail Codex resume requests explicitly | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #945 | Archive scheduled agents after new-agent runs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #939 | ci(nix): smoke-test daemon boot, build desktop derivation | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #922 | Fix iPad Settings sidebar safe area | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #931 | Windows: unwrap \pwsh\ / \powershell\ / \cmd\ in Codex command summaries | `platform-na` | Targets the platform-specific shell surface and has no required web/server port. |
| #941 | Configure STT language from settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #913 | fix(server): desktop daemon stale PID startup | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #937 | Fix iPad sidebar safe area background | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #934 | Normalize HEIC image attachments on the client | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #923 | nix: declarative config, typed relay options, desktop packaging | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #933 | Add trace logging and tighten daemon log defaults | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #935 | fix(server): Copilot Allow All mode wires native ACP allow_all | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #915 | Fix custom Codex provider base URL routing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #916 | Use OpenCode global event stream | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #904 | fix(server): address OpenCode recovery review findings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #902 | fix(server): recover OpenCode turns when 1.14.42+ SSE drops early | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #847 | Harden file explorer symlink handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #845 | Restrict desktop external URL schemes | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #899 | Fix Codex sub-agent status after child tool failures | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #898 | fix (app): mobile web model picker crash | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #897 | Fix Windows git command console flashing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #859 | Fix macOS tab jump shortcut conflict on international keyboards | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #896 | Fix old relay pairing URL TLS compat | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #895 | fix(server): recover completed opencode turns after SSE EOF | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #842 | Redact MCP debug request logs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #887 | refactor(server): exercise codex features through fake app-server | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #873 | refactor(server): extract codex app-server fake | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #874 | refactor(cli): inject local daemon launch runtime | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #881 | refactor(app): extract workspace terminal lifecycle | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #883 | refactor(server): extract task document persistence | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #886 | Refactor daemon connection probe tests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #885 | Refactor worktree create request parsing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #884 | Extract sidebar callout state | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #882 | Refactor relay transport socket tests | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #878 | Extract worktree setup callout policy | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #880 | Unslop workspace git watch tests | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #877 | Extract agent archive projection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #876 | Refactor workspace layout id generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #875 | Extract websocket runtime metrics | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #858 | Fix infinite recursion in web crypto randomUUID polyfill | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #879 | ci: trigger required checks on merge_group events | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #872 | refactor(server): inject push notification sender | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #870 | ci: remove duplicate server-ci workflow | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #869 | test(codex): regression coverage for app-server JSON-RPC dispatch | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #868 | refactor(server): inject OpenCode runtime | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #866 | refactor(server): extract Codex app-server transport | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #865 | refactor(server): extract opencode server manager | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #864 | chore: issue forms, PR template, contributor guidance | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #863 | Fix Pi session shutdown lifecycle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #854 | refactor(server): extract import session boundary | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #853 | refactor(app): centralize tool call presentation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #856 | Patch production dependency advisories | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #850 | fix(app): enable image drop on new workspace screen | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #852 | fix(app): redirect optimistically when archiving worktree from toolbar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #851 | refactor(app): move agent tab visibility policy | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #849 | Fix relay encryption docs | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #848 | refactor(app): extract workspace archive transaction | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #846 | refactor: share agent state priority | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #841 | refactor(app): unified navigateToAgent | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #844 | refactor(app): centralize checkout query keys | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #843 | refactor: share github remote parsing | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #840 | refactor(server): centralize task graph readiness | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #839 | refactor(server): extract shared task graph utilities | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #838 | refactor(server): extract checkout status projection | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #837 | feat(app): grouped project settings with docs links + scrollbar fix | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #834 | feat(app): create empty workspace without a prompt | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #836 | feat: project-level prompts for metadata generation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #833 | feat(app): import-agent pill above draft composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #830 | Fix chat fanout + unify system-injected agent prompts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #831 | fix(app): submit typed path from iOS project picker (#829) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #766 | Import existing Claude/Codex/OpenCode sessions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #825 | Protect local state file permissions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #828 | feat(app): focus attention-needing agent tab on workspace navigation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #814 | feat(checkout): merge PR action with real-GitHub e2e test | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #532 | Surface paseo subagents in a collapsible section above the composer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #827 | feat(codex): archive native Codex thread when archiving agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #809 | Run server tests on Linux+Windows matrix | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #808 | fix(server): keep requested cwd when creating an agent | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #799 | Add Sonnet 4.6 1M model to Claude model picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #806 | test(server): real-fs coverage for Linux walker gitignore skip | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #794 | fix(server): stop Linux watcher event storms on busy working trees | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #797 | Replace skills auto-sync with explicit install/update/uninstall | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #793 | Fix ACP terminal shell command spawning | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #791 | Fix desktop CLI passthrough tty handling | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #787 | fix(server): harden findExecutable + remove gratuitous realpath from spawn paths | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #785 | Render Codex image thread items as path markdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #788 | Use tree-kill for daemon shutdown | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #789 | Fix dev override host bootstrap | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #782 | fix(cli): honor PASEO_PASSWORD env var (fix #776) | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #770 | Add ACP provider registry modal | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #765 | Wrap desktop IPC in shared mutation/query hooks (fix #761) | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #774 | fix(relay): use TLS for any port-443 relay endpoint | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #767 | Allow self-hosted relays to opt into wss:// | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #711 | feat(codex): wire /goal slash command with mid-turn support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `15-goals-schedule-knowledge.md`. |
| #772 | Fix workspace navigation regression on web | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #759 | refactor: long-tail type-aware sweep (T3.c) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #762 | fix: include untracked files in checkout shortstat (#608) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #760 | fix: normalize Claude AskUserQuestion answers (#755) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #758 | refactor(server,app): lift return types and parse at boundaries (T2 typeaware production sweep) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #757 | refactor(server/tests): solve class-stub mock pattern (T1.e) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #756 | refactor: explicit returns + void floating promises (T3.a typeaware sweep) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #754 | refactor(typeaware): no-unnecessary-type-conversion + unbound-method sweep (T3.b partial) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #753 | refactor(server/tests): T1.a — clear 146 type-aware lint errors in session tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #752 | refactor(server/tests): replace unsafe type assertions with Reflect + Zod (T1.b partial) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #750 | refactor(server): parse daemon/ws/wire test responses with Zod (T1.c typeaware sweep) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #749 | refactor(app/relay): parse test responses with Zod (T1.d) | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #742 | test(app/e2e): sessions-screen empty state (Cluster G7) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #744 | test(app/e2e): picker keyboard interaction tests (Cluster G8) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #746 | test(app/e2e): mobile sidebar open/close transition (Cluster G6) | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #743 | test(app/e2e): stream auto-scroll and working-indicator→copy-button (Cluster G5) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #737 | fix(cli-tests): prepend root node_modules/.bin to PATH so npx paseo resolves locally | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #739 | fix(app/e2e): fix composer-lock test — mock provider + prompt so lock releases | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #731 | test(app/e2e): cover project-settings error-UX paths (Cluster G3) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #734 | test(app/e2e): add composer-attachments spec (8 behaviors) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #732 | feat(app/e2e): add PR pane E2E spec with fixture-based seeding | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #733 | test(app/e2e): add desktop-updates spec covering update banner and daemon lifecycle (cluster G4) | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #727 | refactor(app/e2e): eliminate raw locators from spec bodies (cluster #13) | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #726 | refactor(app/e2e): rewrite settings-navigation spec — zero raw locators | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #725 | refactor(app): replace screen test slop batch 2 with proper coverage | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #724 | refactor(app): replace 4 component test slop files with pure module extractions | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #723 | chore(app): clean up E2E helpers in packages/app/e2e/helpers/ | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #721 | test(app): triage desktop test files — delete 16-mock component slop, tighten attachment store | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #722 | refactor(app/e2e): migrate workspace-cwd spec to withWorkspace fixture | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #720 | refactor(app): extract composer-actions module with pure tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #719 | refactor(app): extract resolveAgentForm pure reducer from use-agent-form-state | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #718 | refactor(app): extract keyboard shortcut routing into a pure function | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #716 | refactor(app): make use-agent-input-draft storage injectable | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #717 | feat(app/e2e): withWorkspace fixture + DSL helpers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #714 | test(app): tighten weak assertions in utils tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #713 | refactor(app): extract pr-pane derivations into pure utils and unit tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #715 | refactor(app): assert store state rather than mock call counts in store tests | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #710 | refactor(app): fix type-aware lint errors in UI components | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #708 | perf(cli): run CLI E2E tests in parallel | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #705 | refactor(agent-providers): fix type-aware lint errors in diagnostic-utils and generic-acp-agent | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #706 | refactor(app): fix type-aware lint errors in app state/runtime files | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #707 | refactor(claude-agent): replace unsafe type assertions with type guards | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #704 | refactor(server): add getErrorMessage helper and fix error-related type-aware lint errors | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #699 | refactor(agent-providers): add toObjectRecord helper and fix type-aware lint errors | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #701 | refactor(speech): add ONNX type augmentation and fix type-aware lint errors | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #702 | fix(app): make e2e setup an auto fixture so first-of-spec tests get setup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #698 | refactor(relay): fix type-aware lint errors in WebSocket and crypto handling | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #694 | schedule: add `paseo schedule update` to edit schedules in place | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #697 | fix(server): derive non-GitHub project display names from remote | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #696 | refactor(app): remove unnecessary String() and Boolean() conversions from type-aware lint fixes | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #695 | refactor(server): remove unnecessary String() conversions from type-aware lint fixes | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #693 | refactor(server): remove redundant null from unknown union types | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #692 | refactor(app): remove redundant type constituents for type-aware lint | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #691 | refactor(server): replace JSON.parse type assertions with Zod validation | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #681 | Feat/open projects config to any | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #689 | schedule: fire --every now by default, add run-once | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #688 | mcp(create_agent): validate mode and refuse silent cross-provider inheritance | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #687 | refactor(relay): remove unnecessary awaits from synchronous crypto functions | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #686 | feat(cli): paseo worktree create with MCP parity | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #685 | cli(schedule): require --cwd when --host is set | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #657 | fix(app): paginate canonical timeline catch-up to avoid relay 1009 disconnect loop | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #670 | Add browser pane element picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `13-preview-browser.md`. |
| #672 | [codex] Stream Codex sub-agents as tool calls | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #668 | refactor(server): extract provider turn runner | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #666 | refactor(server): extract foreground run state from agent-manager | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #667 | refactor(server): extract WorkspaceDirectory from session.ts | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #664 | refactor(app): fold timeline sequencing helpers into stream reducer | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #665 | refactor(server): extract terminal stream router from daemon-client | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #663 | Fix assistant stream continuity during init hydration | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #659 | feat: stream files as binary frames over WebSocket | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #658 | feat(opencode): subagent timeline support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #606 | fix(opencode): include all-mode agents in mode picker | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #635 | feat: direct TCP URI with SSL toggle and optional password auth | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #639 | feat(cli): connect via relay using pairing offer URL | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #636 | Unify worktree creation workflow | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #640 | Keep archived worktrees optimistically hidden | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #530 | Add inline review comments to git diff pane | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #632 | feat(cli): add `paseo import --provider <name> <id>` for existing sessions | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #628 | fix(server): make editor provider CLI and other ACP custom providers reliable | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #634 | docs: lowercase internal docs + migrate website docs to public-docs/ | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #629 | fix: percent escaping for git --format on Windows | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #621 | fix(desktop): warn about Rosetta installs on Apple Silicon | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #627 | feat(app): add pull-and-push git action | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #613 | fix(server): preserve fatal log on crash and guard socket.send against close races | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #595 | fix(server): support OpenCode full-access approvals | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #600 | fix: keep @ file mention responsive on very large projects | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #597 | fix(opencode): support executable slash commands | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #594 | fix(loop): pass provider/model to daemon in loop/run | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #504 | docs: add star history to README | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #583 | Support opening workspace branches on GitHub | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #563 | fix(server): skip home directory in workspace prefix matching | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #503 | Support GitHub SSH host aliases for PR actions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `16-walkthrough-review-github.md`. |
| #570 | feat(speech): make OpenAI realtime transcription URL configurable | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #585 | [codex] Centralize subprocess env boundaries | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #578 | Add macOS packaged desktop smoke gate | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #545 | chore: drive linter to zero, promote warn -> error in CI | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #542 | [codex] Make workspace git registration nonblocking | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #526 | fix(server): preserve Codex fast mode after plan approval | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #500 | fix(app): allow collapsing parent folder of selected file in explorer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #202 | feat(server): replace Pi ACP with direct SDK provider | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #230 | feat: add persistent workspace state, first-class terminals, and setup streaming | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #454 | fix(server): harden Codex/Windows startup and provider resolution | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #426 | feat: provider model freshness TTL and diagnostic UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #447 | fix: make code file preview text selectable on iOS | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #398 | Fix OpenCode permission prompts missing command context | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #399 | style(app): theme native scrollbars across all web views | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `14-settings-plugins-mcp.md`. |
| #423 | fix: MCP tools work for archived agents, CLI parity | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #419 | fix(desktop): allow localhost origins in dev | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #427 | Render .md and .markdown files as markdown in the file pane | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #429 | fix(server): Map OpenCode todo and compaction events | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #442 | fix: retry file explorer init when client reconnects after page refresh | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #444 | Fix duplicate command args for generic ACP providers | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #411 | fix: file preview shows stale content when re-opening a file | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #412 | fix: update lockfile signatures and Nix hash | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #413 | refactor: rename allowedHosts to hostnames | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #407 | fix: handle OpenCode slash command header timeouts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #408 | fix: archive upstream OpenCode sessions on close | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #357 | Update the scripts to support dev on Windows machine | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #290 | feat: provider profiles — custom provider definitions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #325 | fix: add getId to workspace route so navigation updates params | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #270 | fix: skip Enter key handling during IME composition | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #322 | Add  reasoning effort option for Opus 4.6 models | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #318 | fix: centralize Windows exec handling and async migrations | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #319 | feat: add Cmd+, keyboard shortcut to toggle settings | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #310 | fix(server): centralize git subprocesses with p-limit throttling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #291 | Align MCP/CLI naming and resolve default model/mode server-side | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #260 | Split streaming markdown into memoized blocks | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #258 | Add `paseo agent reload` CLI command | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #236 | ci: fix all tests to green | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #232 | feat: middle-click to close tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #231 | feat: branch switching with stash-and-switch | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #220 | feat(app): Add WebStorm editor target | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #225 | fix(pi): Pi agent slash commands not loading before being requested | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #217 | refactor(app): improve route types, reduce amount of `as any` | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #204 | fix(server): serve workspace list instantly on fetch, reconcile in background | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #201 | fix(server): reset session ID on query restart to prevent overwrite crash | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #206 | fix(server): bypass Copilot ACP prompts in autopilot | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #211 | fix: show direct connection and pairing modal content on tablets | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #209 | feat(app): add open in editor toolbar action | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #208 | feat(app): Add side-by-side diff view and whitespace toggle | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #191 | feat(server): add Pi agent provider and re-enable Copilot | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #190 | fix(server): deduplicate workspaces by git worktree root | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #189 | feat(cli): support `paseo .` to open desktop app with project | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #186 | feat: provider-declared features with Codex fast mode | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #170 | feat: ACP base provider, Copilot integration, eliminate hardcoded provider unions | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #172 | feat(app): add searchable model favorites | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #169 | fix(server): implement slash command support for OpenCode harness | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #165 | [codex] add batch close rpc for workspace tabs | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #158 | WIP: fix archive tab reconciliation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #152 | Fix mobile sidebar reset after theme switch | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #149 | feat: add loop, schedule, and chat CLI commands | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #148 | fix: handle Windows drive-letter paths across the codebase | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #130 | Add support for Nix and NixOS | `platform-na` | Targets the platform packaging surface and has no required web/server port. |
| #143 | Expose PASEO_AGENT_ID to Claude and Codex agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #141 | fix(app): sync keyboard pane focus with active panel | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `19-palette-hotkeys-a11y.md`. |
| #140 | Fix assistant message text selection on Chrome | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #122 | fix: route Claude partial tool input through canonical mapping (#108) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #92 | fix(test): add missing getRuntimeMetrics mock to MockSession | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #93 | Fix stale Android autolinking cache when switching variants | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #90 | build: universal macOS binary (Apple Silicon + Intel) | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #88 | Daemon logging defaults: split console/file levels + file rotation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #81 | Fix auto-generated agent title/branch updates not surfacing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #79 | Show task notifications as synthetic tool calls in chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #80 | Fix web stream scroll contention with strategy-driven renderer | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #78 | fix(server): decouple explicit and auto agent title limits | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #73 | Fix app stream/timeline ordering desync and init lifecycle race | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #67 | perf(app): optimize streaming state updates and auto-scroll | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #62 | refactor: remove permission timeout logic and rely on abort handler | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #68 | fix: pin @opencode-ai/sdk to 1.2.6 to fix startup crash | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #69 | Add desktop app + local daemon update controls in Settings | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #70 | Centralize perf diagnostics and activity coalescing | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #61 | Fix archive UX with shared pending state and agent-screen overlay | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #60 | feat(app): paste images into prompt attachments | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #59 | feat(app): shared custom overlay scrollbars on desktop web panes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #58 | Add @ workspace file autocomplete for agent chat | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #57 | Improve post-ship worktree flow and merged PR handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #56 | Add Claude provider /rewind command support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #55 | fix: unify agent attention notification payloads | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #54 | Enable explorer sidebar on draft screen after cwd selection | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `11-sidebar-sessions.md`. |
| #53 | Improve desktop command autocomplete to match combobox behavior | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #52 | Confirm terminal close when a command is running | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #51 | fix: archive worktree when last agent is archived | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #33 | Show image previews in optimistic user messages | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #32 | Fix worktree archive terminal cleanup and tighten worktree setup | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #45 | fix: terminal shrinks after switching agents | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #48 | Make slash commands available in the new-agent draft screen | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `03-GAPS-vs-polyth.md`. |
| #49 | fix: hash worktree root by cwd to prevent path clashes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #29 | Decouple onboarding from voice model downloads and gate unavailable voice starts | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #28 | fix(app): avoid unnecessary git diff header auto-scroll on collapse | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #25 | Refactor Claude/Codex tool-call parsing to provider-local Zod passes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `17-usage-models-profiles.md`. |
| #24 | Push-driven checkout diff subscriptions for changes sidebar | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #23 | Add worktree destroy script support | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #22 | voice: harden local voice agent path and UUID validation | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #19 | Local streaming STT/TTS (Parakeet v3 + Pocket TTS) | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #20 | Git panel: share checkout actions + fix push loading | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #18 | Fix agent history catch-up + avoid mobile background stream deltas | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #16 | Desktop tooltips for header toggles | `platform-na` | Targets the desktop shell surface and has no required web/server port. |
| #15 | Update changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #12 | Update changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #5 | feat: implement end-to-end encryption for relay connections | `platform-na` | Targets the remote-host platform surface and has no required web/server port. |
| #11 | Fix diff maxBuffer crash + harden RPC handling | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #10 | Fix web voice mode; share VAD/segmenting | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `21-notifications-permissions-voice.md`. |
| #8 | feat: add live model and thinking option preferences UI | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `10-chat-composer.md`. |
| #9 | refactor: rename realtime to voice throughout app and server | `skip-internal` | Maintenance, tests, documentation, performance work, or refactoring with no standalone parity feature. |
| #6 | Presence-gated Expo push notifications | `platform-na` | Targets the native mobile surface and has no required web/server port. |
| #3 | Update changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #2 | Update changes | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
| #4 | feat: add CLI package with daemon and agent commands | `platform-na` | Targets the command-line surface surface and has no required web/server port. |
| #1 | fix: remove stale raw field expectation from test  The 'raw' field was removed from timeline entries in commit 8bb3518 (Nov 28) to reduce payload sizes by 64-85%. This test was never updated and has been broken since then. Remove the stale expectation to align with the current implementation.  🤖 Generated with [Claude Code](https://claude.com/claude-code)  Co-Authored-By: Claude <noreply@anthropic.com> | `implement-in-polyth` | Web/server product behavior to port or verify; mapped to `12-files-git-context.md`. |
