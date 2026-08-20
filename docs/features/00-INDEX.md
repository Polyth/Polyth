# polyth and Paseo parity research index

## Inventory result

This research snapshot covers every merged pull request present in the supplied inventories through 2026-08-19.

| Source | Merged PRs | Already in Polyth | Implement in Polyth | Platform N/A | Skip internal |
|---|---:|---:|---:|---:|---:|
| polyth | 1,037 | 7 | 752 | 226 | 52 |
| Paseo | 1,090 | 4 | 802 | 191 | 93 |
| Total | 2,127 | 11 | 1,554 | 417 | 145 |

The large `implement-in-polyth` count includes upstream reliability, correctness, accessibility, and UX fixes, not 1,554 independent features. The detailed documents consolidate those PRs into 68 implement-now feature workstreams and 15 ordered delivery packages. An index disposition means:

- `already-in-polyth`: equivalent behavior is present now, even if adjacent improvements remain.
- `implement-in-polyth`: web/server behavior belongs in Polyth or is a regression invariant the implementation must preserve.
- `platform-na`: source behavior is confined to an unsupported shell or service such as Electron chrome, native mobile, VS Code, messenger bots, packaging, CLI-only UX, or remote Hub/relay.
- `skip-internal`: tests, docs, dependency work, CI, dead-code cleanup, or refactoring without a standalone product behavior.

## Reading order

1. `03-GAPS-vs-polyth.md` — current architecture, shipped seams, and gap decisions.
2. `20-IMPLEMENTATION-ORDER.md` — the 15 work packages and their Done definitions.
3. Domain specification for the package being implemented:
   - `10-chat-composer.md`
   - `11-sidebar-sessions.md`
   - `12-files-git-context.md`
   - `13-preview-browser.md`
   - `14-settings-plugins-mcp.md`
   - `15-goals-schedule-knowledge.md`
   - `16-walkthrough-review-github.md`
   - `17-usage-models-profiles.md`
   - `18-paseo-workspace-ux.md`
   - `19-palette-hotkeys-a11y.md`
   - `21-notifications-permissions-voice.md`
4. `TEST-PLAN.md` — browser walkthrough matrix and evidence requirements.
5. `01-PR-INDEX-polyth.md` and `02-PR-INDEX-paseo.md` — exhaustive source traceability.

## Implement-now feature count by domain

| Domain | Consolidated workstreams | Primary existing seam |
|---|---:|---|
| Chat/composer and message rendering | 14 | `Composer.tsx`, `Timeline.tsx`, `markdown.tsx`, session events |
| Sidebar/projects/sessions | 7 | `Sidebar.tsx`, project/session REST, session projections |
| Files/Git/context surfaces | 9 | `@polyth/files`, `@polyth/git`, `ContextRail.tsx`, `EditorView.tsx` |
| Real browser panel | 1 | `@polyth/preview`, `PreviewView.tsx` |
| Settings/plugins/MCP | 8 | `settings.pages` slot, `SettingsView.tsx`, `uiPrefs.ts` |
| Goals/schedules/knowledge | 5 | `@polyth/goals`, `@polyth/schedule`, append-only events |
| Walkthrough/review/GitHub | 6 | `@polyth/walkthrough`, `@polyth/github` |
| Usage/models/profiles | 4 | `usage/recorded`, `@polyth/models`, model picker |
| Paseo workspace UX | 3 | typed surface slots and project/session projections |
| Palette/hotkeys/accessibility | 5 | `commandPalette.commands`, `@polyth/hotkeys` |
| Notifications/permissions/questions/voice | 6 | canonical permission/question events, `@polyth/dictation` |
| Total | 68 | |

## Source depth

All 2,127 PRs are title-classified in the exhaustive indexes. The implement-now design is grounded in deep reads of 75 polyth PRs and 43 Paseo PRs, including PR bodies, commits, and key file lists. Related fix PRs are folded into the acceptance criteria and edge cases rather than repeated as independent features.

## Global implementation contract

Every domain document applies these rules:

- Use Node 22 erasable TypeScript: no enums, namespaces, or parameter properties; local imports include `.ts`.
- Use workspace package imports such as `@polyth/contracts`; do not reach across package source trees.
- Only `packages/backend-opencode` may communicate with the OpenCode process or SDK.
- Append everything model-visible to the session event log before any UI display; replay must reconstruct the same model history.
- Extend the existing `/api` REST and `/ws` event/projection protocol; do not create a parallel gateway.
- Add surfaces through typed UI slots and capability contracts instead of importing feature implementations into a mega-component.
- Test with `node --test` and plain `node:assert`.
