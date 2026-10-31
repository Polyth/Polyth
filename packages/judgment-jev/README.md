# Jev adapter for Judgment

Consumers use [`@polyth/judgment`](../judgment/README.md). This package owns the
currently recommended dedicated backend. Engine ID `jev` and upstream provider ID
`typesafe` are separate. No SDK type is exported.

The pinned [`@typesafe-ai/sdk` 0.6.0](https://www.npmjs.com/package/@typesafe-ai/sdk/v/0.6.0)
has [official source](https://github.com/typesafe-ai/typesafe-sdk-js) and
[documentation](https://docs.typesafe.ai/sdk/javascript). It sends model, state and
questions to `<baseURL>/v1/systemone`; it has no general upstream-vendor selector.

## Routes

`src/routes.ts` is the single table of ways to reach Jev. Each route is one Judgment
provider (provider ID = route ID) with a pinned origin and path root, its own
credential, its floating aliases and whether Automatic may use it:

| Route | Endpoint root | Credential | Automatic | Discovery |
| --- | --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai` | Vault handle | 1st | `/v1/models` |
| `openrouter` | `https://openrouter.ai/api` | Vault handle | 2nd | no |
| `vercel-ai-gateway` | `https://ai-gateway.vercel.sh/typesafe` | Vault handle | 3rd | no |
| `opencode-zen` | `https://opencode.ai/zen` | Vault handle | 4th | no |
| `opencode-zen-free` | `https://opencode.ai/zen` | none | never | no |

Only the TypeSafe route is backed by the SDK's documented origin. The gateway rows
are offline-tested against mock transport; their live access is **unverified** until
separately authorized evidence exists — Settings → Judgment → Check is the way to
prove one answers. Automatic resolves to the first route in table order whose
credential is connected and still resolves in this Space/project; with none, it
reports TypeSafe as needing setup. The keyless promotional route is used only when
picked explicitly and sends no `Authorization` header at all. A 402 (exhausted
balance, ended promotion) fails `provider-unavailable` without retry.

Per route, Automatic prefers the route's default model (`jev-latest` for TypeSafe);
after TypeSafe account discovery, if that alias is absent, it uses the first
available model in ID order. An empty account catalog has no automatic model.
Choosing another route drops a model pinned for the previous one and uses the new
route's default (`capabilities().defaultModels`). Unknown routes fail
`provider-unavailable`; unadvertised models fail `model-unavailable`. There is no
generic LLM fallback.

Account model discovery uses `/v1/models`, mapped directly to canonical Polyth
`ModelDescriptor` fields. Refreshed descriptors persist with project adapter config
so explicit model selections survive restart. Credential changes clear the catalog;
late refreshes cannot overwrite newer selections. No harness catalog or duplicate
general vendor/model list is maintained. Catalog availability does not prove future
service access or response quality.

## Credentials and configuration

Settings → Judgment chooses an existing Credential Vault handle per route. Scoped
adapter storage is `judgment-jev/<encoded-project-id>.json`: version 2, a
`credentials` map of route ID → handle, and non-secret TypeSafe model descriptors
only. A version 1 file (one TypeSafe `secretHandle`) is read as the TypeSafe entry
and rewritten as version 2 on the next credential change. A handle can only be saved
for a route that requires one. Changing the TypeSafe credential clears its discovered
catalog; other routes keep it. Project ownership is rechecked at use time. The existing
Vault `useCredential` callback constructs the SDK client entirely server-side. A
missing resolver or inaccessible handle fails. Creating/rotating credentials remains
a protected user/UI action; the agent never reads or supplies a real secret.

The adapter reserves a `baseUrl` option for the TypeSafe route but accepts only its
pinned origin. Every request URL must start with its own route's `<root>/v1/`, so a
credential can never reach another route's host. Production fetch rejects redirects. Explicit key,
endpoint, default model and log-level options prevent ambient SDK configuration
from selecting them. SDK logging is off and retries are zero: Judgment owns budgets,
deadline and retries. The adapter does not directly read environment variables.

## Normalization

- Noul preserves positive probability. SDK 0.6.0 reports no separate confidence;
  canonical confidence is explicitly derived as `max(p, 1-p)`, not a separate
  provider estimate or acceptance threshold.
- Choice preserves label, confidence and all probabilities.
- Score preserves the continuous score and confidence; numeric probability keys
  become an ordered array without rounding.
- Token usage is mapped; actual cost is omitted because the SDK does not report it.
  Runtime timing covers the complete call.
- Concrete model identity is preserved when a route's floating aliases (TypeSafe
  `jev-latest`/`jev-preview`, each gateway's default) resolve. Explicitly pinned
  models cannot silently become another release. The answering route is reported
  as the provider.
- Native errors/bodies are sanitized. 429, 502, 503, 504 and connection failures
  may retry; auth, validation, 404, cancellation and invalid responses do not.

Standalone server embeddings supply `createJevJudgmentEngine` with a trusted
`withCredential` callback and optional canonical descriptors. An injected `fetch`
supports offline tests; it is not an agent/browser-selected endpoint. The discovered
package registers/unregisters with Judgment and aborts on disable.

Tests run the actual pinned SDK against mock HTTP transport. The completion smoke
evaluates evidence without actions. Default CI needs no credentials, network or
paid provider turns; live service access remains separately verified.
