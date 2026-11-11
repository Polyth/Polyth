import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_ORDER,
  localPinningErrors,
  validateCatalog,
  validateManifest,
  type IntegrationManifest,
} from "../src/manifest.ts";

/** A manifest that passes; each test breaks exactly one field. */
function valid(id = "linear"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name: "Linear",
    publisher: "Linear",
    verified: true,
    summary: "Read and change Linear issues.",
    description: "Linear's own remote MCP server, with the agent acting as your account.",
    categories: ["product"],
    status: "stable",
    homepage: "https://linear.app",
    mcp: { auth: "oauth", remote: { url: "https://mcp.linear.app/mcp" } },
    evidence: {
      checkedAt: "2026-11-06",
      source: "https://linear.app/docs/mcp",
      probe: { state: "observed", httpStatus: 401, challenge: "bearer-oauth" },
    },
  };
}

const errorsOf = (manifest: unknown, id = "linear"): string[] => validateManifest(manifest, id);

test("a complete manifest has no errors", () => {
  assert.deepEqual(errorsOf(valid()), []);
});

test("the entry id is the folder name", () => {
  assert.deepEqual(errorsOf(valid("linear"), "notion"), ['id "linear" must match the folder name "notion"']);
  assert.match(errorsOf(valid("Linear MCP")).join("\n"), /kebab-case/);
  assert.match(errorsOf(valid("a".repeat(60))).join("\n"), /kebab-case/);
});

test("a manifest names one endpoint and one authentication kind", () => {
  const both = valid();
  both.mcp = {
    auth: "oauth",
    remote: { url: "https://mcp.linear.app/mcp" },
    local: { command: ["npx", "-y", "server"] },
  };
  assert.match(errorsOf(both).join("\n"), /exactly one of remote and local/);

  const neither = valid();
  neither.mcp = { auth: "oauth" };
  assert.match(errorsOf(neither).join("\n"), /exactly one of remote and local/);

  const localOauth = valid();
  localOauth.mcp = { auth: "oauth", local: { command: ["npx", "-y", "server"] } };
  assert.match(errorsOf(localOauth).join("\n"), /local server cannot use oauth/);

  const remoteWithoutAuth = valid();
  remoteWithoutAuth.mcp = { auth: "maybe", remote: { url: "https://x.test/mcp" } };
  assert.match(errorsOf(remoteWithoutAuth).join("\n"), /mcp\.auth/);
});

test("a token remote says where the token comes from", () => {
  const token = valid();
  token.mcp = {
    auth: "token",
    remote: { url: "https://api.test/mcp", tokenHeader: { name: "Authorization", valuePrefix: "Bearer " } },
  };
  assert.match(errorsOf(token).join("\n"), /tokenHelpUrl/);

  (token.mcp as Record<string, unknown>).tokenHelpUrl = "https://api.test/keys";
  assert.deepEqual(errorsOf(token), []);

  const oauthWithHeader = valid();
  oauthWithHeader.mcp = {
    auth: "oauth",
    remote: { url: "https://mcp.test/mcp", tokenHeader: { name: "Authorization" } },
  };
  assert.match(errorsOf(oauthWithHeader).join("\n"), /tokenHeader/);

  const badHeader = valid();
  badHeader.mcp = {
    auth: "token",
    remote: { url: "https://api.test/mcp", tokenHeader: { name: "Author ization" } },
    tokenHelpUrl: "https://api.test/keys",
  };
  assert.match(errorsOf(badHeader).join("\n"), /HTTP header name/);
});

test("plain http and relative paths are refused", () => {
  const insecure = valid();
  insecure.homepage = "http://linear.app";
  assert.match(errorsOf(insecure).join("\n"), /homepage/);

  const remote = valid();
  remote.mcp = { auth: "none", remote: { url: "http://mcp.test/mcp" } };
  assert.match(errorsOf(remote).join("\n"), /https URL/);

  const skill = valid();
  skill.skills = [{ source: "owner/repo", subpath: "../outside", name: "helper" }];
  assert.match(errorsOf(skill).join("\n"), /repo-relative/);
});

test("a local command is a non-empty argv", () => {
  const empty = valid();
  empty.mcp = { auth: "none", local: { command: [] } };
  assert.match(errorsOf(empty).join("\n"), /command/);

  const ok = valid();
  ok.mcp = {
    auth: "none",
    local: { command: ["npx", "-y", "@playwright/mcp@0.0.84"], requires: ["node"], timeoutMs: 60000 },
  };
  assert.deepEqual(errorsOf(ok), []);

  const badRequirement = valid();
  badRequirement.mcp = { auth: "none", local: { command: ["npx"], requires: ["rust"] } };
  assert.match(errorsOf(badRequirement).join("\n"), /requires/);

  const badTimeout = valid();
  badTimeout.mcp = { auth: "none", local: { command: ["npx"], timeoutMs: 10 } };
  assert.match(errorsOf(badTimeout).join("\n"), /timeoutMs/);
});

test("categories come from the fixed list, once each", () => {
  const unknown = valid();
  unknown.categories = ["payments"];
  assert.match(errorsOf(unknown).join("\n"), /unknown category/);

  const tooMany = valid();
  tooMany.categories = ["product", "code", "ai"];
  assert.match(errorsOf(tooMany).join("\n"), /one or two/);

  const repeated = valid();
  repeated.categories = ["code", "code"];
  assert.match(errorsOf(repeated).join("\n"), /duplicate category/);

  const empty = valid();
  empty.categories = [];
  assert.match(errorsOf(empty).join("\n"), /one or two/);

  for (const category of CATEGORY_ORDER) {
    const entry = valid();
    entry.categories = [category];
    assert.deepEqual(errorsOf(entry), [], category);
  }
});

test("evidence records how sure the claim is", () => {
  const observedWithoutStatus = valid();
  observedWithoutStatus.evidence = {
    checkedAt: "2026-11-06",
    source: "https://linear.app/docs/mcp",
    probe: { state: "observed" },
  };
  assert.match(errorsOf(observedWithoutStatus).join("\n"), /httpStatus/);

  const undocumented = valid();
  undocumented.evidence = { checkedAt: "yesterday", source: "not a url", probe: { state: "pending" } };
  const errors = errorsOf(undocumented).join("\n");
  assert.match(errors, /checkedAt/);
  assert.match(errors, /source/);

  const badChallenge = valid();
  badChallenge.evidence = {
    checkedAt: "2026-11-06",
    source: "https://linear.app/docs/mcp",
    probe: { state: "observed", httpStatus: 401, challenge: "cookie" },
  };
  assert.match(errorsOf(badChallenge).join("\n"), /challenge/);

  const documented = valid();
  documented.evidence = {
    checkedAt: "2026-11-06",
    source: "https://github.com/microsoft/playwright-mcp",
    probe: { state: "documented", note: "read in the vendor README" },
  };
  assert.deepEqual(errorsOf(documented), []);
});

test("text and status fields stay in bounds", () => {
  const vague = valid();
  vague.description = "too short";
  assert.match(errorsOf(vague).join("\n"), /description/);

  const longSummary = valid();
  longSummary.summary = "x".repeat(200);
  assert.match(errorsOf(longSummary).join("\n"), /summary/);

  const status = valid();
  status.status = "experimental";
  assert.match(errorsOf(status).join("\n"), /status/);

  const verified = valid();
  verified.verified = "yes";
  assert.match(errorsOf(verified).join("\n"), /verified/);

  const featured = valid();
  featured.featured = 1;
  assert.match(errorsOf(featured).join("\n"), /featured/);
});

test("a non-object is reported instead of throwing", () => {
  assert.deepEqual(errorsOf(null), ["manifest must be a JSON object"]);
  assert.deepEqual(errorsOf([]), ["manifest must be a JSON object"]);
  assert.deepEqual(errorsOf("linear"), ["manifest must be a JSON object"]);
});

test("duplicate ids across the catalog are refused", () => {
  const one = valid("linear") as unknown as IntegrationManifest;
  const two = valid("linear") as unknown as IntegrationManifest;
  assert.deepEqual(validateCatalog([one, two]), ['duplicate entry id "linear"']);
  assert.deepEqual(validateCatalog([one]), []);
});

test("a local package must name an exact version", () => {
  assert.deepEqual(localPinningErrors(["npx", "-y", "@playwright/mcp@0.0.84"]), []);
  assert.deepEqual(localPinningErrors(["uvx", "mcp-server-fetch@0.6.1"]), []);
  assert.deepEqual(localPinningErrors(["pnpm", "dlx", "openapi-mcp@1.2.3"]), []);
  assert.match(localPinningErrors(["npx", "-y", "@playwright/mcp@latest"]).join("\n"), /exact version/);
  assert.match(localPinningErrors(["npx", "some-mcp"]).join("\n"), /exact version/);
  assert.match(localPinningErrors(["npx", "some-mcp@^1.2.0"]).join("\n"), /exact version/);
  assert.match(localPinningErrors(["npx", "-y"]).join("\n"), /must name a package/);
  // Not a package runner: nothing to pin.
  assert.deepEqual(localPinningErrors(["node", "server.js"]), []);
  assert.deepEqual(localPinningErrors(["/usr/local/bin/python3", "-m", "server"]), []);
});

test("a docker image must not float on latest", () => {
  assert.deepEqual(localPinningErrors(["docker", "run", "-i", "--rm", "ghcr.io/owner/image:1.4.0"]), []);
  assert.deepEqual(localPinningErrors(["docker", "run", "ghcr.io/owner/image@sha256:abc"]), []);
  assert.match(localPinningErrors(["docker", "run", "ghcr.io/owner/image"]).join("\n"), /pin a tag/);
  assert.match(localPinningErrors(["docker", "run", "owner/image:latest"]).join("\n"), /pin a tag/);
});

test("an unpinned local command fails the manifest", () => {
  const floating = valid();
  floating.mcp = { auth: "none", local: { command: ["npx", "-y", "@playwright/mcp@latest"] } };
  assert.match(errorsOf(floating).join("\n"), /exact version/);
});

test("an input is declared, used, and bounded by choices or a pattern", () => {
  const withInput = (url: string, inputs: unknown): Record<string, unknown> => {
    const manifest = valid();
    manifest.mcp = { auth: "oauth", remote: { url }, ...(inputs === undefined ? {} : { inputs }) };
    return manifest;
  };
  const site = { id: "site", label: "Site", default: "a.test", choices: [{ value: "a.test", label: "A" }, { value: "b.test", label: "B" }] };
  assert.deepEqual(errorsOf(withInput("https://mcp.{site}/mcp", [site])), []);

  assert.match(errorsOf(withInput("https://mcp.{site}/mcp", undefined)).join("\n"), /\{site\} is used but not declared/);
  assert.match(errorsOf(withInput("https://mcp.a.test/mcp", [site])).join("\n"), /never uses \{site\}/);
  assert.match(
    errorsOf(withInput("https://mcp.{site}/mcp", [{ id: "site", label: "Site", pattern: "^[a-z.]+$" }])).join("\n"),
    /picks the URL host, so it must be a choice/,
  );
  assert.match(
    errorsOf(withInput("https://mcp.a.test/{org}/mcp", [{ id: "org", label: "Org", pattern: "[a-z]+" }])).join("\n"),
    /anchored/,
  );
  assert.match(
    errorsOf(withInput("https://mcp.{site}/mcp", [{ ...site, default: "c.test" }])).join("\n"),
    /default must be a valid value/,
  );
  assert.match(
    errorsOf(withInput("https://mcp.{site}/mcp", [{ ...site, choices: [{ value: "a.test/x", label: "Bad" }] }])).join("\n"),
    /plain value/,
  );
  assert.match(
    errorsOf(withInput("https://mcp.{site}/mcp", [{ id: "site", label: "Site" }])).join("\n"),
    /exactly one of choices and pattern/,
  );
});

test("a local command may carry an input in an argument, never in the executable", () => {
  const manifest = valid();
  manifest.mcp = {
    auth: "none",
    local: { command: ["{bin}", "-y", "pkg@1.2.3"] },
    inputs: [{ id: "bin", label: "Binary", pattern: "^[a-z]+$" }],
  };
  assert.match(errorsOf(manifest).join("\n"), /command\[0\] cannot carry an input/);
  manifest.mcp = {
    auth: "none",
    local: { command: ["npx", "-y", "pkg@1.2.3", "{org}"] },
    inputs: [{ id: "org", label: "Org", pattern: "^[a-z]+$" }],
  };
  assert.deepEqual(errorsOf(manifest), []);
});

test("an observed OAuth probe may record how a client registers", () => {
  const manifest = valid();
  (manifest.evidence as { probe: Record<string, unknown> }).probe.registration = "dynamic";
  assert.deepEqual(errorsOf(manifest), []);
  (manifest.evidence as { probe: Record<string, unknown> }).probe.registration = "maybe";
  assert.match(errorsOf(manifest).join("\n"), /registration must be dynamic/);
});

test("the shipped catalog: every OAuth entry offers dynamic registration", async () => {
  // One-click sign-in in the harnesses depends on it; an entry whose server
  // needs a hand-registered app belongs in the README's "not suitable" table.
  const { loadCatalog, CATALOG_DIR } = await import("../src/entries.ts");
  const { entries, problems } = await loadCatalog(CATALOG_DIR);
  assert.deepEqual(problems, []);
  const offenders = entries
    .filter((entry) => entry.mcp.auth === "oauth" && entry.evidence.probe.registration !== "dynamic")
    .map((entry) => entry.id);
  assert.deepEqual(offenders, []);
});
