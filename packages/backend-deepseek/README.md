# DeepSeek harness (`backend-deepseek`)

Runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`, npm `@deepseek-ai/dsh`) as a Polyth harness through its native ACP
stdio profile and the shared [`backend-acp`](../backend-acp) adapter. The
harness id is `deepseek`; extra logins register as `deepseek-<account>`.

## Install and sign in

- Install: `npm install -g @deepseek-ai/dsh` (Settings → Harnesses shows the
  install, update and release check; the release source is the npm `latest`
  tag). Override the executable with `POLYTH_DEEPSEEK_BIN`.
- Sign in: dsh has no login command. Its official route reads
  `DEEPSEEK_API_KEY` from the launch environment, then its own credential
  store (`$DSH_HOME/.credentials.yaml`, written by `dsh web` → Models), then
  `$DSH_HOME/.env`. Polyth's sign-in command runs `bin/sign-in.mjs` in a
  terminal: it reads the key with hidden input, checks it against DeepSeek's
  free `GET /user/balance` (skipped for a custom `DEEPSEEK_BASE_URL`), and
  writes `$DSH_HOME/.env` with mode 0600. It never prints the key. A key in
  the Polyth server's environment is used by the default login only; an extra
  account never inherits it.
- Authentication is reported `unknown` until a turn runs: there is no
  native status report, and Polyth does not read credential files. A turn
  without a usable key stops with `auth-expired` and the sign-in guidance.

## What is wired

| Area | Behaviour |
| --- | --- |
| Launch | `dsh --profile acp --patch assets/acp.patch.yml` in the session's cwd; `DSH_HOME` per account. |
| Delegation | The overlay disables dsh's subagent providers and spawning tools; delegation goes through Polyth `agent.spawn`. Not applied on SSH hosts (the overlay file is local). |
| Models | `session/new` config options; route values like `["deepseek-official","deepseek-v4-pro"]` become `deepseek-v4-pro` (other routes keep a `route/` prefix). `reasoning_effort` is the variant. |
| Admission | dsh sends committed messages only, so the prompt is admitted when dsh's session log records it (or by the first update). |
| Usage | Each `assistant/message` in the session log becomes one exact `usage/recorded` (non-cached input, output, cache read/write) before `turn/stopped`. Context occupancy comes from ACP `usage_update`. |
| Tools | The ACP `title` is the tool name; `todo_write` publishes task snapshots; sandbox escalations become permission requests. |
| Failures | `turn failed: <reason>` is classified (sign-in, rate limit and overload with auto-resume, exhausted balance, unavailable model); other reasons keep dsh's text. |
| MCP | Polyth tools and project MCP servers are passed on `session/new`; stdio commands are resolved to absolute paths, and a server dsh rejects is left out and recorded failed. |
| Import | Native sessions of the same workspace are listed for Snapshot import (user prompts and visible replies only). |

Session logs are read with a Zstandard frame walker; on Node older than
22.15 (no `zlib.zstdDecompressSync`) usage, log-based admission and import are
off and the harness still runs.

## Limits

- No image, audio or PDF prompts (dsh's ACP profile advertises none); no
  compaction, fork, questions or plan mode over ACP.
- `deepseek-v4-flash` is only the ACP profile's default route: dsh lists it
  while it is selected, drops it after another model is chosen and refuses a
  switch back.
- Verified against dsh 0.2.0-rc.2 with a fake Messages endpoint; no paid
  DeepSeek turn has been run.

## Tests

- `node --experimental-strip-types --test packages/backend-deepseek/test/units.test.ts`
- `POLYTH_TEST_DSH_BIN=/path/to/dsh node --experimental-strip-types --test packages/backend-deepseek/test/dsh.integration.test.ts`
  — a real `dsh` against an in-process fake of the DeepSeek Messages API
  (catalog, turns, usage, todos, model and effort selection, sandbox
  escalation, provider refusal, cancellation, resume, import). Skipped without
  the variable.
