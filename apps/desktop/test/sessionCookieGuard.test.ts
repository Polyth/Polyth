import assert from "node:assert/strict";
import test from "node:test";
import { withoutForeignSessionCookies } from "../src/sessionCookieGuard.ts";

const local = "http://127.0.0.1:4400";
const ownName = "polyth_auth_0123456789abcdef";
const app = { local: { url: local, cookieName: ownName } };
const jar = `${ownName}=${"a".repeat(64)}; ${ownName}_csrf=${"b".repeat(64)}; theme=dark`;

test("the app's own server keeps every cookie, over HTTP and WebSocket", () => {
  assert.equal(withoutForeignSessionCookies(jar, `${local}/api/spaces`, app), null);
  assert.equal(withoutForeignSessionCookies(jar, "ws://127.0.0.1:4400/ws", app), null);
});

test("another local port never receives Polyth's session or CSRF cookie", () => {
  for (const url of ["http://127.0.0.1:5173/", "http://localhost:4400/", "ws://127.0.0.1:9000/x", "https://example.com/a.png"]) {
    assert.equal(withoutForeignSessionCookies(jar, url, app), "theme=dark", url);
  }
  assert.equal(withoutForeignSessionCookies(`${ownName}=x`, "http://127.0.0.1:5173/", app), "");
  assert.equal(withoutForeignSessionCookies("theme=dark", "http://127.0.0.1:5173/", app), null);
  assert.equal(withoutForeignSessionCookies(jar, "not a url", app), null);
});

const proxyCookie = "polyth_link_proxy_41234=" + "c".repeat(64);

test("a Link proxy's session goes only to that proxy's port", () => {
  const both = `${proxyCookie}; theme=dark`;
  assert.equal(withoutForeignSessionCookies(both, "http://127.0.0.1:41234/api/health", {}), null);
  assert.equal(withoutForeignSessionCookies(both, "ws://127.0.0.1:41234/ws", {}), null);
  assert.equal(withoutForeignSessionCookies(both, "http://127.0.0.1:4400/api/health", app), "theme=dark");
  assert.equal(withoutForeignSessionCookies(both, "http://127.0.0.1:5173/logo.png", app), "theme=dark");
  assert.equal(withoutForeignSessionCookies(both, "http://localhost:41234/", app), "theme=dark");
});

test("with no server of its own, nothing local receives this computer's session", () => {
  assert.equal(withoutForeignSessionCookies(jar, "http://127.0.0.1:41234/api/health", {}), "theme=dark");
});

const tunnel = "http://127.0.0.1:8080";
const theirName = "polyth_auth_fedcba9876543210";
const shared = `${ownName}=${"a".repeat(64)}; ${theirName}=${"d".repeat(64)}; ${theirName}_csrf=${"e".repeat(64)}; theme=dark`;
const withTunnel = { ...app, addresses: [tunnel] };

test("a server on this computer's host (an SSH tunnel) never receives this computer's session", () => {
  assert.equal(
    withoutForeignSessionCookies(shared, `${tunnel}/api/health`, withTunnel),
    `${theirName}=${"d".repeat(64)}; ${theirName}_csrf=${"e".repeat(64)}; theme=dark`,
  );
});

test("this computer's server receives none of another server's sessions", () => {
  assert.equal(withoutForeignSessionCookies(shared, `${local}/api/health`, withTunnel), `${ownName}=${"a".repeat(64)}; theme=dark`);
});

test("a server opened by address keeps its own session on its own host", () => {
  const address = { ...app, addresses: ["https://polyth.example.com"] };
  const secure = `__Host-${theirName}=${"d".repeat(64)}; theme=dark`;
  assert.equal(withoutForeignSessionCookies(secure, "https://polyth.example.com/api/health", address), null);
  assert.equal(withoutForeignSessionCookies(secure, "https://other.example.com/", address), "theme=dark");
});

test("before this computer's server has named its session, its own host still gets its setup cookies", () => {
  const setup = { local: { url: local, cookieName: null } };
  assert.equal(withoutForeignSessionCookies(jar, `${local}/api/auth/status`, setup), null);
  assert.equal(withoutForeignSessionCookies(jar, "http://127.0.0.1:5173/", setup), "theme=dark");
});
