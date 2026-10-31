# Judgment

Judgment provides typed, bounded semantic evidence. Models generate. Judgment
evaluates. Code decides. Judgment does not authorize or execute actions.

## Consumer API

```ts
import { choice } from "@polyth/judgment";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";

// Resolve lazily in an enabled package handler. rc.space is gateway-validated.
const service = host.services.require(JUDGMENT_SERVICE);
const run = await service.createRun({ space: rc.space, projectId });
try {
  const result = await run.judge({
    scope: "agent.task-completion.v1",
    state: { changedFiles: ["composer.css"], testsPassed: [] },
    questions: { outcome: choice("Does the supplied evidence establish completion?", {
      complete: "Direct verification supports the requested behavior.",
      cannot_tell: "Evidence is insufficient.",
    }) },
  });
  if (result.ok) {
    // result.answers.outcome.value is "complete" | "cannot_tell".
    // Application policy interprets the probabilities; no action happens here.
  } else {
    // Choose an explicit conservative fallback for result.reason.
  }
} finally { run.dispose(); }
```

## Uses: features that ask Judgment

A feature registers a *use* from its server enable hook and reads its resolved
state before every evaluation. Settings → Judgment → Uses renders every registered
use from its descriptor; a feature builds no settings UI of its own for a use.

```ts
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
const judgment = host.services.get(JUDGMENT_SERVICE); // absent → behave as today
const off = judgment?.registerUse({ id: "workflow.review-verdict", packageId: "workflow",
  title: "Review verdicts", description: "…", effect: "…", scope: "workflow.review-verdict.v1",
  evidence: "long", defaultEnabled: false,
  params: [{ id: "threshold", label: "Required confidence", kind: "probability", default: 0.7 }] });
// Per evaluation:
const use = await judgment.resolveUse({ space, projectId }, "workflow.review-verdict");
if (!use.enabled) { /* today's behavior */ }
// use.params.threshold: default ← all projects ← this project
```

- `params` kinds: `probability` (0–1, shown as %), `integer` (min/max/unit), `boolean`,
  `choice` (2–16 options), `text` (`maxLength`, optional `multiline`). Values stored for
  a registered use are validated against its descriptor on save; stored values that
  stop fitting fall back to the default. Values of an unregistered (disabled) package
  are kept untouched.
- `evidence: "short"` means the state fits a small local model (TinyDecide reads 127
  tokens); `"long"` needs a hosted model.
- A use's own model is `scopes[descriptor.scope]`; otherwise it follows the page.
- `resolveUse` reports `reason`: `judgment-off`, `use-off` or `unknown-use`.
- Every use is opt-in (`defaultEnabled: false`) unless its owner documents otherwise.

Registered uses (each owner's README has its policy and fallback):

| Use | Owner | What the answer can change |
| --- | --- | --- |
| `workflow.review-verdict` | workflow | Only when a review report has no Verdict line: rework on a confident "changes requested", else ask or accept |
| `judges.completion-check` | judgment-judges | A "Not verified" marker on the turn; never a prompt |
| `judges.needs-you` | judgment-judges | A marker and a raised notification for an idle chat |
| `judges.keep-warm` | judgment-judges | A few hidden keep-alives before an unfinished chat's prompt cache expires, within a cost and count budget |
| `permissions.scope-check` | permissions | Can only leave an Auto-Approve request for a person, never approve |
| `goals.audit` | goals | Done/stuck/progress of a goal audit, with the small-model audit as fallback |
| `memory.reflect-durability` | memory | Sorts and hides proposed memories; a person still approves each |
| `multirun.rubric-score` | multirun (+ fusion) | Scores shown beside answers; Fusion may preselect, never start |

User-defined judges (Settings → Judges, `@polyth/judgment-judges`) run through the
same service with scope `judges.custom.<id>.v1`. A person may give a judge actions
(send a fixed message, merge an isolated chat, approve or deny a waiting request,
change Auto-Approve, switch the model at a usage limit); the judge's code runs them with
that person's own access, as if they pressed the button (see its
[README](../judgment-judges/README.md#actions)).

Standalone consumers use `createJudgmentRuntime({ engines, global, project,
budget, observe })`. `@polyth/judgment/testing` exports `createFakeJudgmentEngine`
with scripted responses, transient errors and asynchronous steps.

`noul(instructions)` preserves positive probability and confidence.
`choice(instructions, criteria)` preserves literal labels and their distribution.
`score(instructions, rubric)` preserves a continuous zero-based score in
`[0, rubric.length - 1]`; rounding requires `nearestScoreLevel`. Probabilities and
confidences are finite in `[0, 1]`; distributions allow a 0.01 sum tolerance for
rounding. `choiceMargin`, `topChoiceProbability`, `noulPolarity` and `isAbove` contain
no business acceptance thresholds.

## Ownership and lifecycle

The root export is provider-neutral: no SDK, Node imports, environment, network,
secret, session or Git access. `./server` defines the server service seam;
`./settings` supplies browser-safe DTOs. The separate discovered server entry owns
scoped settings/lifecycle, and the web entry owns Settings → Judgment.

`createRun` validates the project through `host.forSpace(space).projects`, without
resolving a session model/runtime. Each run must be disposed. Engine contributions
supply an adapter factory, canonical provider/model descriptors, and optional
settings/catalog hooks. Disabling Judgment or changing applicable settings cancels
existing runs. Removing an engine aborts its requests and prevents further use.
Consumers persist model-visible facts through their existing canonical event path.

## Configuration and settings

Engine, provider and model resolve independently: call target → project scope →
global scope → project config → global config → selected engine defaults. The
default engine is the first recommended engine sorted by ID, otherwise the first
registered ID. `Automatic` means this deterministic inheritance. A model belongs to
the provider it was chosen with: when a later layer changes the provider, the model
falls back to that provider's entry in `capabilities().defaultModels`, or stays
unresolved — it is never sent to a provider it was not chosen for. Likewise a
provider/model belongs to the engine in effect for the layer that chose it: after a
later layer switches engine, the new engine's `capabilities().defaults` apply
(`engineDefaults` in `resolveTarget`). Explicit unavailable targets fail; there is no
harness fallback or silent remapping.

Settings → Judgment is one page in four parts, built from shared primitives (order: Status, Uses, Route, Model, Privacy):

1. **Status** answers "is it working, through what, can I prove it": a toned badge
   (Off / Needs setup / Model unavailable / Ready), the effective provider, model and
   endpoint host, the enable switch and **Check**. Check makes one real call through
   the effective target and reports latency and the answering model, or a plain
   reason (ended promotion, rejected key, timeout…). The engine is shown here,
   informationally, with Recommended metadata.
2. **Uses** lists every feature registered through `snapshot.uses`, generically from
   its descriptor: title, description, what Polyth does with the answer, an evidence
   pill only when it matters (Fits local model; Needs a hosted model when the route
   the use would take runs on this server) and a switch (stored
   `uses[id].enabled`, else `defaultEnabled`). At “This project” a use says whether it
   is inherited or set for the project and can drop its override. When a use is on,
   **Options** discloses one control per declared parameter (probability → % stepper,
   integer → number field, boolean → switch, choice → segmented control up to three
   options else a select, text → input/textarea with `maxLength`) with per-value
   reset, plus an optional **Model** override stored in `scopes[descriptor.scope]`
   (Automatic inherits the route and model below). Edits save the full level config
   with the current revision; text and slider edits are debounced (600 ms) and flushed
   on blur, saves queue behind each other, and the server's validation message is
   shown inline. While Judgment is off the list is dimmed and read-only. With no
   registered uses it says so. Settings search targets the section (`judgment.uses`);
   per-use items are not registered because the search registry is static.
3. **Route** is a radio list: Automatic plus every provider the engine reports, each
   with who answers/bills, a status badge and, for credentialed providers, an inline
   Credential Vault picker (opened automatically when the effective route needs one).
   Unavailable/unsupported providers are shown but cannot be chosen. A keyless
   provider says what it sends where.
4. **Model** uses the shared model picker only when there is a real choice;
   Refresh models (account metadata, not inference) appears for providers that
   support discovery.

With more than one engine registered, the Engine row (bottom of the page) becomes a
picker; choosing an engine clears that level's route and model. A provider marked
`local` runs on the Polyth server: it shows a Local badge and no send-to-endpoint note.

### Agent model engine

The package itself registers engine `agent` (`src/agentEngine.ts`) when the host
offers harness completions (`host.runtimes.forProject` and `host.smallModelComplete`).
It asks a model of the person's own connected harnesses with one completion, so it
needs **no API key and no Credential Vault entry**; that harness's account answers and
bills. Providers are `small-model` (model `default`: the Small Model of the person
the run is created for, Settings → Sessions → Small Model, read when the call runs)
and one provider per harness of the live runtime catalog, whose model ids are
`provider/model`. A provider marked `harness` shows a "Your account" badge.

- Calls are **direct only** (`requireDirect: true`): a runtime without a tool-less
  completion fails `provider-unavailable` instead of running the evidence as an agent
  turn with tools. Evidence is untrusted text; the prompt marks it as data and escapes
  `<` so it cannot close its block.
- The model answers JSON probabilities; replies are normalized (percentages,
  distributions that do not sum to 1, a fenced or wrapped object). An unreadable reply
  is asked once more when at least 8 s remain, then fails `invalid-response`.
- `capabilities().timeoutMs` (60 s) replaces the 10 s default call timeout unless a
  `timeoutMs` limit is configured. Any engine may declare one.
- It is not recommended, so it never becomes the Space default by itself. Features
  opt in with `target: { engineId: "agent" }`; [Judges](../judgment-judges/README.md)
  always do.

The page never accepts plaintext; a missing key is added in Credential Vault. See
the [Jev adapter](../judgment-jev/README.md) for hosted providers and the
[local engine](../judgment-local/README.md) for on-server models.

“Global” means Space-wide. `spaceStorage(space).packageDir("judgment")/settings.json`
stores version 1, revision, global config and project overrides. Atomic replacement
requires the current revision. Missing storage defaults to `{ enabled: true }`;
corrupt settings fail rather than silently reset. Backend config lives separately.

All routes are local-only and require an owned `projectId` query parameter:

| Route | Purpose |
| --- | --- |
| `GET /api/judgment/settings` | Config, engine metadata, canonical model options and handle manifest |
| `PUT /api/judgment/settings` | `{ revision, level: "global" | "project", config }` replacement |
| `PUT /api/judgment/credential` | `{ providerId?, secretHandle }`, or omit `secretHandle` to disconnect that provider for this project; no `providerId` means the engine's primary provider |
| `POST /api/judgment/models/refresh` | Explicit adapter catalog refresh, optionally `{ providerId }` |
| `POST /api/judgment/check` | One real call through the effective target; returns `JudgmentCheckResult` (ok, reason, answering provider/model, duration), never evidence |

The snapshot's `providers` may carry `description`, `credential` (`"none"` for a
keyless provider), `endpoint` host, `automatic` and `discovery`; `engineSettings.credentials`
maps provider ID → handle. Engines that predate these fields keep working with the
single `secretHandle`.

There is no browser judgment endpoint or raw-evidence route. Features consume the
server API through registered uses (above). No registered use approves or executes
because of an answer. The only prompts sent are fixed ones whose policy lives in code
(goal continuations, `judges.keep-warm` keep-alives, and messages a person wrote or
picked for a judge), never text from the model. A judge's actions are the person's
choice, run with that person's access; Judgment still only answered.

## Limits, budgets and cancellation

Defaults: 8 questions, 64,000 UTF-8 state bytes, 8,000 bytes per question, 96,000
request bytes, 64 attempts per run, 4 concurrent calls, 10,000 ms call deadline,
and at most one retry. State must be lossless finite JSON: cycles, getters, custom
prototypes, sparse arrays and excessive depth are rejected. Evidence is detached
before asynchronous work and again before adapter delivery. Scope IDs should use
semantic versions, e.g. `agent.task-completion.v1`.

One runtime is one bounded run. Calls/input bytes reserve **per physical attempt**
before queuing. Failed admission/cancelled queued work refunds reservations;
executed attempts consume calls/bytes. Wall time reserves the remaining deadline
and refunds unused time on settlement. Default run wall budget is
`maxCallsPerRun * timeoutMs`. Per-call `budget` can reduce limits.
`createJudgmentBudget({ maxCalls, maxInputBytes, maxWallClockMs })` can be shared
across runs and workflow children; every participating child must receive the same pool.

Server concurrency is shared across runs per Space and project. Space limits cap
all projects; project limits restrict their runs further. Updated limits retain
outstanding occupancy. Explicit abort returns `cancelled`; a deadline, including
queueing/backoff, returns `timeout`. An adapter ignoring abort retains its slot and
wall reservation until its actual promise settles: timeout is not release proof.

Only canonical transient failures retry. Invalid responses, auth/compatibility
errors, cancellation and exhausted budgets do not. Adapters disable SDK retries
so core accounts for every attempt.

## Observations and privacy

Optional `observe` receives `JudgmentObservation`: engine/provider/model, scope,
SHA-256 question-set ID, sizes, timings, attempts, status, optional correlation IDs
and reported usage. Observer failure cannot change the result. Fingerprints include
question semantics and ordered rubrics, never evidence. The optional synchronous
`redactState` hook is bounded/validated again before delivery.

No raw state, questions, native responses or credentials are logged/persisted.
Observations are a future Polyth Usage integration seam, not a new analytics store
or agent turn. Failed attempts may incur unreported upstream costs; usage preserves
only reported values. Judgment itself keeps no history or cache; consumers that show
an answer persist their own bounded result (never evidence) through their canonical
event path.

## Architectural invariants

- Judgment is evidence, not authority; it never executes application actions.
- Harnesses consume Judgment. A harness session or turn is never a Judgment engine;
  the [Agent model engine](#agent-model-engine) uses only a harness's tool-less
  direct completion, and only for callers that target it.
- Session and Judgment models are independent.
- Provider-specific details stop at the adapter boundary.
- Uncertainty is preserved; failure never means false, safe, approved or complete.
- Confidence policy belongs to each use case.
- Evidence is bounded before semantic evaluation.
- Question semantics are versioned behavior.
- Engine, upstream provider and model are separate identities.
- Current implementation choices must not become permanent consumer coupling.

See the [architecture decision](../../docs/architecture/adr-judgment.md).

## Verification

```sh
node --experimental-strip-types --test packages/judgment/test/*.test.ts packages/judgment-jev/test/*.test.ts packages/judgment-local/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/judgment
node node_modules/typescript/bin/tsc --noEmit -p packages/judgment-jev
node node_modules/typescript/bin/tsc --noEmit -p packages/judgment-local
```

The deterministic release-quality gate includes these tests/typechecks. Tests use
a fake engine or the pinned SDK with offline transport. They cover inference,
validation, configuration, budgets, retries, cancellation, physical concurrency,
privacy, Space isolation, lifecycle, settings interactions and an isolated completion
smoke consumer. Live provider quality/access requires separately authorized evidence.
