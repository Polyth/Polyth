# Command ownership and side effects

Observed at the evidence baseline. Inspect current manifests before execution. These are repository commands, not automatically authorized operations. Run from the repository root unless stated otherwise. The kit CLI requires Node >=22.14 and Git for inventory/impact; it does not require npm dependencies.

| Command | Meaning | Side effect / limitation |
| --- | --- | --- |
| `npm ci` | Install locked workspace dependencies | Network and install scripts; only when installation is authorized |
| `npm run build:web` / `npm run build` | Bundle package web entries and web shell | Writes dist; does not validate native apps |
| `npm start` | Start Node server | Uses real runtime/data unless explicitly isolated |
| `npm run dev` | Build once then start | Not a guarantee of HMR |
| `npm run watch` | Run the development supervisor | Can start/manage a runtime; read `scripts/supervisor.ts` and its actual options before starting |
| `npm test` | Root Node test glob | Broader than generic CI selection; may include environment-dependent tests |
| `node --experimental-strip-types --test <existing-test.ts>` | Focused Node test | Explicit stripping works with the repository minimum Node contract |
| `node node_modules/typescript/bin/tsc --noEmit -p <existing-project>` | Existing local TypeScript compiler | No implicit download; verify installed compiler and tsconfig first |
| `node scripts/ci/select-tests.mjs ci` | Print generic CI-owned tests | Selection only, does not execute tests |
| `node scripts/ci/select-tests.mjs polyth-link` | Print Link-owned tests | Selection only; dedicated workflow owns this set |
| `npm run build:desktop` | Web + Electron build | Not signing, packaging or launched-app smoke |
| `npm run mobile:sync` / `npm run build:mobile` | Web build + Capacitor sync | Writes native generated files; not a native production build |
| `npm run mobile:build:android` | Web, sync and Android build command | Requires Android toolchain and current signing/config requirements |
| `npm run mobile:open:ios` / `mobile:open:android` | Open native project | Requires platform tooling; not a test |
| `npm run build:link` | Build declared Link Rust executables | Requires pinned Rust toolchain; not a native mobile adapter test |

Native release authority lives in `.github/workflows/desktop-release.yml`, `android-release.yml`, `polyth-link.yml`, and `codemagic.yaml` as applicable. Preserve their existing triggers and secret boundaries. Read them for current exact build/sign/upload steps rather than copying commands from an old chat.

## Existing CI is not “everything passed”

At the audited revision, generic CI runs npm ci, release metadata resolution, web build, selected project typechecks and the `ci` selector's tests. Its typecheck set is not every package. The selector separates Link ownership and explicitly excludes one workflow baseline test. This is an observed configuration, not an endorsement or permission to add exclusions. Check its current contents.

No root lint or root typecheck script was declared at the audit baseline. Do not infer the absence of CI from that fact. Use manifest-defined commands or the actual installed local compiler. Never let a package manager install a missing tool silently while claiming to have only run a check.

## Safe test environments

Do not hardcode a private IP, assume any port is the user's intended instance, or kill a process just because it occupies a preferred port. Establish the instance identity. Test mutation/restart/migration against isolated data and an isolated port; one data directory has one owner. Confirm fake runtimes do not call paid providers. Never point fixtures at the user's active data.

## Identity migration preparation

`node --experimental-strip-types scripts/migrate-identity.ts --help` describes the
operator-only `inspect`, `stage` and `verify` commands. See
[the migration preparation procedure](../dev/identity-migration.md) before use.
Staging requires a stopped installation, a pinned inventory digest, and a private
non-overlapping destination. It creates a scoped input capsule, not a full asset
backup or an activated control authority. No live apply or automatic restart is
exposed. Fixture tests live in `packages/tenancy/test/migrationStage.test.ts` and
`scripts/test/migrate-identity.test.ts`.
