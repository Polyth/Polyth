import test from "node:test";
import assert from "node:assert/strict";
import {
  isPairingDeepLink,
  isPolythLinkLoopbackOrigin,
  mobileConnectionHubUrl,
  mobileDeepLinkPath,
  mobileServerZones,
  normalizePolythHost,
  zoneProjectPath,
} from "../src/runtime.ts";

test("normalizes a Polyth host without retaining paths or credentials", () => {
  assert.equal(normalizePolythHost("polyth.example.test:4400/path?x=1"), "http://polyth.example.test:4400");
  assert.equal(normalizePolythHost("https://polyth.example.test/"), "https://polyth.example.test");
  assert.throws(() => normalizePolythHost("ftp://polyth.example.test"), /HTTP or HTTPS/);
  assert.throws(() => normalizePolythHost("https://name:secret@polyth.example.test"), /credentials/);
});

test("recognizes only the authenticated Rust proxy origin as ephemeral loopback", () => {
  assert.equal(isPolythLinkLoopbackOrigin("http://127.0.0.1:49152"), true);
  assert.equal(isPolythLinkLoopbackOrigin("https://127.0.0.1:49152"), false);
  assert.equal(isPolythLinkLoopbackOrigin("http://localhost:49152"), false);
  assert.equal(isPolythLinkLoopbackOrigin("http://192.168.1.10:4400"), false);
});

test("maps native session and project links to canonical app paths", () => {
  assert.equal(mobileDeepLinkPath("polyth://session/session-1"), "/?session=session-1");
  assert.equal(mobileDeepLinkPath("polyth://project/project-1"), "/p/project-1");
  assert.equal(
    mobileDeepLinkPath("polyth://open/p/project-1/s/session-1"),
    "/p/project-1/s/session-1",
  );
  assert.equal(
    mobileDeepLinkPath("https://polyth.example.test/?session=session-1"),
    "/?session=session-1",
  );
  assert.equal(mobileDeepLinkPath("polyth://pair?v=1&t=abc"), undefined);
  assert.equal(isPairingDeepLink("polyth://pair?v=1&t=abc"), true);
});

test("deep links discard unsupported query data and malformed path ids", () => {
  assert.equal(
    mobileDeepLinkPath("https://links.example.test/p/project-1/s/session-1?action=delete&token=secret"),
    "/p/project-1/s/session-1",
  );
  assert.equal(
    mobileDeepLinkPath("polyth://open?session=session-1&action=delete&token=secret"),
    "/?session=session-1",
  );
  assert.doesNotThrow(() => mobileDeepLinkPath("polyth://session/%"));
  assert.equal(mobileDeepLinkPath("polyth://session/%"), undefined);
  assert.equal(mobileDeepLinkPath("polyth://project/%2Fsettings"), undefined);
  assert.equal(mobileDeepLinkPath("polyth://open/p/%/s/session-1"), undefined);
  assert.equal(mobileDeepLinkPath("polyth://open/p/%2Fsettings"), undefined);
  assert.equal(mobileDeepLinkPath("https://links.example.test/p/project-1/s/%"), undefined);
  assert.equal(mobileDeepLinkPath("https://links.example.test/p/%2Fsettings"), undefined);
  assert.equal(
    mobileDeepLinkPath("https://links.example.test/?session=session-1&password=secret#token"),
    "/?session=session-1",
  );
});

test("hub bounces carry either a server choice or a resume, never both", () => {
  const origin = "capacitor://localhost";
  assert.equal(mobileConnectionHubUrl(origin), origin);
  assert.equal(mobileConnectionHubUrl(origin, { resume: true }), `${origin}?resume=1`);
  assert.equal(mobileConnectionHubUrl(origin, { selectServer: true }), `${origin}?selectServer=1`);
  assert.equal(mobileConnectionHubUrl(origin, { selectServer: true, resume: true }), `${origin}?selectServer=1`);
  // "Add server" from the native server menu is a server choice too.
  assert.equal(mobileConnectionHubUrl(origin, { addServer: true }), `${origin}?selectServer=1&addServer=1`);
  assert.equal(mobileConnectionHubUrl(origin, { addServer: true, resume: true }), `${origin}?selectServer=1&addServer=1`);
});

test("a zone opens its server at the tapped project only while the pairing stands", () => {
  assert.equal(zoneProjectPath(true, "p1"), "/p/p1");
  // The id travels as one path segment, the form the hub accepts.
  assert.equal(zoneProjectPath(true, "мій проєкт"), `/p/${encodeURIComponent("мій проєкт")}`);
  assert.equal(mobileDeepLinkPath(`https://polyth.example.test${zoneProjectPath(true, "a&b=c")}`), "/p/a%26b%3Dc");
  assert.equal(zoneProjectPath(true), undefined);
  // A revoked pairing lands on the server list, at no path.
  assert.equal(zoneProjectPath(false, "p1"), undefined);
  assert.equal(zoneProjectPath(undefined, "p1"), undefined);
});

test("zones have nothing to ask outside the phone app", () => {
  assert.equal(mobileServerZones(), null);
});
