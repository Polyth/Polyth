# Content-bound trust for repository instructions

Repository-controlled executable instructions are untrusted input. Protected consumers are agent files, `.agents/agents/*.md` (format `agent/v1`, source kind `agents-agent`), and legacy loops, `.agents/loops/*.md` (source kind `agents-loop`).

## Agent files (`agent/v1`)

Frontmatter is flat `key: value`; structured settings (`budget`, `approvals`, `wakes`) are one line of JSON, which is also YAML flow syntax. The body is the agent's instructions. Keys: `format`, `id`, `name`, `description`, `icon`, `color`, `schedule` (5-field cron; absent = by hand or on events), `timeZone`, `enabled`, `context` (`fresh`/`rolling`), `rotateAt`, `whenFull`, `keepWarm`, `overlap`, `catchUp`, `agentProfile`, `model` (`provider/model#variant`), `harness`, `fallbackModels` (one line of JSON: up to 8 `{"model": "provider/model#variant", "harness": "<id>"}` backups, highest priority first), `budget`, `pauseAfterFailures`, `approvals`, `wakes`, `heartbeat` (one line of JSON; needs `context: rolling`), `notify` (`alerts`/`updates`/`off`). Unknown or duplicate keys, invalid JSON and webhook wakes (they need a per-install secret URL) are parse errors. There is no permissions key: an agent's approval level (`permissions`) is set by its owner in the app, and syncing a repository file clears it, so repository content can never raise what its agent may do unasked. The semantic digest of an agent file covers every setting, so changing a budget, a wake or the model needs approval exactly like changing the instructions; legacy loop digests are unchanged. An agent made in the app can be written to the repository (`POST /api/schedule/:id/file`, `export`), and a trusted loop can be converted (`convert`, which replaces the loop file); both write only `.agents/agents/<id>.md` inside real (non-symlink) directories, never overwrite a file, keep the agent's history, and trust exactly the bytes they wrote. Symlinked `.agents`, `.agents/agents` and `.agents/loops` directories are not read. A wake's `script` is part of the file's semantic digest: a repository change to a script needs approval like any other instruction, and an approved script still runs only inside the QuickJS sandbox. Ids are unique across both directories; agent files win.

## Reused architecture

- `@polyth/agents` remains the canonical owner of managed loop tasks, cadence, history, and execution state.
- `@polyth/permissions` owns the small generic `ContentTrustReceipt` authorization contract.
- The existing loop scanner remains responsible for discovery, parsing, validation, and SHA-256 content identity.
- No parallel scheduler, permission engine, or repository watcher was added.

## Trust invariant

A receipt binds Space, project, source kind, source identity/path, full content digest, semantic executable digest, approval scope, and approval time. Any mismatch fails closed.

Discovery is not authorization. A new or changed loop is parsed and surfaced, but remains disabled until the exact current version is approved. Once a version has been approved, later repository bytes never overwrite its stored executable prompt/cadence/title/profile before reapproval.

The available decisions are:

- **Trust this version** — promotes exactly the repository version re-read at the approval boundary and persists a `current-version` receipt.
- **Run this version once** — executes an exact temporary snapshot with a `once` receipt; persistent trust and the last approved executable snapshot are unchanged.
- **Keep blocked** — records the decision for the current digest and keeps execution disabled.

## Change detection and TOCTOU safety

Trust is invalidated by effective content identity rather than by Git status. Agent edits, manual edits, pulls, checkouts, merges, rebases, and external filesystem changes therefore have the same effect when the bytes change.

The periodic scanner updates pending metadata for UX, but it is not the final security boundary. The schedule runner re-reads the loop file immediately before dispatch and validates the current path/content/semantic identity against the execution receipt. A change between scan and execution cannot silently run.

## Compatibility

Existing managed-loop records without a content receipt migrate fail-closed: their history is retained, but they are disabled and require one explicit approval of the current repository version. UI-created schedule tasks are unchanged.

The receipt type is consumer-neutral so future executable repository sources (for example project commands or tracks) can reuse the same content identity without sharing schedule state.
