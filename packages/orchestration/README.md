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
- **The person's own order of the ranked list** (both modes): `pinned` (≤12
  keys, listed first in that order, even unused), `demoted` (≤24, listed last)
  and `harnesses` (≤24 harness id → `prefer` | `avoid` | `never`). A key sits in
  one list only: `excluded` beats `pinned` beats `demoted` (parsing drops the
  weaker copy). `never` hides every model of that harness from the list and
  marks its role choices `excluded`. Empty fields are left out of the revision
  hash, so a policy saved before they existed keeps its revision.
- **Service**: provides `SERVER_DELEGATION_POLICY`. `agent.models` prints
  `brief.text`, a blank line, then the Usage shortlist built with
  `brief.exclude`, `brief.excludeHarnesses` and `brief.order` (`listOptions` in
  `src/serverEntry.ts`). The never lists and the order apply in both modes: in
  `auto` mode the brief has empty `text` (no policy block) and is undefined only
  when the person set none of them.
- **Recommend** (`src/recommend.ts`) fills each role from the person's
  favorites and use by name-based tier. A model with at least 20 turns in the
  window of which 30% or more failed is placed after every reliable model of
  the role's tiers, so a person's own failure history shapes the draft; it is
  still offered when nothing else exists.
- **Route for one role**: the same service answers `route(space, roleId,
  { exclude })` with the first usable model of that role's chain (statuses
  `ready` and `unverified`) whose key is not excluded; undefined in `auto`
  mode, while the package is disabled, and for an unknown, disabled or empty
  role. The workflow engine uses it to run a unit that names a routing role
  ([workflows](../../docs/dev/workflows.md#routing-roles)).
- **Resolution** (`src/resolve.ts`): one `SERVER_MODEL_ROUTING.candidates(space,
  { pairs, limit: 50 })` call; per choice the status is
  excluded > unlisted > unavailable > blocked > over-pace > ceiling > unverified > ready.
  Without the Usage package every non-excluded choice is `unverified`.

## Settings → Orchestration

`widgets/` registers one settings page (`id` = package id, group Workspace, so
the shell's header "?" opens the package tour from `widgets/tour.ts`):

- **How to choose**: Auto | By role, a hint that follows the mode, and a closed
  "How it works" disclosure with the three steps of that mode.
- **Now**: what an agent gets if it delegates right now, from the *draft*
  (the server's `POST /preview`, with `orderRows` applying the draft's order at
  once so an edit never waits on it): each role's pick (Ready / Fallback /
  Nothing usable, with the reason) and the ranked list, up to 50 rows with a
  line after the first 12 ("Agents see the 12 models above", the rest behind
  "Show N more"). Harness chips filter the list; choosing one shows its rule
  (Prefer / Normal / Avoid / Never). Each row's ⋯ menu explains its rank
  (`rankReasons`: usable or not, the person's placement, star position, use in
  the window, fullest quota) and moves it: Pin to top / Move up / Move down /
  Unpin, Push to bottom / Return to its place, Never use; a placement chip
  marks moved rows. Quota sources are titled by the harness's registry name
  with the plan beside it; each window is a line (label, meter, reset) that
  opens the ranked models it meters (`quotaWindows`). In By role mode a meter
  also warns from the over-pace level while its window runs over pace. "What
  the agent sees" is the verbatim `agent.models` text, copyable.
- **Roles**: one disclosure per role with its priority chain (move, remove, an
  advisory "at once" limit, live status from a debounced `POST /preview` of the
  unsaved draft), "Add model" (picker: starred, used, then each harness; facts
  only, never the name-based tier), custom roles (name + "when", read by agents
  verbatim) and "Fill from my models" (`POST /recommend`, never saves by itself).
- **Safeguards**: the never-delegate list first (models and harnesses set to
  Never; it applies in both modes), then, under an Auto-mode note, the
  roles-only quota threshold, earlier over-pace threshold, what to do when
  nothing fits and subagents at once; reset.
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
