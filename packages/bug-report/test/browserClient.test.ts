import assert from "node:assert/strict";
import test from "node:test";

import { browserClient, browserName, browserPlatform, canCaptureThisTab } from "../src/browserClient.ts";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36",
  electron: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Polyth/1.2.371-nightly Chrome/142.0.7444.59 Electron/39.2.1 Safari/537.36",
};

test("the browser is named by family and major version only", () => {
  assert.equal(browserName(UA.chromeMac), "Chrome 131");
  assert.equal(browserName(UA.edgeWin), "Edge 131");
  assert.equal(browserName(UA.firefoxLinux), "Firefox 133");
  assert.equal(browserName(UA.safariMac), "Safari 18");
  assert.equal(browserName(UA.safariIphone), "Safari 18");
  assert.equal(browserName(UA.chromeIphone), "Chrome 131");
  assert.equal(browserName("curl/8.5.0"), "");
});

test("the OS family, an iPad asking for desktop pages included", () => {
  assert.equal(browserPlatform({ userAgent: UA.chromeMac }), "darwin");
  assert.equal(browserPlatform({ userAgent: UA.safariMac, maxTouchPoints: 5 }), "ios", "iPad in desktop mode");
  assert.equal(browserPlatform({ userAgent: UA.edgeWin }), "win32");
  assert.equal(browserPlatform({ userAgent: UA.firefoxLinux }), "linux");
  assert.equal(browserPlatform({ userAgent: UA.chromeAndroid }), "android");
  assert.equal(browserPlatform({ userAgent: UA.safariIphone }), "ios");
  assert.equal(browserPlatform({ userAgent: "", uaPlatform: "macOS" }), "darwin");
  assert.equal(browserPlatform({ userAgent: "" }), "unknown");
});

test("the language tag falls back to en", () => {
  assert.equal(browserClient({ userAgent: UA.chromeMac, language: "uk-UA" }).locale, "uk-UA");
  assert.equal(browserClient({ userAgent: UA.chromeMac, language: "x" }).locale, "en");
  assert.deepEqual(browserClient({ userAgent: UA.safariIphone, language: "uk" }), { platform: "ios", browser: "Safari 18", locale: "uk" });
});

test("this tab is captured only where the browser offers just this tab", () => {
  const can = (userAgent: string, extra: { brands?: string[]; maxTouchPoints?: number; hasDisplayMedia?: boolean } = {}) =>
    canCaptureThisTab({ userAgent, hasDisplayMedia: true, ...extra });
  assert.equal(can(UA.chromeMac, { brands: ["Chromium", "Google Chrome"] }), true);
  assert.equal(can(UA.edgeWin), true);
  assert.equal(can(UA.chromeMac, { hasDisplayMedia: false }), false);
  assert.equal(can(UA.firefoxLinux), false, "Firefox offers only windows and screens");
  assert.equal(can(UA.safariMac), false);
  assert.equal(can(UA.chromeAndroid), false);
  assert.equal(can(UA.chromeIphone), false);
  assert.equal(can(UA.electron), false, "the desktop shell captures its own window");
});
