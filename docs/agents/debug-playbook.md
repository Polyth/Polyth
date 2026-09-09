# Causal debugging playbook

## Minimal diagnostic packet

Requested action or exact command; current commit and dirty scope; first causal error; smallest reproducer; expected versus observed; last known working evidence; relevant tool/runtime versions; redacted logs. Avoid copying entire environments or transcripts. Do not change code before recording enough evidence to recognize the original failure.

| Symptom | First trace | Common false conclusion to avoid |
| --- | --- | --- |
| `Could not resolve node:*` in web build | Browser entry -> exported subpath -> transitive Node import | “esbuild is broken; externalize Node modules” |
| `EPIPE` / closed stream | Stream owner, subprocess lifecycle, close/error order, pending mutation receipt | “Ignore EPIPE globally” or “retry all requests” |
| Empty/slow model picker | Selected harness/account, cache identity, discovery call chain, loading state and stale result | “Provider has no models” from a timeout or old table |
| Attachment rejected | Native picker -> upload/DTO -> admission -> capability -> adapter translation | “All file types work because images work” |
| No final assistant text | Native terminal item/event mapping, dedup/ordering, canonical persistence and projection | “Hide the spinner and synthesize success” |
| Duplicated turn/tool | Logical operation identity, acknowledgement loss, restart/reconciliation fences | “Just add another retry” |
| Pairing screen exists but connect fails | Default implementation, native registration, build linkage, identity/grants/proxy | “The backend is down” without checking MissingNativeCore |
| Wrong project's content after switching | Server/Space/project keys, abort/disposal, stale callbacks and revision fencing | “Clear all storage on every render” |
| Test fails only in full suite | Shared fixtures/process state, cleanup, ports/data roots, order/concurrency | “Increase timeout” without finding interference |

## Experiment loop

State a bounded hypothesis and the observation that would falsify it. Prefer one discriminating test to broad speculative edits. Once a mechanism is established, patch the owning boundary and add a regression. Re-run the reproducer and adjacent boundary checks. If the environment cannot reproduce, clearly separate established source defects from untested operational hypotheses.

## Baseline and provenance

Use git history/blame/diff only when the question requires introduction timing or the current cause remains ambiguous. Do not assume the latest commit caused the symptom merely because its files look related. A claimed pre-existing failure must be reproduced on a comparable base. Never reset, clean, stash or kill another contributor's work to obtain a clean experiment.

## Stop conditions

Stop expanding investigation when the cause, owner, correction and adequate validation are known. Expand again only when new evidence contradicts the hypothesis, a shared contract changes, or an adjacent check exposes another causal path. Record unrelated findings separately; do not turn a narrow fix into a repository rewrite.
