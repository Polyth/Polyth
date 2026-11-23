import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

/** The body of one native method, up to the next method of its class. */
function method(source: string, signature: RegExp): string {
  const start = source.search(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n\s*(?:@objc func|@PluginMethod|private func|private void|private String|private List|\/\*\*)/);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

const ZONE_METHODS = ["serverZones", "reportZoneProjects", "allowServerZones", "foldServerZone", "openServerZone"];

test("a page speaks for its own server: the zone sender is the proxy this app opened, never a value it sends", async () => {
  const [swift, android] = await Promise.all([
    read("../ios/App/App/AppDelegate.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java"),
  ]);
  const sender = method(swift, /private func zoneSender\(/);
  assert.match(sender, /guard loopbackContent\(\), let sender = UserDefaults\.standard\.string\(forKey: lastConnectionKey\) else \{\s*call\.reject\("forbidden"/);
  const senderAndroid = method(android, /private String zoneSender\(/);
  assert.match(senderAndroid, /loopbackContent\(\) \? statePrefs\.getString\(LAST_CONNECTION, null\) : null/);
  assert.match(senderAndroid, /if \(sender == null\) call\.reject\("forbidden"/);

  for (const name of ZONE_METHODS) {
    assert.match(swift, new RegExp(`CAPPluginMethod\\(name: "${name}"`));
    const ios = method(swift, new RegExp(`@objc func ${name}\\(`));
    const droid = method(android, new RegExp(`public void ${name}\\(`));
    for (const body of [ios, droid]) {
      // Every method goes through the sender check, and none reads a
      // connection from the call.
      assert.match(body, /zoneSender\(call\)|zones\(call, "zones\./, name);
      assert.doesNotMatch(body, /get(?:String|Any|Object)\("connectionId"/, name);
    }
  }
  // The shared helper stamps the sender over whatever was built before it.
  assert.match(method(swift, /private func zones\(/), /params\["connectionId"\] = sender/);
  assert.match(method(android, /private void zones\(/), /params\.put\("connectionId", sender\)/);
});

test("the app asks before a server lists the others, in its own words, and allows only on Allow", async () => {
  const [swift, android] = await Promise.all([
    read("../ios/App/App/AppDelegate.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java"),
  ]);
  for (const allow of [
    method(swift, /@objc func allowServerZones\(/),
    method(android, /public void allowServerZones\(/),
  ]) {
    // The question is the app's: nothing from the call reaches it.
    assert.doesNotMatch(allow, /call\.get/);
    assert.match(allow, /Show your other servers in /);
    // One question at a time, and only for the page that asked.
    assert.match(allow, /zonePromptOpen/);
    assert.match(allow, /"busy"/);
    assert.equal([...allow.matchAll(/"zones\.allow"/g)].length, 1);
    // `zones.allow` sits inside the Allow action, after the question.
    assert.ok(allow.indexOf('"zones.allow"') > allow.indexOf('"Allow"'));
  }
});

test("a tap on a zone holds the server natively for the hub; the page learns only whether it is available", async () => {
  const [swift, android] = await Promise.all([
    read("../ios/App/App/AppDelegate.swift"),
    read("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java"),
  ]);
  for (const open of [
    method(swift, /@objc func openServerZone\(/),
    method(android, /public void openServerZone\(/),
  ]) {
    assert.match(open, /"zones\.open"/);
    assert.match(open, /pendingServerChoice = /);
    const resolved = [...open.matchAll(/call\.resolve\(([^;\n]*)/g)].map((match) => match[1]!);
    assert.equal(resolved.length, 1);
    assert.match(resolved[0]!, /"available"/);
    assert.doesNotMatch(resolved[0]!, /connectionId|\bid\b/);
  }
});
