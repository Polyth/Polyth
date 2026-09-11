import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("late native listener handles remove themselves after bridge disposal", async () => {
  const source = await readFile(new URL("../src/nativeBridge.ts", import.meta.url), "utf8");

  assert.match(source, /generation !== installationGeneration/);
  assert.match(source, /void handle\.remove\(\);/);
  assert.match(source, /installationGeneration \+= 1;[\s\S]*?installed = false;/);
  assert.doesNotMatch(source, /\.then\(\(handle\) => disposers\.push/);
});

test("native haptics are centralized behind a local-action adapter", async () => {
  const [bridge, connection, haptics] = await Promise.all([
    readFile(new URL("../src/nativeBridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ConnectionScreen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/haptics.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(bridge, /@capacitor\/haptics/);
  assert.doesNotMatch(connection, /@capacitor\/haptics/);
  assert.match(bridge, /nativeTapFeedback\(\)/);
  assert.match(connection, /nativeTapFeedback\(\)/);
  assert.match(haptics, /Haptics\.selectionChanged/);
  assert.match(haptics, /Haptics\.impact/);
  assert.match(haptics, /Haptics\.notification/);
  assert.match(bridge, /NATIVE_HAPTIC_EVENT/);
});

test("Android back keeps one enabled dispatcher and opts into predictive back", async () => {
  const [config, manifest] = await Promise.all([
    readFile(new URL("../capacitor.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
  ]);

  assert.match(config, /disableBackButtonHandler:\s*false/);
  assert.match(manifest, /android:enableOnBackInvokedCallback="true"/);
});
