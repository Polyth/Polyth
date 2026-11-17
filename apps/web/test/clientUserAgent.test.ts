// The shell token tells Polyth's own apps apart in the account device list.
// A phone app and phone Safari ship the same WebKit agent, and an Electron
// window reports a plain Chrome agent, so nothing else can.
import test from "node:test";
import assert from "node:assert/strict";

const { browserOf, isPhoneAgent, osOf, shellOf } = await import("../src/clientUserAgent.ts");

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const IPHONE_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 PolythMobile";
const ANDROID_APP = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 PolythMobile";

test("a browser user agent carries no shell token", () => {
  assert.equal(shellOf(CHROME_MAC), null);
  assert.equal(shellOf(""), null);
  // The mobile app and phone Safari are the same agent apart from the token.
  assert.equal(shellOf(IPHONE_APP.replace(" PolythMobile", "")), null);
});

test("the desktop app names itself with its version", () => {
  assert.deepEqual(shellOf(`${CHROME_MAC} PolythDesktop/1.2.0`), { kind: "desktop", version: "1.2.0" });
  // A build without a baked version still says which shell it is.
  assert.deepEqual(shellOf(`${CHROME_MAC} PolythDesktop`), { kind: "desktop", version: null });
});

test("a workstation build keeps its own shell name", () => {
  assert.deepEqual(shellOf(`${CHROME_MAC} PolythDesktop-Workstation/1.2.0`), { kind: "desktop-workstation", version: "1.2.0" });
});

test("the phone app is recognised on iPhone and Android", () => {
  assert.deepEqual(shellOf(IPHONE_APP), { kind: "mobile", version: null });
  assert.deepEqual(shellOf(ANDROID_APP), { kind: "mobile", version: null });
});

test("a token inside another word is not a shell", () => {
  assert.equal(shellOf(`${CHROME_MAC} NotPolythMobile`), null);
  assert.equal(shellOf(`${CHROME_MAC} PolythMobileSafari`), null);
});

test("browser and system still read from a plain agent", () => {
  assert.equal(browserOf(CHROME_MAC), "chrome");
  assert.equal(osOf(CHROME_MAC), "macos");
  assert.equal(browserOf(IPHONE_APP), null); // a WebView has no Safari token
  assert.equal(osOf(IPHONE_APP), "ios");
});

test("an iPad's Macintosh agent is a phone, not a Mac", () => {
  const ipad = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 PolythMobile";
  assert.equal(osOf(ipad), "ios");
  assert.equal(isPhoneAgent(ipad), true);
});

test("the phone icon follows the shell, then the agent", () => {
  assert.equal(isPhoneAgent(IPHONE_APP), true);
  assert.equal(isPhoneAgent(CHROME_MAC), false);
  assert.equal(isPhoneAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"), true);
  // A tablet reports no "Mobile" field and is not a phone.
  assert.equal(isPhoneAgent("Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"), false);
});
