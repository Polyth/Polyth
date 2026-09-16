# Project Composition — partial foundation, not merge-ready

Base: `8d034dec3674f9e581491ae422d64ef91d0eb7dc` (`master` when work started).
Input: Drive `media/backups/polyth.zip`, modified 2026-09-16T06:50:11Z.
The archive's ahead commit and uncommitted edits were preserved separately; 2,946 non-Git source files were compared byte-for-byte with the input ZIP and remain unchanged.

## Published vs integrated

This branch publishes the browser-safe resolver/validation contract, its tests, and the package subpath export. The accompanying `project-composition-integration.patch` download contains the remaining locally implemented foundation against this branch. The integration patch and complete source ZIP are conversation deliverables, not applied source on this remote branch. The patch is deliberately not represented as already-applied production code.

The complete local foundation is commit `678e8724187d5474e93834978311831579908e54`: canonical Project/ProjectPatch composition, atomic project persistence, local add/create API plumbing, removal of the duplicate organization PATCH route, validated category/affinity metadata for 45 package descriptors, and regression tests. After downloading `project-composition-integration.patch`, verify it with `git apply --check /path/to/project-composition-integration.patch`, then apply it with `git apply /path/to/project-composition-integration.patch` on this branch. Remove this temporary handoff note before final feature acceptance.

## Frozen foundation contracts

- `version: 1`, a union of directions, and package include/exclude overrides.
- Directions: engineering, research, wellbeing, finance, home, operations.
- Global disable wins over project include. Exclude wins over inferred affinity. Explicit include wins over affinity. Absent composition preserves legacy behavior; empty directions mean general-purpose.
- Relevance is discovery/presentation, never authorization or package lifecycle.
- Unknown/unclassified packages remain compatible; explicit unknown-package overrides survive reinstall.
- No implicit migration on read. `composition: null` deliberately restores legacy discovery without deleting defaults/layouts.
- Patch validation and durable I/O complete before publishing the staged record; input/output nested values are copied.

## Automated evidence — complete local foundation

Node v22.16.0; TypeScript 5.8.3. Workspace links point to the actual source; missing external dependencies were not replaced with fake packages.

- Focused new tests: **22 passed, 0 failed**.
- Contracts + existing server-package suite + new metadata/persistence/route tests: **73 passed, 0 failed**.
- Contracts strict typecheck: passed.
- Project persistence strict typecheck: passed.
- `git diff --check`: passed.

Exact test commands:

```sh
node --experimental-strip-types --test packages/contracts/test/projectComposition.test.ts packages/plugins/test/projectCompositionMetadata.test.ts packages/server/test/projectComposition.test.ts
node --experimental-strip-types --test packages/contracts/test/*.test.ts packages/plugins/test/serverPackage.test.ts packages/plugins/test/projectCompositionMetadata.test.ts packages/server/test/projectComposition.test.ts
```

The currently published resolver-only source has 8 focused tests; the additional tests above require applying the integration patch. They are not a claim that the unpatched branch already contains the integration.

## Not implemented / not verified

- Client contribution filtering for capabilities, surfaces, slots, widgets/mini-widgets, Project Context and workbench profiles.
- Agent capability delivery filtering and live reconciliation.
- Initial workspace/widget/profile seeding through the existing stores.
- Metadata-driven onboarding and the shared Project Settings editor.
- Complete remote/clone creation composition plumbing.
- Desktop/mobile product polish and live browser verification.
- Native-device verification and independent frontier review.

No full-feature completion or merge readiness is claimed.

## Execution blockers

Local npm dependency installation could not complete; DNS lookup of registry.npmjs.org failed and the ZIP contains no node_modules. A narrowly branch-scoped temporary dependency-bootstrap workflow was attempted twice. Both attempts ended with failure before any reported steps and produced no logs/artifacts. The connector did not expose the failure annotation; no billing or quota cause is asserted.

Run: https://github.com/otto-assistant/polyth/actions/runs/35067091649

The temporary workflow is removed in this branch. No master changes, bypassed branch protections, auto-merge requests, background follow-up promises, or independent-model review claims were made.

Integration patch SHA-256: `e3f9e063e1ef0003d1a057c9303a9419a8a9ff33212fd89ed727310c79361666`. The patch was checked by reconstructing the exact complete local tree `b737720c378512511460c64b5e3351f43ab226b5` in a separate Git index.
