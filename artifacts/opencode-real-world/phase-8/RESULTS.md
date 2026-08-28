# Phase 8 — SSH remote and network faults (OC-REAL-078–083)

Validated 2026-08-28 against OpenCode CLI `1.18.18` (binary SHA-256
`bb71f45b564f9234a97f54d6252a4a41d2f4388ae4b078918f691824cc3b3e54`),
Node `v22.22.2`, OpenSSH client/server `9.6p1`, Linux `6.12.94+`, and Polyth
validation SHA `026c0deb4bddecb4fd561e3fbec89a66a53b70cf`. Counts: **0 pass,
2 partial, 4 fail.**

## Environment used

No external remote host was configured or reachable. The closest realistic
environment supported by the repository was used explicitly: an isolated real
`sshd` listening on `127.0.0.1:22282`, user `ubuntu`, dedicated Ed25519 client
and host keys, and the production `@polyth/ssh` OpenSSH ControlMaster,
long-lived process channel, and `-L` TCP-forward implementation. The target is
the same VM, so CPU, kernel, and physical filesystem are shared; all remote
commands, process lifecycle, and HTTP/SSE traffic still cross a real SSH daemon
and real forwarded TCP sockets.

OC-REAL-078–082 each used a fresh remote project, OpenCode config/data
directory, SSH inventory, ControlMaster socket, and forwarded port. OpenCode
was selected through a scenario-local wrapper that exported the isolated
directories. OC-REAL-083 used the production Polyth composition root and SSH
project APIs with a fresh `POLYTH_DATA_DIR`; the isolated `sshd` supplied its
OpenCode config/data environment. Polyth used port `28383`; remote OpenCode
ports were dynamically selected. Port `14500` was never used.

Every forced stop targeted one numeric PID after checking `/proc` identity or
the exact ControlMaster socket. No process-name kill was used. The production
restart database passed `PRAGMA integrity_check` (`ok`) and passive WAL
checkpoint (`busy=0`, `158/158` frames checkpointed).

## Verdicts

| ID | Verdict | Result |
| --- | --- | --- |
| OC-REAL-078 | **FAIL (POLYTH)** | PATH extension, version probe, missing binary/path errors, real serve/forward, 29 models, 4 agents, create/list join, prompt admission, exact remote PID record, and read-only unchanged config were observed. A deliberately occupied remote port was not classified as `port-in-use`; startup failed without trying the fresh candidate. The attachment reached OpenCode but `big-pickle` rejected `text/plain` media, so attachment consumption was not proved. |
| OC-REAL-079 | **PARTIAL (POLYTH)** | The ControlMaster was dropped before prompt I/O. No user mutation appeared upstream and a new SSH master plus generation-2 endpoint were created on a fresh local port (no dead-port reuse). Recovery was not transparent: the operation threw protocol-negotiation failure instead of a conservative mutation outcome, and the prior session was not reconciled across the generation change. |
| OC-REAL-080 | **FAIL (POLYTH)** | One prompt received a confirmed OpenCode admission before the exact ControlMaster PID was killed. The remote PID still answered `kill -0` after the outage, but no accepted user history was recoverable, the old SSE/forward died, generation 2 replaced the endpoint, and the bound session failed protocol/history recovery. The test dropped after the confirmed response rather than using a response-hold proxy, so the narrower “accept before response bytes” boundary remains a documented evidence gap; the observed post-accept recovery still fails the expected result. |
| OC-REAL-081 | **FAIL (POLYTH)** | A confirmed remote prompt requested a delayed tool and completion, then SSH was interrupted for 15 seconds. The process/forward ownership coupling prevented a usable remote history while disconnected; refresh replaced the whole owned generation and reconciliation failed. No local runtime was substituted and no duplicate prompt was observed, but remote completion was not recovered. |
| OC-REAL-082 | **PARTIAL (POLYTH)** | The identity-recorded remote OpenCode child was killed only after its start identity matched. A stale record pointing to an unrelated live `sleep` PID with mismatched start/executable/command identity did not signal that PID. A fresh child/forward reached generation 2, but the active session could not prove continuity or reconcile. |
| OC-REAL-083 | **FAIL (POLYTH)** | Production Polyth was SIGKILLed by exact verified PID one second after confirmed remote prompt admission and restarted from the same SQLite database. The canonical intent/operation survived exactly once, but the session remained `working`; first-wire materialization and the next send failed `binding-mismatch` because the SSH-owned lease minted a new authority/generation. A separately killed exact ControlMaster disconnected SSE and left the projection stale. The remote PID record was not captured before the Polyth kill in this run, so duplicate-child identity across the restart is not claimed. |

## Reliability result

The required disconnected-completion behavior did **not** pass. No tested
remote turn completed while SSH was unavailable and then reconciled into
Polyth. The SSH transport ties the remote `opencode serve` shell, child
lifetime, and local forward to one ControlMaster. Connection loss makes the
process handle exit; the remote launcher traps `HUP` and signals the child, and
endpoint refresh replaces the entire generation. Even where `kill -0` briefly
reported the remote PID, the old history/forward was unusable and the
generation-only binding could not cross to the replacement.

The production Polyth-restart path has an additional durable-authority gap for
SSH runtimes: unlike the owned-local lease, the SSH-owned lease does not persist
authority/generation state. This phase does not patch either issue because a
correct fix must split forward recovery from remote-child ownership, prove
same-child continuity, and persist remote authority/generation semantics. That
is broader than a localized forwarding correction and was not speculatively
implemented.

## Evidence

Per-ID verdicts and details are under
`artifacts/opencode-real-world/phase-8/OC-REAL-0NN/`; bounded timelines are
under `logs/opencode-real-world/phase-8/OC-REAL-0NN/`. The repeatable
OC-REAL-078–082 runner is `scripts/opencode-real-world/phase8.ts`.
OC-REAL-083 uses the production `boot()` helper
`scripts/opencode-real-world/phase8-server.ts`.
