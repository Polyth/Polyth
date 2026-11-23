// Session URL parse/format: /p/:projectId/s/:sessionId plus ?session= for agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAppUrl, PACKAGES_LINK_PARAMS, packagesLinkFromSearch, parseAppUrl, settingsPageFromSearch } from "../src/router.ts";

test("parseAppUrl reads project and session from the path", () => {
  assert.deepEqual(parseAppUrl("/p/prj_1/s/ses_2"), { projectId: "prj_1", sessionId: "ses_2" });
  assert.deepEqual(parseAppUrl("/p/prj_1/s/ses_2/"), { projectId: "prj_1", sessionId: "ses_2" });
  assert.deepEqual(parseAppUrl("/p/prj_1"), { projectId: "prj_1" });
  assert.deepEqual(parseAppUrl("/"), {});
  assert.deepEqual(parseAppUrl(""), {});
});

test("parseAppUrl ignores non-app paths", () => {
  assert.deepEqual(parseAppUrl("/settings"), {});
  assert.deepEqual(parseAppUrl("/p/"), {});
  assert.deepEqual(parseAppUrl("/p/a/b/c"), {});
  assert.deepEqual(parseAppUrl("/api/sessions/x"), {});
});

test("?session= wins over the path so agents can deep-link by id alone", () => {
  assert.deepEqual(parseAppUrl("/", "?session=ses_9"), { sessionId: "ses_9" });
  assert.deepEqual(parseAppUrl("/p/prj_1/s/ses_2", "?session=ses_9"), { projectId: "prj_1", sessionId: "ses_9" });
  assert.deepEqual(parseAppUrl("/", "?other=1"), {});
});

test("percent-encoded ids round-trip", () => {
  const url = formatAppUrl("prj/with slash", "ses 100%");
  assert.equal(url, "/p/prj%2Fwith%20slash/s/ses%20100%25");
  assert.deepEqual(parseAppUrl(url), { projectId: "prj/with slash", sessionId: "ses 100%" });
});

test("settingsPageFromSearch reads a safe settings deep-link", () => {
  assert.equal(settingsPageFromSearch("?settings=plugins"), "plugins");
  assert.equal(settingsPageFromSearch("?settings=harnesses/opencode/roles"), "harnesses/opencode/roles");
  assert.equal(settingsPageFromSearch("?session=ses_1&settings=plugins"), "plugins");
  assert.equal(settingsPageFromSearch("?settings=not a page"), null);
  assert.equal(settingsPageFromSearch("?settings=/evil"), null);
  assert.equal(settingsPageFromSearch("?settings=harnesses/opencode/roles/extra"), null);
  assert.equal(settingsPageFromSearch(""), null);
});

test("packagesLinkFromSearch reads catalog install links", () => {
  assert.deepEqual(packagesLinkFromSearch("?settings=packages&package=github"), { packageId: "github" });
  const source = "https://github.com/acme/polyth-weather/tree/v1.2.0";
  assert.deepEqual(
    packagesLinkFromSearch(`?settings=packages&install=${encodeURIComponent(source)}`),
    { installSource: source },
  );
  // Only on the Packages page, and a package id wins over an install source.
  assert.equal(packagesLinkFromSearch("?settings=plugins&package=github"), null);
  assert.equal(packagesLinkFromSearch("?package=github"), null);
  assert.deepEqual(packagesLinkFromSearch(`?settings=packages&package=git&install=${source}`), { packageId: "git" });
  // Bounded values: no odd ids, whitespace, control characters or huge sources.
  assert.equal(packagesLinkFromSearch("?settings=packages&package=../evil"), null);
  assert.equal(packagesLinkFromSearch("?settings=packages&package=Git"), null);
  assert.equal(packagesLinkFromSearch(`?settings=packages&install=${encodeURIComponent("a b")}`), null);
  assert.equal(packagesLinkFromSearch(`?settings=packages&install=${encodeURIComponent("x\u0000")}`), null);
  assert.equal(packagesLinkFromSearch(`?settings=packages&install=${"a".repeat(2049)}`), null);
  assert.equal(packagesLinkFromSearch("?settings=packages"), null);
  assert.deepEqual(PACKAGES_LINK_PARAMS, ["package", "install"]);
});

test("formatAppUrl builds canonical urls", () => {
  assert.equal(formatAppUrl("prj_1", "ses_2"), "/p/prj_1/s/ses_2");
  assert.equal(formatAppUrl("prj_1", null), "/p/prj_1");
  assert.equal(formatAppUrl(null, null), "/");
  assert.equal(formatAppUrl(null, "ses_2"), "/?session=ses_2");
});
