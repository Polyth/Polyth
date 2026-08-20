# Usage, quotas, models, and agent profiles

## Current Polyth baseline

`usage/recorded` events already accumulate tokens and cost into `SessionProjection`, `ContextRail`, `UsagePage`, and turn footers. `@polyth/models` and `modelPrefs.ts` provide favorites, recency, provider grouping, and search; composer picks a model and agent. Preserve these. Missing parity is provider quota windows, pace/prediction, and reusable atomic agent profiles.

## 1. Generic quota provider service

**Sources:** polyth #259; Paseo #1278.

Implement provider-neutral contracts, not a vendor-specific dashboard:

```ts
interface QuotaWindow {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: "tokens"|"requests"|"currency"|"percent";
  resetsAt?: number;
  periodMs?: number;
}

interface QuotaSnapshot {
  providerId: string;
  accountLabel?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  stale: boolean;
  error?: { code: string; message: string };
}

interface QuotaProvider {
  id: string;
  fetch(signal: AbortSignal): Promise<QuotaSnapshot>;
}
```

Add a `packages/usage` service that polls registered providers with jitter, deduplicates in-flight requests, backs off, and keeps last-good snapshots. Provider adapters receive secret references through capabilities; browser clients never receive credentials.

```http
GET  /api/usage/quotas → QuotaSnapshot[]
POST /api/usage/quotas/refresh {"providerId":"..."} → QuotaSnapshot
```

Quota data is account telemetry, not session/model context, so it is not a `SessionEvent`. Persist only bounded last-good snapshots and timestamps in server storage. Never log headers/tokens or raw provider responses.

UI: `QuotaSummary`, `QuotaCard`, `UsageProgressBar`, provider status/error. Classes `.quota-grid`, `.quota-card`, `.quota-progress`, `.quota-stale`.

**Tests:** provider timeout, abort, rate limit, malformed numbers, limit zero, reset past/future, stale fallback, parallel clients, secret redaction, no adapters.

## 2. Pace and exhaustion prediction

**Source:** polyth #372.

For windows with a known period/reset, calculate from normalized fractions:

```ts
interface QuotaPace {
  usageFraction: number;
  timeFraction: number;
  pace: "under"|"on-track"|"over";
  predictedAtReset?: number;
  exhaustsAt?: number;
}
```

Use multiple snapshots for a minimum observation interval; do not extrapolate from one point. Clamp counter resets and negative deltas. UI wording is probabilistic (“At current pace”) and hides prediction when insufficient data.

Pure helpers live in `packages/usage/src/pace.ts`. Test reset boundaries, sparse samples, counter decrease, unknown period, clock skew, zero slope, and projected overflow.

## 3. Session context/cost readout

**Source:** polyth #2991; Paseo #1163.

Equivalent web behavior already ships: cumulative cost is derived from durable usage events and appears in Context/Usage and the turn footer. Preserve these invariants:

- Cost is cumulative, not just the last message.
- Unknown cost renders `—`, never `$0.00`.
- Context percentage uses current model context capacity and does not count unrelated internal round trips.
- Tooltip breaks down input/output/reasoning/cache when present.

Extend `TokenUsage` only with optional fields and keep old replay compatible. No new polling/API. Test duplicate usage replay, model switch/context denominator, unknown rates, cache accounting, and aborted turns.

## 4. Reusable agent profiles

**Sources:** Paseo #3208, #3331.

**Acceptance criteria**

- A named profile atomically bundles provider/model, agent, mode, thinking/variant, feature toggles, notes, icon, and color.
- Profile picker appears beside model/agent controls. Applying one is one state transition; no intermediate invalid provider/model combination reaches a send.
- Invalid provider-scoped choices are repaired visibly against current capabilities, not silently persisted.
- Existing model favorites migrate to minimal profiles once, while favorites continue to read during the migration release.

**Data/API**

```ts
interface AgentProfile {
  id: string; name: string;
  providerID: string; modelID: string;
  agent?: string; mode?: string; thinking?: string;
  features: Record<string, boolean>;
  notes?: string; icon?: string; color?: string;
  revision: number; createdAt: number; updatedAt: number;
}
```

```http
GET    /api/agent-profiles
POST   /api/agent-profiles {...}
PATCH  /api/agent-profiles/:id {"expectedRevision":2,...}
DELETE /api/agent-profiles/:id
POST   /api/agent-profiles/:id/validate
→ {"valid":false,"repairs":[{"field":"thinking","from":"high","to":"default","reason":"..."}]}
```

Persist server-side in `node:sqlite` or a revisioned package-owned store. Add optional `agentProfileId` to project defaults, session create, and `SessionProjection`. At send time, resolve the profile to explicit `model`, `agent`, and options; append the resolved selection in `turn/started`, not only the mutable profile ID, so replay is stable.

`packages/backend-opencode` alone maps mode/thinking/features to backend options. Generic model/profile packages use capability descriptors reported by the adapter.

UI: `AgentProfilePicker`, `AgentProfileSettings`, `AgentProfileForm`; classes `.profile-picker`, `.profile-avatar`, `.profile-form`, `.profile-repair`.

**Tests:** deleted model/provider, profile revision conflict, atomic apply, project default, session override, migration idempotency, unknown feature, adapter absent, replay after profile edit.

## 5. Create profiles from the model chooser

**Source:** Paseo #3533.

Each model row has a trailing Pin/Edit action. Pin opens the profile form seeded with immutable `{providerID,modelID}` plus a suggested name; if one matching profile exists, open Edit instead. The row action must not also choose the model.

```ts
interface AgentProfileSeed { providerID: string; modelID: string; name?: string }
```

After save, select the profile only if the user chose “Save and use.” Keyboard users reach the trailing action, and favorites/matching profiles display distinct indicators.

Test duplicate matching profiles, event propagation, keyboard actions, model removed while dialog open, save failure, and simple-persona composer.

## 6. Usage/profile settings integration

Usage cards, profiles, and model preferences remain separate concepts:

- Usage: observed provider/account limits.
- Model preference: sorting/favorites/recency.
- Agent profile: reusable execution configuration.

Do not write quotas into `polyth.settings` or make profile records local-only. Contribute provider quota adapters and profile fields through typed capabilities. The settings item registry makes each provider/profile searchable.

## Suggested implementation order

1. Profile DTO/store/validation and resolved turn metadata.
2. Profile settings/picker and favorites migration.
3. Generic quota contracts/service and one test adapter.
4. Quota dashboard and stale/error states.
5. Pace/prediction from sampled snapshots.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Use workspace package imports.
- Only `packages/backend-opencode` maps profile fields to OpenCode.
- Log resolved model/profile configuration before model use; quota telemetry stays out of session history.
- Extend `/api` and `/ws`.
- Profile/usage UI uses typed settings/composer/context slots.
- Tests use `node --test` and plain `node:assert`.
