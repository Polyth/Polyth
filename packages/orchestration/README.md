# Orchestration (`@polyth/orchestration`)

A removable package: each person chooses which models delegated agents run on
for which kind of work, with quota fallbacks and a never-use list.

## What it does

- **Policy** (`src/contracts.ts`): `mode` `auto` (Polyth's ranking alone; agents
  get no policy block) or `roles`. Six built-in roles (explore, implement,
  verify, review, vision, write) plus up to 4 custom roles, each an ordered chain
  of at most 5 models with an optional advisory `maxConcurrent`. Also
  `quotaCeiling`, `overPaceCeiling`, `whenExhausted` (`shortlist` | `direct`),
  `maxChildren` and a `excluded` never-list.
- **Service**: provides `SERVER_DELEGATION_POLICY`. `agent.models` prints
  `brief.text`, a blank line, then the Usage shortlist built with `brief.exclude`.
  `auto` mode returns no brief.
- **Resolution** (`src/resolve.ts`): one `SERVER_MODEL_ROUTING.candidates(space,
  { pairs, limit: 50 })` call; per choice the status is
  excluded > unlisted > unavailable > blocked > over-pace > ceiling > unverified > ready.
  Without the Usage package every non-excluded choice is `unverified`.

## Settings → Orchestration

`widgets/` registers one settings page (`id` = package id, group Workspace, so
the shell's header "?" opens the package tour from `widgets/tour.ts`):

- **How to choose**: Auto | By role, a hint that follows the mode, and a closed
  "How it works" disclosure with the three steps of that mode.
- **Now**: what an agent gets if it delegates right now, from the *saved*
  policy: each role's pick (Ready / Fallback / Nothing usable, with the reason),
  the ranked list exactly as agents see it (first 12, with the omitted, retired
  and never-delegate counts), quota sources with pace, and "What the agent sees"
  (the verbatim `agent.models` text, copyable).
- **Roles**: one disclosure per role with its priority chain (move, remove, an
  advisory "at once" limit, live status from a debounced `POST /preview` of the
  unsaved draft), "Add model" (picker: starred, used, then each harness; facts
  only, never the name-based tier), custom roles (name + "when", read by agents
  verbatim) and "Fill from my models" (`POST /recommend`, never saves by itself).
- **Safeguards**: quota threshold, the earlier over-pace threshold, what to do
  when nothing fits, subagents at once, the never-delegate list, reset.
- One SaveBar; a 409 shows a reload notice instead of overwriting.

Copy lives in `src/i18n` (12 locales). Visual acceptance: 1280×800, 1440×900 and
390×844, light and dark, with zero horizontal overflow at 390.

## Data

`spaceStorage(space).packageDir("orchestration")/people/<sha256(userId)[0..32]>.json`,
mode 0600, one file per person; the person always comes from `rc.space`, never
from the request. Writes to one file are serialized and checked against
`expectedRevision` (content hash; `"default"` before the first save). A corrupt
file reads as the default policy.

## Routes (`/api/orchestration`)

`GET` state · `POST /preview` (draft) · `PUT /policy` (`expectedRevision`, 409 on
mismatch) · `DELETE /policy` · `GET /models` · `POST /recommend`. Bodies over
64 KiB and invalid policies are 400. Paired devices are denied
(`localOnlyRemoteAccess`).

## Agent-facing format

```
Routing policy (the person's own rules from Settings → Orchestration; …):
- explore (read-only research: …): use <harness> <provider>/<model> (at most 2 at once); then …; skipped now: … (quota 93% ≥ 85%)
- <custom label> (custom: "<when>"): none usable now (… BLOCKED ~2h) → choose from the ranked list below
Never delegate to: <harness> <provider>/<model>, ….
Run at most N delegated children at once.
No role fits the work: choose from the ranked list below.
```

Person-written text is stripped of control characters and newlines first.

## Exclusions and aliases

A never-delegate key hides the model, not one spelling of it: the shortlist
(`SERVER_MODEL_ROUTING` `exclude`) drops every row that runs the same concrete
model, and a role choice that is an alias of an excluded model (`default` when
`opus` is excluded) resolves as `excluded` too.

## Disabled package

The policy service is registered once at load (the service registry has no
withdraw), so it answers only between `onEnable` and `onDisable`. While the
package is disabled agents get Polyth's automatic ranking, exactly as without
the package.

## Limits

`maxChildren` and `maxConcurrent` are advisory: agents are told, Polyth does not
refuse a spawn. Quota facts are the Usage package's cached snapshots.

Tests: `node --experimental-strip-types --test packages/orchestration/test/*.test.ts`.
