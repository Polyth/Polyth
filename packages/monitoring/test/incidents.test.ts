import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCIDENT_QUIET_MS, INCIDENT_WRITE_INTERVAL_MS, incidentStore } from "../src/incidents.ts";

const storageIn = (dir: string) => (spaceId: string) => ({
  root: join(dir, spaceId),
  packageDir: (id: string) => { const path = join(dir, spaceId, "packages", id); mkdirSync(path, { recursive: true }); return path; },
  path: (relative: string) => join(dir, spaceId, relative),
});

const tempDir = (t: { after(fn: () => void): void }): string => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-incidents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("incident state is per Space, persisted and expired at the quiet window", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  const store = incidentStore(storageIn(dir)("s"));
  store.open("p", "chat-1", 1_000);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 1, projects: { p: { sessionId: "chat-1", openedAt: 1_000, lastWarningAt: 1_000 } } },
    "only ids and timestamps reach disk");

  assert.equal(store.active(1_000 + INCIDENT_QUIET_MS - 1, "p")?.sessionId, "chat-1");
  assert.equal(store.active(1_000 + INCIDENT_QUIET_MS, "p"), undefined, "a quiet window expires the incident");

  const restarted = incidentStore(storageIn(dir)("s"));
  assert.equal(restarted.active(2_000, "p")?.sessionId, "chat-1", "a fresh instance reads the same Space's file");
  assert.equal(incidentStore(storageIn(dir)("t")).active(2_000, "p"), undefined, "another Space never sees it");
});

test("a warning refresh writes at most once per interval", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  const store = incidentStore(storageIn(dir)("s"));
  store.open("p", "chat-1", 0);
  store.touch("p", INCIDENT_WRITE_INTERVAL_MS - 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projects.p.lastWarningAt, 0, "a recent warning does not hit the disk");
  store.touch("p", INCIDENT_WRITE_INTERVAL_MS);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projects.p.lastWarningAt, INCIDENT_WRITE_INTERVAL_MS);
  assert.equal(incidentStore(storageIn(dir)("s")).active(INCIDENT_WRITE_INTERVAL_MS, "p")?.sessionId, "chat-1",
    "the refreshed timestamp keeps the incident alive across a restart");
});

test("the open count ignores expired incidents and a write drops them", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  const store = incidentStore(storageIn(dir)("s"));
  store.open("p", "chat-1", 0);
  store.open("q", "chat-2", INCIDENT_QUIET_MS - 1);
  assert.equal(store.openCount(INCIDENT_QUIET_MS), 1, "only incidents inside their window count");
  store.open("r", "chat-3", INCIDENT_QUIET_MS);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).projects), ["q", "r"], "a write drops the expired entry");
});

test("a corrupt file is empty state, warns once and is replaced by the next write", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  mkdirSync(join(dir, "s", "packages/monitoring"), { recursive: true });
  writeFileSync(file, "{not json");
  const store = incidentStore(storageIn(dir)("s"));
  assert.equal(store.active(0, "p"), undefined);
  assert.equal(store.openCount(0), 0);
  store.open("p", "chat-1", 10);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 1, projects: { p: { sessionId: "chat-1", openedAt: 10, lastWarningAt: 10 } } });
});

test("records with the wrong shape or a missing file are ignored, never thrown", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  mkdirSync(join(dir, "s", "packages/monitoring"), { recursive: true });
  assert.equal(incidentStore(storageIn(dir)("s")).active(0, "p"), undefined, "a missing file is empty state");
  writeFileSync(file, JSON.stringify({ v: 1, projects: { p: { sessionId: 7, openedAt: "x" }, q: { sessionId: "chat-2", openedAt: 1, lastWarningAt: 1 } } }));
  const store = incidentStore(storageIn(dir)("s"));
  assert.equal(store.active(2, "p"), undefined, "an invalid record is skipped");
  assert.equal(store.active(2, "q")?.sessionId, "chat-2", "a valid sibling still loads");
});
