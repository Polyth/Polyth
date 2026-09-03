import test from "node:test";
import assert from "node:assert/strict";
import { defaultRelayConfig, IROH_RELAY_VERSION, validateRelayConfig } from "../src/index.ts";

test("relay config pins upstream Iroh and TLS 443", () => {
  assert.equal(IROH_RELAY_VERSION, "1.1.0");
  const config = defaultRelayConfig("relay.example.test");
  assert.equal(config.listenPort, 443);
  assert.deepEqual(validateRelayConfig(config), []);
  assert.ok(validateRelayConfig({ ...config, domain: "x" }).includes("domain"));
});
