import assert from "node:assert/strict";
import test from "node:test";
import { withoutForeignSessionCookies } from "../src/sessionCookieGuard.ts";

const app = "http://127.0.0.1:4400";
const jar = "polyth_auth_0123456789abcdef=" + "a".repeat(64) + "; polyth_auth_0123456789abcdef_csrf=" + "b".repeat(64) + "; theme=dark";

test("the app's own server keeps every cookie, over HTTP and WebSocket", () => {
  assert.equal(withoutForeignSessionCookies(jar, `${app}/api/spaces`, app), null);
  assert.equal(withoutForeignSessionCookies(jar, "ws://127.0.0.1:4400/ws", app), null);
});

test("another local port never receives Polyth's session or CSRF cookie", () => {
  assert.equal(withoutForeignSessionCookies(jar, "http://127.0.0.1:5173/logo.png", app), "theme=dark");
  assert.equal(withoutForeignSessionCookies(jar, "ws://127.0.0.1:9229/", app), "theme=dark");
  assert.equal(withoutForeignSessionCookies("__Host-polyth_auth_x=1", "https://127.0.0.1:8443/", app), "");
  // Nothing of Polyth's to remove: the header is left alone.
  assert.equal(withoutForeignSessionCookies("theme=dark", "http://127.0.0.1:5173/", app), null);
  assert.equal(withoutForeignSessionCookies(jar, "not a url", app), null);
});
