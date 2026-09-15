// WP14 URL policy: canonicalization, unsafe schemes, private/loopback
// always-open, approvals, and DNS resolution errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrl, checkNetworkEgress, checkTopLevelNavigation, isInternalBrowserUrl, isPrivateAddress, originAliases, originOf, webSocketUrlAsHttp, type Resolver } from "../src/index.ts";

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

test("loopback opens without approval", async () => {
  for (const raw of ["http://127.0.0.1:5173/app", "http://127.0.0.1:9999/", "http://localhost:9999/"]) {
    const d = await checkUrl(raw, {});
    assert.equal(d.ok, true, raw);
    if (d.ok) assert.equal(d.origin, new URL(raw).origin.toLowerCase(), raw);
  }
});

test("private/link-local/CGNAT/metadata literal IPs open without approval", async () => {
  for (const ip of ["10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.3.2", "0.0.0.0"]) {
    const d = await checkUrl(`http://${ip}/`, {});
    assert.equal(d.ok, true, ip);
  }
});

test("hostname resolving to a private address opens (local-first intranet)", async () => {
  const d = await checkUrl("https://internal.example.com/", {
    resolve: async () => ["10.0.0.5"],
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.origin, "https://internal.example.com");
});

test("DNS rebinding: re-resolving to loopback on a later hop still opens", async () => {
  let calls = 0;
  const flipFlop: Resolver = async () => {
    calls++;
    return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const opts = { approvedOrigins: new Set(["https://evil.example.com"]), resolve: flipFlop };
  const first = await checkUrl("https://evil.example.com/", opts);
  assert.equal(first.ok, true);
  // redirect hop: policy re-runs; loopback is now an allowed target
  const second = await checkUrl("https://evil.example.com/next", opts);
  assert.equal(second.ok, true);
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

test("server-owned exact origins do not inherit the human www/apex alias", async () => {
  const exactWww = await checkUrl("https://www.example.com/login", {
    exactAllowedOrigins: ["https://www.example.com"],
    resolve: publicDns,
  });
  assert.equal(exactWww.ok, true);

  const apex = await checkUrl("https://example.com/", {
    exactAllowedOrigins: ["https://www.example.com"],
    resolve: publicDns,
  });
  assert.equal(apex.ok, false);
  if (!apex.ok) assert.equal(apex.code, "approval-required");

  const exactApex = await checkUrl("https://example.com/", {
    exactAllowedOrigins: ["https://example.com"],
    resolve: publicDns,
  });
  assert.equal(exactApex.ok, true);
  const www = await checkUrl("https://www.example.com/", {
    exactAllowedOrigins: ["https://example.com"],
    resolve: publicDns,
  });
  assert.equal(www.ok, false);
  if (!www.ok) assert.equal(www.code, "approval-required");
});

test("generic Browser still opens private and metadata targets without approval", async () => {
  for (const raw of ["http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.1/", "http://169.254.169.254/"]) {
    const d = await checkUrl(raw, {});
    assert.equal(d.ok, true, raw);
  }
});

test("explicit-only blocks unlisted private, loopback, and metadata targets", async () => {
  const opts = { privateNetwork: "explicit-only" as const, resolve: publicDns };
  for (const raw of [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.9/",
    "http://169.254.169.254/",
  ]) {
    const d = await checkUrl(raw, opts);
    assert.equal(d.ok, false, raw);
    if (!d.ok) assert.equal(d.code, "blocked-private", raw);
  }
});

test("explicit-only allows a listed custom local origin", async () => {
  const d = await checkUrl("http://127.0.0.1:8123/lovelace", {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://127.0.0.1:8123"],
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.origin, "http://127.0.0.1:8123");
});

test("explicit-only listed custom origin does not grant other private ranges", async () => {
  const d = await checkUrl("http://192.168.1.1/", {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://127.0.0.1:8123"],
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "blocked-private");
});

test("explicit-only does not auto-allow a hostname that resolves privately", async () => {
  const d = await checkUrl("http://private.example/", {
    privateNetwork: "explicit-only",
    resolve: async () => ["10.0.0.2"],
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "blocked-private");
});

test("explicit-only listed hostname may resolve privately (custom local DNS)", async () => {
  const d = await checkUrl("http://homeassistant.local/", {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://homeassistant.local"],
    resolve: async () => ["192.168.1.50"],
  });
  assert.equal(d.ok, true);
});

test("explicit-only still requires approval for unlisted public origins", async () => {
  const d = await checkUrl("https://example.com/docs", {
    privateNetwork: "explicit-only",
    resolve: publicDns,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "approval-required");
});

test("subresource purpose allows unlisted public origins without approval", async () => {
  const d = await checkNetworkEgress("https://cdn.example.com/app.js", {
    privateNetwork: "explicit-only",
    resolve: publicDns,
  });
  assert.equal(d.ok, true);
});

test("subresource purpose still blocks unlisted private and metadata destinations", async () => {
  const opts = { privateNetwork: "explicit-only" as const, purpose: "subresource" as const };
  for (const raw of ["http://127.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/"]) {
    const d = await checkUrl(raw, opts);
    assert.equal(d.ok, false, raw);
    if (!d.ok) assert.equal(d.code, "blocked-private", raw);
  }
});

test("subresource purpose allows an explicitly listed custom local origin", async () => {
  const d = await checkNetworkEgress("http://127.0.0.1:8123/api", {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://127.0.0.1:8123"],
  });
  assert.equal(d.ok, true);
});

test("generic Browser subresource still allows private destinations", async () => {
  const d = await checkNetworkEgress("http://192.168.1.1/img.png", {});
  assert.equal(d.ok, true);
});

test("websocket URLs map onto HTTP policy without becoming a navigable scheme", async () => {
  const raw = await checkUrl("ws://127.0.0.1:8123/ws");
  assert.equal(raw.ok, false);
  if (!raw.ok) assert.equal(raw.code, "blocked-scheme");
  const listed = await checkNetworkEgress(webSocketUrlAsHttp("ws://127.0.0.1:8123/ws"), {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://127.0.0.1:8123"],
  });
  assert.equal(listed.ok, true);
  const otherPort = await checkNetworkEgress(webSocketUrlAsHttp("ws://127.0.0.1:9999/ws"), {
    privateNetwork: "explicit-only",
    allowedOrigins: ["http://127.0.0.1:8123"],
  });
  assert.equal(otherPort.ok, false);
  if (!otherPort.ok) assert.equal(otherPort.code, "blocked-private");
});

test("top-level wrapper still requires approval for unlisted public origins", async () => {
  const d = await checkTopLevelNavigation("https://example.com/docs", { resolve: publicDns });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "approval-required");
});

test("isInternalBrowserUrl accepts about:blank variants only", () => {
  assert.equal(isInternalBrowserUrl("about:blank"), true);
  assert.equal(isInternalBrowserUrl(" about:blank#foo "), true);
  assert.equal(isInternalBrowserUrl("about:srcdoc"), true);
  assert.equal(isInternalBrowserUrl("about:config"), false);
  assert.equal(isInternalBrowserUrl("http://127.0.0.1/"), false);
});
