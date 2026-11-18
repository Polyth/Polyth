// A Space-scoped session list reads the canonical rows, membership, grants and
// project policy once per call instead of once per row. These tests hold it to
// the per-row decisions it replaced: the same rows, the same per-row content,
// the same reconciliation writes, and a read count that does not grow with the
// number of rows.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { CanonicalSecurity } from "../src/canonicalSecurity.ts";
import { sessionAccess } from "../src/sessionSharing.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

type Fixture = ReturnType<typeof sharingFixture>;
type Grant = { principalId: string; access: "view" | "collaborate" | "manage" };

const HOME = { orgId: "org_home", spaceId: "spc_home" } as const;

/** Today's per-row reader view, kept here as the reference: one `sessionAccess`
 *  per row and one registry/grant read per lookup. */
function referenceRowsForReader(
  security: CanonicalSecurity,
  rows: readonly SessionProjection[],
  readerId: string,
  spaceId: string,
): SessionProjection[] {
  if (!readerId || readerId.startsWith("system:")) return [...rows];
  const resource = (id: string) => security.resources.resource(id);
  type Row = NonNullable<ReturnType<typeof resource>>;
  const shareRoot = (row: Row): Row => {
    let current = row;
    for (let depth = 0; depth < 32 && current.visibility === "inherit" && current.accessParentId; depth += 1) {
      const parent = resource(current.accessParentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const effectiveVisibility = (row: Row): string => {
    let current: Row | undefined = row;
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (current.visibility !== "inherit") return current.visibility;
      const parentId: string | undefined = current.accessParentId ?? current.parentId;
      current = parentId ? resource(parentId) : undefined;
    }
    return "private";
  };
  const memberIds = (): Set<string> => new Set(security.control.all<{ userId: string }>(
    `SELECT m.principal_id AS userId FROM space_memberships m JOIN principals p ON p.id=m.principal_id
      WHERE m.space_id=? AND m.state='active' AND m.role IN ('owner','admin','member','viewer')
        AND (m.expires_at_ms IS NULL OR m.expires_at_ms>?) AND p.kind='user' AND p.status='active'
      ORDER BY m.created_at_ms, m.principal_id`,
    spaceId, Date.now(),
  ).map((member) => member.userId));
  const ownerOf = (principalId: string) => {
    if (!security.control.get("SELECT 1 FROM principals WHERE id=? AND kind='user'", principalId)) return undefined;
    const name = security.control.get<{ name: string }>(
      "SELECT u.display_name AS name FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user'",
      principalId,
    )?.name;
    return { userId: principalId, ...(name ? { name } : {}) };
  };
  const out: SessionProjection[] = [];
  for (const row of rows) {
    const access = sessionAccess(readerId, row.spaceId ?? spaceId, row.id);
    if (!access) continue;
    const members = memberIds();
    const others = [...members].some((id) => id !== readerId);
    const root = shareRoot(access.resource);
    const visibility = effectiveVisibility(access.resource);
    const inherited = access.resource.visibility === "inherit" && !!access.resource.accessParentId;
    const owner = root.ownerPrincipalId === readerId ? undefined : ownerOf(root.ownerPrincipalId);
    let shared = owner !== undefined;
    if (!shared && visibility === "space") shared = others;
    let named = false;
    if (visibility !== "private") {
      named = security.sharing.grants(root.id).some((grant) => grant.principalId !== readerId && members.has(grant.principalId));
    }
    if (!shared && visibility === "restricted") shared = named;
    out.push({
      ...row,
      sharing: { visibility, ...(inherited ? { inherited: true } : {}), access: access.level, ...(owner ? { owner } : {}), shared, ...(named ? { named: true } : {}), ...(others ? { multiPerson: true } : {}) },
    } as SessionProjection);
  }
  return out;
}

/** Today's list: delete reconciliation, then one canonical admission per row
 *  (`snapshot` runs exactly the per-row admission), then the per-row view. */
async function referenceList(f: Fixture, ctx: SpaceContext, projectId?: string): Promise<SessionProjection[]> {
  const canonical = f.canonicalFor(ctx);
  // A project without rows: only the Space-wide delete reconciliation runs.
  await canonical.list("prj_none");
  const admitted: SessionProjection[] = [];
  for (const row of await f.base.list(projectId)) {
    try {
      await canonical.snapshot(row.id);
      admitted.push(row);
    } catch (cause) {
      if ((cause as { code?: unknown }).code !== "not-found") throw cause;
    }
  }
  return referenceRowsForReader(f.security, admitted, ctx.userId, ctx.spaceId);
}

function addPeople(f: Fixture): void {
  f.security.control.transaction(() => {
    for (const [id, name, role] of [["usr_boss", "Bohdan", "owner"], ["usr_plain", "Pavlo", "member"]]) {
      f.security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      f.security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      f.security.control.run(
        "INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home',?,?,1)", id, role,
      );
    }
  });
}

const readers = (f: Fixture): Array<[string, SpaceContext]> => [
  ["space owner", { ...f.ctx("usr_boss"), role: "owner" } as SpaceContext],
  ["member who owns most rows", f.ctx("usr_owner")],
  ["member with restricted grants", f.ctx("usr_member")],
  ["member without restricted access", f.ctx("usr_plain")],
  ["viewer", f.ctx("usr_viewer")],
  ["system", f.system()],
];

/** Ordinary rows: plain, children following their parent, archived, shared to
 *  the Space, restricted to named people, and some owned by another person. */
async function seedSettled(f: Fixture, count: number): Promise<void> {
  addPeople(f);
  const services: Record<string, SessionService> = {
    usr_owner: f.sessionsFor(f.ctx("usr_owner")),
    usr_other: f.sessionsFor(f.ctx("usr_other")),
  };
  const tops: Record<string, string[]> = { usr_owner: [], usr_other: [] };
  const share = (resourceId: string, actor: string, visibility: "space" | "restricted", grants: Grant[]): void => {
    f.security.sharing.share({ resourceId, ...HOME, actor, visibility, grants });
  };
  for (let i = 0; i < count; i += 1) {
    const author = i % 7 === 3 ? "usr_other" : "usr_owner";
    const parentId = i % 5 === 4 ? tops[author]!.at(-1) : undefined;
    const id = `s-${String(i).padStart(4, "0")}`;
    await services[author]!.create({ projectId: "prj_one", id, ...(parentId ? { parentId } : {}) } as never);
    if (parentId) continue;
    tops[author]!.push(id);
    const variant = i % 6;
    if (variant === 0) share(id, author, "space", []);
    if (variant === 1) share(id, author, "restricted", [{ principalId: "usr_member", access: "view" }]);
    if (variant === 2) share(id, author, "restricted", [{ principalId: "usr_member", access: "collaborate" }, { principalId: "usr_viewer", access: "manage" }]);
    if (variant === 3) share(id, author, "space", [{ principalId: "usr_member", access: "manage" }]);
    if (i % 11 === 6) await services[author]!.archive(id);
  }
}

/** Rows that need reconciliation: no canonical row yet, still provisioning,
 *  mid-archive both ways, archived but restored, deleting with and without
 *  its projection, and a row of another Space. */
async function seedRepairs(f: Fixture): Promise<void> {
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const projection = (id: string, status = "idle"): SessionProjection => ({
    id, projectId: "prj_one", spaceId: "spc_home", title: id, status, createdAt: 1, updatedAt: 2,
  } as SessionProjection);
  const move = (id: string, from: "active" | "archiving", to: "archiving" | "archived" | "deleting"): void => {
    f.security.resourceLifecycle.transition({
      resourceId: id, kind: "session", ...HOME, from: [from], to,
      expectedRevision: f.security.resources.resource(id)!.revision,
      actor: "usr_owner", action: "resource.test-setup", bumpAccess: false,
    });
  };
  f.projections.set("s-missing", projection("s-missing"));
  f.security.resources.begin({
    operationId: "op-prov", resourceId: "s-prov", kind: "session", ...HOME, parentId: "prj_one",
    ownerPrincipalId: "usr_owner", createdBy: "usr_owner", visibility: "inherit",
  });
  f.projections.set("s-prov", projection("s-prov"));
  for (const id of ["s-arch-done", "s-arch-back", "s-restore", "s-deleting", "s-gone"]) {
    await owner.create({ projectId: "prj_one", id } as never);
  }
  f.projections.set("s-arch-done", { ...f.projections.get("s-arch-done")!, status: "archived" });
  move("s-arch-done", "active", "archiving");
  move("s-arch-back", "active", "archiving");
  move("s-restore", "active", "archiving");
  move("s-restore", "archiving", "archived");
  move("s-deleting", "active", "deleting");
  move("s-gone", "active", "deleting");
  f.projections.delete("s-gone");
  await f.sessionsFor(f.ctx("usr_outside", "spc_work")).create({ projectId: "prj_work", id: "w-0001" } as never);
}

function controlState(f: Fixture, afterSeq: number) {
  return {
    resources: f.security.control.all(
      `SELECT id,kind,parent_id,access_parent_id,owner_principal_id,visibility,lifecycle,revision,access_revision
         FROM resources ORDER BY id`,
    ),
    provisioning: f.security.control.all("SELECT resource_id,state,revision FROM resource_provisioning ORDER BY resource_id"),
    audit: f.security.control.all("SELECT actor_id,action,resource_id FROM audit_events WHERE seq>? ORDER BY seq", afterSeq),
  };
}

async function scenario(t: test.TestContext, mode: "batched" | "reference") {
  const f = sharingFixture(t);
  await seedSettled(f, 90);
  await seedRepairs(f);
  const seeded = f.security.control.get<{ seq: number }>("SELECT max(seq) AS seq FROM audit_events")!.seq;
  const results: Array<{ reader: string; call: string; rows: SessionProjection[] }> = [];
  // Twice: the first round repairs, the second lists the settled state.
  for (let round = 0; round < 2; round += 1) {
    for (const [reader, ctx] of readers(f)) {
      for (const [call, run, perRow] of [
        ["list(prj_one)", (s: SessionService) => s.list("prj_one"), () => referenceList(f, ctx, "prj_one")],
        ["list()", (s: SessionService) => s.list(), () => referenceList(f, ctx)],
        // The fixture's `sync` returns the project's rows, as `list` does.
        ["sync(prj_one)", (s: SessionService) => s.sync("prj_one"), () => referenceList(f, ctx, "prj_one")],
      ] as const) {
        const rows = mode === "batched" ? await run(f.sessionsFor(ctx)) : await perRow();
        results.push({ reader: `${round}:${reader}`, call, rows });
      }
    }
  }
  return { results, state: controlState(f, seeded) };
}

test("a batched list returns exactly what the per-row list returns and writes the same repairs", async (t) => {
  let batched: Awaited<ReturnType<typeof scenario>> | undefined;
  let reference: Awaited<ReturnType<typeof scenario>> | undefined;
  await t.test("batched", async (st) => { batched = await scenario(st, "batched"); });
  await t.test("per-row reference", async (st) => { reference = await scenario(st, "reference"); });
  assert.ok(batched && reference);
  assert.equal(batched.results.length, reference.results.length);
  for (let i = 0; i < batched.results.length; i += 1) {
    const got = batched.results[i]!;
    const want = reference.results[i]!;
    assert.equal(got.reader, want.reader);
    assert.deepEqual(got.rows, want.rows, `${got.reader} ${got.call}`);
  }
  assert.deepEqual(batched.state, reference.state);

  // The fixture exercises what it claims to.
  const count = (reader: string, call = "list(prj_one)") =>
    batched!.results.find((entry) => entry.reader === reader && entry.call === call)!.rows.length;
  assert.ok(count("1:system") > count("1:member who owns most rows"));
  assert.ok(count("1:member with restricted grants") > count("1:member without restricted access"));
  assert.ok(count("1:member without restricted access") > 0);
  assert.equal(count("1:system", "list()"), count("1:system"), "another Space's row is never listed");
  const repairs = batched.state.audit.map((event) => `${(event as { action: string }).action} ${(event as { resource_id: string }).resource_id}`);
  for (const expected of [
    "resource.provisioning-begun s-missing", "resource.activated s-prov", "resource.archived s-arch-done",
    "resource.archive-rolled-back s-arch-back", "resource.restored s-restore", "resource.delete-reconciled s-gone",
  ]) assert.ok(repairs.includes(expected), `${expected} in ${repairs.join(", ")}`);
  const levels = new Set(batched.results.flatMap((entry) => entry.rows.map((row) => row.sharing?.access ?? "none")));
  assert.deepEqual([...levels].sort(), ["collaborate", "manage", "none", "view"]);
});

test("listing settled rows reads the control plane a constant number of times", async (t) => {
  const readsFor = async (st: test.TestContext, rows: number): Promise<Record<string, number>> => {
    const f = sharingFixture(st);
    await seedSettled(f, rows);
    const control = f.security.control;
    const original = { get: control.get, all: control.all };
    let reads = 0;
    control.get = ((...args: Parameters<typeof control.get>) => { reads += 1; return original.get.apply(control, args); }) as typeof control.get;
    control.all = ((...args: Parameters<typeof control.all>) => { reads += 1; return original.all.apply(control, args); }) as typeof control.all;
    const out: Record<string, number> = {};
    try {
      for (const [reader, ctx] of readers(f)) {
        const sessions = f.sessionsFor(ctx);
        reads = 0;
        const listed = await sessions.list("prj_one");
        out[reader] = reads;
        if (reader !== "viewer") assert.ok(listed.length > 0, reader);
      }
    } finally {
      Object.assign(control, original);
    }
    return out;
  };
  let small: Record<string, number> = {};
  let large: Record<string, number> = {};
  await t.test("40 rows", async (st) => { small = await readsFor(st, 40); });
  await t.test("200 rows", async (st) => { large = await readsFor(st, 200); });
  assert.deepEqual(large, small);
  for (const [reader, reads] of Object.entries(large)) assert.ok(reads <= 16, `${reader}: ${reads} reads`);
});
