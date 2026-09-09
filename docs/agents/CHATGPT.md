# ChatGPT / generic agent bootstrap

A plain conversation does not automatically load repository instructions or files. Supply the relevant files or use an authorized repository connector. A connected GitHub repository and a local shell are different capabilities; do not claim to have run local tests merely because source reads succeeded.

For a compact starting packet from a local checkout:

```sh
node scripts/agent-kit.mjs bundle mobile > /tmp/polyth-mobile-context.md
```

This emits root policy, the selected skill, selected kit reference text and source-status/navigation metadata. It deliberately does not include arbitrary application source, credentials, conversations or logs. Review the resulting private project document before sharing. It is context, not a substitute for fetching the current code that the task changes. `bundle` does not automatically upload anything.

## Prompt to accompany a task

> Work on the supplied Polyth task using root AGENTS.md and the relevant canonical skill. Establish the exact repository revision and available tools. Treat the attached context as a dated navigation aid, not proof of current APIs or feature readiness. Fetch/read the defining code and directly relevant tests before proposing or applying changes. Preserve package ownership, Space isolation, browser/Node boundaries, durable event/reconciliation rules and the user's existing work. Do not guess missing source, execute live/paid/destructive operations without authorization or claim checks you did not run. Return scoped changes, exact evidence and remaining unknowns. When the task crosses a trust/public-contract boundary, expand verification accordingly rather than skipping it to save tokens.

Provide the actual behavior/request, relevant error or screenshot, intended branch, allowed operations and acceptance criteria alongside that prompt. Do not include secrets. A context-only review should finish with source-level findings and explicitly unrun runtime checks, not “all tests passed.”
