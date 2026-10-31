import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PLACEMENT_OVERRIDES,
  capabilityLayoutStorageKey,
  parseCapabilityLayout,
  resolvePlacements,
} from "../src/capabilityLayout.ts";
import { workspaceModeStorageKey } from "../src/widgets/workspaceMode.ts";

test("project canvas and capability settings use project-scoped keys", () => {
  assert.equal(
    capabilityLayoutStorageKey("project-a"),
    "polyth.capabilityLayout.v1.project-a",
  );
  assert.equal(
    workspaceModeStorageKey("project-a"),
    "polyth.workspaceMode.v1.project-a",
  );
  assert.notEqual(
    capabilityLayoutStorageKey("project-a"),
    capabilityLayoutStorageKey("project-b"),
  );
});

test("capability layout parsing is bounded and rejects malformed placements", () => {
  const placements: Record<string, unknown> = {};
  for (let index = 0; index < 300; index++) {
    placements[`cap-${index}`] = { tier: "more", rank: index };
  }
  placements.invalidTier = { tier: "hidden", rank: 1 };
  placements.invalidRank = { tier: "primary", rank: "first" };

  const parsed = parseCapabilityLayout(JSON.stringify({ version: 1, placements }));
  assert.equal(Object.keys(parsed.placements).length, MAX_PLACEMENT_OVERRIDES);
  assert.equal(parsed.placements.invalidTier, undefined);
  assert.equal(parsed.placements.invalidRank, undefined);
  assert.deepEqual(parseCapabilityLayout("not-json"), { version: 1, placements: {} });
});

test("capability placement overrides preserve the full capability set", () => {
  const capabilities = [
    { id: "chat", standardTier: "primary" as const, standardRank: 0 },
    { id: "files", standardTier: "primary" as const, standardRank: 1 },
    { id: "terminal", standardTier: "technical" as const, standardRank: 10 },
  ];
  const resolved = resolvePlacements(capabilities, {
    terminal: { tier: "primary", rank: 0.5 },
    ghost: { tier: "primary", rank: 0 },
  });
  assert.deepEqual(resolved.map((placement) => placement.id), ["chat", "terminal", "files"]);
  assert.equal(resolved.length, capabilities.length);
});
