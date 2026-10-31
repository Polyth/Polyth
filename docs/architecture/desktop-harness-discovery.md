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

Windows discovery honours `PATHEXT` and common npm/pnpm/Scoop/Chocolatey/WindowsApps locations, plus the per-user directories the official installers write to and only add to the *User* PATH a running server never sees: Polyth's own npm prefix and Node.js (`%LOCALAPPDATA%\Polyth\npm`, `\Polyth\node`), Cursor (`%LOCALAPPDATA%\cursor-agent`, ahead of `~\.grok\bin`, which also ships an `agent.exe`), Antigravity (`%LOCALAPPDATA%\agy\bin`) and OMP (`%LOCALAPPDATA%\omp`). `.cmd` and `.bat` shims are launched through the Windows shell only after Polyth has resolved their exact path, with that path quoted. Claude Code's npm shim wraps a native `claude.exe`; Polyth runs that program directly (`windowsCmdShimTarget`) so SDK arguments never pass through `cmd.exe`; an older npm release whose shim runs `cli.js` hands the SDK that script, which it starts with `node`, while the short CLI reports (`--version`, `auth status`) keep the shim. A utility (small-model) CLI run through a shim quotes empty and spaced arguments and refuses an argv prompt containing shell syntax. The inherited `Path` is read case-insensitively and the child receives a single `PATH`, so a copied Windows environment keeps the user's directories. macOS discovery includes common Homebrew and user-local locations, and every platform also checks the install directories of the harness CLIs themselves (`~/.opencode/bin`, `~/.claude/local`, `~/.grok/bin`). Linux keeps the same search widening in addition to its durable process supervisor.

`POLYTH_<HARNESS>_BIN` overrides stay exact: when a user names a path, Polyth must not silently execute another binary.

## Execution ownership

Discovery portability and crash-safe switching are deliberately separate guarantees.

- **Linux:** Codex, Claude, ACP-family and Pi runtimes use the existing durable Polyth process authority. The bundled supervisor, release receipts, `/proc` identity and optional systemd user scope provide the evidence required by cross-harness switching and crash recovery.
- **Windows:** each local runtime (`createHarnessProcessAuthority`, `packages/harness-runtime/src/processAuthority.ts`) runs inside its own named Job Object through `polyth-job.exe` (`packages/harness-runtime/native/polyth-job.cs`, built by `build-supervisor.mjs` with the C# compiler that ships with Windows' .NET Framework 4.x, packaged under `resources/runtime-supervisor/win32/`). The job kills every member when its last handle closes, and no member can break away. The helper holds the only handle and ends the job when the command exits or the process that started it dies; if the helper is killed, the kernel ends the job. A job name that no longer exists is therefore kernel proof that the tree is gone. After a Polyth crash the next generation probes, or ends, the previous generation's exact job (`Local\polyth-runtime-<hash>-<generation>`, recorded as `containment` in the authority file), so sessions recover without a reboot, and cross-harness switching uses the same proof (`releaseHarnessProcessExecution`). Programs that launch children with `CREATE_BREAKAWAY_FROM_JOB` get access denied inside the job.
- **macOS, and Windows without the helper:** local runtimes use a portable owned-process lifecycle. Normal execution and explicit disposal are supported; POSIX process groups or Windows `taskkill /T` clean up the owned tree. This lifecycle is **not durable release evidence across a Polyth crash**: a crashed execution stays fenced until a reboot.
- Therefore cross-harness switching remains blocked wherever the safe-switch algorithm has no durable release proof. Polyth must never turn best-effort process termination into a fictional proof.

## Desktop harness matrix

| Harness | Detection | Local execution | Auto routing | Notes |
| --- | --- | --- | --- | --- |
| OpenCode | Bundled binary first, then installed CLI fallback | Linux / macOS / Windows according to the existing OpenCode runtime support | Yes when configured | Existing provider/model configuration remains authoritative. |
| Codex | Shared desktop CLI resolver | Linux / macOS / Windows | Yes after native detail discovery proves readiness | Uses native `codex app-server`; source import remains cwd-scoped. |
| Claude Code | Shared desktop CLI resolver plus native auth status | Linux / macOS / Windows | Yes when authenticated | Agent SDK receives the exact discovered Claude executable. |
| Cursor | Shared desktop CLI resolver | Linux / macOS / Windows | No | ACP v1. Native sign-in status is still not independently verifiable, so explicit selection is required. |
| fx | Shared desktop CLI resolver | Linux / macOS / Windows | No | ACP v1. Authentication remains native/unknown until connection. |
| Grok Build | Shared desktop CLI resolver | Linux / macOS / Windows where the native CLI supports ACP | No | Native `grok agent stdio` ACP profile; authentication is verified by native initialization rather than credential-file inspection. |
| DeepSeek | Shared desktop CLI resolver; `dsh --version` must be a bare semver and `dsh --help` must name DeepSeek Harness, so the Debian distributed shell or another `dsh` is never launched | Linux / macOS / Windows; release proof for harness switching is Linux-only | No | `dsh --profile acp` with Polyth's subagent-free overlay. The API key is verified by the first turn; no credential file is read. |
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

Cursor, DeepSeek, fx, Grok Build, OMP and Pi remain excluded from automatic routing while their native authentication/readiness state cannot be positively established by the cheap installation probe. Detailed Pi discovery uses its native configured-model catalog; explicit selection is available when that catalog is ready.

## Failure semantics

- Missing CLI: `not-installed`.
- Installed but native sign-in/configuration required: `auth-required` when the native detail path can prove it.
- Installed but a verified protocol contract is unavailable: `incompatible`; no current first-party desktop harness intentionally ships in this state.
- Probe/detail failure after a previously healthy snapshot: existing degraded/stale snapshot semantics apply.
- Unsupported durable release (macOS, or Windows without `polyth-job.exe`): ordinary execution remains available, but a cross-harness switch is rejected with an explicit safety reason.

The desktop must stay usable when any optional harness is missing or broken; one failed provider probe cannot block server startup or hide the remaining harnesses.
