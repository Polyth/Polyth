import test from "node:test";
import assert from "node:assert/strict";
import { brokerFetch, isBlockedIp } from "../src/networkBroker.ts";

test("blocked destinations include loopback, private, link-local, and metadata", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "192.168.1.8", "172.16.4.4", "169.254.169.254",
    "198.18.1.1", "192.0.0.8", "224.0.0.1", "240.0.0.1",
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp("1.1.1.1"), false);
});

test("broker fetch denies undeclared origins, private literals, metadata, and forbidden headers", async () => {
  const origins = ["https://api.example.com"];
  await assert.rejects(
    () => brokerFetch({ url: "https://evil.example/x" }, origins),
    /not declared/,
  );
  await assert.rejects(
    () => brokerFetch({ url: "http://api.example.com/x" }, origins),
    /https/,
  );
  await assert.rejects(
    () => brokerFetch({ url: "https://127.0.0.1/secret" }, origins),
    /private|declared|loopback/,
  );
  await assert.rejects(
    () => brokerFetch({ url: "https://169.254.169.254/latest/meta-data" }, ["https://169.254.169.254"]),
    /private|blocked/,
  );
  await assert.rejects(
    () => brokerFetch({ url: "https://api.example.com/", headers: { Authorization: "secret" } }, origins),
    /header/,
  );
});
