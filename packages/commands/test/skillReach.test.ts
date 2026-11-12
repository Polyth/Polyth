import assert from "node:assert/strict";
import test from "node:test";
import { harnessRuleAllows } from "@polyth/contracts";
import type { SkillReachDto } from "@polyth/contracts/capability-installations";
import {
  applyReachPatch,
  capabilityRule,
  familyMode,
  harnessMode,
  pruneReach,
  reachHasAlways,
  skillReach,
  validReach,
} from "../src/skillReach.ts";

const harnesses = [
  { id: "claude", family: "claude" },
  { id: "claude-work", family: "claude" },
  { id: "codex", family: "codex" },
];
const descriptor = (id: string) => (id.startsWith("claude") ? { id, accounts: { family: "claude" } } : { id });

test("the most specific rule wins: harness, then family, then the default", () => {
  const reach = { default: "some" as const, families: { claude: "on" as const }, harnesses: { "claude-work": "always" as const } };
  assert.deepEqual(harnessMode(reach, harnesses[0]!), { mode: "on", source: "family" });
  assert.deepEqual(harnessMode(reach, harnesses[1]!), { mode: "always", source: "harness" });
  assert.deepEqual(harnessMode(reach, harnesses[2]!), { mode: "off", source: "default" });
  assert.deepEqual(familyMode(reach, "codex"), { mode: "off", source: "default" });
  assert.deepEqual(harnessMode({ ...reach, default: "none" }, harnesses[1]!), { mode: "off", source: "none" });
});

test("an older exclusion list reads as every harness but those", () => {
  assert.deepEqual(skillReach({ offHarnesses: ["codex"] }), { default: "all", harnesses: { codex: "off" } });
  assert.deepEqual(skillReach({}), { default: "all" });
  assert.deepEqual(skillReach({ reach: { default: "none" }, offHarnesses: ["codex"] }), { default: "none" });
});

test("all reaches every harness now and later: every off goes, always stays", () => {
  const next = applyReachPatch(
    { default: "some", families: { claude: "on" }, harnesses: { codex: "off", "claude-work": "always" } },
    { default: "all" },
    harnesses,
  );
  assert.deepEqual(next, { default: "all", harnesses: { "claude-work": "always" } });
});

test("some keeps the skill exactly where it works now", () => {
  const before = { default: "all" as const, harnesses: { codex: "off" as const } };
  const next = applyReachPatch(before, { default: "some" }, harnesses);
  assert.deepEqual(next, { default: "some", families: { claude: "on" } });
  for (const harness of harnesses) assert.equal(harnessMode(next, harness).mode, harnessMode(before, harness).mode, harness.id);
  // A single-account harness is named by itself, not as a family.
  assert.deepEqual(applyReachPatch({ default: "all" }, { default: "some" }, [{ id: "codex", family: "codex" }]), { default: "some", harnesses: { codex: "on" } });
});

test("none keeps every choice for later, and refuses finer changes meanwhile", () => {
  const chosen = { default: "some" as const, families: { claude: "on" as const } };
  const off = applyReachPatch(chosen, { default: "none" }, harnesses);
  assert.deepEqual(off, { default: "none", families: { claude: "on" } });
  assert.deepEqual(applyReachPatch(off, { default: "some" }, harnesses), chosen);
  assert.throws(() => applyReachPatch(off, { harness: { id: "codex", mode: "on" } }, harnesses), /reaches no harness/);
});

test("a rule equal to the broader one is not kept, and null resets", () => {
  const family = applyReachPatch({ default: "some" }, { family: { id: "claude", mode: "on" } }, harnesses);
  assert.deepEqual(family, { default: "some", families: { claude: "on" } });
  const same = applyReachPatch(family, { harness: { id: "claude-work", mode: "on" } }, harnesses);
  assert.deepEqual(same, family, "the account already follows its family");
  const differs = applyReachPatch(family, { harness: { id: "claude-work", mode: "off" } }, harnesses);
  assert.deepEqual(differs.harnesses, { "claude-work": "off" });
  assert.deepEqual(applyReachPatch(differs, { harness: { id: "claude-work", mode: null } }, harnesses), family);
  assert.deepEqual(pruneReach({ default: "all", families: { codex: "on" }, harnesses: { gone: "off" } }, harnesses), { default: "all", harnesses: { gone: "off" } }, "an unknown harness keeps its rule");
  assert.throws(() => applyReachPatch(family, { harness: { id: "../x", mode: "on" } }, harnesses), /invalid/);
});

test("delivery rules agree with the modes, harness by harness", () => {
  const reaches: SkillReachDto[] = [
    { default: "all" as const },
    { default: "all" as const, harnesses: { codex: "off" as const } },
    { default: "some" as const, families: { claude: "always" as const }, harnesses: { "claude-work": "on" as const } },
    { default: "some" as const, harnesses: { codex: "always" as const } },
  ];
  for (const reach of reaches) {
    for (const harness of harnesses) {
      const mode = harnessMode(reach, harness).mode;
      assert.equal(harnessRuleAllows(capabilityRule(reach, "skill"), descriptor(harness.id)), mode !== "off", `${JSON.stringify(reach)} ${harness.id} skill`);
      assert.equal(harnessRuleAllows(capabilityRule(reach, "always"), descriptor(harness.id)), mode === "always", `${JSON.stringify(reach)} ${harness.id} always`);
    }
  }
  assert.equal(capabilityRule({ default: "all" }, "skill"), undefined);
  assert.equal(reachHasAlways({ default: "none", harnesses: { codex: "always" } }), false);
});

test("stored reaches are checked before they are trusted", () => {
  assert.equal(validReach(undefined), true);
  assert.equal(validReach({ default: "some", families: { claude: "on" } }), true);
  assert.equal(validReach({ default: "most" }), false);
  assert.equal(validReach({ default: "all", harnesses: { codex: "maybe" } }), false);
  assert.equal(validReach({ default: "all", harnesses: { "Bad Id": "on" } }), false);
  assert.equal(validReach({ default: "all", harnesses: [] }), false);
});
