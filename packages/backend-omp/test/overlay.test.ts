import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { test } from "node:test";
import { createOmpProfile, OMP_CONFIG_OVERLAY, withPolythOverlay } from "../src/serverEntry.ts";

test("OMP launches with Polyth's overlay that turns background jobs off", () => {
  const overlay = readFileSync(OMP_CONFIG_OVERLAY, "utf8");
  // Results of async jobs arrive in a follow-up turn no ACP client sees.
  assert.match(overlay, /^async:\n {2}enabled: false$/m);
  assert.match(overlay, /^bash:\n {2}autoBackground:\n {4}enabled: false$/m);
  assert.match(overlay, /^eval:\n {2}autoBackground:\n {4}enabled: false$/m);

  const profile = createOmpProfile();
  assert.equal(profile.env?.PI_CONFIG_FILES?.split(delimiter).at(-1), OMP_CONFIG_OVERLAY);
});

test("Polyth's overlay goes last in an existing PI_CONFIG_FILES list, once", () => {
  const env = withPolythOverlay({ PI_CONFIG_FILES: ["/a.yml", OMP_CONFIG_OVERLAY, "/b.yml"].join(delimiter) });
  assert.deepEqual(env.PI_CONFIG_FILES?.split(delimiter), ["/a.yml", "/b.yml", OMP_CONFIG_OVERLAY]);
  assert.equal(withPolythOverlay({}).PI_CONFIG_FILES, OMP_CONFIG_OVERLAY);
});
