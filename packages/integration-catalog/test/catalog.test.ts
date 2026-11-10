import assert from "node:assert/strict";
import test from "node:test";
import {
  authSummary,
  catalogSections,
  catalogStats,
  componentSummary,
  endpoint,
  featuredSection,
  filterEntries,
  isLocal,
  sortForDisplay,
} from "../src/catalog.ts";
import type { IntegrationManifest } from "../src/manifest.ts";

function entry(id: string, extra: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    schemaVersion: 1,
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    publisher: id,
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
    ...extra,
  };
}

const entries: IntegrationManifest[] = [
  entry("notion", { featured: true }),
  entry("linear", { featured: true }),
  entry("beta-tool", {
    status: "beta",
    categories: ["code", "quality"],
    mcp: { auth: "token", remote: { url: "https://beta.test/mcp" }, tokenHelpUrl: "https://beta.test/keys" },
  }),
  entry("local-tool", {
    categories: ["code"],
    mcp: { auth: "none", local: { command: ["npx", "-y", "local-mcp@latest"] } },
  }),
  entry("quiet", { mcp: { auth: "none", remote: { url: "https://quiet.test/mcp" } } }),
];

test("featured entries come first, then everything by name", () => {
  assert.deepEqual(sortForDisplay(entries).map((item) => item.id), [
    "linear", "notion", "beta-tool", "local-tool", "quiet",
  ]);
});

test("sections follow the category order and drop empty categories", () => {
  const sections = catalogSections(entries);
  assert.deepEqual(sections.map((section) => section.id), ["product", "code", "quality"]);
  assert.deepEqual(sections[0]!.entries.map((item) => item.id), ["linear", "notion", "quiet"]);
  assert.deepEqual(sections.find((section) => section.id === "code")!.entries.map((item) => item.id), [
    "beta-tool", "local-tool",
  ]);
});

test("a featured section appears only when something is featured", () => {
  assert.deepEqual(featuredSection(entries)?.entries.map((item) => item.id), ["linear", "notion"]);
  assert.equal(featuredSection([entry("plain")]), null);
});

test("filtering is case-insensitive and ranks a name prefix first", () => {
  assert.deepEqual(filterEntries(entries, { query: "LINE" }).map((item) => item.id), ["linear"]);
  // "local" appears in a name, a host and a command; the name wins.
  assert.equal(filterEntries(entries, { query: "local" })[0]!.id, "local-tool");
  assert.deepEqual(filterEntries(entries, { query: "npx" }).map((item) => item.id), ["local-tool"]);
  assert.deepEqual(filterEntries(entries, { query: "zzz" }), []);
});

test("filtering by category keeps the display order", () => {
  assert.deepEqual(
    filterEntries(entries, { category: "code" }).map((item) => item.id),
    ["beta-tool", "local-tool"],
  );
  assert.deepEqual(filterEntries(entries, { category: "design" }), []);
  assert.equal(filterEntries(entries, { category: "all" }).length, entries.length);
});

test("a query and a category apply together", () => {
  assert.deepEqual(
    filterEntries(entries, { query: "beta", category: "quality" }).map((item) => item.id),
    ["beta-tool"],
  );
  assert.deepEqual(filterEntries(entries, { query: "beta", category: "product" }), []);
});

test("stats count what the header shows", () => {
  const stats = catalogStats(entries);
  assert.equal(stats.total, 5);
  assert.equal(stats.featured, 2);
  assert.equal(stats.oauth, 2);
  assert.equal(stats.token, 1);
  assert.equal(stats.none, 2);
  assert.equal(stats.local, 1);
  assert.equal(stats.byCategory.code, 2);
  assert.equal(stats.byCategory.data, 0);
});

test("endpoint, local and the connect summary describe the real target", () => {
  const local = entries.find((item) => item.id === "local-tool")!;
  assert.equal(isLocal(local), true);
  assert.equal(endpoint(local), "npx -y local-mcp@latest");
  assert.equal(authSummary(local), "Runs locally, no sign-in");
  assert.deepEqual(componentSummary(local), ["Local MCP server"]);

  const oauth = entries.find((item) => item.id === "linear")!;
  assert.equal(isLocal(oauth), false);
  assert.equal(endpoint(oauth), "https://linear.test/mcp");
  assert.equal(authSummary(oauth), "Sign in with the service (OAuth)");
  assert.deepEqual(componentSummary(oauth), ["Remote MCP server"]);

  const token = entries.find((item) => item.id === "beta-tool")!;
  assert.equal(authSummary(token), "Needs an API token");

  const optional: IntegrationManifest = {
    ...token,
    mcp: { auth: "token", remote: { url: "https://x.test/mcp", tokenOptional: true }, tokenHelpUrl: "https://x.test/keys" },
  };
  assert.equal(authSummary(optional), "Works without a token; a key raises limits");

  const withSkill: IntegrationManifest = { ...oauth, skills: [{ source: "o/r", subpath: "s", name: "one" }] };
  assert.deepEqual(componentSummary(withSkill), ["Remote MCP server", "1 skill"]);
});
