#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const TYPECHECK_PROJECTS = [
  "packages/contracts",
  "packages/plugins",
  "packages/server",
  "packages/control-plane",
  "packages/identity",
  "packages/tenancy",
  "packages/secure-safe",
  "packages/pairing-qr",
  "packages/tunnel",
  "packages/terminal",
  "packages/markets",
  "packages/peak-pricing",
  "packages/web-search",
  "packages/custom-titles",
  "packages/cli",
  // Workspace widgets are TypeScript props contracts at runtime: a missing
  // required JSX prop reaches the browser as an undefined value and crashes the
  // surface instead of failing a build.
  "packages/judgment",
  "packages/judgment-jev",
  "packages/judgment-local",
  "apps/mobile",
];

// Keep the required merge/release gate deterministic. The repository contains
// broader environment-heavy suites that are intentionally not treated as a
// blocking baseline until they are independently made green.
const QUALITY_TEST_FILES = [
  "scripts/test/release-version.test.ts",
  "scripts/test/bump-version.test.ts",
  "scripts/test/releaseQuality.test.ts",
  "scripts/test/release-quality-gates.test.ts",
  "scripts/test/agentBeta.test.ts",
  "apps/desktop/test/configuration.test.ts",
  "apps/web/test/streamIngestion.test.ts",
  "apps/web/test/sync.test.ts",
  "packages/server/test/streamPersistence.test.ts",
  "packages/server/test/streamObservationPersistence.test.ts",
  "packages/server/test/wsGapFill.test.ts",
  "packages/server/test/wsNotifications.test.ts",
  "packages/server/test/canonicalAuth.test.ts",
  "packages/server/test/runtimeSecurityBinding.test.ts",
  "packages/server/test/debugAgentAccess.test.ts",
  "packages/server/test/routeRegistry.test.ts",
  "packages/server/test/customTitles.test.ts",
  "packages/harness-runtime/test/agentBeta.test.ts",
  "packages/backend-opencode/test/delegation.test.ts",
  "packages/custom-titles/test/title.test.ts",
  "packages/backend-commandcode/test/capabilities.test.ts",
  "packages/files/test/agentBeta.test.ts",
  "packages/git/test/agentBeta.test.ts",
  "packages/terminal/test/agentBeta.test.ts",
  "packages/git/test/repositoryRoute.test.ts",
  "packages/git/test/workspaceIsolation.test.ts",
  "packages/judgment/test/runtime.test.ts",
  "packages/judgment/test/server.test.ts",
  "packages/judgment/test/settings.test.ts",
  "packages/judgment/test/boundaries.test.ts",
  "packages/judgment/test/agentEngine.test.ts",
  "packages/judgment-jev/test/adapter.test.ts",
  "packages/judgment-jev/test/server.test.ts",
  "packages/judgment-local/test/engine.test.ts",
  "packages/web-search/test/agentTool.test.ts",
  "packages/web-search/test/package.test.ts",
  "packages/web-search/test/providers.test.ts",
  "packages/web-search/test/routes.test.ts",
  "packages/web-search/test/runtime.test.ts",
  "packages/peak-pricing/test/indicator.test.ts",
  "packages/peak-pricing/test/indicatorMounted.test.ts",
  "packages/peak-pricing/test/schedule.test.ts",
  "packages/web-search/test/scheduler.test.ts",
  "packages/web-search/test/settings.test.ts",
  "packages/web-search/test/settingsStore.test.ts",
  "apps/desktop/test/serverPackages.test.ts",
  "packages/cli/test/cli.test.ts",
  "packages/identity/test/accessTokens.test.ts",
  "packages/identity/test/cliHttp.test.ts",
  "packages/server/test/cliAccess.test.ts",
  "apps/desktop/test/cliInstall.test.ts",
];

function fail(command, result) {
  const suffix = result.error ? `: ${result.error.message}` : "";
  console.error(`release-quality: failed: ${command}${suffix}`);
  process.exit(typeof result.status === "number" && result.status > 0 ? result.status : 1);
}

function run(command, args, options = {}) {
  const display = [command, ...args].join(" ");
  console.log(`\n==> ${display}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error || result.status !== 0) fail(display, result);
}

// Removable feature packages may be deleted from a checkout. Their gate
// entries go with them; a missing file inside a package that still exists is
// a real failure and is left for tsc/node to report.
function presentPackages(paths) {
  return paths.filter((path) => {
    const id = /^packages\/([^/]+)/.exec(path)?.[1];
    if (!id || existsSync(join(ROOT, "packages", id, "package.json"))) return true;
    console.log(`release-quality: skipping ${path} (package ${id} is not installed)`);
    return false;
  });
}
const typecheckProjects = presentPackages(TYPECHECK_PROJECTS);
const qualityTestFiles = presentPackages(QUALITY_TEST_FILES);

run(process.execPath, ["scripts/release-version.mjs"]);
run(npm, ["run", "build:web"]);

for (const project of typecheckProjects) {
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    project,
  ]);
}

run(process.execPath, [
  "--experimental-strip-types",
  "--test",
  "--test-force-exit",
  ...qualityTestFiles,
]);

// Signed/mobile release paths rely on the Link core helper existing even though
// the full Rust suite is owned by the dedicated CI Rust job.
run("cargo", ["build", "-p", "polyth-link-core", "--bin", "polyth-link-ws-echo"]);

console.log(`\nrelease-quality: passed (${typecheckProjects.length} typecheck projects, ${qualityTestFiles.length} contract test files)`);
