# Fusion

Collect several models' answers to one prompt, then ask a small model to
synthesize one weighted answer with attribution and a list of disagreements.
The synthesis runner lives in `src/index.ts`; the setup view's "pick sources"
step is where the person chooses the models.

## Preselecting sources by Multirun score

Fusion reads the `multirun.rubric-score` Judgment use registered by the
[Multirun package](../multirun/README.md). When its `fusionTopK` parameter is
nonzero and the session's newest Multirun has rubric scores, the setup view
preselects the top-K scoring models that the model picker also offers. This is a
suggestion only: the person can change the selection and must still confirm by
starting the fusion. Nothing about the synthesis itself changes.

Scores and the resolved `fusionTopK` come from the canonical `multirun/run-scored`
events of the session (the Multirun server records the value it resolved when it
scored), so Fusion never reads Judgment settings and the preselection survives a
reload. With `fusionTopK` at 0 (the default) or no scores, the selection simply
stays empty.

## Verification

```sh
node --experimental-strip-types --test packages/fusion/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/fusion
```
