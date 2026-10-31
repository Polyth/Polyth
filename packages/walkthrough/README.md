# @polyth/walkthrough

Guided review of agent file changes. Three views in the workspace pane:

- **Session steps** — ordered file edits derived from the session event log (`deriveWalkthrough`), approve/reject overlay events.
- **Replay** — Replay Theater (`src/replay.ts`, `widgets/ReplayTheater.tsx`). Scoped to the last file-changing turn by default, or any inclusive turn range (user prompts delimit turns; hidden auto-resume prompts do not). Play/pause, step, scrub, 0.5–4× speed, per-file filter chips, a before/after file-state pane per step and a jump-to-originating-message action (`[data-message-seq]` in the timeline). Keys: Space/K play·pause, ←/→ or J/L step, Home/End, +/− speed, M jump. Auto-advance is a plain timer the user controls; no animation depends on it, and tick transitions are disabled under `prefers-reduced-motion`.
- **Generate** — model-written staged walkthroughs and structured reviews (`src/generate.ts`, `src/review.ts`). A pull-request source is read through the shared GitHub service with the host's `gh` login (the installation's account), so only the instance owner on local-trusted may use one; everyone else gets `git-account-required` (409, not started) before any `gh` call. Working-tree and range sources use local Git only.

Replay is a pure fold of `user/message` and `tool/result` events; nothing is stored. File state is exact only when a `write` (or a prior replayable edit chain) established the base; otherwise the pane shows just the changed snippet and labels it so. `patch` steps show the diff only.
