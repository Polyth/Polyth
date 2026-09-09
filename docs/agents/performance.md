# Performance measurement contract

Use this document when a task asks for faster startup, catalog loading, harness switching, streaming, rendering or lower resource use. It is a measurement protocol, not a claim that any numeric budget has already been achieved.

## Define the workload

Specify operation, start/stop milestones, dataset/session size, cold/warm state, network/provider conditions, machine, build and sample count. Separate first usable UI from first token and final completion. Provider latency is not interchangeable with local orchestration overhead. Record whether data is real or mocked.

## Find removable work

Measure the critical path: discovery, auth/capability checks, IPC/network requests, parsing, event append, reconciliation, rendering. Count repeated requests and redundant work. Inspect cache identity, lifetime and invalidation before adding memoization. Existing state owners and lifecycle seams are preferred to a second global cache.

Safe optimizations include scoped single-flight requests, bounded reusable metadata, lazy nonessential modules, narrower subscriptions, incremental derivation and cleanup of inactive work. Each needs evidence that it does not leak across server/Space/account/project/runtime identities or show stale results.

Never trade away authorization, durability, release proof, idempotence or correct cancellation. A fast but incorrect response is a regression. Do not replace functional behavior with a placeholder merely to improve perceived latency. Preserve low-resource and user appearance preferences.

## Compare fairly

Run before/after under comparable conditions with multiple samples. Report sample size, observed range or appropriate statistics and memory/request count where relevant. One observation cannot justify a p95 claim. Include an erroring/slow-provider scenario and rapid selection changes. Avoid flaky millisecond assertions when work-count and state-invariant tests are more reliable.

Keep profiling output bounded and redacted. Add instrumentation only where the task needs it; do not permanently log user prompts or secrets. Document residual external latency and what was not measured.
