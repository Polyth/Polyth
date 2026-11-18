import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentPackageRelevanceGate,
  isAgentPackageRelevant,
} from "../src/projectCompositionAgentGate.ts";

const fixture = () => mkdtempSync(join(tmpdir(), "polyth-agent-composition-"));
const write = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value));

test("agent package relevance follows project directions without becoming authorization", () => {
  const dir = fixture();
  write(dir, "projects.json", [{ id: "eng", composition: { version: 1, directions: ["engineering"], packageOverrides: {} } }]);
  write(dir, "package-composition.json", {
    git: { category: "engineering", projectAffinity: { directions: ["engineering"], recommended: true } },
    finance: { category: "finance", projectAffinity: { directions: ["finance"], recommended: true } },
  });
  assert.equal(isAgentPackageRelevant(dir, "git", { projectId: "eng" }), true);
  assert.equal(isAgentPackageRelevant(dir, "finance", { projectId: "eng" }), false);
});

test("explicit override applies to unclassified/managed owners and projects stay isolated", () => {
  const dir = fixture();
  write(dir, "projects.json", [
    { id: "a", composition: { version: 1, directions: ["engineering"], packageOverrides: { custom: "exclude", finance: "include" } } },
    { id: "b", composition: { version: 1, directions: ["engineering"], packageOverrides: {} } },
  ]);
  write(dir, "package-composition.json", { finance: { projectAffinity: { directions: ["finance"] } } });
  assert.equal(isAgentPackageRelevant(dir, "custom", { projectId: "a" }), false);
  assert.equal(isAgentPackageRelevant(dir, "custom", { projectId: "b" }), true);
  assert.equal(isAgentPackageRelevant(dir, "finance", { projectId: "a" }), true);
  assert.equal(isAgentPackageRelevant(dir, "finance", { projectId: "b" }), false);
});

test("legacy, missing and malformed relevance metadata fail open", () => {
  const dir = fixture();
  write(dir, "projects.json", [
    { id: "legacy" },
    { id: "bad", composition: { version: 1, directions: "engineering", packageOverrides: {} } },
  ]);
  write(dir, "package-composition.json", { broken: { projectAffinity: { directions: ["typo"] } } });
  assert.equal(isAgentPackageRelevant(dir, "broken", { projectId: "legacy" }), true);
  assert.equal(isAgentPackageRelevant(dir, "broken", { projectId: "bad" }), true);
  assert.equal(isAgentPackageRelevant(dir, "missing", { projectId: "missing" }), true);
});

test("controller gate batches one context but observes later project changes", async () => {
  const dir = fixture();
  const context = { projectId: "p" };
  write(dir, "package-composition.json", {
    finance: { projectAffinity: { directions: ["finance"] } },
    git: { projectAffinity: { directions: ["engineering"] } },
  });
  write(dir, "projects.json", [
    { id: "p", composition: { version: 1, directions: ["engineering"], packageOverrides: {} } },
  ]);
  const relevant = createAgentPackageRelevanceGate(dir);
  assert.equal(relevant("git", context), true);
  assert.equal(relevant("finance", context), false);

  // A synchronous resolve batch is internally consistent even if disk changes
  // mid-stack. The cache expires before the next microtask/turn.
  write(dir, "projects.json", [
    { id: "p", composition: { version: 1, directions: ["finance"], packageOverrides: {} } },
  ]);
  assert.equal(relevant("finance", context), false);
  await Promise.resolve();
  assert.equal(relevant("finance", context), true);
  assert.equal(relevant("git", context), false);
});

test("the registry is parsed once while projects.json is unchanged, and re-read after a rewrite", async () => {
  const dir = fixture();
  const file = join(dir, "projects.json");
  write(dir, "projects.json", [{ id: "p", composition: { version: 1, directions: ["engineering"], packageOverrides: { x: "exclude" } } }]);
  const gate = createAgentPackageRelevanceGate(dir);
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parses++; return parse(...args); }) as typeof JSON.parse;
  try {
    for (let turn = 0; turn < 5; turn++) {
      assert.equal(gate("x", { projectId: "p" }), false);
      await Promise.resolve();
    }
    assert.equal(parses, 1, "projects.json is parsed once across five turns");
    const rewritten = JSON.stringify([{ id: "p", composition: { version: 1, directions: ["engineering"], packageOverrides: { x: "include" } } }]);
    writeFileSync(`${file}.tmp`, rewritten);
    renameSync(`${file}.tmp`, file);
    await Promise.resolve();
    assert.equal(gate("x", { projectId: "p" }), true);
  } finally {
    JSON.parse = parse;
  }
});
