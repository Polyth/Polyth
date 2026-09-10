# ADR: Polyth-owned local runtime containment and recovery

Status: accepted
Date and source revision: 2026-09-10, `8548089b`

Problem and concrete constraint: Polyth already owns canonical sessions and launches local provider runtimes, but a killed per-runtime supervisor can leave its provider child alive without a final release receipt. A later server correctly refuses a speculative replacement, yet that also leaves an owned OpenCode runtime permanently unavailable. Transport failure separately rebuilt connections but did not escalate a failed readiness check into destruction of the owned runtime.

Existing owner/seam and why insufficient: `@polyth/harness-runtime` owns process supervision and durable authority generations; `backend-opencode` owns HTTP/SSE and native session translation; the session service owns epoch transitions and canonical recovery. A PID/start-time pair protects against PID reuse but cannot prove that detached descendants are gone after the supervisor disappears.

Options considered and evidence:

- Delete the ledger or signal the remembered PID: rejected because neither proves descendant release and PID reuse can target an unrelated process.
- Treat disconnect/timeout as death and retry: rejected because the original mutation may have executed.
- Reuse an ambient OpenCode daemon: rejected because its process, configuration, storage and execution identity are outside the Polyth authority.
- Put each generation in a transient user-systemd scope while retaining the native subreaper: selected. The supervisor supplies normal descendant-empty receipts; systemd supplies an independently queryable, exact cgroup boundary if that supervisor is lost.

Decision / invariants:

- Every Polyth-launched local runtime is placed in a generation-specific transient scope when a user systemd manager is available. Scope name and boot identity are persisted before the launch gate opens.
- Normal shutdown still requires the native supervisor's descendant-empty receipt. On lost supervisor/timeout, Polyth may kill only the persisted exact scope and advances only after systemd reports it inactive/not found. A boot-ID change is equivalent release evidence for the previous boot.
- If none of those proofs exists, replacement stays blocked. Legacy uncontained ledgers are not silently upgraded after the fact.
- An owned OpenCode disconnect first attempts transport/protocol reconstruction. A readiness/connection timeout escalates to an owned `crash` restart. The failed operation is not replayed.
- Every endpoint generation change is broadcast through the existing lifecycle seam. Canonical sessions on that runtime enter reconciliation/epoch recovery, fence old observations and rebuild native context from confirmed Polyth history.
- Borrowed endpoints are never killed and never gain owned recovery semantics.

Consumers, security and persistence impact: the authority ledger gains an optional `containment` object (`kind`, exact unit, boot ID). Old records remain readable. `backend-opencode` consumes the existing owned lease restart seam; session/core contracts and browser DTOs do not change. Scope names contain only a hash of authority identity and generation. System commands receive a strictly validated generated unit name, never repository or provider input.

Compatibility/migration/rollback: systems without user systemd retain receipt-only supervision and fail closed after a lost supervisor receipt. Existing authority records have no containment and retain their prior behavior. Removing the feature leaves the optional field inert; it must not be used as proof by older code.

Verification and rollout: exercise native supervisor release, supervisor loss with a live child inside a real transient scope, PID-reuse denial, legacy fail-closed behavior, readiness-failure restart, endpoint replacement notification and existing runtime-epoch recovery suites. Live rollout should first confirm the server account has a usable user systemd manager and should not delete legacy ledgers automatically.

Remaining uncertainty: macOS/Windows and owned SSH runtimes do not have this local scope proof. A user-systemd outage during same-boot recovery remains fail-closed. Already orphaned legacy processes require an external containment/reboot procedure; this change cannot retroactively prove their descendants absent.

Supersedes / superseded by: refines the local-execution-ownership section of `docs/architecture/multi-harness.md`; no prior ADR superseded.
