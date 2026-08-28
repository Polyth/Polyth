# OpenCode hardening release gate

Validated against OpenCode CLI `1.18.18`. A checked row has durable automated
coverage; historical execution output is not retained as source.

| Gate | Status | Regression coverage / limitation |
| --- | --- | --- |
| V2 model discovery and normalization | Pass | `protocolV2.test.ts`; compact redacted catalog fixture |
| V2 session creation, model selection, prompt, and stream translation | Pass | `protocolV2.test.ts`, `protocolContract.test.ts` |
| Mutation response loss and no generic replay | Pass | `transportFaults.test.ts`, `opencodeReliabilityE2E.test.ts` |
| Atomic SSE/pull observation deduplication | Pass | `reconciliation.test.ts`, session runtime-operation tests |
| Owned local restart authority and fencing | Pass | `regressionOwnedAuthorityRestart.test.ts`, `runtimeLifecycle.test.ts` |
| SSH identity across restart/host/path changes | Pass | `regressionOwnedAuthorityRestart.test.ts` |
| Cross-process generation uniqueness | Pass | `regressionOwnedAuthorityRestart.test.ts` |
| Legacy revision-less live terminalization | Pass with upstream limitation | `realLegacyTerminalization.test.ts`, `reconciliation.test.ts`; stale reconnect history remains unknown |
| Multi-client ordering and durable queue | Pass | server delivery and reliability suites |
| Worktree isolation and binding scope | Pass for isolation | Fork/rotation recovery limitations remain in `UPSTREAM-ISSUES.md` |
| Shared V2 daemon product attachment | Open | No authoritative OpenCode service descriptor or normal composition path |
| SSH ControlMaster-independent recovery | Open | Forward and remote-child lifecycle remain coupled |
| Duplicate model-visible facts under all replay shapes | Open | Some changed-transport-ID/revision cases remain unresolved |
| 24-hour / 10,000-turn soak | Not run | No long-soak claim |

Release claims are limited to the checked behavior above. This document does
not claim complete OpenCode V2, polyth, or Paseo parity.
