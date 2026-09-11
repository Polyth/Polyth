# Desktop harness discovery and portability

Verification date: 2026-09-11.

This document describes the desktop bootstrap added after the original multi-harness foundation. The earlier `multi-harness.md` remains the design record for canonical sessions, switching and continuity; this document is authoritative for desktop executable discovery and platform support.

## Product contract

A desktop launch must not depend on the environment inherited from a terminal. For every known harness Polyth:

1. registers the harness in the desktop inventory before probing it;
2. probes installation without creating a canonical session;
3. resolves the native CLI from the inherited `PATH`, documented/common user install locations, then the user's login-shell `PATH` on POSIX;
4. records and launches the exact executable path that was discovered instead of repeating a bare-name lookup later;
5. refreshes native discovery after an explicit refresh/configuration change;
6. keeps unsupported or unauthenticated integrations visible with an honest state instead of silently hiding them.

Windows discovery honours `PATHEXT` and common npm/pnpm/Scoop/Chocolatey/WindowsApps locations. `.cmd` and `.bat` shims are launched through the Windows shell only after Polyth has resolved their exact path. macOS discovery includes common Homebrew and user-local locations. Linux keeps the same search widening in addition to its durable process supervisor.

`POLYTH_<HARNESS>_BIN` overrides stay exact: when a user names a path, Polyth must not silently execute another binary.

## Execution ownership

Discovery portability and crash-safe switching are deliberately separate guarantees.

- **Linux:** Codex, Claude, ACP-family and Pi runtimes use the existing durable Polyth process authority. The bundled supervisor, release receipts, `/proc` identity and optional systemd user scope provide the evidence required by cross-harness switching and crash recovery.
- **macOS / Windows:** local runtimes use a portable owned-process lifecycle. Normal execution and explicit disposal are supported; POSIX process groups or Windows `taskkill /T` clean up the owned tree. This lifecycle is **not durable release evidence across a Polyth crash**.
- Therefore non-Linux execution is supported, but cross-harness switching remains blocked whenever the safe-switch algorithm requires a durable release proof. Polyth must never turn best-effort process termination into a fictional proof.

## Desktop harness matrix

| Harness | Detection | Local execution | Auto routing | Notes |
| --- | --- | --- | --- | --- |
| OpenCode | Bundled binary first, then installed CLI fallback | Linux / macOS / Windows according to the existing OpenCode runtime support | Yes when configured | Existing provider/model configuration remains authoritative. |
| Codex | Shared desktop CLI resolver | Linux / macOS / Windows | Yes after native detail discovery proves readiness | Uses native `codex app-server`; source import remains cwd-scoped. |
| Claude Code | Shared desktop CLI resolver plus native auth status | Linux / macOS / Windows | Yes when authenticated | Agent SDK receives the exact discovered Claude executable. |
| Cursor | Shared desktop CLI resolver | Linux / macOS / Windows | No | ACP v1. Native sign-in status is still not independently verifiable, so explicit selection is required. |
| fx | Shared desktop CLI resolver | Linux / macOS / Windows | No | ACP v1. Authentication remains native/unknown until connection. |
| Grok Build | Shared desktop CLI resolver | Linux / macOS / Windows where the native CLI supports ACP | No | Native `grok agent stdio` ACP profile; authentication is verified by native initialization rather than credential-file inspection. |
| OMP / oh-my-pi | Shared desktop CLI resolver | Linux / macOS / Windows where the native CLI supports ACP | No | Native `omp acp` profile. |
| Pi | Shared desktop CLI resolver | Linux / macOS / Windows | No | Native `pi --mode rpc` JSONL adapter. `sessionFile` is the durable native conversation identity; prompt admission uses correlated responses and terminal completion uses `agent_settled`. |

Generic ACP infrastructure does not scan arbitrary executables and guess protocols. A harness becomes runnable only through a package/profile that declares and verifies its native invocation contract. Pi is intentionally separate from ACP because its native RPC protocol has different framing, session and settlement semantics.

## Pi native RPC boundary

Polyth uses Pi's documented strict JSONL RPC rather than parsing terminal output or pretending it is ACP:

- LF-delimited JSON records are parsed with bounded buffering; malformed or oversized records close the authority instead of being guessed through.
- The correlated `prompt` response is native admission evidence. A lost response stays outcome-unknown and is never replayed speculatively.
- `sessionFile` from `get_state` is the native backend-session identity. `switch_session` must resolve to that exact path before a persisted leg is considered reattached.
- `message_update` text deltas stream into canonical assistant chunks; `message_end` is authoritative for the completed assistant message.
- Native tool start/end events map to canonical tool events.
- `agent_end` is not treated as terminal because Pi may still retry, compact or process queued continuations. Only `agent_settled` closes the canonical turn.
- `abort` is stronger than generic ACP cancellation: Pi responds only after the session is idle, so Polyth can confirm the abort operation rather than returning an invented acknowledgement.
- Native model and thinking-level selection use `set_model` and `set_thinking_level`; available models/levels come from Pi itself.
- The current adapter supports native images. Other attachment modalities remain explicitly unsupported rather than being silently coerced.

The upstream project is `earendil-works/pi`; the current CLI package is `@earendil-works/pi-coding-agent`.

## Catalog bootstrap

The existing Models package remains responsible for warming enabled harness catalogs during shell bootstrap, unless low-resource mode explicitly disables eager discovery. Roster metadata is process-free; detailed catalog discovery may open a temporary native metadata connection but does not create or bind a canonical execution leg.

Cursor, fx, Grok Build, OMP and Pi remain excluded from automatic routing while their native authentication/readiness state cannot be positively established by the cheap installation probe. Detailed Pi discovery uses its native configured-model catalog; explicit selection is available when that catalog is ready.

## Failure semantics

- Missing CLI: `not-installed`.
- Installed but native sign-in/configuration required: `auth-required` when the native detail path can prove it.
- Installed but a verified protocol contract is unavailable: `incompatible`; no current first-party desktop harness intentionally ships in this state.
- Probe/detail failure after a previously healthy snapshot: existing degraded/stale snapshot semantics apply.
- Unsupported durable release on macOS/Windows: ordinary execution remains available, but a cross-harness switch is rejected with an explicit safety reason.

The desktop must stay usable when any optional harness is missing or broken; one failed provider probe cannot block server startup or hide the remaining harnesses.
