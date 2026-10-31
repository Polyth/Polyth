import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

const androidPermissions = (manifest: string): string[] =>
  [...manifest.matchAll(/<uses-permission\s+android:name="android\.permission\.([A-Z_]+)"/g)]
    .map((match) => match[1]!)
    .sort();

test("Android declares exactly the permissions Polyth features request", async () => {
  const manifest = await read("../android/app/src/main/AndroidManifest.xml");
  assert.deepEqual(androidPermissions(manifest), [
    "CAMERA",
    "CHANGE_WIFI_MULTICAST_STATE",
    "INTERNET",
    // Capacitor's BridgeWebChromeClient requests MODIFY_AUDIO_SETTINGS with
    // RECORD_AUDIO for a WebView audio capture and denies it unless both are
    // granted; dictation and voice mode need both declared.
    "MODIFY_AUDIO_SETTINGS",
    "POST_NOTIFICATIONS",
    "RECORD_AUDIO",
  ]);
  // No broad storage, media, location or background access.
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|READ_MEDIA_|ACCESS_(FINE|COARSE)_LOCATION|ACCESS_BACKGROUND|SYSTEM_ALERT_WINDOW/);
});

test("Android capture permissions do not make camera or microphone hardware required", async () => {
  const manifest = await read("../android/app/src/main/AndroidManifest.xml");
  for (const feature of ["android.hardware.camera", "android.hardware.microphone"]) {
    assert.match(
      manifest,
      new RegExp(`<uses-feature android:name="${feature.replaceAll(".", "\\.")}" android:required="false" />`),
      feature,
    );
  }
});

test("iOS explains every protected resource the app touches", async () => {
  const plist = await read("../ios/App/App/Info.plist");
  const purpose = (key: string): string => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist);
    assert.ok(match, `${key} is declared`);
    return match[1]!;
  };
  // Native QR scanner and the WebView fallback both use the camera.
  assert.match(purpose("NSCameraUsageDescription"), /pairing QR/);
  // Dictation and voice mode both capture through WKWebView getUserMedia.
  assert.match(purpose("NSMicrophoneUsageDescription"), /dictat/);
  assert.match(purpose("NSMicrophoneUsageDescription"), /voice mode/);
  // Local discovery browses this Bonjour type on both platforms.
  assert.match(purpose("NSLocalNetworkUsageDescription"), /local network/);
  assert.match(plist, /<key>NSBonjourServices<\/key>\s*<array>\s*<string>_polyth\._udp<\/string>/);
  const [ios, android] = await Promise.all([
    read("../ios/App/App/PolythDiscoveryPlugin.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythDiscoveryPlugin.java"),
  ]);
  assert.match(ios, /type: "_polyth\._udp"/);
  assert.match(android, /SERVICE_TYPE = "_polyth\._udp\."/);
  // The document picker grants scoped access; no photo-library prompt exists.
  assert.doesNotMatch(plist, /NSPhotoLibrary(Add)?UsageDescription|NSLocation|NSContacts/);
});
