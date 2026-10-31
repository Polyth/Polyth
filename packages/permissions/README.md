# Permissions

Rules, Auto-Approve resolution, the deterministic risk tripwire (`src/risk.ts`)
and the permission card. Tool approval has one server decision point,
`automaticPermissionResolution` in `packages/server/src/sessions.ts`; see
[security](../../docs/agents/security.md).

## Approval levels and defaults

Three levels: **Ask** (`off`), **Auto-approve** (`routine`: what `risk.ts`
rates routine runs, high-risk requests wait for a person) and **Full access**
(`all`: everything no deny rule blocks). A chat's level is its own choice, else
the nearest ancestor's, else its approval default:

1. the project's own level (Project settings → Approvals, or the Projects list
   in Settings → Permissions), which may be above or below the Space's;
2. the Space's default level (Settings → Permissions);
3. Ask.

`src/approvalDefaults.ts` owns the per-Space state (`full-access.json`, the
historic file name, in the package's Space directory) and fails closed: an
unknown level or project entry reads as Ask, and `enabled` (what older servers
read) is true only when Full access is the Space default and no project is
narrower. `src/serverEntry.ts` serves `GET/PUT /api/permissions/defaults` and
`PUT /api/permissions/defaults/projects/:id`: the instance owner changes them,
only a person raises one, and the agent control socket may lower them.

UI: the approval switch (`widgets/index.tsx`, header and composer) shows the
effective level, offers "Use default" when a chat has its own level, and asks
before anything becomes Full access. Settings → Permissions (`PermissionsSettingsPage.tsx`)
picks the Space level from a radio list (arrows move focus; Enter, Space or a
click chooses, so arrowing never saves a level), folds away what Auto-approve
still asks about, and lists every project with its level. Full access as a
Space or project default takes two warnings; lower levels autosave.

Limits: remembered "always" approvals (`permissions.json`) are not yet
editable in the UI, and user-scope rules written before "always" became
session-scoped still live in the shared, non-Space storage and apply in every
Space.

## Package notes on a request — `session.permission.notes`

Each request of the permission card mounts the host slot
`session.permission.notes` (`host.ui.Slot`, passed to `PermissionBanner` as
`Slot`) between its scrolling explanation and its decisions, so a note stays in
view next to Allow and Deny. Context: `sessionId` (the chat showing the card),
`requestId`, and `sourceSessionId` on a parent's mirror of a delegated child's
request. A contribution renders nothing when it has nothing to say about that
request; the card never names the package behind it (a removable package such
as Judges puts a permission judge's check and verdict there).

## Judgment second opinion — `permissions.scope-check`

An opt-in Judgment use (scope `permissions.scope-check.v1`, Settings → Judgment).
Before Auto-Approve answers a request `risk.ts` rates routine, Judgment scores how
far the action goes beyond the latest person-authored request of the session
(0 = directly asked for … 4 = clearly outside it, normalized to 0..1).

**Strictly one-way.** The answer can only take a request away from Auto-Approve:
`scopeCheckMayAnswer(automaticMayAnswer, outcome)` is `automaticMayAnswer && !hold`.
A held request waits for the person; its preview gets the `outside-task` reason code
and `scopeCheck.probability`, which the web reducer keeps on `PendingPermission.preview`,
and the card shows "Outside the task · 86%". No answer
approves anything `risk.ts`, rules or policy would not. Explicit allow/deny rules,
the session's own todo list and guarded Spaces never ask.

| Param | Default | Meaning |
| --- | --- | --- |
| `threshold` | 0.75 | Normalized score above which the request is held. |
| `timeoutMs` | 3000 (500..10000) | Longest wait for an answer. |
| `onlyWhenAutoApprove` | true | Off also checks Full access answers. |

**Timeout tradeoff.** Auto-Approve exists to keep the agent moving, so the check is
bounded: without an answer within `timeoutMs` (or on failure, `cannot_tell`-like
errors, Judgment off/absent, no person-authored request) Auto-Approve answers exactly
as it would without a second opinion. A slow Judgment therefore lets a request it
would have held through, and every routine auto-answer may wait up to `timeoutMs`.
Raise the bound for more coverage, lower it for less waiting.

Evidence: the tail of the latest person-authored `user/message` (≤1,200 chars;
package-produced, GitHub handoff and recovery messages and rewound turns excluded)
plus permission, tool and the server's **redacted** preview title/lines (≤6 × 200
chars). Raw patterns and metadata are never sent.

Server seam: the package publishes `serverServiceKey<PermissionScopeCheck>("permissions.scope-check")`
(`review({ sessionId, level, request: { permission, tool, preview } })`). The
session service calls it only when Auto-Approve would answer, before the request
event is persisted, so the held reason lands in the canonical preview.

## Verification

```sh
node --experimental-strip-types --test packages/permissions/test/*.test.ts
node --experimental-strip-types --test packages/server/test/autoAccept.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/permissions
```
