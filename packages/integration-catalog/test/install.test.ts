import assert from "node:assert/strict";
import test from "node:test";
import { installedFrom, planInstall, serverNameFor } from "../src/install.ts";
import type { IntegrationManifest } from "../src/manifest.ts";

function entry(id: string, overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    publisher: "Vendor",
    verified: true,
    summary: `Summary for ${id}.`,
    description: `A description of ${id} that is long enough to be a sentence.`,
    categories: ["product"],
    status: "stable",
    homepage: "https://example.test",
    mcp: { auth: "oauth", remote: { url: `https://${id}.test/mcp` } },
    evidence: {
      checkedAt: "2026-11-06",
      source: "https://example.test/docs",
      probe: { state: "observed", httpStatus: 401 },
    },
    ...overrides,
  };
}

const oauth = entry("linear");
const token = entry("github", {
  mcp: {
    auth: "token",
    remote: {
      url: "https://api.github.test/mcp/",
      tokenHeader: { name: "Authorization", valuePrefix: "Bearer " },
    },
    tokenHelpUrl: "https://github.test/tokens",
  },
});
const optionalToken = entry("context7", {
  mcp: {
    auth: "token",
    remote: { url: "https://context7.test/mcp", tokenHeader: { name: "CONTEXT7_API_KEY" }, tokenOptional: true },
    tokenHelpUrl: "https://context7.test/keys",
  },
});
const headerless = entry("exa", {
  mcp: { auth: "token", remote: { url: "https://exa.test/mcp" }, tokenHelpUrl: "https://exa.test/keys" },
});
const local = entry("playwright", {
  mcp: { auth: "none", local: { command: ["npx", "-y", "@playwright/mcp@0.0.84"], requires: ["node"] } },
});
const open = entry("cloudflare", { mcp: { auth: "none", remote: { url: "https://docs.test/mcp" } } });

test("the entry id is the server name", () => {
  assert.equal(serverNameFor(oauth), "linear");
});

test("an OAuth entry becomes a project-scoped http server with no secret", () => {
  const plan = planInstall(oauth);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.scope, "project");
  assert.deepEqual(plan.input.transport, { kind: "http", url: "https://linear.test/mcp", headersSecretRefs: [] });
  assert.equal(plan.input.secrets, undefined);
  assert.equal(plan.input.name, "linear");
  assert.match(plan.notes[0]!, /sign-in/);
});

test("a Space scope can be asked for explicitly", () => {
  const plan = planInstall(open, { scope: "space" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.scope, "space");
});

test("a token entry is always person-owned and its secret carries the prefix", () => {
  const plan = planInstall(token, { token: "  ghp_secret  " });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.scope, "person");
  assert.deepEqual(plan.input.transport, {
    kind: "http",
    url: "https://api.github.test/mcp/",
    headersSecretRefs: ["Authorization"],
  });
  assert.deepEqual(plan.input.secrets, { Authorization: "Bearer ghp_secret" });
  assert.match(plan.notes[0]!, /Credential Vault/);
});

test("a token entry refuses a shared Space copy instead of downgrading it", () => {
  const plan = planInstall(token, { token: "x", scope: "project" });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.failure, "scope-not-allowed");
});

test("a token entry with no token is refused unless the key is optional", () => {
  const missing = planInstall(token, {});
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.failure, "token-required");

  const optional = planInstall(optionalToken, {});
  assert.equal(optional.ok, true);
  if (!optional.ok) return;
  assert.deepEqual(optional.input.transport, {
    kind: "http",
    url: "https://context7.test/mcp",
    headersSecretRefs: [],
  });
  assert.equal(optional.input.secrets, undefined);
  assert.match(optional.notes[0]!, /without a key/);

  const keyed = planInstall(optionalToken, { token: "abc" });
  assert.equal(keyed.ok, true);
  if (!keyed.ok) return;
  assert.deepEqual(keyed.input.secrets, { CONTEXT7_API_KEY: "abc" });
});

test("an entry that does not say how its token travels cannot be installed", () => {
  const plan = planInstall(headerless, { token: "abc" });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.failure, "token-header-missing");
  assert.match(plan.message, /tokenHeader/);
});

test("a local entry becomes a stdio command that is already pinned", () => {
  const plan = planInstall(local);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.scope, "project");
  assert.deepEqual(plan.input.transport, {
    kind: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.84"],
    envKeys: [],
  });
  assert.equal(plan.input.secrets, undefined);
});

test("a local entry that slipped through unpinned is refused at install", () => {
  const floating = entry("floating", {
    mcp: { auth: "none", local: { command: ["npx", "-y", "some-mcp@latest"] } },
  });
  const plan = planInstall(floating);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.failure, "local-unpinned");
  assert.match(plan.message, /exact version/);
});

test("an unknown entry is a plain refusal", () => {
  const plan = planInstall(undefined);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.failure, "unknown-entry");
});

test("live servers match entries by name, and only the ledger owns removal", () => {
  const installed = installedFrom(
    [oauth, token, local],
    [
      { id: "srv-1", name: "linear", revision: 3, enabled: true, projectId: "p1" },
      { id: "srv-2", name: "hand-made", revision: 1 },
      { id: "srv-3", name: "playwright", revision: 2, enabled: false },
    ],
    [{ id: "per-1", name: "github", revision: 1 }],
    [{ serverId: "srv-1" }],
  );
  assert.deepEqual(installed.map((row) => [row.entryId, row.scope, row.catalogManaged]), [
    ["linear", "project", true],
    ["playwright", "space", false],
    ["github", "person", false],
  ]);
  assert.equal(installed[0]!.projectId, "p1");
  assert.equal(installed[1]!.enabled, false);
});
