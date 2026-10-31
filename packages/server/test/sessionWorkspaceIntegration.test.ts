import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "@polyth/session";
import type { AgentRuntime, AttachmentRef, Project, ProjectService, RuntimeEvent, WorkspaceContext, WorkspaceMutationScope } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createAttachmentSourceService } from "../../files/src/serverEntry.ts";
import { createFileService } from "../../files/src/index.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Harness = ReturnType<typeof makeHarness>;

function makeRuntime(beforeStart?: (sessionId: string) => Promise<void>) {
  const listeners = new Set<(id: string, event: RuntimeEvent) => void | Promise<void>>();
  const starts: Array<{ text: string; workspace?: WorkspaceContext; attachments?: AttachmentRef[] }> = [];
  const releases: string[] = [];
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false,
      subagents: false, steering: false, attachments: { modalities: { file: "native" } },
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => `backend-${input.sessionId}`,
    resetSession: async () => "fresh-runtime-session",
    releaseExecution: async (binding) => {
      releases.push(binding.location.directory);
      return {
        kind: "confirmed",
        value: { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId! },
      };
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (input) => {
      await beforeStart?.(input.sessionId);
      starts.push({
        text: input.text,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      await Promise.all([...listeners].map((listener) => listener(input.sessionId, {
        type: "turn/started", turnId: `turn-${starts.length}`,
      })));
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: async () => {},
  };
  return { runtime, starts, releases };
}

function makeHarness(options: { root?: string; spaceId?: string; onEvent?: Broadcaster["event"]; onRuntimeAcquire?: () => void } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "polyth-workspace-integration-"));
  const secondary = join(root, "secondary");
  mkdirSync(secondary, { recursive: true });
  writeFileSync(join(secondary, "notes.md"), "secondary notes");
  const project: Project = {
    id: "project-1", name: "Project", path: root, createdAt: 1,
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    primaryRepositoryId: "repo-primary",
    repositories: [
      { id: "repo-primary", alias: "app", path: root },
      { id: "repo-secondary", alias: "docs", path: secondary },
    ],
  };
  let projectVisible = true;
  const projects: ProjectService = {
    list: async () => projectVisible ? [project] : [], get: async (id) => projectVisible && id === project.id ? project : undefined,
    add: async () => project, create: async () => project, remove: async () => {},
  };
  const permissions = { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: options.onEvent ?? (() => {}), projection: () => {} };
  const store = createStore(join(root, "session.db"));
  const fake = makeRuntime(async (sessionId) => {
    const message = (await store.events(sessionId)).find((event) => event.type === "user/message");
    const recoveryContext = (message?.data as { recoveryContext?: unknown } | undefined)?.recoveryContext;
    if (typeof recoveryContext !== "string" || !recoveryContext.includes("Session workspace manifest")) {
      throw new Error("workspace manifest was not durable before backend delivery");
    }
  });
  const sessions = createSessionService({
    store, projects, permissions, broadcast,
    runtimes: { forProject: async () => { options.onRuntimeAcquire?.(); return fake.runtime; } },
    attachments: createAttachmentSourceService(async () => createFileService()),
  });
  return { root, secondary, project, fake, store, sessions, projects, hideProject: () => { projectVisible = false; } };
}

async function reopen(harness: Harness): Promise<Harness> {
  const root = harness.root;
  harness.sessions.dispose();
  await harness.store.close();
  return makeHarness({ root, spaceId: harness.project.spaceId });
}

test("subset workspace survives persistence and reopen", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id, repositoryIds: ["repo-secondary"] });
  const before = await harness.store.projection(created.id);
  assert.deepEqual(before?.workspace?.repositories.map((row) => row.repositoryId), ["repo-secondary"]);
  const reopened = await reopen(harness);
  const after = await reopened.store.projection(created.id);
  assert.deepEqual(after?.workspace?.repositories.map((row) => row.repositoryId), ["repo-secondary"]);
  reopened.sessions.dispose();
  await reopened.store.close();
});

test("session creation rejects a secondary checkout outside its registered inventory", async () => {
  const harness = makeHarness();
  try {
    await assert.rejects(harness.sessions.create({ projectId: harness.project.id,
      workspace: { revision: 1, mode: "all", executionRepositoryId: "repo-primary", repositories: [
        { repositoryId: "repo-primary", path: harness.root, state: "ready" },
        { repositoryId: "repo-secondary", path: join(harness.root, "foreign-checkout"), state: "ready" },
      ] },
    }), /workspace checkout is not registered/);
    assert.equal(harness.fake.starts.length, 0);
  } finally {
    harness.sessions.dispose();
    await harness.store.close();
  }
});

test("workspace update uses durable event plus projection CAS", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const updated = await harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-primary"], expectedRevision: 1 });
  assert.equal(updated.workspace?.revision, 2);
  assert.equal((await harness.store.projection(created.id))?.workspace?.revision, 2);
  assert.ok((await harness.store.events(created.id)).some((event) => event.type === "session/workspace-updated"));
  await assert.rejects(
    harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-primary"], expectedRevision: 1 }),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  harness.sessions.dispose();
  await harness.store.close();
});

test("workspace update refuses active and uncertain sessions", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const current = await harness.store.projection(created.id);
  await harness.store.upsertProjection({ ...current!, status: "working" });
  await assert.rejects(() => harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-primary"] }), /active execution/);
  await harness.store.upsertProjection({ ...current!, status: "unknown" });
  await assert.rejects(() => harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-primary"] }), /active execution/);
  harness.sessions.dispose();
  await harness.store.close();
});

// A turn that stopped on a harness error parks the session in `failed`; its
// isolated work must still be integrable (no admitted turn is running).
test("workspace mutation accepts a failed session", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const current = await harness.store.projection(created.id);
  await harness.store.upsertProjection({ ...current!, status: "failed" });
  const updated = await harness.sessions.withWorkspaceMutation(created.id, current!.workspace!.revision, async (scope) => {
    const snapshot = await scope.snapshot();
    const workspace = snapshot.workspace!;
    return scope.commit({
      ...workspace,
      repositories: workspace.repositories.map((row) => row.repositoryId === "repo-primary"
        ? { ...row, branch: "merged-branch" }
        : row),
    }, { branch: "merged-branch" });
  });
  assert.equal(updated.branch, "merged-branch");
  assert.equal(
    (await harness.store.projection(created.id))?.workspace?.repositories
      .find((row) => row.repositoryId === "repo-primary")?.branch,
    "merged-branch",
  );
  harness.sessions.dispose();
  await harness.store.close();
});

test("workspace update fails closed when the project is no longer visible", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  harness.hideProject();
  await assert.rejects(
    harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-primary"] }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  harness.sessions.dispose();
  await harness.store.close();
});

test("removing a missing execution anchor releases it before the new anchor is committed", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const current = await harness.store.projection(created.id);
  await harness.store.upsertProjection({
    ...current!,
    workspace: {
      ...current!.workspace!,
      repositories: current!.workspace!.repositories.map((row) => row.repositoryId === "repo-primary"
        ? { ...row, state: "missing" as const }
        : row),
    },
    runtimeBinding: {
      canonicalSessionId: created.id,
      backendSessionId: `backend-${created.id}`,
      authorityId: "fake-authority",
      generation: 1,
      continuity: "generation-only",
      location: { directory: harness.root },
    },
  });
  const updated = await harness.sessions.updateWorkspace(created.id, {
    repositoryIds: ["repo-secondary"], expectedRevision: 1,
  });
  assert.equal(harness.fake.releases.length, 1);
  assert.equal(harness.fake.releases[0], harness.root);
  assert.equal(updated.workspace?.executionRepositoryId, "repo-secondary");
  assert.equal(updated.workspace?.revision, 2);
  const change = (await harness.store.events(created.id)).findLast((event) => event.type === "session/workspace-updated");
  assert.deepEqual(change?.data.workspace, updated.workspace);
  assert.equal(updated.workspace?.repositories.some((row) => row.repositoryId === "repo-primary"), false);
  await assert.rejects(
    harness.sessions.rebindWorkspace!(created.id, {
      executionRepositoryId: "repo-primary",
      expectedWorkspaceRevision: 1,
      workspace: updated.workspace,
      worktreePath: harness.root,
    }),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  harness.sessions.dispose();
  await harness.store.close();
});

test("multi-repository manifest is persisted before native delivery", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  await harness.sessions.send(created.id, { text: "inspect both repositories" });
  const events = await harness.store.events(created.id);
  const message = events.find((event) => event.type === "user/message");
  const recoveryContext = (message?.data as { recoveryContext?: unknown } | undefined)?.recoveryContext;
  const manifest = typeof recoveryContext === "string" ? recoveryContext.indexOf("Session workspace manifest") : -1;
  assert.ok(message);
  assert.ok(manifest >= 0);
  assert.ok(harness.fake.starts.length >= 1);
  assert.deepEqual((message?.data as { workspace?: unknown })?.workspace, harness.fake.starts[0]?.workspace);
  harness.sessions.dispose();
  await harness.store.close();
});

test("explicit relocation releases the old execution authority before committing the located path", async () => {
  const harness = makeHarness();
  try {
    const created = await harness.sessions.create({ projectId: harness.project.id, repositoryIds: ["repo-secondary"] });
    const current = (await harness.store.projection(created.id))!;
    await harness.store.upsertProjection({ ...current, workspace: { ...current.workspace!, repositories: current.workspace!.repositories.map((row) => ({ ...row, state: "missing" as const })) }, runtimeBinding: {
      canonicalSessionId: created.id, backendSessionId: current.backendSessionId!, authorityId: "fake-authority", generation: 1,
      continuity: "generation-only", location: { directory: harness.secondary },
    } });
    const located = join(harness.root, "located-docs");
    mkdirSync(located);
    harness.project.repositories = harness.project.repositories!.map((row) => row.id === "repo-secondary" ? { ...row, path: located } : row);
    await assert.rejects(() => harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-secondary"], expectedRevision: 1 }), /missing|unavailable/);
    assert.deepEqual(harness.fake.releases, []);
    const repaired = await harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-secondary"], expectedRevision: 1, relocateRepositoryIds: ["repo-secondary"] });
    assert.deepEqual(harness.fake.releases, [harness.secondary]);
    assert.equal(repaired.workspace?.revision, 2);
    assert.deepEqual(repaired.workspace?.repositories.map((row) => [row.repositoryId, row.path, row.state]), [["repo-secondary", located, "ready"]]);
    const event = (await harness.store.events(created.id)).findLast((row) => row.type === "session/workspace-updated");
    assert.deepEqual(event?.data.workspace, repaired.workspace);
    await assert.rejects(() => harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-secondary"], expectedRevision: 1, relocateRepositoryIds: ["repo-secondary"] }), /stale/);
  } finally {
    harness.sessions.dispose();
    await harness.store.close();
  }
});

test("a completed child can leave its parent's checkout through a canonical execution relocation", async () => {
  const harness = makeHarness();
  try {
    const created = await harness.sessions.create({ projectId: harness.project.id });
    const current = (await harness.store.projection(created.id))!;
    const source = join(harness.root, "completed-parent");
    mkdirSync(source);
    let released = false;
    const releaseExecution = harness.fake.runtime.releaseExecution!;
    harness.fake.runtime.endpoint = async () => ({
      authorityId: released ? "located-authority" : "fake-authority",
      generation: released ? 2 : 1, continuity: "generation-only",
      url: "http://fake",
      location: { directory: released ? harness.root : source },
      control: { kind: "owned", instanceToken: "test-owner" },
      config: { kind: "read-only" }, authentication: { kind: "none" },
    });
    harness.fake.runtime.releaseExecution = async (binding, operationId) => {
      const outcome = await releaseExecution(binding, operationId);
      released = outcome.kind === "confirmed";
      return outcome;
    };
    let resetOperationId: string | undefined;
    let observation = 0;
    harness.fake.runtime.resetSessionOperation = async (_request, operationId) => {
      resetOperationId = operationId;
      return {
        kind: "confirmed", value: { backendSessionId: "fresh-runtime-session" },
        receipt: "fresh-runtime-session",
      };
    };
    harness.fake.runtime.protocol = async () => "legacy";
    harness.fake.runtime.reconcile = async (binding) => ({
      ...await harness.fake.runtime.endpoint!(),
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
      state: {
        value: "idle", comparison: { domain: "test-authority", order: ++observation },
        ...(resetOperationId ? { causalOperationId: resetOperationId } : {}),
      },
      completeness: { events: "complete", permissions: "complete", questions: "complete" },
      permissions: [], questions: [], events: [], acceptedOperations: [],
    });
    await harness.store.upsertProjection({
      ...current,
      branch: "polyth/isolate/completed-parent",
      worktreePath: source,
      workspace: {
        ...current.workspace!,
        repositories: current.workspace!.repositories.map((row) => row.repositoryId === "repo-primary" ? { ...row, path: source } : row),
      },
      runtimeBinding: {
        canonicalSessionId: created.id, backendSessionId: current.backendSessionId!,
        authorityId: "fake-authority", generation: 1, continuity: "generation-only",
        location: { directory: source },
      },
    });
    const repaired = await harness.sessions.updateWorkspace(created.id, {
      expectedRevision: 1, relocateRepositoryIds: ["repo-primary"],
    });
    assert.deepEqual(harness.fake.releases, [source]);
    assert.equal(repaired.worktreePath, harness.root);
    assert.equal(repaired.branch, undefined);
    assert.equal(repaired.workspace?.repositories[0]?.branch, undefined);
    assert.equal(repaired.workspace?.repositories[0]?.path, harness.root);
    assert.equal(repaired.workspace?.revision, 2);
    assert.notEqual(repaired.runtimeBinding?.location.directory, source);
    const events = await harness.store.events(created.id);
    const release = events.findLast((row) => row.type === "session/workspace-execution-released");
    const committed = events.findLast((row) => row.type === "session/workspace-updated");
    assert.ok(release && committed && release.seq < committed.seq);
    await assert.rejects(() => harness.sessions.updateWorkspace(created.id, {
      expectedRevision: 1, relocateRepositoryIds: ["repo-primary"],
    }), /stale/);
  } finally {
    harness.sessions.dispose();
    await harness.store.close();
  }
});

test("startup repairs confirmed relocation labels without acquiring execution, including archived histories", async () => {
  let harness = makeHarness();
  const ids: string[] = [];
  try {
    for (const status of ["idle", "working", "archived", "unknown"] as const) {
      const { id } = await harness.sessions.create({ projectId: harness.project.id });
      ids.push(id);
      const current = (await harness.store.projection(id))!;
      const projection = {
        ...current, status, branch: "polyth/isolate/completed-parent", worktreePath: harness.root,
        workspace: { ...current.workspace!, revision: 2 },
        runtimeBinding: {
          canonicalSessionId: id, backendSessionId: current.backendSessionId!,
          authorityId: "confirmed-destination", generation: 2, continuity: "verified" as const,
          location: { directory: status === "unknown" ? join(harness.root, "unreleased-source") : harness.root },
        },
      };
      await harness.store.appendBatch!(id, [{ type: "session/workspace-updated", ignorable: true,
        data: { workspace: projection.workspace as never,
          scalar: { worktreePath: harness.root, branch: projection.branch } },
      }], { projection, expectedSeq: await harness.store.latestSeq(id) });
    }
    const root = harness.root;
    harness.sessions.dispose();
    await harness.store.close();
    let runtimeAcquires = 0;
    let repaired = 0;
    let complete!: () => void;
    const ready = new Promise<void>(resolve => { complete = resolve; });
    harness = makeHarness({ root, onRuntimeAcquire: () => { runtimeAcquires++; }, onEvent: event => {
      if (event.type === "session/workspace-updated" && (event.data.scalar as { branch?: unknown })?.branch === null) {
        if (++repaired === 3) complete();
      }
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("canonical branch repair did not publish")), 1_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(runtimeAcquires, 0);
    assert.deepEqual(harness.fake.releases, []);
    for (let index = 0; index < ids.length; index++) {
      const after = (await harness.store.projection(ids[index]!))!;
      assert.equal(after.branch, index === 3 ? "polyth/isolate/completed-parent" : undefined);
      assert.equal(after.workspace?.revision, 2);
      assert.equal(after.status, ["idle", "working", "archived", "unknown"][index]);
      assert.equal(after.runtimeBinding?.authorityId, "confirmed-destination");
    }
  } finally {
    harness.sessions.dispose();
    await harness.store.close();
  }
});

test("canonical checkout mutations release execution, fence turns, and expire their commit scope", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const current = (await harness.store.projection(created.id))!;
  await harness.store.upsertProjection({ ...current, runtimeBinding: {
    canonicalSessionId: created.id, backendSessionId: current.backendSessionId!, authorityId: "fake-authority", generation: 1,
    continuity: "generation-only", location: { directory: harness.root },
  } });
  let savedScope: WorkspaceMutationScope | undefined;
  const result = await harness.sessions.withWorkspaceMutation(created.id, 1, async (scope) => {
    savedScope = scope;
    assert.deepEqual(harness.fake.releases, [harness.root]);
    assert.ok((await harness.store.events(created.id)).some((event) => event.type === "session/workspace-execution-released"));
    const projection = await scope.snapshot();
    const updated = await scope.commit({ ...projection.workspace!, mode: "subset", repositories: projection.workspace!.repositories.slice(0, 1) });
    assert.equal(updated.workspace?.revision, 2);
    return "committed";
  });
  assert.equal(result, "committed");
  assert.equal((await harness.sessions.snapshot(created.id)).workspace?.executionRepositoryId, "repo-primary");
  await assert.rejects(() => savedScope!.commit(current.workspace!), /expired/);
  await assert.rejects(() => harness.sessions.withWorkspaceMutation(created.id, 1, async () => undefined), /workspace changed/);
  harness.sessions.dispose();
  await harness.store.close();
});

test("unproven runtime release never calls the checkout mutation", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const current = (await harness.store.projection(created.id))!;
  await harness.store.upsertProjection({ ...current, runtimeBinding: {
    canonicalSessionId: created.id, backendSessionId: current.backendSessionId!, authorityId: "fake-authority", generation: 1,
    continuity: "generation-only", location: { directory: harness.root },
  } });
  harness.fake.runtime.releaseExecution = async () => ({ kind: "unknown", code: "outcome-unknown", message: "release unconfirmed" });
  let mutated = false;
  await assert.rejects(() => harness.sessions.withWorkspaceMutation(created.id, 1, async () => { mutated = true; }), { code: "outcome-unknown" });
  assert.equal(mutated, false);
  assert.equal((await harness.store.projection(created.id))?.workspace?.revision, 1);
  harness.sessions.dispose();
  await harness.store.close();
});

test("secondary attachment keeps canonical relative ref for native delivery", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id, repositoryIds: ["repo-secondary"] });
  await harness.sessions.send(created.id, {
    text: "read notes",
    attachments: [{ id: "secondary-note", name: "notes.md", mime: "text/markdown", size: 1, kind: "file", path: "notes.md", repositoryId: "repo-secondary" }],
  });
  assert.equal(harness.fake.starts[0]?.attachments?.[0]?.path, "notes.md");
  assert.equal(harness.fake.starts[0]?.attachments?.[0]?.repositoryId, "repo-secondary");
  assert.equal(harness.fake.starts[0]?.attachments?.[0]?.url?.includes("repositoryId=repo-secondary"), true);
  harness.sessions.dispose();
  await harness.store.close();
});


test("direct execution anchor rebind advances revision and rejects unknown destination before release", async () => {
  const harness = makeHarness();
  const created = await harness.sessions.create({ projectId: harness.project.id });
  const updated = await harness.sessions.rebindWorkspace!(created.id, {
    executionRepositoryId: "repo-secondary", worktreePath: harness.secondary, expectedWorkspaceRevision: 1,
  });
  assert.equal(updated.workspace?.revision, 2);
  assert.equal(updated.workspace?.executionRepositoryId, "repo-secondary");
  await assert.rejects(() => harness.sessions.updateWorkspace(created.id, { repositoryIds: ["repo-secondary"], expectedRevision: 1 }), /stale/);
  const before = await harness.store.projection(created.id);
  await assert.rejects(() => harness.sessions.rebindWorkspace!(created.id, { worktreePath: join(harness.root, "outside"), expectedWorkspaceRevision: 2 }), /not registered/);
  assert.deepEqual(await harness.store.projection(created.id), before);
  harness.sessions.dispose();
  await harness.store.close();
});

test("child session with parentId inherits worktree and workspace from ordinary parent", async () => {
  const harness = makeHarness();
  const parent = await harness.sessions.create({
    projectId: harness.project.id,
    repositoryIds: ["repo-secondary"],
  });
  const child = await harness.sessions.create({
    projectId: harness.project.id,
    parentId: parent.id,
    title: "Child Worker",
  });
  const childSnapshot = await harness.store.projection(child.id);
  assert.equal(childSnapshot?.parentId, parent.id);
  assert.deepEqual(childSnapshot?.workspace?.repositories.map((row) => row.repositoryId), ["repo-secondary"]);
  assert.equal(childSnapshot?.workspace?.executionRepositoryId, "repo-secondary");
  harness.sessions.dispose();
  await harness.store.close();
});
