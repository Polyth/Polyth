import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentPackageRelevant } from "../src/projectCompositionAgentGate.ts";

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
