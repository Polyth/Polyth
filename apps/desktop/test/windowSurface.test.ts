import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedFromLocalServer,
  channelAllowed,
  HUB_ORIGIN,
  hubUrl,
  linkRequest,
  navigationAllowed,
  safeNextPath,
  settingsPatchFor,
  windowSurface,
  type WindowOrigins,
} from "../src/windowSurface.ts";

const origins: WindowOrigins = {
  local: "http://127.0.0.1:4400",
  remote: new Set(["http://127.0.0.1:41234", "https://polyth.example.com"]),
};

test("a page's surface comes from its own origin, and an unknown origin has none", () => {
  assert.equal(windowSurface("http://127.0.0.1:4400/p/x", origins), "local");
  assert.equal(windowSurface(`${HUB_ORIGIN}/?add=1`, origins), "hub");
  assert.equal(windowSurface("http://127.0.0.1:41234/__polyth/bootstrap", origins), "remote");
  assert.equal(windowSurface("https://polyth.example.com/", origins), "remote");
  assert.equal(windowSurface("http://127.0.0.1:5173/", origins), null);
  assert.equal(windowSurface("https://evil.example/", origins), null);
  assert.equal(windowSurface("file:///etc/passwd", origins), null);
  assert.equal(windowSurface("", origins), null);
  // Lookalikes of the list's origin.
  assert.equal(windowSurface("polyth-app://hub.evil/", origins), null);
  assert.equal(windowSurface("http://hub/", origins), null);
});

test("with no server running, the local origin matches nothing", () => {
  assert.equal(windowSurface("http://127.0.0.1:4400/", { local: null, remote: new Set() }), null);
});

test("another server's page reaches nothing on this computer", () => {
  for (const channel of [
    "desktop:path:reveal",
    "desktop:path:open",
    "desktop:data:open",
    "desktop:setup:claim",
    "desktop:setup:restart",
    "desktop:setup:local",
    "desktop:session:renew",
    "desktop:session:confirm",
    "desktop:link",
    "desktop:servers:state",
    "desktop:servers:open",
    "desktop:servers:forget-address",
    "desktop:servers:run-local",
    "desktop:some-future-channel",
  ]) {
    assert.equal(channelAllowed("remote", channel), false, channel);
  }
});

test("another server's page keeps the window working", () => {
  for (const channel of [
    "desktop:info",
    "desktop:settings:get",
    "desktop:settings:set",
    "desktop:window",
    "desktop:window:get",
    "desktop:window:titlebar",
    "desktop:update:get",
    "desktop:keep-awake:activity",
    "desktop:servers:menu",
    "desktop:servers:list",
    "desktop:servers:resume",
  ]) {
    assert.equal(channelAllowed("remote", channel), true, channel);
  }
});

test("only the server list holds connection authority", () => {
  for (const channel of ["desktop:link", "desktop:servers:open", "desktop:servers:state", "desktop:servers:forget-address", "desktop:servers:run-local"]) {
    assert.equal(channelAllowed("hub", channel), true, channel);
    assert.equal(channelAllowed("local", channel), false, channel);
  }
  // The list has no files or sign-in of its own.
  assert.equal(channelAllowed("hub", "desktop:path:open"), false);
  assert.equal(channelAllowed("hub", "desktop:session:renew"), false);
});

test("this computer's page keeps what it always had, and an unknown page gets nothing", () => {
  for (const channel of ["desktop:path:reveal", "desktop:setup:claim", "desktop:session:confirm", "desktop:data:open", "desktop:servers:menu"]) {
    assert.equal(channelAllowed("local", channel), true, channel);
    assert.equal(channelAllowed(null, channel), false, channel);
  }
});

test("a page navigates inside its origin; only the list hands the window to a server", () => {
  const hub = `${HUB_ORIGIN}/`;
  assert.equal(navigationAllowed("http://127.0.0.1:41234/a", "http://127.0.0.1:41234/b", origins), true);
  assert.equal(navigationAllowed(hub, "http://127.0.0.1:41234/__polyth/bootstrap?x=1", origins), true);
  assert.equal(navigationAllowed(hub, "https://polyth.example.com/", origins), true);
  // A server's page cannot climb back into the list or across to another server.
  assert.equal(navigationAllowed("http://127.0.0.1:41234/", hub, origins), false);
  assert.equal(navigationAllowed("http://127.0.0.1:41234/", "http://127.0.0.1:4400/", origins), false);
  assert.equal(navigationAllowed("https://polyth.example.com/", "http://127.0.0.1:41234/", origins), false);
  assert.equal(navigationAllowed(hub, "https://evil.example/", origins), false);
  assert.equal(navigationAllowed(hub, "not a url", origins), false);
});

test("another server's page cannot change what runs on this computer", () => {
  const patch = { launchAtLogin: true, automaticUpdates: false, updateChannel: "nightly", closeToTray: false, reduceAnimations: true };
  assert.deepEqual(settingsPatchFor("remote", patch), { closeToTray: false, reduceAnimations: true });
  assert.deepEqual(settingsPatchFor("local", patch), patch);
  assert.deepEqual(settingsPatchFor("remote", null), {});
  assert.deepEqual(settingsPatchFor("remote", ["launchAtLogin"]), {});
});

test("the list's Link requests carry only the fields each one uses", () => {
  const id = "a".repeat(64);
  assert.deepEqual(linkRequest("connect", { connectionId: id, preferredPort: 1, evil: true }), {
    method: "connect",
    params: { connectionId: id },
  });
  assert.deepEqual(linkRequest("connections.list", { anything: 1 }), { method: "connections.list", params: {} });
  assert.deepEqual(linkRequest("pairing.begin", { ticket: "polyth://pair?v=1", label: "x".repeat(200) }), {
    method: "pairing.begin",
    params: { ticket: "polyth://pair?v=1", label: "x".repeat(80) },
  });
});

test("the list's Link requests refuse what the client would act on blindly", () => {
  for (const id of ["../../etc", "a/b", "a\\b", "", 7, undefined, "a".repeat(200)]) {
    assert.throws(() => linkRequest("forget", { connectionId: id }), { code: "invalid-request" }, String(id));
  }
  assert.throws(() => linkRequest("serve", {}), { code: "invalid-request" });
  assert.throws(() => linkRequest("constructor", {}), { code: "invalid-request" });
  assert.throws(() => linkRequest(7, {}), { code: "invalid-request" });
  assert.throws(() => linkRequest("pairing.parse", { ticket: "x".repeat(10_000) }), { code: "invalid-request" });
});

test("a path to open on a server is one of the app's own routes", () => {
  assert.equal(safeNextPath("/p/a/s/b?x=1"), "/p/a/s/b?x=1");
  for (const bad of ["//evil.example/", "https://evil.example/", "p/a", "/a b", "/a\\b", "/a\nb", 7, undefined, `/${"x".repeat(3000)}`]) {
    assert.equal(safeNextPath(bad), undefined, String(bad));
  }
});

test("the list's address says what to do and nothing else", () => {
  assert.equal(hubUrl(), `${HUB_ORIGIN}/`);
  assert.equal(hubUrl({ add: true }), `${HUB_ORIGIN}/?add=1`);
  assert.equal(hubUrl({ open: "abc", resume: true, next: "/p/a" }), `${HUB_ORIGIN}/?open=abc&resume=1&next=%2Fp%2Fa`);
  assert.equal(hubUrl({ next: "//evil.example" }), `${HUB_ORIGIN}/`);
});

test("only this computer's page may call this computer's server", () => {
  const api = { url: "http://127.0.0.1:4400/api/sessions", resourceType: "xhr" };
  const socket = { url: "ws://127.0.0.1:4400/ws", resourceType: "webSocket" };
  for (const page of ["http://127.0.0.1:41234/", "https://polyth.example.com/", `${HUB_ORIGIN}/`, "https://evil.example/", ""]) {
    assert.equal(blockedFromLocalServer(api, page, origins), true, page);
    assert.equal(blockedFromLocalServer(socket, page, origins), true, page);
  }
  assert.equal(blockedFromLocalServer(api, "http://127.0.0.1:4400/p/x", origins), false);
  assert.equal(blockedFromLocalServer(socket, "http://127.0.0.1:4400/p/x", origins), false);
});

test("another server's page keeps its own requests, and the window can still come home", () => {
  const page = "http://127.0.0.1:41234/";
  assert.equal(blockedFromLocalServer({ url: "http://127.0.0.1:41234/api/health", resourceType: "xhr" }, page, origins), false);
  assert.equal(blockedFromLocalServer({ url: "https://cdn.example/x.png", resourceType: "image" }, page, origins), false);
  assert.equal(blockedFromLocalServer({ url: "http://127.0.0.1:4400/", resourceType: "mainFrame" }, page, origins), false);
  assert.equal(blockedFromLocalServer({ url: "http://127.0.0.1:4400/", resourceType: "subFrame" }, page, origins), true);
  // With no server of its own there is nothing to protect.
  assert.equal(blockedFromLocalServer({ url: "http://127.0.0.1:4400/api", resourceType: "xhr" }, page, { local: null, remote: new Set([page]) }), false);
  assert.equal(blockedFromLocalServer({ url: "not a url", resourceType: "xhr" }, page, origins), false);
});
