// Polyth Desktop's window names its shell in the user agent, which is what the
// account device list renders: without it the app signs in as "Chrome on macOS".
import assert from "node:assert/strict";
import test from "node:test";
import { desktopUserAgent } from "../src/userAgent.ts";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

test("the window agent keeps the browser agent and appends the shell token", () => {
  assert.equal(desktopUserAgent(CHROME_MAC, { version: "1.2.0" }), `${CHROME_MAC} PolythDesktop/1.2.0`);
});

test("a workstation build names its edition", () => {
  assert.equal(desktopUserAgent(CHROME_MAC, { version: "1.2.0", workstation: true }), `${CHROME_MAC} PolythDesktop-Workstation/1.2.0`);
});

test("setting the agent twice never stacks tokens", () => {
  const once = desktopUserAgent(CHROME_MAC, { version: "1.2.0" });
  assert.equal(desktopUserAgent(once, { version: "1.2.0" }), once);
  const workstation = desktopUserAgent(CHROME_MAC, { version: "1.2.0", workstation: true });
  assert.equal(desktopUserAgent(workstation, { version: "1.2.0", workstation: true }), workstation);
  // A token left over from another shape is replaced by the current one.
  assert.equal(
    desktopUserAgent(`${CHROME_MAC} PolythDesktop/1.1.0`, { version: "1.2.0", workstation: true }),
    `${CHROME_MAC} PolythDesktop-Workstation/1.2.0`,
  );
});

test("a version that cannot be a token is dropped, never injected", () => {
  assert.equal(desktopUserAgent(CHROME_MAC, { version: "1.2.0 (beta)" }), `${CHROME_MAC} PolythDesktop/1.2.0beta`);
  assert.equal(desktopUserAgent(CHROME_MAC, { version: "  " }), `${CHROME_MAC} PolythDesktop`);
});

test("an empty base agent is just the token", () => {
  assert.equal(desktopUserAgent("", { version: "1.2.0" }), "PolythDesktop/1.2.0");
  assert.equal(desktopUserAgent("   ", { version: "1.2.0" }), "PolythDesktop/1.2.0");
});

test("the main window sets its agent before the first page loads", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /webContents\.setUserAgent\(desktopUserAgent\(/);
  assert.match(main, /version: app\.getVersion\(\)/);
  assert.match(main, /workstation,\n/);
});
