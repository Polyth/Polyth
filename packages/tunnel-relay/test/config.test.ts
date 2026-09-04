import test from "node:test";
import assert from "node:assert/strict";
import { defaultRelayConfig, IROH_RELAY_VERSION, validateRelayConfig } from "../src/index.ts";

test("experimental relay config matches the Rust binary bind, not production TLS/443", () => {
  assert.equal(IROH_RELAY_VERSION, "1.1.0");
  const config = defaultRelayConfig();
  assert.equal(config.httpBind, "127.0.0.1:3340");
  assert.deepEqual(validateRelayConfig(config), []);
  assert.ok(validateRelayConfig({ httpBind: "" }).includes("httpBind"));
});
