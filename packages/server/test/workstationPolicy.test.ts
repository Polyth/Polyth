import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkstationListener, workstationPushDisabled } from "../src/workstationPolicy.ts";

const workstation = { POLYTH_EDITION: "workstation" };

test("the standard edition keeps every listener option", () => {
  assert.doesNotThrow(() => assertWorkstationListener({ hostname: "0.0.0.0", publicOrigin: "https://polyth.example", env: { POLYTH_DEBUG_AGENT_ACCESS: "1" } }));
  assert.equal(workstationPushDisabled({}), false);
});

test("the workstation edition listens on loopback only", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.doesNotThrow(() => assertWorkstationListener({ hostname, publicOrigin: "", env: workstation }));
  }
  for (const hostname of ["0.0.0.0", "::", "[::]", "192.168.1.10", "polyth.local"]) {
    assert.throws(() => assertWorkstationListener({ hostname, publicOrigin: "", env: workstation }), { code: "unavailable-in-edition" });
  }
});

test("the workstation edition refuses switches that publish the server or skip sign-in", () => {
  assert.throws(() => assertWorkstationListener({ hostname: "127.0.0.1", publicOrigin: "https://polyth.example", env: workstation }), { code: "unavailable-in-edition" });
  for (const [name, value] of [["POLYTH_TRUSTED_PROXIES", "10.0.0.1"], ["POLYTH_AGENT_BETA", "1"], ["POLYTH_DEBUG_AGENT_ACCESS", "1"], ["POLYTH_UI_PASSWORD_LOCALHOST", "optional"]]) {
    assert.throws(() => assertWorkstationListener({ hostname: "127.0.0.1", publicOrigin: "", env: { ...workstation, [name!]: value } }), { code: "unavailable-in-edition" }, name);
  }
  assert.doesNotThrow(() => assertWorkstationListener({ hostname: "127.0.0.1", publicOrigin: "", env: { ...workstation, POLYTH_DEBUG_AGENT_ACCESS: "0" } }));
});

test("the workstation edition sends no push notifications", () => {
  assert.equal(workstationPushDisabled(workstation), true);
});
