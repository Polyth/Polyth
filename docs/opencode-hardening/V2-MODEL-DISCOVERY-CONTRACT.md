# OpenCode V2 model discovery contract

Source of truth: a live, real OpenCode `1.18.18` server on 2026-08-28, its OpenAPI
`3.1.0` document from `GET /doc`, and successful/error responses captured from that
server. This contract does not infer V2 behavior from `protocolLegacy.ts`.

## HTTP and authentication

The validated server was started with:

```sh
/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 14721
```

It logged that `OPENCODE_SERVER_PASSWORD` was unset and accepted loopback requests
without authentication. Every inspected V2 OpenAPI operation declares `security: []`.
Reads need no special request headers. JSON mutations use
`Content-Type: application/json`; the event endpoint returns `text/event-stream`.
Polyth's endpoint transport still carries explicitly resolved endpoint headers (including
HTTP Basic when configured) to REST and SSE together; it never reads ambient credentials
inside this adapter.

## Endpoints used by the core adapter

| Purpose | Method and path | Parameters/body | Success |
| --- | --- | --- | --- |
| Health/protocol evidence | `GET /api/health`, `GET /doc` | Flat optional `directory` probe query | `200` |
| Models | `GET /api/model` | Deep query `location[directory]`, optional `location[workspace]` | `{location,data: ModelV2Info[]}` |
| Providers | `GET /api/provider` | Same deep location query | `{location,data: ProviderV2Info[]}` |
| Agents | `GET /api/agent` | Same deep location query | `{location,data: AgentV2Info[]}` |
| Sessions | `GET /api/session` | `directory`, optional `workspace`, `limit`, `order`, `cursor` | `SessionsResponse` |
| One session | `GET /api/session/{sessionID}` | Path ID; Polyth also sends its location query | `{data: SessionV2Info}` |
| History | `GET /api/session/{sessionID}/message` | `limit`, `order`, or opaque `cursor` | `SessionMessagesResponse` |
| Create | `POST /api/session` | `{location:{directory,workspaceID?}}`; schema also permits `id`, `agent`, `model` | `{data: SessionV2Info}` |
| Select model | `POST /api/session/{sessionID}/model` | `{model:{id,providerID,variant?}}` | `204` |
| Select agent | `POST /api/session/{sessionID}/agent` | `{agent}` | `204` |
| Prompt/steer | `POST /api/session/{sessionID}/prompt` | `{prompt:{text,files?},delivery:"queue"|"steer"}` | `{data: SessionInputAdmitted}` |
| Events | `GET /api/event` | No operation-specific parameters | native V2 SSE |
| Active status | `GET /api/session/active` | Location query | `{data: Record<sessionID,status>}` |
| Interrupt | `POST /api/session/{sessionID}/interrupt` | No body | `204` |
| Pending permissions | `GET /api/permission/request` | Deep location query | `{location,data: PermissionRequest[]}` |
| Permission reply | `POST /api/session/{sessionID}/permission/{requestID}/reply` | `{reply}` | `204` |
| Pending questions | `GET /api/question/request` | Deep location query | `{location,data: QuestionRequest[]}` |
| Question reply/reject | `POST /api/session/{sessionID}/question/{requestID}/reply` or `/reject` | `{answers}` for reply; no body for reject | `204` |

`LocationRef` uses `workspaceID` in JSON bodies, while model/provider/agent deep-object
queries use the property name `workspace`, and session-list filtering uses the flat query
name `workspace`.

No V2 fork/branch or delete-session operation is present in the live document.

## Model and provider response schemas

`ModelV2Info` requires:

- `id`, `providerID`, and `name`;
- `api`, `request`, `variants`, `time`, and `cost`;
- `capabilities: {tools,input[],output[]}`;
- `status: "alpha" | "beta" | "deprecated" | "active"`;
- `enabled`; and
- `limit: {context,input?,output}`.

Variant rows contain `id`, `headers`, and `body`. The model request/provider fields may
contain provider configuration material and are never copied into Polyth DTOs, evidence,
or logs.

`ProviderV2Info` requires `id`, `name`, `api`, and `request`; optional fields are
`integrationID` and `disabled`. The endpoint describes and returned active providers. The
live response had two provider rows (`google`, `opencode`) and no `disabled: true` row.
Therefore:

- a matching provider not marked disabled makes the model `connected: true`;
- a missing provider row or `disabled: true` makes it `connected: false`; and
- a failed/malformed provider request fails discovery explicitly, because the
  protocol-neutral DTO has no field in which to report a partial-provider error.

This avoids manufacturing connectivity when provider discovery is unavailable.

## Normalization

For every model not explicitly marked `enabled: false`, Polyth creates one
`ModelDescriptor`:

| Descriptor field | Native V2 source |
| --- | --- |
| `providerID` | `model.providerID` |
| `modelID` | `model.id` |
| `name` | `model.name` |
| `providerName` | matching `provider.name` |
| `context` | `model.limit.context` |
| `cost` | first `model.cost[]` row's `input` and `output`, when both are numeric |
| `variants` | `id` (or forward-compatible string/name) from `model.variants` |
| `connected` | matching provider exists and is not disabled |

Capabilities use the existing protocol-neutral vocabulary: `tools: true` becomes
`toolcall`; input/output modalities become `input:<modality>` and `output:<modality>`;
a present empty modality array becomes `input:none` or `output:none`. Values are
deduplicated and sorted. V2 does not report the legacy `attachment` boolean, so the
adapter does not invent it.

Alpha, beta, and deprecated are not exclusion signals when OpenCode returns
`enabled: true`. Only `enabled: false` is excluded.

## Pagination

Model, provider, and agent list operations are not cursor-paged. Sessions and messages
return `{data,cursor:{previous?,next?}}`. Cursors are opaque. Polyth requests the first
page with `order`, follows `cursor.next`, rejects repeated cursors, and caps traversal at
100 pages. Subsequent cursor requests omit `order`; the message contract explicitly
forbids combining them because ordering is encoded in the cursor.

## Session model selection

V2 session create can accept a `model` in its body. Polyth instead creates the binding
with the location, retains the user's protocol-neutral selection on the canonical
session, then calls `POST /api/session/{sessionID}/model` immediately before the first
selected-model prompt. This preserves model choice across the existing higher-level
catalog/session contract without adding V2 conditionals outside the adapter.

The live proof created a canonical Polyth session bound to
`ses_fb9582c4dffegGuKA9ZR6H27WQ`; native model selection returned `204`, and the following
session read reported `opencode/x-preview-f-free`.

## Empty, error, and refresh semantics

These states remain distinct:

1. Successful model and provider envelopes with model `data: []` return a genuine `[]`.
2. Non-2xx discovery throws with HTTP status, path, and the bounded upstream message.
3. Timeout/connection failures propagate as backend errors.
4. A successful non-JSON or malformed envelope throws `protocol-response-invalid`.
5. Capabilities absent from the V2 document return typed `capability-unsupported`;
   they never return fake empty/success results.

Every `models()` call queries both native endpoints. There is no adapter-level catalog
cache, so initial use, attach, endpoint generation replacement, reconnect refresh, and
provider configuration refresh all observe the current V2 service. V2 failure never
falls through to legacy.

## Live proof

- `docs/opencode-hardening/BLOCKER-0-REPRO.md` and the bounded captures under
  `artifacts/opencode-real-world/blocker-0-repro/` record the original false-empty
  behavior while real OpenCode had models.
- `artifacts/opencode-real-world/blocker-0-sol/polyth-v2-runtime-validation.json` records
  auto-selected `v2`, upstream `200`, and matching 68/68 upstream/Polyth model counts.
- `artifacts/opencode-real-world/blocker-0-sol/final-validation.md` records the final
  native and Polyth HTTP calls, real session binding/model selection, and test results.
