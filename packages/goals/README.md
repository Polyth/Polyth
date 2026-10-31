# Goals

Durable session objectives, completion audits and bounded continuations. The
design is in [docs/dev/goals.md](../../docs/dev/goals.md).

## Judgment audit — `goals.audit`

An opt-in Judgment use (scope `goals.audit.v1`, Settings → Judgment). When it is on,
the completion audit after a turn asks Judgment instead of the session's small model:

- `status`: choice `progressing` / `stuck` / `done`;
- `progress`: score on a 0..4 rubric (none … fully achieved and verified).

Policy (`goalAuditVerdict`): `done` only when it is the top answer, its probability
is ≥ `doneThreshold` and it leads the next answer by ≥ `minMargin`; `stuck` likewise
with `stuckThreshold`, and then follows the existing stuck path (streak →
`goal/stuck`); anything else is `keep` (progressing, continue). Dependency audits
(delegated sessions settling) never ask.

| Param | Default |
| --- | --- |
| `doneThreshold` | 0.8 |
| `stuckThreshold` | 0.7 |
| `minMargin` | 0.2 |

Failure, timeout, cancellation, Judgment off/absent or the use off → the original
small-model audit runs unchanged. Judged audits add `judgment: { probabilities,
margin, progress, progressLevels }` and `lastProgress` (fraction 0..1) to the
`goal/audit` event; the goal strip and Goals view show the progress percentage.

Evidence: the objective (≤4,000 chars), the tail of the latest reply (≤8,000 chars)
and the already bounded delegated-session reports.

## Verification

```sh
node --experimental-strip-types --test packages/goals/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/goals
```
