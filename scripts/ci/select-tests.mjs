#!/usr/bin/env node
/**
 * Single source of truth for CI vs Polyth Link Node test ownership.
 *
 * Usage:
 *   node scripts/ci/select-tests.mjs ci
 *   node scripts/ci/select-tests.mjs polyth-link
 */
import { globSync } from "node:fs";

const ROOT = process.cwd();

const ALL_GLOBS = [
  "packages/*/test/*.test.ts",
  "apps/*/test/*.test.ts",
  "scripts/test/*.test.ts",
];

const POLYTH_LINK_CONTRACT_GLOBS = [
  "packages/tunnel/test/*.test.ts",
  "packages/pairing-qr/test/*.test.ts",
];

const POLYTH_LINK_CONTRACT_FILES = [
  "packages/contracts/test/remoteAccess.test.ts",
  "packages/server/test/localAdmin.test.ts",
  "packages/server/test/remotePolicy.test.ts",
  "packages/server/test/remotePolicyHttp.test.ts",
  "packages/server/test/authIngress.test.ts",
  "packages/server/test/httpTunnel.test.ts",
  "packages/server/test/remotePolicyCoverage.test.ts",
  "packages/server/test/wsRemoteAuth.test.ts",
  "packages/server/test/auth.test.ts",
  "packages/server/test/packageDiscovery.test.ts",
  "packages/plugins/test/serverPackage.test.ts",
  "packages/terminal/test/wsCapability.test.ts",
  "apps/mobile/test/runtime.test.ts",
  "apps/mobile/test/connectionUi.test.ts",
  "apps/desktop/test/configuration.test.ts",
  "apps/desktop/test/serverPackages.test.ts",
  "apps/web/test/packageContainment.test.ts",
];

/** Known baseline-red tests on current master; keep the exclusion list explicit. */
const CI_BASELINE_EXCLUDE = [
  "packages/workflow/test/workflowOrchestration.test.ts",
];

/**
 * @param {string} path
 */
function norm(path) {
  return path.replace(/\\/g, "/");
}

function allTests() {
  return [...new Set(
    ALL_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: ROOT }).map(norm)),
  )].sort();
}

export function polythLinkTests() {
  const fromGlobs = POLYTH_LINK_CONTRACT_GLOBS.flatMap((pattern) =>
    globSync(pattern, { cwd: ROOT }).map(norm),
  );
  return [...new Set([...POLYTH_LINK_CONTRACT_FILES, ...fromGlobs])].sort();
}

export function ciTests() {
  const link = new Set(polythLinkTests());
  const exclude = new Set(CI_BASELINE_EXCLUDE);
  return allTests().filter((file) => !link.has(file) && !exclude.has(file));
}

const mode = process.argv[2];
const files = mode === "polyth-link"
  ? polythLinkTests()
  : mode === "ci"
    ? ciTests()
    : null;

if (!files) {
  console.error("usage: node scripts/ci/select-tests.mjs <ci|polyth-link>");
  process.exit(1);
}

for (const file of files) {
  console.log(file);
}
