import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantCapabilities, missingRequiredGrants, readGrants } from "../src/grants.ts";
import { testSpaceStorage } from "./helpers.ts";

test("approved capability replacement can remove one previous bound", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-grant-scope-"));
  const storage = testSpaceStorage(root);
  grantCapabilities(storage, "com-example", [{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com"],
      methods: ["GET"],
    },
  }]);
  grantCapabilities(storage, "com-example", [{
    name: "network.fetch",
    constraints: { methods: ["GET"] },
  }]);

  const grant = readGrants(storage, "com-example").find((item) => item.name === "network.fetch");
  assert.deepEqual(grant?.constraints, { methods: ["GET"] });
  assert.equal(missingRequiredGrants(readGrants(storage, "com-example"), [{
    name: "network.fetch",
    constraints: { methods: ["GET"] },
  }]).length, 0);
});

test("approved capability replacement can become fully unconstrained", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-grant-unbounded-"));
  const storage = testSpaceStorage(root);
  grantCapabilities(storage, "com-example", [{
    name: "network.fetch",
    constraints: { origins: ["https://api.example.com"] },
  }]);
  grantCapabilities(storage, "com-example", [{ name: "network.fetch" }]);

  const grant = readGrants(storage, "com-example").find((item) => item.name === "network.fetch");
  assert.equal(grant?.constraints, undefined);
  assert.equal(missingRequiredGrants(readGrants(storage, "com-example"), [{ name: "network.fetch" }]).length, 0);
});

test("approved model grant can remove a previous output-token ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-grant-model-"));
  const storage = testSpaceStorage(root);
  grantCapabilities(storage, "com-example", [{
    name: "model.generate",
    constraints: { modelClasses: ["utility"], maxOutputTokens: 512 },
  }]);
  grantCapabilities(storage, "com-example", [{
    name: "model.generate",
    constraints: { modelClasses: ["utility"] },
  }]);

  const grant = readGrants(storage, "com-example").find((item) => item.name === "model.generate");
  assert.deepEqual(grant?.constraints, { modelClasses: ["utility"] });
});
