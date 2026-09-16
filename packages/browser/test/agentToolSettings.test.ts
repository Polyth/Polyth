import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  readBrowserAgentAutoApprove,
  writeBrowserAgentAutoApprove,
} from "../src/agentToolSettings.ts";

const storage = (label: string) => {
  const root = mkdtempSync(join(tmpdir(), `browser-settings-${label}-`));
  mkdirSync(join(root, "packages", "browser"), { recursive: true });
  return createSpaceStorage(root);
};

test("browser agent auto-approve defaults to ON when settings are missing", async () => {
  assert.equal(await readBrowserAgentAutoApprove(storage("missing")), true);
});

test("browser agent auto-approve treats corrupt settings as ON", async () => {
  const next = storage("corrupt");
  writeFileSync(join(next.packageDir("browser"), "agent-auto-approve.json"), "{not json", "utf8");
  assert.equal(await readBrowserAgentAutoApprove(next), true);
});

test("browser agent auto-approve persists explicit OFF and ON", async () => {
  const next = storage("persist");
  assert.equal(await readBrowserAgentAutoApprove(next), true);
  await writeBrowserAgentAutoApprove(next, false);
  assert.equal(await readBrowserAgentAutoApprove(next), false);
  await writeBrowserAgentAutoApprove(next, true);
  assert.equal(await readBrowserAgentAutoApprove(next), true);
});

test("browser agent auto-approve settings stay isolated per Space storage", async () => {
  const spaceA = storage("a");
  const spaceB = storage("b");
  await writeBrowserAgentAutoApprove(spaceA, false);
  await writeBrowserAgentAutoApprove(spaceB, true);
  assert.equal(await readBrowserAgentAutoApprove(spaceA), false);
  assert.equal(await readBrowserAgentAutoApprove(spaceB), true);
});
