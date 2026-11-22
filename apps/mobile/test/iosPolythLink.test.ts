import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectPath = fileURLToPath(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url));

// `netdev` (through iroh's iOS interface listing) calls the res_9_* resolver
// API, which lives in libresolv. A static Rust library cannot link it itself, so
// the App target must. Without this the archive fails with
// "Undefined symbols: _res_9_getservers" and the iOS job produces no build.
test("iOS App target links libresolv for the Polyth Link static library", async () => {
  const project = await readFile(projectPath, "utf8");
  const phaseStart = project.indexOf("isa = PBXFrameworksBuildPhase;");
  assert.notEqual(phaseStart, -1, "the App target has no Frameworks build phase");
  const files = project.slice(phaseStart, project.indexOf(");", phaseStart));
  assert.ok(files.includes("libresolv.tbd in Frameworks"), "the App target must link libresolv.tbd");

  const reference = project
    .split("\n")
    .find((line) => line.includes("/* libresolv.tbd */") && line.includes("PBXFileReference"));
  assert.ok(reference, "libresolv.tbd needs a file reference");
  assert.ok(reference.includes("path = usr/lib/libresolv.tbd;"), "libresolv.tbd must point at the SDK library");
  assert.ok(reference.includes("sourceTree = SDKROOT;"), "libresolv.tbd must resolve from the SDK");
});
