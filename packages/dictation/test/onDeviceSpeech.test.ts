import { test } from "node:test";
import assert from "node:assert/strict";
import {
  embeddedWebView,
  installOnDeviceSpeech,
  onDeviceSpeechAvailability,
} from "@polyth/dictation";

// Android System WebView 157 on Android 13 as the Polyth app reports it
// (Capacitor appends "PolythMobile").
const ANDROID_WEBVIEW_UA = "Mozilla/5.0 (Linux; Android 13; 21051182G Build/TKQ1.221114.001; wv) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8103.50 Safari/537.36 PolythMobile";
// The legacy WebView form without the `wv` token.
const ANDROID_LEGACY_WEBVIEW_UA = "Mozilla/5.0 (Linux; Android 9; Pixel 3) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const ANDROID_CHROME_UA = "Mozilla/5.0 (Linux; Android 13; K) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const IOS_SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface Calls { available: unknown[]; install: unknown[] }

function fakeWindow(userAgent: string | undefined, results: { available?: string; install?: boolean } = {}) {
  const calls: Calls = { available: [], install: [] };
  class FakeRecognition {
    static available(options: unknown): Promise<string> {
      calls.available.push(options);
      return Promise.resolve(results.available ?? "available");
    }
    static install(options: unknown): Promise<boolean> {
      calls.install.push(options);
      return Promise.resolve(results.install ?? true);
    }
  }
  const navigator = userAgent === undefined ? undefined : { userAgent };
  return { win: { SpeechRecognition: FakeRecognition, navigator }, calls };
}

test("embeddedWebView recognizes Android WebView user agents only", () => {
  assert.equal(embeddedWebView({ navigator: { userAgent: ANDROID_WEBVIEW_UA } }), true);
  assert.equal(embeddedWebView({ navigator: { userAgent: ANDROID_LEGACY_WEBVIEW_UA } }), true);
  assert.equal(embeddedWebView({ navigator: { userAgent: ANDROID_CHROME_UA } }), false);
  assert.equal(embeddedWebView({ navigator: { userAgent: DESKTOP_CHROME_UA } }), false);
  assert.equal(embeddedWebView({ navigator: { userAgent: IOS_SAFARI_UA } }), false);
  assert.equal(embeddedWebView(undefined), false);
  assert.equal(embeddedWebView(null), false);
  assert.equal(embeddedWebView({}), false);
  assert.equal(embeddedWebView({ navigator: {} }), false);
  assert.equal(embeddedWebView({ navigator: { userAgent: 42 } }), false);
});

test("Android WebView reports unavailable without touching SpeechRecognition.available", async () => {
  const { win, calls } = fakeWindow(ANDROID_WEBVIEW_UA);
  assert.equal(await onDeviceSpeechAvailability(win, "en-US"), "unavailable");
  assert.deepEqual(calls.available, []);

  // A constructor whose statics throw synchronously would crash the caller if
  // the guard were missing; the guard must short-circuit before any access.
  class Throwing {
    static available(): never { throw new Error("bad IPC"); }
    static install(): never { throw new Error("bad IPC"); }
  }
  const throwing = { webkitSpeechRecognition: Throwing, navigator: { userAgent: ANDROID_LEGACY_WEBVIEW_UA } };
  assert.equal(await onDeviceSpeechAvailability(throwing, "en-US"), "unavailable");
  assert.equal(await installOnDeviceSpeech(throwing, "en-US"), false);
});

test("installOnDeviceSpeech is false in Android WebView and never calls install", async () => {
  const { win, calls } = fakeWindow(ANDROID_WEBVIEW_UA);
  assert.equal(await installOnDeviceSpeech(win, "en-US"), false);
  assert.deepEqual(calls.install, []);
});

test("normal Chrome still asks available() and maps its answer", async () => {
  for (const [answer, expected] of [
    ["available", "available"],
    ["downloadable", "downloadable"],
    ["downloading", "downloading"],
    ["unavailable", "unavailable"],
    ["something-new", "unavailable"],
  ] as const) {
    const { win, calls } = fakeWindow(ANDROID_CHROME_UA, { available: answer });
    assert.equal(await onDeviceSpeechAvailability(win, "uk-UA"), expected);
    assert.deepEqual(calls.available, [{ langs: ["uk-UA"], processLocally: true }]);
  }
  const desktop = fakeWindow(DESKTOP_CHROME_UA);
  assert.equal(await onDeviceSpeechAvailability(desktop.win, "en-US"), "available");
  assert.equal(desktop.calls.available.length, 1);
  assert.equal(await installOnDeviceSpeech(desktop.win, "en-US"), true);
  assert.deepEqual(desktop.calls.install, [{ langs: ["en-US"], processLocally: true }]);
});

test("on-device helpers stay safe without a window or user agent", async () => {
  assert.equal(await onDeviceSpeechAvailability(undefined, "en-US"), "unavailable");
  assert.equal(await installOnDeviceSpeech(undefined, "en-US"), false);
  assert.equal(await onDeviceSpeechAvailability({}, "en-US"), "unavailable");

  // No navigator: the API itself still decides, as before.
  const bare = fakeWindow(undefined);
  assert.equal(await onDeviceSpeechAvailability(bare.win, "en-US"), "available");
  assert.equal(bare.calls.available.length, 1);
  assert.equal(await onDeviceSpeechAvailability(bare.win, "auto"), "unavailable");
  assert.equal(bare.calls.available.length, 1);
});
