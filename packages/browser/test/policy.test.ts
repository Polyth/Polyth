// WP14 URL policy: canonicalization, unsafe schemes, private networks,
// approvals, and DNS-rebinding defense via per-hop re-resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrl, isPrivateAddress, originAliases, originOf, type Resolver } from "../src/index.ts";

const publicDns: Resolver = async () => ["93.184.216.34"];

test("unsafe schemes are blocked outright", async () => {
  for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "about:config", "chrome://settings", "blob:http://x/y", "ftp://host/f"]) {
    const d = await checkUrl(raw, { resolve: publicDns });
    assert.equal(d.ok, false, raw);
    if (!d.ok) assert.equal(d.code, "blocked-scheme", raw);
  }
});

test("credentials embedded in a URL are rejected", async () => {
  const d = await checkUrl("https://user:pass@example.com/", { resolve: publicDns });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "blocked-credentials");
});

test("garbage input is invalid-url; bare host:port gets an http scheme", async () => {
  const bad = await checkUrl("ht!tp::/:", { resolve: publicDns });
  assert.equal(bad.ok, false);
  const bare = await checkUrl("localhost:5173", { allowedOrigins: ["http://localhost:5173"], resolve: publicDns });
  assert.equal(bare.ok, true);
  if (bare.ok) assert.equal(bare.origin, "http://localhost:5173");
});

test("loopback allowed only for polyth-started or approved origins", async () => {
  const allowed = await checkUrl("http://127.0.0.1:5173/app", { allowedOrigins: ["http://127.0.0.1:5173"] });
  assert.equal(allowed.ok, true);
  const denied = await checkUrl("http://127.0.0.1:9999/", {});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "approval-required");
  const approved = await checkUrl("http://localhost:9999/", { approvedOrigins: new Set(["http://localhost:9999"]) });
  assert.equal(approved.ok, true);
});

test("private/link-local/CGNAT/metadata literal IPs are blocked even if approved", async () => {
  for (const ip of ["10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.3.2", "0.0.0.0"]) {
    const d = await checkUrl(`http://${ip}/`, { approvedOrigins: new Set([`http://${ip}`]) });
    assert.equal(d.ok, false, ip);
    if (!d.ok) assert.equal(d.code, "blocked-private", ip);
  }
});

test("hostname resolving to a private address is blocked (SSRF)", async () => {
  const d = await checkUrl("https://internal.example.com/", {
    approvedOrigins: new Set(["https://internal.example.com"]),
    resolve: async () => ["10.0.0.5"],
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "blocked-private");
});

test("DNS rebinding: second hop re-resolves and gets blocked", async () => {
  let calls = 0;
  const flipFlop: Resolver = async () => {
    calls++;
    return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const opts = { approvedOrigins: new Set(["https://evil.example.com"]), resolve: flipFlop };
  const first = await checkUrl("https://evil.example.com/", opts);
  assert.equal(first.ok, true);
  // redirect hop: policy re-runs, resolver now answers loopback → blocked
  const second = await checkUrl("https://evil.example.com/next", opts);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "blocked-private");
});

test("external public origins need per-origin approval", async () => {
  const denied = await checkUrl("https://example.com/docs", { resolve: publicDns });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "approval-required");
  const ok = await checkUrl("https://example.com/docs", {
    approvedOrigins: new Set(["https://example.com"]),
    resolve: publicDns,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.origin, "https://example.com");
});

test("dns failure is an explicit dns-error, not a pass", async () => {
  const d = await checkUrl("https://nope.example.com/", {
    approvedOrigins: new Set(["https://nope.example.com"]),
    resolve: async () => { throw new Error("NXDOMAIN"); },
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "dns-error");
});

test("isPrivateAddress covers v6 forms and treats malformed as unsafe", () => {
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fd00::2"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.0.1"), true);
  assert.equal(isPrivateAddress("2606:4700::1111"), false);
  assert.equal(isPrivateAddress("999.1.1.1"), true);
});

test("originOf canonicalizes for approval keys", () => {
  assert.equal(originOf("HTTPS://Example.COM/path?q=1"), "https://example.com");
  assert.equal(originOf("localhost:5173/workbench"), "http://localhost:5173");
  assert.equal(originOf("not a url"), null);
});

test("originAliases pairs www and apex; loopback and literal IPs are not aliased", () => {
  const aliases = originAliases("https://example.com");
  assert.deepEqual([...aliases].sort(), ["https://example.com", "https://www.example.com"].sort());
  assert.deepEqual(originAliases("https://www.example.com").sort(), aliases.sort());
  assert.deepEqual(originAliases("http://127.0.0.1:5173"), ["http://127.0.0.1:5173"]);
  assert.deepEqual(originAliases("http://93.184.216.34"), ["http://93.184.216.34"]);
});

test("www and apex share an approval in both directions", async () => {
  const approvedWww = await checkUrl("https://example.com/docs", {
    approvedOrigins: new Set(["https://www.example.com"]),
    resolve: publicDns,
  });
  assert.equal(approvedWww.ok, true);
  if (approvedWww.ok) assert.equal(approvedWww.origin, "https://example.com");

  const approvedApex = await checkUrl("https://www.example.com/about", {
    approvedOrigins: new Set(["https://example.com"]),
    resolve: publicDns,
  });
  assert.equal(approvedApex.ok, true);
  if (approvedApex.ok) assert.equal(approvedApex.origin, "https://www.example.com");
});

test("new public origin without approval is still approval-required", async () => {
  const d = await checkUrl("https://other.example.org/", { resolve: publicDns });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "approval-required");
});
