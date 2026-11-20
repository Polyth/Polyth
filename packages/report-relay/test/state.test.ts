import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ReportState } from "../src/state.ts";
import { fixture } from "./support.ts";

const DAY = 86_400_000;

test("state remembers a report and a fingerprint and survives a reload", (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const file = join(base.data, "state.json");
  const now = 1_700_000_000_000;

  const state = new ReportState(file, () => now);
  state.rememberReport("report-1", { issue: 12, result: "created", at: now });
  state.rememberFingerprint("fingerprint-1", 12, now);
  assert.deepEqual(state.report("report-1"), { issue: 12, result: "created", at: now });
  assert.deepEqual(state.fingerprint("fingerprint-1"), { issue: 12, at: now });

  const reloaded = new ReportState(file, () => now);
  assert.deepEqual(reloaded.report("report-1"), { issue: 12, result: "created", at: now });
  assert.deepEqual(reloaded.fingerprint("fingerprint-1"), { issue: 12, at: now });
  assert.deepEqual(readdirSync(base.data), ["state.json"]);
});

test("a corrupt state file is renamed aside and the state starts empty", (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const file = join(base.data, "state.json");
  writeFileSync(file, "not json at all");

  const state = new ReportState(file, () => 1_700_000_000_000);
  assert.equal(state.report("anything"), undefined);
  const aside = readdirSync(base.data).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(base.data, aside[0]!), "utf8"), "not json at all");
  assert.equal(state.report("anything"), undefined);
});

test("a structurally wrong state file is set aside too", (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const file = join(base.data, "state.json");
  writeFileSync(file, JSON.stringify({ reports: [], fingerprints: "nope" }));
  const state = new ReportState(file, () => 1_700_000_000_000);
  assert.equal(state.report("anything"), undefined);
  assert.equal(readdirSync(base.data).filter((name) => name.startsWith("state.json.corrupt-")).length, 1);
});

test("entries older than 30 days expire and are pruned from the file", (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const file = join(base.data, "state.json");
  const start = 1_700_000_000_000;
  let now = start;

  const state = new ReportState(file, () => now);
  state.rememberReport("old", { issue: 1, result: "created", at: start });
  state.rememberFingerprint("old-fp", 1, start);
  now = start + 31 * DAY;

  assert.equal(state.report("old"), undefined);
  assert.equal(state.fingerprint("old-fp"), undefined);
  state.prune(now);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { reports: Record<string, unknown>; fingerprints: Record<string, unknown> };
  assert.deepEqual(saved.reports, {});
  assert.deepEqual(saved.fingerprints, {});
});

test("a missing file is a fresh, empty state and the first write creates it", (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const file = join(base.data, "nested", "state.json");
  const state = new ReportState(file, () => 1_700_000_000_000);
  assert.equal(state.report("missing"), undefined);
  state.rememberFingerprint("fp", 3, 1_700_000_000_000);
  assert.ok(readFileSync(file, "utf8").includes("\"fp\""));
});
