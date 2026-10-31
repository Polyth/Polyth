import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPinnedHttp,
  inspectOutboundHttpUrl,
  isMetadataOrLinkLocal,
  isPrivateAddress,
} from "../src/outboundUrl.ts";
import { createServer } from "node:http";

test("literal metadata and link-local addresses are always blocked", async () => {
  assert.equal(isMetadataOrLinkLocal("169.254.169.254"), true);
  assert.equal(isMetadataOrLinkLocal("::ffff:169.254.169.254"), true);
  assert.equal(isMetadataOrLinkLocal("::ffff:a9fe:a9fe"), true);
  assert.equal(isMetadataOrLinkLocal("fe80::1"), true);
  assert.equal(isMetadataOrLinkLocal("fe90::1"), true);
  assert.equal(isMetadataOrLinkLocal("fea0::1"), true);
  assert.equal(isMetadataOrLinkLocal("febf::1"), true);
  assert.equal(isMetadataOrLinkLocal("fec0::1"), false);
  assert.equal(isMetadataOrLinkLocal("fd00:ec2::254"), true);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("::ffff:c0a8:101"), true);
  assert.equal((await inspectOutboundHttpUrl("http://169.254.169.254", { policy: "user-origin" })).ok, false);
  assert.equal((await inspectOutboundHttpUrl("http://[fe90::1]", { policy: "user-origin" })).ok, false);
  assert.equal((await inspectOutboundHttpUrl("http://[::ffff:a9fe:a9fe]", { policy: "user-origin" })).ok, false);
  assert.equal((await inspectOutboundHttpUrl("http://metadata.google.internal", { policy: "user-origin" })).ok, false);
  assert.equal((await inspectOutboundHttpUrl("javascript:alert(1)", { policy: "user-origin" })).ok, false);
  assert.equal((await inspectOutboundHttpUrl("https://user:pass@example.com", { policy: "user-origin" })).ok, false);
});

test("user-origin allows private LAN; public-only does not", async () => {
  const lan = await inspectOutboundHttpUrl("http://192.168.1.20", { policy: "user-origin" });
  assert.equal(lan.ok, true);
  const blocked = await inspectOutboundHttpUrl("http://192.168.1.20", { policy: "public-only" });
  assert.equal(blocked.ok, false);
  const loopback = await inspectOutboundHttpUrl("http://127.0.0.1:8080", { policy: "user-origin" });
  assert.equal(loopback.ok, true);
});

test("DNS to metadata is blocked even for user-origin", async () => {
  const result = await inspectOutboundHttpUrl("https://sneaky.example", {
    policy: "user-origin",
    resolve: async () => ["169.254.169.254"],
  });
  assert.equal(result.ok, false);
});

test("hostname resolving to RFC1918 is allowed only for user-origin", async () => {
  const allowed = await inspectOutboundHttpUrl("https://nas.local", {
    policy: "user-origin",
    resolve: async () => ["10.0.0.8"],
  });
  assert.equal(allowed.ok, true);
  const denied = await inspectOutboundHttpUrl("https://nas.local", {
    policy: "public-only",
    resolve: async () => ["10.0.0.8"],
  });
  assert.equal(denied.ok, false);
});

test("pinned fetch connects to the inspected IP and sends the original Host", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ host: req.headers.host }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const url = new URL(`http://evil.example:${port}/.well-known/opencode`);
    const response = await fetchPinnedHttp(url, ["127.0.0.1"], { method: "GET" });
    assert.equal(response.status, 200);
    const body = await response.json() as { host: string };
    assert.equal(body.host, `evil.example:${port}`);
  } finally {
    server.close();
  }
});
