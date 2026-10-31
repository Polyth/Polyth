import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

/** The body of one native method, up to the next method of its class. */
function method(source: string, signature: RegExp): string {
  const start = source.search(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n\s*(?:@objc func|@PluginMethod|private func|private void|private List)/);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

test("the server menu is native: the page sends only its button and gets back only the kind of choice", async () => {
  const [swift, android] = await Promise.all([
    read("../ios/App/App/AppDelegate.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java"),
  ]);
  assert.match(swift, /CAPPluginMethod\(name: "presentServerMenu"/);
  assert.match(swift, /CAPPluginMethod\(name: "consumeServerChoice"/);

  // Only the page of the proxy this app opened (or the hub) may ask for it.
  const present = method(swift, /@objc func presentServerMenu\(/);
  assert.match(present, /guard loopbackContent\(\) \|\| isBundledContent\(\) else \{\s*call\.reject\("forbidden"/);
  const presentAndroid = method(android, /public void presentServerMenu\(/);
  assert.match(presentAndroid, /!ownsCurrentProxy\(getContext\(\), url\) && !PolythLinkOrigin\.isBundledOrigin\(url\)/);

  // The page learns the kind of choice, never a server: the picked id stays
  // native until the bundled hub takes it.
  for (const show of [
    method(swift, /private func showServerMenu\(/),
    method(android, /private void showServerMenu\(/),
  ]) {
    const resolved = [...show.matchAll(/resolve\(([^;\n]*)/g)].map((match) => match[1]!);
    assert.equal(resolved.length, 4);
    for (const payload of resolved) {
      assert.match(payload, /"action"/);
      assert.doesNotMatch(payload, /connection|id\b|label/i);
    }
  }

  // The choice is handed out only to the bundled hub, once, and goes stale.
  const consume = method(swift, /@objc func consumeServerChoice\(/);
  assert.match(consume, /guard trusted\(call\) else \{ return \}/);
  assert.match(consume, /self\.pendingServerChoice = nil/);
  assert.match(consume, /serverChoiceLifetime/);
  const consumeAndroid = method(android, /public void consumeServerChoice\(/);
  assert.match(consumeAndroid, /if \(!trusted\(call\)\) return;/);
  assert.match(consumeAndroid, /pendingServerChoice = null;/);
  assert.match(consumeAndroid, /SERVER_CHOICE_LIFETIME_MS/);
});

test("the native menus offer every paired server and Add server, and close quickly", async () => {
  const [swift, android] = await Promise.all([
    read("../ios/App/App/AppDelegate.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythServerMenu.java"),
  ]);
  assert.match(swift, /title: "Add server"/);
  assert.match(swift, /finish\(\.add\)/);
  assert.match(swift, /UIViewPropertyAnimator\(duration: 0\.34, dampingRatio: 0\.84\)/);
  assert.match(swift, /UIAccessibility\.isReduceMotionEnabled/);
  // Started before the first frame, so the panel never shows at rest first.
  assert.match(swift, /override func viewWillAppear\(_ animated: Bool\) \{\s*super\.viewWillAppear\(animated\)\s*guard !opened/);

  assert.match(android, /row\("Add server"/);
  assert.match(android, /finish\("add", null\)/);
  assert.match(android, /popup\.setAnimationStyle\(0\)/);
  assert.match(android, /\.setDuration\(130\)/);
  // API 28 call on a minSdk 24 app stays guarded.
  assert.match(android, /if \(android\.os\.Build\.VERSION\.SDK_INT >= 28\) label\.setAccessibilityHeading\(true\)/);
});

test("the hub opens a server picked from the menu behind the veil, and leads with pairing for Add server", async () => {
  const [runtime, screen] = await Promise.all([read("../src/runtime.ts"), read("../src/ConnectionScreen.tsx")]);
  // Only a hub opened for a server choice takes one; an OS deep link wins.
  assert.match(runtime, /const switchTo = selectServer && !addServer && !opened\s*\? await consumeNativeServerChoice\(\)/);
  // A menu that cannot show (an older app, a development host) falls back to the hub list.
  assert.match(runtime, /if \(action === "current" \|\| action === "cancel"\) return;\s*await returnToMobileConnectionHub\(undefined, action === "add" \? \{ addServer: true \} : \{ selectServer: true \}\)/);

  assert.match(screen, /connection\.id === launch\.switchTo && !connection\.revoked && connection\.hasSecureIdentity/);
  assert.match(screen, /\|\| switchConnectStarted\.current\s*\|\| Boolean\(switchTarget\)/);
  assert.match(screen, /switchConnectStarted\.current = true;\s*void reconnectTrusted\(switchTarget\);/);
  assert.match(screen, /pairSectionRef\.current\?\.scrollIntoView/);
});
