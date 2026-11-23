// The rules every native browser page lives by on this computer: where its
// profile may sit, what it may load before the browser's own guard is asked,
// and the place a window may give it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confinedProfileDir, parseViewRect, plainChromeUserAgent, schemeVerdict } from "../src/nativeWebViewPolicy.ts";

test("a profile directory must lie inside the data directory, without a symlink out", (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-nwv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(data);
  mkdirSync(outside);
  const dir = confinedProfileDir(data, join(data, "packages", "browser", "profiles", "a"));
  assert.equal(dir, join(data, "packages", "browser", "profiles", "a"));
  assert.throws(() => confinedProfileDir(data, data), /invalid-request/);
  assert.throws(() => confinedProfileDir(data, join(data, "..", "outside")), /invalid-request/);
  assert.throws(() => confinedProfileDir(data, "relative/profile"), /invalid-request/);
  symlinkSync(outside, join(data, "escape"));
  assert.throws(() => confinedProfileDir(data, join(data, "escape", "profile")), /invalid-request/);
});

test("http(s) and sockets go to the guard; only harmless local schemes load unasked", () => {
  assert.equal(schemeVerdict("https://example.com/", true), "guard");
  assert.equal(schemeVerdict("http://127.0.0.1:3000/x", false), "guard");
  assert.equal(schemeVerdict("wss://example.com/socket", false), "guard");
  assert.equal(schemeVerdict("about:blank", true), "allow");
  assert.equal(schemeVerdict("data:image/png;base64,AAAA", false), "allow");
  assert.equal(schemeVerdict("blob:https://example.com/uuid", false), "allow");
  // A page cannot become a local document, a data page or an app scheme.
  assert.equal(schemeVerdict("data:text/html,<h1>hi</h1>", true), "deny");
  assert.equal(schemeVerdict("file:///etc/passwd", true), "deny");
  assert.equal(schemeVerdict("file:///etc/passwd", false), "deny");
  assert.equal(schemeVerdict("chrome://settings", true), "deny");
  assert.equal(schemeVerdict("polyth://open", true), "deny");
  assert.equal(schemeVerdict("not a url", false), "deny");
});

test("a place is a finite rectangle of bounded size, or null to park", () => {
  assert.equal(parseViewRect(null), null);
  assert.deepEqual(parseViewRect({ x: 10.4, y: 20.6, width: 800.2, height: 600 }), { x: 10, y: 21, width: 800, height: 600 });
  for (const bad of [undefined, "x", [], { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: Number.NaN, height: 10 },
    { x: 0, y: 0, width: 100_000, height: 10 }, { x: 0, y: 0, width: 10 }]) {
    assert.throws(() => parseViewRect(bad), /invalid-request/);
  }
});

test("pages present a plain Chrome user agent: sign-in pages refuse embedded apps", () => {
  const base = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Polyth/1.2.0 Chrome/140.0.7339.80 Electron/45.4.1 Safari/537.36";
  assert.equal(plainChromeUserAgent(base, "Polyth"),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36");
});
