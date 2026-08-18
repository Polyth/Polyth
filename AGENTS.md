# Polyth agent rules

- Node 22 runs TS directly (type stripping). **Erasable TS only**: no enums, namespaces, parameter properties. Local imports use explicit `.ts` extension.
- Cross-package imports use workspace names (`@polyth/contracts`), resolved via npm workspaces; each package's `package.json` has `"exports": {".": "./src/index.ts"}`.
- Only `packages/backend-opencode` may talk to the opencode process/SDK. Grep gate enforced.
- Everything model-visible must be appended to the session event log before UI display.
- Tests: `node --test <file>`, plain `node:assert`.
- Run `npx tsc -p tsconfig.base.json --noEmit false --noEmit` equivalent: typecheck with `npx tsc --noEmit -p tsconfig.base.json` from repo root won't include files; instead each package typechecks via `npx tsc --noEmit` in its dir with the base config extended.
