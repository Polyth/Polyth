# OpenCode 1.18.18 API surface — live `/doc`

Source: `GET /doc` from
`/home/ubuntu/.local/bin/opencode serve --pure --hostname 127.0.0.1 --port 45126`.
The 478,747-byte document identifies itself as OpenAPI `3.1.0`, API version `1.0.0`,
while `/global/health` reports runtime version `1.18.18`.

## V2 paths actually advertised

| Area | Methods and paths |
| --- | --- |
| Health/location | `GET /api/health`; `GET /api/location` |
| Catalog | `GET /api/agent`; `GET /api/model`; `GET /api/provider`; `GET /api/provider/{providerID}` |
| Sessions | `GET,POST /api/session`; `GET /api/session/active`; `GET /api/session/{sessionID}` |
| Session selection | `POST /api/session/{sessionID}/agent`; `POST /api/session/{sessionID}/model` |
| Prompt/lifecycle | `POST /api/session/{sessionID}/prompt`; `POST /api/session/{sessionID}/compact`; `POST /api/session/{sessionID}/wait`; `POST /api/session/{sessionID}/interrupt` |
| Hydration | `GET /api/session/{sessionID}/context`; `GET /api/session/{sessionID}/history`; `GET /api/session/{sessionID}/message`; `GET /api/session/{sessionID}/message/{messageID}` |
| Events | `GET /api/event`; `GET /api/session/{sessionID}/event` |
| Revert | `POST /api/session/{sessionID}/revert/stage`; `POST /api/session/{sessionID}/revert/clear`; `POST /api/session/{sessionID}/revert/commit` |
| Permissions | `GET /api/permission/request`; `GET /api/permission/saved`; `DELETE /api/permission/saved/{id}`; `GET,POST /api/session/{sessionID}/permission`; `GET /api/session/{sessionID}/permission/{requestID}`; `POST /api/session/{sessionID}/permission/{requestID}/reply` |
| Questions | `GET /api/question/request`; `GET /api/session/{sessionID}/question`; `POST /api/session/{sessionID}/question/{requestID}/reply`; `POST /api/session/{sessionID}/question/{requestID}/reject` |
| Integrations/auth | `GET /api/integration`; `GET /api/integration/{integrationID}`; `POST /api/integration/{integrationID}/connect/key`; `POST /api/integration/{integrationID}/connect/oauth`; `GET,DELETE /api/integration/attempt/{attemptID}`; `POST /api/integration/attempt/{attemptID}/complete`; `PATCH,DELETE /api/credential/{credentialID}` |
| Files/commands | `GET /api/fs/read/*`; `GET /api/fs/list`; `GET /api/fs/find`; `GET /api/command`; `GET /api/skill`; `GET /api/reference` |
| PTY | `GET,POST /api/pty`; `GET,PUT,DELETE /api/pty/{ptyID}`; `POST /api/pty/{ptyID}/connect-token`; `GET /api/pty/{ptyID}/connect` |

The exact machine-readable method/path list is `doc-paths.tsv`; operation request/response
schemas are in `doc-v2-operations.json`.

Not advertised under `/api/*`:

- session delete;
- session fork/branch;
- a V2 config endpoint;
- service discover/ensure/stop;
- protocol/version negotiation separate from `/doc`.

Calling unadvertised `DELETE /api/session/{id}` or
`POST /api/session/{id}/fork` returned HTTP 200 `text/html` containing the OpenCode SPA.
Unknown V2 paths therefore cannot be classified by status alone.

## Live shapes

### Startup and health

```json
GET /global/health
{"healthy":true,"version":"1.18.18"}
```

```json
GET /api/health
{"healthy":true}
```

With `OPENCODE_SERVER_PASSWORD` set, both health paths require Basic auth. Unauthenticated
`/api/health` returned:

```json
{"_tag":"UnauthorizedError","message":"Authentication required"}
```

### Catalog

- `GET /api/model?location[directory]=...` returned
  `{location, data: ModelV2Info[]}` with 7,402 rows.
- `GET /api/provider?location[directory]=...` returned
  `{location, data: ProviderV2Info[]}` with 204 rows.
- `GET /api/agent?location[directory]=...` returned
  `{location, data: AgentV2Info[]}` with 7 rows.
- Model entries use `id`, `providerID`, `capabilities.input/output`, `variants[]`,
  `status`, `enabled`, `limit`, and cost arrays. This is not legacy `/provider`'s
  `{all, connected}` shape.

Catalog raw payloads are `04-api-model.redacted.body` and
`05-api-provider.redacted.body`. Potential credential-shaped fields are redacted.

### Session create, list and hydrate

Create accepts an optional client ID and `location`:

```json
{
  "id": "ses_phase1v2_001",
  "model": {"providerID":"orcarouter","id":"orcarouter/free"},
  "location": {"directory":"/tmp/polyth-oc-phase1-v2/project"}
}
```

Response is `{data: SessionV2Info}`. Repeating the same create returned 200 with the same ID
and original creation timestamp, indicating idempotent behavior for this one live case.
This is stronger than Polyth's currently disabled V2 contract, but it is not yet a pinned
cross-version guarantee.

- list: `{data: SessionV2Info[], cursor:{previous,next}}`;
- one session: `{data: SessionV2Info}`;
- projected messages: `{data: SessionMessage[], cursor:{previous,next}}`;
- context: `{data: SessionMessage[]}`;
- durable history: `{data: SessionDurableEvent[], hasMore:boolean}`;
- active status: `{data: Record<sessionID, SessionActive>}`.

The idle active-status response was `{"data":{}}`; it supplies no terminal watermark for a
specific previously-active session.

### Prompt and attachments

V2 prompt body is not legacy `parts[]`:

```json
{
  "id": "msg_phase1v2_001",
  "prompt": {
    "text": "Reply with exactly V2_WIRE_OK and nothing else."
  },
  "delivery": "queue"
}
```

It returned:

```json
{
  "data": {
    "admittedSeq": 1,
    "id": "msg_phase1v2_001",
    "sessionID": "ses_phase1v2_001",
    "prompt": {"text":"Reply with exactly V2_WIRE_OK and nothing else."},
    "delivery": "queue",
    "timeCreated": 1787887067419
  }
}
```

`prompt.files[]` uses `{uri,name,description?,source?}`. The server normalized a local file
URI by adding `mime:"text/plain"` before returning and persisting it.

The isolated headless process durably admitted two prompts but emitted no assistant,
reasoning or tool events. `/api/session/{id}/wait` immediately returned:

```json
{
  "_tag":"ServiceUnavailableError",
  "message":"Session wait is not available yet",
  "service":"session.wait"
}
```

`compact` returned the same error family for `session.compact`. Thus runtime execution,
tools and thinking were not silently substituted from the legacy API.

### SSE and reconnect

Global stream: `GET /api/event`.  
Session replay/live stream: `GET /api/session/{sessionID}/event?after=<aggregate-seq>`.

Observed session event order:

1. `session.next.prompt.admitted`, durable seq 1;
2. `session.next.prompted`, durable seq 2;
3. `session.next.agent.switched`, durable seq 3;
4. `session.next.prompt.admitted`, durable seq 4;
5. `session.next.prompted`, durable seq 5.

Reconnect with no `after` replayed sequences 1–5. `after=2` replayed 3–5, proving exclusive
numeric aggregate-sequence semantics. Frames were:

```text
data: {"id":"evt_...","type":"session.next.prompted","durable":{...},"data":{...}}
```

There was no SSE `id:` line. The event ID exists only inside JSON.

Critical declaration/wire mismatch: `/doc` and the generated V2 SDK type event
`after` as `string`, but `after=<evt ID>` returned:

```json
{
  "_tag":"InvalidRequestError",
  "message":"Expected an integer, got NaN\n  at [\"after\"]",
  "kind":"Query"
}
```

History's generated SDK type correctly uses numeric `after`; the live OpenAPI document
incorrectly emits it as `string`. Live history also used exclusive numeric sequence.

### Permissions, questions, abort and config

- empty permission/question lists are `{data:[]}`;
- missing permission reply returns 404 `PermissionNotFoundError` and includes `requestID`;
- missing question reply/reject returns 404 `QuestionNotFoundError`;
- permission reply body is `{reply, message?}`, not legacy `{response}`;
- question reply is session-scoped under `/api/session/{sessionID}/question/...`;
- abort is `POST /api/session/{sessionID}/interrupt`; idle interrupt is a 204 no-op;
- there is no `/api/config`; legacy `GET /config` remained available on the same process.

## Event names versus Polyth

The V2 schema declares durable `session.next.*` families for prompt admission, agent/model
switch, context, steps, text, reasoning, tool input/call/progress/success/failure, retry,
compaction and revert. It also declares `permission.v2.asked/replied`,
`question.v2.asked/replied/rejected`, `session.error`, and compatibility event families
such as `message.updated`.

Polyth `protocolV2.ts` currently consumes none of them: `eventStreamPath()` is undefined,
history throws `capability-unsupported`, and reconcile returns no events with
`completeness: unverifiable`.

Polyth `protocolLegacy.ts` instead uses:

- `/provider`, `/agent`, `/session`, `/session/{id}/message`;
- `/session/status`, `/permission`, `/question`;
- global `/event`;
- `/session/{id}/prompt_async` or `/message`;
- `/session/{id}/abort`, `/fork`, DELETE session, legacy permission/question reply paths.

The two surfaces coexist, but list visibility is not semantic equivalence. Current Polyth
`auto` checks only for `/api/session` plus `/api/session/{id}/prompt` and therefore chooses
the non-operational V2 adapter before considering operational legacy prompt paths.

## Shared-service surface

`opencode serve --help` has `--mdns` and `--mdns-domain`; top-level CLI has
`attach <url>`. There is no `serve --service`.

Installed `@opencode-ai/sdk@1.18.18` exports `./v2/server`, whose declaration is:

```ts
createOpencodeServer(options?): Promise<{ url: string; close(): void }>
```

It does not expose `Service.discover`, `Service.ensure`, descriptor headers, authority ID,
instance ID, continuity, or borrowed stop semantics. mDNS advertisement and a manually
supplied attach URL cannot prove those fields.

Polyth's borrowed descriptor rotation run is therefore explicitly synthetic at the
discovery boundary, although both authenticated endpoints and all HTTP responses were real
OpenCode 1.18.18.
