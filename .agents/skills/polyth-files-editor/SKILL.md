---
name: polyth-files-editor
description: Work on resources, files, editors and git views with revision checks, safe paths, unsaved-state handling and lazy editor boundaries.
---
# Files, resources and editor workflows

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context files-editor`. This command is a navigation aid, not an audit.

- `packages/files`
- `packages/editor`
- `packages/git`
- `apps/web/test/packageContainment.test.ts`
- `docs/dev/ui.md`
- `docs/agents/security.md`

## Workflow and constraints
Trace resource identity, provider, revision and ownership before changing file/editor behavior. Preserve the distinction between browsing file contents and adding content to the model-visible session. Read the current resource/provider contracts; do not assume a filesystem path and a resource locator are interchangeable.

Use validated project/Space roots and existing resource seams. Reject traversal and symlink escapes, and avoid sending absolute private host paths unnecessarily. Handle stale revisions, deleted/renamed files, unsaved buffers and remote changes explicitly. Do not silently overwrite a user's concurrent edits or auto-save a review preview.

Keep CodeMirror lazy and inside the editor package. Git operations require correct cwd/worktree and explicit destructive-operation authorization; do not reset/clean/stash another agent's work to make tests easier. Capture a scoped diff before refactoring file operations.

Test empty/binary/large files, stale writes, permission denial, renamed resources, multiple editor instances, unsaved navigation and reconnect where applicable. Use realistic isolated fixtures and assert no cross-Space reads or writes with known-valid foreign IDs. Record which UI interactions and git operations were actually exercised. Do not infer editor readiness solely from a successful browser build.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/web/test/packageContainment.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
