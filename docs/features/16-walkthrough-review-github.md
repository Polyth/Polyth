# Walkthrough, review, and GitHub

## Current Polyth baseline

`packages/walkthrough` already derives ordered file-edit steps and unified diffs from durable tool events; approve/reject decisions append `walkthrough/step-*` events. `WalkthroughView.tsx` navigates and decides steps. `packages/github` uses the local `gh` CLI, fails soft, and lists repo/issues/open PRs. Missing parity is explicit AI walkthrough generation over stable Git snapshots, PR detail/check/comment surfaces, inline review threads, and an opt-in review loop.

## 1. Generated changes walkthrough

**Source:** polyth #2572.

**Acceptance criteria**

- User explicitly starts generation for working changes, a commit range, branch comparison, or PR.
- Generation captures an immutable source digest, groups/reorders hunks into logical stops, and explains intent/risk without mutating files.
- A stale-source banner appears if the working tree changes; cached results remain reviewable against their snapshot.
- Existing approve/reject events remain available for session-derived edit steps.

**Data**

```ts
type WalkthroughSource =
  | { kind: "working-tree"; projectId: string }
  | { kind: "range"; projectId: string; base: string; head: string }
  | { kind: "pull-request"; projectId: string; number: number };

interface WalkthroughDto {
  id: string; source: WalkthroughSource; sourceDigest: string;
  status: "queued"|"running"|"ready"|"failed";
  stages: Array<{
    id: string; title: string; explanation: string;
    stops: Array<{ id: string; path: string; hunkDigest: string; diff: string; explanation: string }>;
  }>;
  error?: string; createdAt: number;
}
```

```http
POST /api/walkthroughs {"source":{...},"sessionId":"..."}
GET  /api/walkthroughs/:id
POST /api/walkthroughs/:id/cancel
GET  /api/walkthroughs/:id/source-status
```

Use stable hunk identity from normalized path + old/new ranges + content digest. Cache by source digest + prompt version + model ID under server data storage. The source diff is captured before generation. Only `packages/backend-opencode` calls the model; it returns structured JSON through a capability. Append `walkthrough/generated {walkthroughId,sourceDigest,stages}` before explanations appear.

UI: `WalkthroughSourcePicker`, `WalkthroughBlocker`, `WalkthroughStages`, `WalkthroughStop`; classes `.walkthrough-source`, `.walkthrough-stage`, `.walkthrough-stop`, `.walkthrough-stale`.

**Tests:** rename/binary/large diffs, identical hunks, changed source mid-job, cancellation, malformed model JSON, cache prompt-version invalidation, restart, event-before-display.

## 2. Pull-request detail surface

**Source:** polyth #2418.

Selecting a PR opens a right/main surface with overview, changed files, commits, checks, and review comments. Extend `@polyth/github`:

```http
GET /api/github/pr?projectId=&number=
GET /api/github/pr/files?projectId=&number=&pageToken=
GET /api/github/pr/checks?projectId=&number=
GET /api/github/pr/comments?projectId=&number=&pageToken=
```

DTOs include canonical URLs, IDs, timestamps, pagination, and source commit SHA. `gh` commands use fixed argv and bounded JSON output; missing auth/non-GitHub remotes continue to fail soft. Do not store access tokens.

Contribute `github.pr` through pane slots. Components: `PullRequestView`, `PrOverview`, `PrFiles`, `PrChecks`, `PrComments`; classes `.pr-surface`, `.pr-tabbar`, `.pr-state`.

Test closed/draft/fork PR, force-push while open, pagination, missing permissions, rate limit, non-GitHub remote.

## 3. Checks summary and grouping

**Source:** Paseo #3483.

Normalize check runs:

```ts
type CheckStatus = "queued"|"in_progress"|"success"|"failure"|"cancelled"|"skipped"|"neutral"|"timed_out"|"action_required";
interface PrCheck {
  id: string; name: string; workflow?: string; status: CheckStatus;
  startedAt?: string; completedAt?: string; url?: string; summary?: string;
}
```

UI headline follows failure-first semantics, shows counts and an accessible proportional ring, then groups Failure/Action required, Running/Queued, Success, Skipped/Neutral, Cancelled. A skipped required check retains its name. Poll while any check is nonterminal; stop when surface hidden unless subscribed by a review job.

Classes: `.checks-summary`, `.checks-ring`, `.checks-group`, `.check-row`. Ring must have text equivalent and not depend on color.

Test empty checks, all skipped, mixed terminal/running, rerun with same name/new ID, missing URLs, hidden-surface polling.

## 4. Inline PR review comments

**Source:** Paseo #530.

Anchor comments with `{path,side,line,startLine?,commitSha,diffHunk}`. Drafts remain local until submitted. Add:

```http
POST /api/github/pr/:number/reviews
{"projectId":"...","event":"COMMENT|APPROVE|REQUEST_CHANGES","body":"...","comments":[...]}
```

Show outdated comments when commit/hunk no longer maps. Write operations require an explicit permission guard and confirmation for APPROVE/REQUEST_CHANGES. Append `review/submitted {prNumber,reviewId,event,commitSha,commentCount}` to the active session if the review was created from that session; the complete review text is logged before any agent can act on it.

Test line sides, deleted lines, force-push, duplicate submit retry/idempotency, auth scope, draft recovery, and secret redaction.

## 5. Risk and confidence scoring

**Sources:** polyth #1943, #1961.

Generated reviews return a validated schema:

```ts
interface ReviewAssessment {
  summary: string;
  findings: Array<{ severity: "critical"|"high"|"medium"|"low"; path?: string; line?: number; body: string; confidence: number }>;
  riskScore: 1|2|3|4|5;
  confidenceScore: 1|2|3|4|5;
}
```

Reject/clamp invalid model values through a strict parser; do not infer labels from prose. Append `review/generated` and `review/risk-scored` before UI display. Publishing labels is opt-in:

```http
POST /api/github/pr/:number/labels
{"projectId":"...","labels":["risk:3","confidence:4"],"sourceReviewId":"..."}
```

The server ensures the label names/color policy and does not allow arbitrary command injection. If label permission fails, the review remains usable and displays a nonfatal publish error.

Test malformed scores, stale commit, duplicate labels, fork permissions, model failure, replay, and review text size.

## 6. Automatic reviewer/implementer loop

**Source:** polyth #1840.

This is high risk and must be opt-in per session. State machine:

```text
idle → implementing → awaiting-review → reviewing
reviewing → passed | changes-requested | failed
changes-requested → implementing (bounded iteration)
```

```ts
interface ReviewFlowState {
  id: string; sessionId: string; status: string;
  iteration: number; maxIterations: number;
  baseDigest: string; latestReviewId?: string; stoppedReason?: string;
}
```

Endpoints under `/api/sessions/:id/review-flow` create/get/pause/resume/stop. State derives from `review-flow/started`, `review-flow/review-requested`, `review-flow/changes-requested`, `review-flow/passed`, `review-flow/paused`, `review-flow/stopped`, and `review-flow/failed`. Every reviewer prompt/result is logged before handoff. Implementer/reviewer runtime calls remain in `packages/backend-opencode`.

`AutoReviewBanner` shows phase, iteration, changed digest, and Stop. Permission prompts pause the loop. Never auto-publish a GitHub review, merge, push, or destructive Git action; those require a user action.

Test max iteration, unchanged repeated findings, permission/question pause, abort/restart, reviewer parse error, manual edits, source digest change, and stop idempotency.

## 7. Local review versus remote publication

Generated walkthrough/review is local by default. Separate buttons are:

- Generate review (model call, durable local session events).
- Save review draft (server/local persistence).
- Submit GitHub review (external write + permission).
- Publish risk labels (external write + permission).

This separation prevents generation retries from creating duplicate external comments or labels.

## Suggested implementation order

1. GitHub PR detail/read-only DTOs and checks grouping.
2. Stable diff/hunk identity and walkthrough job/cache.
3. Structured review assessment and durable events.
4. Inline drafts and guarded remote submit.
5. Risk/confidence label publishing.
6. Bounded auto-review loop.

## Global implementation contract

- Node 22 erasable TypeScript; `.ts` local imports; no enums/namespaces/parameter properties.
- Use workspace contracts/capabilities.
- Only `packages/backend-opencode` invokes models/OpenCode.
- Append generated explanations, findings, and handoff prompts before display/use.
- Extend `/api` and `/ws`.
- Walkthrough/PR/review surfaces use typed slots.
- Tests use `node --test` and plain `node:assert`.
