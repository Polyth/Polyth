# Multirun

Run one prompt against several models in parallel, compare their answers, and
pick one to continue. The workflow is owned by this package; the server-side
runner (`src/runner.ts`) executes each run on a throwaway backend session.

## Judgment use — `multirun.rubric-score`

An opt-in Judgment use (scope `multirun.rubric-score.v1`, Settings → Judgment).
When it is on, the bounded scoring pass runs once every answer of a comparison
exists, and each answer that returned text is judged separately:

- one `score` question built from the rubric lines (weakest first, 2–8 of them);
- evidence is the prompt (≤2,000 chars) plus that answer's tail
  (`maxAnswerChars`).

The result is a continuous 0-based score, its maximum (`levels - 1`) and a
confidence. Scores are recorded on the run through the existing Multirun event
path (`multirun/run-scored`, ignorable) and in the live snapshot, and the view
shows them beside each answer as `3.4 / 4 · 82%`. Low confidence is shown, not
hidden, and marked as such.

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `rubric` | text (multiline, ≤2,000) | 5-level correctness rubric | One level per line, weakest first; 2–8 lines. |
| `criteria` | text (≤400) | `correctness, completeness` | What the answer is judged on. |
| `maxAnswerChars` | integer 1,000–20,000 | 6,000 | How much of each answer's tail is evidence. |
| `fusionTopK` | integer 0–8 | 0 | Fusion preselects the top-K scoring sources; 0 is off. The person still confirms. |

Policy: Judgment is evidence. A score never selects, picks or sends an answer on
its own. Judgment off/absent, the use off, a failure/timeout/cancellation, an
empty answer or an invalid rubric → no score (an invalid rubric leaves a visible
note instead). Fusion only preselects suggestions the person can change.

## Verification

```sh
node --experimental-strip-types --test packages/multirun/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/multirun
```
