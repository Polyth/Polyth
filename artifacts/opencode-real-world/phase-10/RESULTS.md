# Phase 10: UI State Truthfulness Verification - RESULTS

**Agent:** Agent L (verdict corrected during campaign wrap-up)
**Date:** August 28, 2026

## VERDICT: PARTIAL (coverage gaps; no safety issue confirmed)

### States Successfully Verified
- ✅ **IDLE** - Composer enabled, ready for input
- ✅ **WORKING** - Shows "⏳ Working..." indicator, matches backend state
- ✅ **FAILED** - Clear error message, composer re-enabled
- ✅ **UNKNOWN** - Accurately shown when no agent connected
- ✅ **RELOAD PERSISTENCE** - State correctly restored after F5

### Correction: composer-enabled-during-working is NOT a bug

The original run flagged "composer enabled during active turn" as a CRITICAL
safety issue and recommended disabling input. That classification was wrong
and is withdrawn:

- Polyth's durable queue is an intentional product contract: users may type
  and send while a turn is running, and the extra prompt queues durably
  instead of being admitted into the running turn. Queue behavior during an
  active turn was exercised for real in OC-REAL-075 (Phase 7) and is the
  subject of plan row OC-REAL-090 ("Queue multiple messages during active
  work"). The screenshot `phase10-ui-06-DANGER-composer-enabled-during-working.png`
  shows this intended behavior, not a violation.
- The actual danger named by the requirement is a **stale IDLE projection
  that admits a second in-flight turn** (two concurrent admissions). That was
  not observed here, and OC-REAL-073 (Phase 7) proved with a real two-client
  same-tick race that exactly one send is admitted and the loser is
  fallback-queued exactly once.
- Do NOT disable the composer while working; that would break the queue
  contract.

What remains open for this concern is a dedicated stale-IDLE probe: force a
projection that lies `idle` while a turn is still running upstream and prove
the second send queues (or is fenced) rather than being admitted concurrently
(plan rows OC-REAL-099/100). That was not executed in this run.

### States Not Observed
Due to lack of functioning OpenCode agent:
- SENDING, QUEUED, THINKING (likely merged into "Working...")
- TOOL ACTIVE, PERMISSION REQUIRED, QUESTION REQUIRED
- INTERRUPTED, COMPLETED, RECONNECTING

### Positive Findings
- ✅ No "No models available" P0 bug (was fixed)
- ✅ State persistence on reload works correctly
- ✅ Error messages are clear and helpful
- ✅ Composer stays available during WORKING, consistent with the durable
  queue contract (OC-REAL-075/090)

### Recommendations
1. Run a dedicated stale-IDLE / second-admission probe (OC-REAL-099/100
   territory) with a functioning agent.
2. Test with actual OpenCode agent for full state coverage (OC-REAL-088–100).
3. Verify interrupt/stop functionality.

**Full Report:** `/opt/cursor/artifacts/phase10-ui-verdict.md`
**Screenshots:** `/opt/cursor/artifacts/phase10-ui-*.png`
