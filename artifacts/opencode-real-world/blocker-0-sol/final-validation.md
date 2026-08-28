# BLOCKER 0 final live validation

- Checked: `2026-08-28T04:42:15Z`
- Git: `8b6bdd3c9c55f6c280c243b2ebda48749f78964a`
- OpenCode: `1.18.18`
- Binary SHA-256: `bb71f45b564f9234a97f54d6252a4a41d2f4388ae4b078918f691824cc3b3e54`
- Real standalone server: `http://127.0.0.1:14721`
- Real Polyth server: `http://127.0.0.1:14500`
- Polyth-owned OpenCode child: `http://127.0.0.1:33435`

No credential values or provider request bodies are recorded here.

## Native V2 discovery

```sh
curl -fsS --get http://127.0.0.1:14721/api/model \
  --data-urlencode 'location[directory]=/workspace' |
  jq '{count:(.data|length),providers:(.data|map(.providerID)|unique)}'
```

```json
{"count":68,"providers":["google","opencode"]}
```

```sh
curl -fsS --get http://127.0.0.1:14721/api/provider \
  --data-urlencode 'location[directory]=/workspace' |
  jq '{count:(.data|length),providers:(.data|map({id,name,disabled}))}'
```

```json
{"count":2,"providers":[{"id":"google","name":"Google","disabled":null},{"id":"opencode","name":"OpenCode Zen","disabled":null}]}
```

The live `/doc` reports OpenAPI `3.1.0`, `security: []` on these routes, and
deep-object `location[directory]` / `location[workspace]` query parameters.

## Polyth product APIs after the fix

```sh
curl -fsS 'http://127.0.0.1:14500/api/models?all=1' |
  jq '{count:length,providers:(map(.providerID)|unique),first:.[0]}'
```

```json
{
  "count": 68,
  "providers": ["google", "opencode"],
  "first": {
    "providerID": "opencode",
    "modelID": "x-preview-f-free",
    "name": "Ox Alpha Free (Unlimited)",
    "providerName": "OpenCode Zen",
    "context": 1000000,
    "cost": {"input": 0, "output": 0},
    "capabilities": ["toolcall", "input:image", "input:text", "input:video", "output:text"],
    "connected": true
  }
}
```

```sh
curl -fsS http://127.0.0.1:14500/api/providers |
  jq '{count:length,providers:map({id,name,connected})}'
curl -fsS http://127.0.0.1:14500/api/agents |
  jq '{count:length,names:map(.name)}'
```

```json
{"count":2,"providers":[{"id":"google","name":"Google","connected":true},{"id":"opencode","name":"OpenCode Zen","connected":true}]}
{"count":4,"names":["build","plan","general","explore"]}
```

## Real session creation and model selection

Polyth `POST /api/sessions` created canonical session
`fbef13c7-92dc-40ac-8de0-f16cb211e141`, bound to real V2 session
`ses_fb9582c4dffegGuKA9ZR6H27WQ`, with catalog selection
`opencode/x-preview-f-free`.

The native model switch that Polyth performs before the first selected-model prompt:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:33435/api/session/ses_fb9582c4dffegGuKA9ZR6H27WQ/model \
  -H 'content-type: application/json' \
  -d '{"model":{"id":"x-preview-f-free","providerID":"opencode"}}'
```

```text
204
```

The subsequent native `GET /api/session/{sessionID}` returned:

```json
{
  "id": "ses_fb9582c4dffegGuKA9ZR6H27WQ",
  "location": {"directory": "/workspace"},
  "model": {
    "id": "x-preview-f-free",
    "providerID": "opencode",
    "variant": "default"
  }
}
```

## Regression checks

```sh
node --test packages/backend-opencode/test/protocolV2.test.ts \
  packages/backend-opencode/test/protocolContract.test.ts \
  packages/backend-opencode/test/adapter.test.ts
```

Result: `30` passed, `0` failed, `1` opt-in live test skipped.

```sh
node --test packages/backend-opencode/test/*.test.ts
```

Result: `98` passed, `0` failed, `1` opt-in live test skipped.

```sh
(cd packages/backend-opencode && npx tsc --noEmit)
```

Result: exit `0`.
