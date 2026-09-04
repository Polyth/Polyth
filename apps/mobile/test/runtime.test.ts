import test from "node:test";
import assert from "node:assert/strict";
import { mobileDeepLinkPath, normalizePolythHost, isPairingDeepLink } from "../src/runtime.ts";

test("normalizes a Polyth host without retaining paths or credentials", () => {
  assert.equal(normalizePolythHost("polyth.example.test:4400/path?x=1"), "http://polyth.example.test:4400");
  assert.equal(normalizePolythHost("https://polyth.example.test/"), "https://polyth.example.test");
  assert.throws(() => normalizePolythHost("ftp://polyth.example.test"), /HTTP or HTTPS/);
  assert.throws(() => normalizePolythHost("https://name:secret@polyth.example.test"), /credentials/);
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
