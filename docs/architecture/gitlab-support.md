# GitLab hosting support

Source-inspected and tested implementation, 2026-09-10. Base: `658870147fcbe8b10f82331afd00add43c491ee9`; implementation branch: `codex/gitlab-support`.

## Ownership and compatibility

`@polyth/code-hosting` owns neutral hosting DTOs, check summaries, conflict prompts, browser-safe remote parsing, shared routes, and one set of issue/change-request widgets. GitHub retains its `gh` adapter, public compatibility names, `/api/github` routes, events and widget IDs. GitLab owns its REST client, mappings, accounts, instance binding, `/api/gitlab` routes and presentation. Mature `pr` endpoint suffixes and the existing conflict-turn flag remain wire compatibility details.

Local Git, commit author and Git transport belong to `@polyth/git`. The shared UI consumes its browser-safe `./diff` export. Package contributions provide integration cards, repository identity and create-request controls; the host owns those generic slots, standard controls, navigation and composer insertion. Desktop registers the GitLab server package beside the existing packages. Mobile uses the same surfaces and the host's responsive menu/sheet.

## Implemented behavior

| Area | Behavior |
| --- | --- |
| Accounts | Multiple PAT accounts per normalized instance; gitlab.com and self-managed instances; existing `glab` credentials resolved transiently and checked against the selected username. |
| Repository | All fetch remotes inspected locally, including HTTPS, SCP SSH and `ssh://`; nested groups; explicit account/remote binding; default branch, visibility and upstream/fork metadata. |
| Issues | Search/state filters, descriptions, labels, assignees, comments and context/session actions. |
| Merge requests | Search/state/draft filters, branch/fork identity, files and highlighted patches, threaded discussions, line comments, reply, resolve/reopen, pipelines/jobs and failed-job investigation. |
| Writes | Create/draft, title/description/target update, ready, notes/reviews, approve/unapprove, policy labels, merge/squash. Shared AI description and conflict handoff retain explicit user publication. |
| Project flow | Optional post-add identity setup; clone URL applicability, single-account preselection and inline account connection. Clone completes before an exact observed remote is bound; failed binding does not clone again. |
| UX | Compact identity chip, incompatible accounts visible but disabled, GitHub/GitLab integration cards, and explicit provider choice for mixed-remotes create flows. |

Existing Git Sync already publishes branches and sets upstream using the selected remote. That working transport flow is retained. Choosing a hosting account does not change commit author or inject credentials into Git/agents.

## Security and failure semantics

Routes use gateway `rc.space`, scoped projects/sessions and scoped storage. Account configuration requires Space admin; provider writes require member. Paired-device ingress remains default-deny through the existing local-only package policy. PATs use server-side Secure Safe; metadata is atomic, mode `0600`, schema validated and rollback safe. No raw token or credential reference enters account responses.

Self-managed origins are normalized and requests use the existing DNS-pinned outbound transport. Redirects and cross-origin API paths are rejected. HTTPS is the default; HTTP is restricted to loopback development. Local trusted deployments support private/self-managed networks; hosted deployments enforce the existing public-address policy. CLI credentials are unavailable in hosted deployments.

Activation uses local remote inspection and cached identity only. Credential-capable provider reads occur when the user opens hosting functionality or explicitly checks an account. Each GitLab operation rechecks the exact selected remote and account instance. Bindings do not authorize unrelated remotes.

External writes persist an uncertain receipt before delivery, reject request-key/payload reuse and do not blindly replay after process restart. The browser also coalesces repeated attempts and retains uncertain results. Partial multi-note reviews report an unknown outcome. Merge verifies the displayed source SHA and passes it to GitLab. Ready uses `/ready`, then verifies draft state; it never overwrites a concurrent title edit. Receipt history is bounded at 10,000 entries and requires deliberate reconciliation/archive before further writes.

Pipeline enrichment fails soft. Oversized/collapsed patches are reported explicitly, while authoritative MR details remain visible. Lists are bounded; metadata reports API read access separately from unknown write permissions and independent Git transport permissions. Actual GitLab authorization is checked per operation, without requiring one historical token-scope name.

## Verification

- Focused GitHub/GitLab/shared-hosting/Git/web-SDK, discovery, containment, slot and desktop-registry run: **322 tests, 318 passed, 4 browser-dependent skips, 0 failures**.
- Explicit Chromium run with `POLYTH_CHROMIUM_PATH=/snap/bin/chromium`: shared hosting tabs at 390/1200px, discussion publication, closed/search results and provider switching; **1 passed**. Account menu screenshots were separately inspected at both widths with no document overflow or browser errors.
- `tsc --noEmit -p` for code-hosting, GitLab and web-SDK passes. Web/GitHub project checks reproduce the same base-revision diagnostics: `apps/web/test/sessionRowMenu.test.ts:337`, `apps/web/test/timelineLayout.live.ts:38`, and the optional `harnessSnapshots` call in `packages/server/src/runtimeCatalog.ts:149`. No new diagnostics remain in those checks.
- `npm run build:web` passes. The root manifest defines no lint command.
- Full `npm test` was attempted: 33 failing/cancelled cases reproduced at the base revision. The moved source-control assertion was corrected; an `httpDrain` timing failure passed in isolation. The run stalled in `opencodeReliabilityE2E` and `wsRemoteAuth`; those tests also did not complete in a bounded base-revision run. This is **not** an all-repository green claim.

Reproduce the browser check with:

```sh
POLYTH_CHROMIUM_PATH=/path/to/chromium node --experimental-strip-types --test packages/code-hosting/test/ui.test.ts
```

## Limits and reference

No live GitLab credential, paid agent turn, native-device run, installer signing or publication was performed. Browser/mocked evidence does not prove a particular deployed GitLab server's behavior. `/ready` requires GitLab 15.1+ and remains verified after submission. OAuth/browser/device login is delegated to installed `glab`; Polyth does not manage OAuth refresh. A `glab` account whose active CLI identity changes fails closed; PAT accounts remain independently selectable. Fine-grained write access may remain unknown until the requested operation. Large server-limited patches must be inspected on GitLab. Accounts are localized with English fallback; the rich GitLab presentation currently uses English with shared localized action labels.

A source-inspected reference implementation, captured at `0d7733a2f26ad355fa5f75ceab4220fec8661ba1`, informed the identity chip, visible incompatibility and progressive account setup. Polyth reuses its existing Git flow, Secure Safe, outbound transport and rich views, adds no third-party SDK, and preserves separate author/API/transport identities instead of adopting the reference's broad identity refactor.
