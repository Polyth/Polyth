# Mistral Vibe harness (`backend-vibe`)

Runs [Mistral Vibe](https://github.com/mistralai/mistral-vibe) (PyPI
`mistral-vibe`, commands `vibe` and `vibe-acp`) as a Polyth harness through its
ACP stdio agent and the shared [`backend-acp`](../backend-acp) adapter. The
harness id is `vibe`; extra logins register as `vibe-<account>`.

Everything below was verified against Vibe 3.1.5 on Linux aarch64 with the real
executable and a local fake OpenAI-compatible provider, so no Mistral key and
no paid turn was involved. macOS and Windows have not been run.

## Install and sign in

- Install: Settings → Harnesses runs Mistral's script on macOS and Linux
  (`curl -fsSL https://mistral.ai/vibe/install.sh | bash`: uv, installed first
  when missing, or Homebrew when Homebrew installed Vibe). On Windows a
  PowerShell line installs uv from Astral's script when it is not on PATH and
  runs `uv tool install --python 3.13 mistral-vibe` (source-inspected only).
  Either way `vibe-acp` lands in `~/.local/bin`, which discovery searches.
  `POLYTH_VIBE_BIN` points Polyth at another `vibe-acp`.
- Update: the same script on macOS/Linux, `uv tool upgrade mistral-vibe` on
  Windows. The current release is read from PyPI. Vibe's own update checks are
  off while Polyth runs it.
- Sign in: `vibe --setup` asks for an API key or signs in through Mistral AI
  Studio in the browser and keeps the key in `$VIBE_HOME/.env`
  (`~/.vibe/.env`). `MISTRAL_API_KEY` in the Polyth server's environment works
  too, for the default login only.
- Status: the Accounts list starts `vibe-acp` and reads its answer to
  `session/new`. `-32000 Missing API key for <provider> provider.` means signed
  out; a created session means a key is configured (Vibe opens a session
  without contacting the provider and writes nothing). Whether the key is
  valid is proven by the first turn.
- Accounts: each extra login runs with its own `VIBE_HOME` and without the
  server's `MISTRAL_API_KEY`, which would otherwise win over the account's key.

## What Polyth changes in Vibe

`vibe-acp` takes no flags, but Vibe reads every `VIBE_*` variable as a
configuration layer above the person's `config.toml`
([`src/launchEnv.ts`](src/launchEnv.ts)). Nothing in `~/.vibe` is edited.

| Setting | Why |
| --- | --- |
| `VIBE_ENABLE_SUBAGENTS=false` | Delegation belongs to Polyth; removes `tools.agents.*` / `tools.subagent.*` from code mode. |
| `VIBE_ENABLE_BACKGROUND_PROCESSES=false` | A process ending after the turn would wake Vibe into a turn Polyth never admitted. |
| `VIBE_DISABLED_TOOLS` + `cron`, `create_goal`, `update_goal`, `get_goal` | Both schedule turns of their own. A person's own list is kept. |
| `VIBE_DEFAULT_APPROVAL_POLICY=ask` | Every tool Vibe does not itself treat as safe asks Polyth, whose approval policy then decides. |
| `VIBE_INCLUDE_COMMIT_SIGNATURE=false` | No agent credits itself in a commit. |
| `VIBE_ENABLE_UPDATE_CHECKS=false`, `VIBE_ENABLE_AUTO_UPDATE=false` | Polyth offers updates in Settings. |
| `VIBE_SESSION_LOGGING__GENERATE_TITLES=false` | Polyth names the chat; Vibe's title request would be another model call on the person's quota. |

## Protocol notes (3.1.5)

- Models are the `model` config option, valued by Vibe's model aliases. The
  thinking select has category `thinking`; the shared adapter reads it as the
  thought level, so its values are the model's variants.
- One model has several ids. Until the account's Mistral catalog has loaded,
  the select offers the built-in defaults by alias (`mistral-medium-3.5`,
  `mistral-large-4-0`); afterwards it offers catalog ids
  (`mistral-medium-latest`, …), and Vibe resolves every alias itself.
  `src/models.ts` reads the catalog's aliases from
  `$VIBE_HOME/model_catalog_cache.json` (Vibe's own rules: an alias that is a
  model id or that two models claim names nothing) and publishes them as
  `ModelDescriptor.aliases`, so a chat saved under either name keeps working
  and a row the select offers under an alias gets its catalog id. No catalog
  file means no aliases, never a guess.
- Text and reasoning stream as deltas with a `messageId`. Vibe echoes each
  prompt as `user_message_chunk` before its first model request; that echo
  proves admission. While Vibe retries a 429 or 5xx (about five minutes) it
  sends only `_session/retrying`, which keeps the turn alive.
- Tool calls carry the real tool name in `_meta.tool_name` and a real `kind`
  for built-ins (`execute`, `edit`, `read`, `search`, `fetch`). MCP tools are
  reached only through Vibe's `run_typescript` code mode, as
  `tools.mcp_<server>.<tool>` after `search_tool_functions`; each call is still
  announced and approved on its own and is reported as `mcp__<server>__<tool>`
  (Polyth's own server name restored). Polyth's agent tools are sent as the
  stdio bridge. Vibe also accepts streamable-HTTP servers but advertises no
  `mcpCapabilities.http`, so the shared adapter leaves HTTP servers out; SSE
  servers are refused by Vibe itself.
- Titles: Vibe's `session_info_update` title is first the raw first prompt,
  Polyth's context blocks included. The profile sets `nativeTitles: false`, so
  the adapter ignores Vibe's titles, reports `title: "unsupported"` and Polyth
  names the chat.
- `session/request_permission` names only the tool call; options are
  `allow_once`, `allow_always`, `allow_always_permanent`, `reject_once`.
- Usage exists only as running totals of the native session (the prompt
  answer's `usage` and `usage_update._meta`), carried over after a reload.
  Each turn records one aggregate `usage/recorded`: the answer's totals minus
  the totals seen at the prompt echo ([`src/usage.ts`](src/usage.ts)). Vibe's
  USD `cost` is not recorded. `usage_update.used/size` is the context
  occupancy.
- Provider errors are JSON-RPC errors, classified in
  [`src/failures.ts`](src/failures.ts): `-32000` no key, `-31002` key refused
  (after one refusal every later prompt of that process is refused the same
  way), `-31001` rate limit after Vibe's retries, `-31004`/`-31006` context,
  `-32603` with the HTTP client's text otherwise.
- A session can be open in one process only (an OS lock in
  `$VIBE_HOME/logs/session/active/`): importing a session that a live Polyth
  chat or Vibe's terminal UI holds fails with a clear message.

## Sessions and import

Native sessions live in `$VIBE_HOME/logs/session/unified/<id>/`. The import
picker lists top-level sessions of the project folder from each `meta.json`;
the dialogue is read through ACP `session/load`, which replays the history,
rather than from Vibe's internal snapshot store. Skills come from `.vibe/skills`
and `.agents/skills` in the project and from `$VIBE_HOME/skills` and
`~/.agents/skills`.

## Not supported

- SSH hosts: an SSH launch carries arguments, not the `VIBE_*` settings above,
  so Vibe would run with its own subagents and approval policy there.
- Vibe's own slash commands are offered as native commands; `/compact` runs
  Vibe's compaction, not Polyth's.
- Utility completions (commit messages, titles) use the session-backed path;
  Vibe's headless mode would add a native session per call.

## Tests

- `test/units.test.ts` runs everywhere.
- `test/vibe.integration.test.ts` runs the real `vibe-acp` against a local
  fake chat-completions server (catalog, model and thinking choice, todos,
  approval of a file write, cancel, a refused key, reload in a fresh process
  with usage not repeated, import). Opt in with
  `POLYTH_TEST_VIBE_BIN=/path/to/vibe-acp` (for example after
  `UV_TOOL_DIR=<dir> UV_TOOL_BIN_DIR=<dir>/bin uv tool install mistral-vibe`).
