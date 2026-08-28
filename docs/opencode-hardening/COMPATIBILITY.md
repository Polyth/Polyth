# OpenCode compatibility

Compatibility was validated against OpenCode CLI `1.18.18`. The V2 API remains
beta; generated declarations are not treated as behavioral guarantees.

| Surface | Legacy | V2 | Notes |
| --- | --- | --- | --- |
| Protocol detection | Supported | Supported | Auto detection never falls back after selecting V2. |
| Models/providers | Supported | Supported | V2 distinguishes true-empty, not-ready, malformed, and failed discovery. |
| Agents | Supported | Supported | Hidden V2 agents are omitted. |
| Session create/list/history | Supported | Supported | V2 history uses bounded cursor pagination. |
| Model and agent selection | Supported | Supported | V2 selection occurs before prompt admission. |
| Prompt and event stream | Supported | Supported | Mutations are never generically replayed. |
| Interrupt | Supported | Supported | Ambiguous transport outcomes remain unknown. |
| Permission/question reply | Supported | Supported | Pending snapshots are partial, not absence proof. |
| Fork/delete | Supported | Unsupported | V2 returns `capability-unsupported`; it never sends legacy traffic. |
| Shared service discovery | Unsupported | Library seam only | Normal product composition cannot discover an authoritative shared descriptor. |
| Event replay/cursor resume | Unsupported | Disabled | The live contract is not strong enough to enable replay. |

## V2 wire contract

V2 model/provider/agent reads use deep location queries:
`location[directory]` and optional `location[workspace]`. Session and history
queries use flat `directory`/`workspace` parameters. Session creation uses
`{location:{directory,workspaceID?}}`.

Models require string `id`, `providerID`, and `name`. Disabled models are
excluded. Missing or disabled providers produce `connected: false`; malformed
successful envelopes fail with `protocol-response-invalid`. Connected providers
that temporarily return no models are retried within a bounded readiness
window, then fail with `backend-not-ready`.

Session and message lists follow opaque `cursor.next` values, reject cursor
cycles, and cap traversal. Requests after the first page omit `order`, because
the cursor already carries ordering.

## Legacy terminal events

OpenCode `1.18.18` emits `session.idle` and `session.error` without a comparable
revision. Live terminalization therefore uses a turn-scoped state machine:

- a revision-less idle must follow assistant completion observed for the
  currently admitted turn;
- a duplicate or delayed idle tied to an earlier completion cannot stop a later
  turn;
- a revision-less failure is consumed at most once by the current admitted
  turn;
- reconnect snapshots may not promote unchanged historical completion into a
  newer terminal fact.

Status absence alone is never terminal evidence. A pulled terminal state must
carry comparable assistant-completion evidence newer than the prior checkpoint,
or remain unknown.

## Safety boundaries

- Every observation is fenced by authority, generation, location, backend
  session ID, and reconciliation ordinal.
- A persisted backend session ID without a durable runtime identity fails
  closed; it is never adopted into the currently available runtime.
- Semantic identity excludes transport channel, so SSE and pull can claim the
  same fact.
- Observation claim, canonical events, checkpoint, and cursor update commit in
  one transaction.
- Owned local/SSH disposal targets only an exact process instance. Borrowed
  services expose no stop or writable-config capability.
- Legacy mutations without an exact receipt may remain permanently unknown
  after response loss; similarity is not adoption proof.
