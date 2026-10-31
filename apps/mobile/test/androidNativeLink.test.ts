import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("Android packages the Polyth Link cdylib with a resolvable SONAME", async () => {
  const [cmake, buildScript, rust] = await Promise.all([
    read("../android/app/src/main/cpp/CMakeLists.txt"),
    read("../../../crates/polyth-link-uniffi/build.rs"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythLinkRust.java"),
  ]);

  // Cargo emits no SONAME for cdylibs. Without one the linker records the
  // build-host jniLibs path in DT_NEEDED and loadLibrary fails on-device.
  assert.match(buildScript,
    /rustc-cdylib-link-arg=-Wl,-soname,libpolyth_link_uniffi\.so/);
  assert.match(cmake, /IMPORTED_SONAME\s+"libpolyth_link_uniffi\.so"/);

  // A native load failure must degrade to the documented unavailable state
  // instead of escaping on a worker thread and ending the process.
  assert.match(rust, /catch \(Throwable error\)/);
  assert.match(rust, /static boolean isAvailable\(\)/);
});
