# OpenCode hardening failure matrix

| Scenario | Protocol | Result | Regression test | Upstream issue |
| --- | --- | --- | --- | --- |
| POST accepted, response lost | Legacy/V2 | One attempt; durable unknown | `packages/backend-opencode/test/transportFaults.test.ts`, `packages/server/test/opencodeReliabilityE2E.test.ts` | P1 |
| Create accepted, response lost | Legacy | No duplicate session; exact receipt only | `packages/server/test/opencodeReliabilityE2E.test.ts` | P1 |
| SSE and pull observe the same fact | Legacy/V2 | One semantic claim and canonical append | `packages/backend-opencode/test/reconciliation.test.ts` | P3 |
| Old-generation callback arrives after replacement | Both | Rejected before translation | `packages/backend-opencode/test/runtimeLifecycle.test.ts` | — |
| Same owned-local runtime restarts | Both | Same authority, higher generation | `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts` | — |
| Same SSH host/path restarts | Both | Same authority, higher generation | `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts` | — |
| SSH host or remote path changes | Both | New authority; old backend binding rejected | `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts` | — |
| Two processes acquire one durable lease | Both | Distinct generations; highest state persists | `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts` | — |
| Generation transaction crashes before commit | Both | Last committed generation remains valid | `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts` | — |
| Persisted backend ID has no runtime identity | Both | Attachment fails closed | `packages/server/test/runtimeReconciliation.test.ts` | — |
| Revision-less idle duplicated after new turn | Legacy | Cannot stop the new turn | `packages/backend-opencode/test/realLegacyTerminalization.test.ts` | P2 |
| Old idle arrives after reconnect | Legacy | Remains unclaimed without current-turn completion | `packages/backend-opencode/test/realLegacyTerminalization.test.ts` | P2 |
| Previous completion followed by new submit | Legacy | Previous completion is not current terminal proof | `packages/backend-opencode/test/realLegacyTerminalization.test.ts` | P2 |
| Revision-less session error | Legacy | Consumed once by the current admitted turn | `packages/backend-opencode/test/realLegacyTerminalization.test.ts` | P2/U3 |
| Shared daemon disposal | V2 | Never stops or writes shared service | `packages/backend-opencode/test/runtimeLifecycle.test.ts` | P4 |
| Cross-project supplied session-ID collision | V2 | Product path remains disabled/fenced | Protocol contract tests | U4 |
| Aborted tool reported completed | Legacy | Upstream payload retained; no duplicate abort | Server reliability tests | U2 |
| Nonexistent-file read hangs | Legacy | Honest active/unknown state | Manual upstream reproduction only | U1 |

Runtime captures are deliberately absent. Tests construct temporary state and
fixtures at execution time.
