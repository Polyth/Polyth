// The remembered navigator: only summary fields of the open project's newest
// and pinned rows, never archived ones, always under the Link store's record
// cap; a malformed or foreign record reads as nothing.
import test from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection } from "@polyth/contracts";
import {
  NAVIGATOR_SNAPSHOT_MAX_BYTES,
  NAVIGATOR_SNAPSHOT_ROWS,
  decodeNavigatorSnapshot,
  encodeNavigatorSnapshot,
  snapshotRows,
} from "../src/navigatorSnapshot.ts";

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });
const row = (id: string, updatedAt: number, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id,
  projectId: "p1",
  title: `Chat ${id}`,
  status: "idle",
  createdAt: 1,
  updatedAt,
  ...extra,
} as SessionProjection);

test("rows: the open project's newest page plus pinned ones, summary fields only", () => {
  const sessions = [
    ...Array.from({ length: NAVIGATOR_SNAPSHOT_ROWS + 5 }, (_, index) => row(`r${index}`, 1_000 + index)),
    row("old-pinned", 1, { pinned: { position: 0 } }),
    row("archived", 9_999, { status: "archived" }),
    row("elsewhere", 9_999, { projectId: "p2" }),
    row("detailed", 9_998, { draft: "private draft text" } as Partial<SessionProjection>),
  ];
  const rows = snapshotRows(sessions, "p1");
  const ids = rows.map((entry) => entry.id);
  assert.equal(ids[0], "detailed", "newest first");
  assert.equal(ids.includes("archived"), false);
  assert.equal(ids.includes("elsewhere"), false);
  assert.ok(ids.includes("old-pinned"), "a pinned row is kept however old");
  assert.equal(ids.length, NAVIGATOR_SNAPSHOT_ROWS + 1);
  assert.ok(rows.every((entry) => entry.summary === true), "an open still reads the full session");
  assert.equal("draft" in rows[0]!, false, "detail fields are not kept");
  assert.deepEqual(snapshotRows(sessions, null), []);
});

test("encode stays under the record cap by dropping the oldest rows; decode rejects what it cannot trust", () => {
  const big = "x".repeat(4_000);
  const sessions = Array.from({ length: 80 }, (_, index) => ({ ...row(`r${index}`, 80 - index, { title: big }), summary: true as const }));
  const encoded = encodeNavigatorSnapshot({ savedAt: 5, spaceId: "spc_1", projects: [project("p1")], projectId: "p1", sessions, branch: null });
  assert.ok(encoded !== null && encoded.length <= NAVIGATOR_SNAPSHOT_MAX_BYTES);
  const decoded = decodeNavigatorSnapshot(encoded);
  assert.ok(decoded);
  assert.ok(decoded.sessions.length > 0 && decoded.sessions.length < 80);
  assert.equal(decoded.sessions[0]!.id, "r0", "the newest rows survive");
  assert.equal(decoded.spaceId, "spc_1");

  assert.equal(encodeNavigatorSnapshot({ savedAt: 5, spaceId: "s", projects: [], projectId: null, sessions: [], branch: null }), null);
  assert.equal(decodeNavigatorSnapshot(null), null);
  assert.equal(decodeNavigatorSnapshot("{"), null);
  assert.equal(decodeNavigatorSnapshot(JSON.stringify({ v: 2, spaceId: "s", savedAt: 1, projects: [project("p1")], projectId: null, sessions: [] })), null);
  const foreignRows = decodeNavigatorSnapshot(JSON.stringify({
    v: 1, spaceId: "s", savedAt: 1, projects: [project("p1")], projectId: "p1",
    sessions: [{ ...row("mine", 1), summary: true }, { ...row("theirs", 1, { projectId: "p9" }), summary: true }, row("full", 1)],
  }));
  assert.deepEqual(foreignRows?.sessions.map((entry) => entry.id), ["mine"], "rows of another project or full projections are dropped");
});

test("the branch label rides along only as a non-empty label of the kept project", () => {
  const encoded = encodeNavigatorSnapshot({ savedAt: 1, spaceId: "s", projects: [project("p1")], projectId: "p1", sessions: [], branch: { scope: "/wt/a", label: "feature/a" } });
  assert.deepEqual(decodeNavigatorSnapshot(encoded)?.branch, { scope: "/wt/a", label: "feature/a" });
  const empty = JSON.stringify({ v: 1, spaceId: "s", savedAt: 1, projects: [project("p1")], projectId: "p1", sessions: [], branch: { scope: "", label: "" } });
  assert.equal(decodeNavigatorSnapshot(empty)?.branch, null);
  const malformed = JSON.stringify({ v: 1, spaceId: "s", savedAt: 1, projects: [project("p1")], projectId: "p1", sessions: [], branch: "main" });
  assert.equal(decodeNavigatorSnapshot(malformed)?.branch, null);
});
