# Polyth agent rules

- Node 22 runs TS directly (type stripping). **Erasable TS only**: no enums, namespaces, parameter properties. Local imports use explicit `.ts` extension.
- OpenCode CLI (`opencode`, v1.18.x) and polyth (`polyth` from `@polyth/web`) are both required for feature-parity work. Put `$HOME/.opencode/bin` and the npm global bin (often `$HOME/.local/bin`) on `PATH`. Install: `curl -fsSL https://opencode.ai/install | bash` and `npm i -g @polyth/web`.
- Cross-package imports use workspace names (`@polyth/contracts`), resolved via npm workspaces; each package's `package.json` has `"exports": {".": "./src/index.ts"}`.
- Only `packages/backend-opencode` may talk to the opencode process/SDK. Grep gate enforced.
- Everything model-visible must be appended to the session event log before UI display.
- Tests: `node --test <file>`, plain `node:assert`.
- Run `npx tsc -p tsconfig.base.json --noEmit false --noEmit` equivalent: typecheck with `npx tsc --noEmit -p tsconfig.base.json` from repo root won't include files; instead each package typechecks via `npx tsc --noEmit` in its dir with the base config extended.
