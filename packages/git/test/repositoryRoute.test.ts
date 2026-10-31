import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectService, SessionProjection, SessionService } from "@polyth/contracts";
import { gitRoutes, isolationRoutes } from "../src/serverEntry.ts";
import { createGitService, type GitService } from "../src/index.ts";
import { createPersonGitProfiles } from "../src/actingPerson.ts";
import { fakePeople } from "./fakePeople.ts";
import type { IsolationService } from "../src/sessionIntegration.ts";

function harness(session?: SessionProjection) {
  const roots: string[] = [];
  let sessionCreates = 0;
  let sessionSends = 0;
  const identityWrites: Array<{ root: string; name: string }> = [];
  const git = {
    isRepo: async () => true,
    setIdentity: async (root: string, identity: { name: string }) => {
      identityWrites.push({ root, name: identity.name });
      throw Object.assign(new Error("stop after the write"), { code: "conflict" });
    },
    status: async (root: string) => {
      roots.push(root);
      return { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true };
    },
  } as unknown as GitService;
  const routes = gitRoutes({
    projects: {
      get: async (id: string) => id === "p1" ? {
        id, name: "Project", path: "/repo",
        repositories: [
          { id: "primary", alias: "Project", path: "/repo" },
          { id: "api", alias: "API", path: "/api" },
        ],
        primaryRepositoryId: "primary",
      } : undefined,
    } as unknown as ProjectService,
    sessions: {
      snapshot: async () => session,
      list: async () => [],
      create: async () => { sessionCreates += 1; return { id: "created" }; },
      send: async () => { sessionSends += 1; return {}; },
    } as unknown as SessionService,
    git,
    commitMessage: async () => "",
  });
  return { roots, routes, identityWrites, get sessionCreates() { return sessionCreates; }, get sessionSends() { return sessionSends; } };
}

async function call(routes: ReturnType<typeof gitRoutes>, query: Record<string, string>, method = "GET") {
  let payload: unknown;
  const url = new URL("http://x/api/git/status");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await routes({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method,
    body: async () => ({}), json: (_status: number, data: unknown) => { payload = data; },
  } as never);
  return payload;
}

test("Git resolves an explicit repository without a global active repository", async () => {
  const h = harness();
  const result = await call(h.routes, { projectId: "p1", repositoryId: "api" });
  assert.equal((result as { isRepo: boolean }).isRepo, true);
  assert.deepEqual(h.roots, ["/api"]);
});

test("Git rejects unknown, excluded, and foreign repository context", async () => {
  const excluded = harness({
    id: "s1", projectId: "p1", title: "Session", status: "idle", createdAt: 1, updatedAt: 1,
    workspace: { repositories: [{ repositoryId: "primary", path: "/checkout" }] },
  });
  await assert.rejects(() => call(excluded.routes, { projectId: "p1", sessionId: "s1", repositoryId: "api" }), { code: "not-found" });
  await assert.rejects(() => call(harness().routes, { projectId: "p1", repositoryId: "missing" }), { code: "not-found" });
  const foreign = harness({ id: "foreign", projectId: "other", title: "Foreign", status: "idle", createdAt: 1, updatedAt: 1 });
  await assert.rejects(() => call(foreign.routes, { projectId: "p1", sessionId: "foreign", repositoryId: "primary" }), { code: "not-found" });
});

test("session-scoped Git uses the selected execution repository when primary is excluded", async () => {
  const h = harness({
    id: "s1", projectId: "p1", title: "Session", status: "idle", createdAt: 1, updatedAt: 1,
    worktreePath: "/api-session",
    workspace: {
      mode: "subset",
      executionRepositoryId: "api",
      repositories: [{ repositoryId: "api", path: "/api-session", state: "ready" }],
    },
  });
  await call(h.routes, { projectId: "p1", sessionId: "s1" });
  assert.deepEqual(h.roots, ["/api-session"]);
});

test("repository-scoped worktree management is rejected", async () => {
  const h = harness();
  const url = new URL("http://x/api/worktrees?projectId=p1&repositoryId=api");
  await assert.rejects(() => h.routes({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "GET",
    body: async () => ({}), json: () => {},
  } as never), { code: "unsupported" });
});

test("a ready secondary snapshot remains usable when the legacy primary is missing", async () => {
  const h = harness({
    id: "s1", projectId: "p1", title: "Session", status: "idle", createdAt: 1, updatedAt: 1,
    worktreeState: "missing",
    workspace: {
      repositories: [
        { repositoryId: "primary", path: "/missing", state: "missing" },
        { repositoryId: "api", path: "/api", state: "ready" },
      ],
    },
  });
  await call(h.routes, { projectId: "p1", sessionId: "s1", repositoryId: "api" });
  assert.deepEqual(h.roots, ["/api"]);
});

test("secondary conflict-agent repair is rejected before session creation", async () => {
  const h = harness();
  const url = new URL("http://x/api/git/conflict-prompt");
  let responseStatus = 0;
  await h.routes({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "POST",
    body: async () => ({ projectId: "p1", target: "new-session", repositoryId: "api" }),
    json: (status: number) => { responseStatus = status; },
  } as never);
  assert.equal(responseStatus, 409);
  assert.equal(h.sessionCreates, 0);
  assert.equal(h.sessionSends, 0);
});


test("isolated-session route forwards repository membership selection", async () => {
  let received: Record<string, unknown> | undefined;
  const route = isolationRoutes({
    isolation: {
      createIsolatedSession: async (input: Record<string, unknown>) => {
        received = input;
        return { id: "isolated" };
      },
    } as unknown as IsolationService,
  });
  const url = new URL("http://x/api/isolation/sessions");
  let payload: unknown;
  await route({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "POST",
    body: async () => ({ projectId: "p1", repositoryIds: ["api"], purpose: "playground" }),
    json: (_status: number, data: unknown) => { payload = data; },
  } as never);
  assert.deepEqual(received?.repositoryIds, ["api"]);
  assert.equal(received?.purpose, "playground");
  assert.deepEqual(payload, { id: "isolated" });
});

test("isolated-session route rejects malformed repository membership", async () => {
  const route = isolationRoutes({
    isolation: {
      createIsolatedSession: async () => ({ id: "isolated" }),
    } as unknown as IsolationService,
  });
  const url = new URL("http://x/api/isolation/sessions");
  await assert.rejects(() => route({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "POST",
    body: async () => ({ projectId: "p1", repositoryIds: "api" }),
    json: () => {},
  } as never), { code: "invalid-input" });
});

test("isolation retarget and merge routes forward a validated target and push flag", async () => {
  const calls: Array<{ op: string; sessionId: string; input: unknown }> = [];
  const route = isolationRoutes({
    isolation: {
      retarget: async (sessionId: string, target: unknown) => {
        calls.push({ op: "retarget", sessionId, input: target });
        return { id: sessionId };
      },
      mergeBack: async (sessionId: string, options: Record<string, unknown>) => {
        const { requester: _requester, ...rest } = options;
        calls.push({ op: "merge", sessionId, input: rest });
        return { ok: true };
      },
    } as unknown as IsolationService,
  });
  const post = (path: string, body: unknown) => {
    const url = new URL(`http://x${path}`);
    return route({
      req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "POST",
      body: async () => body,
      json: () => {},
    } as never);
  };
  await post("/api/isolation/s1/retarget", { branch: "devel", path: "/repo" });
  await post("/api/isolation/s1/merge", { push: true });
  await post("/api/isolation/s1/merge", { target: { branch: "devel", path: "/repo" } });
  assert.deepEqual(calls, [
    { op: "retarget", sessionId: "s1", input: { branch: "devel", path: "/repo" } },
    { op: "merge", sessionId: "s1", input: { push: true } },
    { op: "merge", sessionId: "s1", input: { target: { branch: "devel", path: "/repo" } } },
  ]);
  await assert.rejects(() => post("/api/isolation/s1/retarget", { branch: "devel" }), { code: "invalid-input" });
  await assert.rejects(() => post("/api/isolation/s1/retarget", { branch: " ", path: "/repo" }), { code: "invalid-input" });
  await assert.rejects(() => post("/api/isolation/s1/merge", { push: "yes" }), { code: "invalid-input" });
  assert.equal(calls.length, 3, "a malformed request never reaches the service");
});

test("only the instance owner (as a Space admin) rewrites the Git identity of the shared checkout", async () => {
  const h = harness();
  const post = (role: string, extra: Record<string, unknown> = {}) => h.routes({
    req: {}, res: {}, space: { userId: "u1", role, deployment: "local-trusted", ...extra }, url: new URL("http://x/api/git/identity"), path: "/api/git/identity", method: "POST",
    body: async () => ({ projectId: "p1", name: "Ida", email: "ida@example.com" }),
    json: () => {},
  } as never);

  await assert.rejects(post("member"), { code: "permission-denied", status: 403, mutationOutcome: "not-started" });
  assert.deepEqual(h.identityWrites, []);
  // A Space admin who is not the instance owner commits with their own
  // profile; the checkout's config is the installation owner's.
  await assert.rejects(post("admin", { instanceOwner: false }), { code: "permission-denied", status: 403, mutationOutcome: "not-started" });
  await assert.rejects(post("owner", { instanceOwner: true, deployment: "server-trusted" }), { code: "permission-denied", mutationOutcome: "not-started" });
  assert.deepEqual(h.identityWrites, []);
  // The owner passes the gate and reaches the write (the fake stops it there).
  await assert.rejects(post("admin", { instanceOwner: true }), { code: "conflict" });
  assert.deepEqual(h.identityWrites, [{ root: "/repo", name: "Ida" }]);
});

// ---- the acting person's commit identity (Spaces §14.4) -------------------------

async function personRepo() {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "polyth-person-commit-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Checkout Owner"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "owner@host.example"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  const people = fakePeople(join(root, "data"), { s1: ["alice", "bob", "owner"] });
  const profiles = createPersonGitProfiles(people);
  const routes = gitRoutes({
    projects: { get: async (id: string) => id === "p1" ? { id, name: "Repo", path: repo } : undefined } as unknown as ProjectService,
    sessions: {} as SessionService,
    git: createGitService(),
    commitMessage: async () => "",
    personProfiles: profiles,
  });
  const call = async (userId: string, method: string, path: string, body: Record<string, unknown> = {}, owner = false) => {
    let payload: unknown;
    await routes({
      req: {}, res: {}, principal: { kind: "ui-session" },
      space: { spaceId: "s1", spaceSlug: "s1", userId, role: "member", deployment: "local-trusted", storageDir: "/unused", instanceOwner: owner },
      url: new URL(`http://x${path}`), path, method, body: async () => body, json: (_status: number, data: unknown) => { payload = data; },
    } as never);
    return payload;
  };
  const commit = async (userId: string, file: string, owner = false) => {
    writeFileSync(join(repo, file), `${file}\n`);
    execFileSync("git", ["-C", repo, "add", file]);
    return call(userId, "POST", "/api/git/commit", { projectId: "p1", message: `add ${file}` }, owner);
  };
  const head = () => execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>"], { encoding: "utf8" }).trim();
  const count = () => execFileSync("git", ["-C", repo, "rev-list", "--all", "--count"], { encoding: "utf8" }).trim();
  return { root, repo, call, commit, head, count, profiles };
}

test("each person reads and writes only their own Git profile", async () => {
  const h = await personRepo();
  try {
    assert.deepEqual(await h.call("alice", "GET", "/api/git/profile"), { profile: null, usesInstallationFallback: false });
    const saved = await h.call("alice", "PUT", "/api/git/profile", { name: "  Alice Example ", email: "alice@example.com" }) as { profile: { name: string; email: string } };
    assert.deepEqual({ name: saved.profile.name, email: saved.profile.email }, { name: "Alice Example", email: "alice@example.com" });
    assert.deepEqual(await h.call("bob", "GET", "/api/git/profile"), { profile: null, usesInstallationFallback: false }, "Bob never sees Alice's profile");
    assert.equal((await h.call("owner", "GET", "/api/git/profile", {}, true) as { usesInstallationFallback: boolean }).usesInstallationFallback, true);
    await assert.rejects(h.call("bob", "PUT", "/api/git/profile", { name: "Bob", email: "bob" }), { code: "invalid-input", field: "email" });
    await assert.rejects(h.call("bob", "PUT", "/api/git/profile", { name: "Bob\n[core]", email: "bob@example.com" }), { code: "invalid-input", field: "name" });
    await assert.rejects(h.call("system:polyth-runtime", "GET", "/api/git/profile"), { code: "forbidden" });
    assert.deepEqual(await h.call("alice", "DELETE", "/api/git/profile"), { profile: null, usesInstallationFallback: false });
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a UI commit is authored by the signed-in person, never by the shared checkout's config", async () => {
  const h = await personRepo();
  try {
    await h.call("alice", "PUT", "/api/git/profile", { name: "Alice Example", email: "alice@example.com" });
    await h.commit("alice", "a.txt");
    assert.equal(h.head(), "Alice Example <alice@example.com>|Alice Example <alice@example.com>");
    // Bob has no profile and is not the instance owner: refused before Git runs.
    const before = h.count();
    await assert.rejects(h.commit("bob", "b.txt"), {
      code: "git-identity-required", status: 409, mutationOutcome: "not-started", message: "Set your git name and email in Profile → Git.",
    });
    assert.equal(h.count(), before);
    // The instance owner without a profile keeps the checkout's own identity…
    await h.commit("owner", "c.txt", true);
    assert.equal(h.head(), "Checkout Owner <owner@host.example>|Checkout Owner <owner@host.example>");
    // …and with one, uses it.
    await h.call("owner", "PUT", "/api/git/profile", { name: "Owner Person", email: "person@example.com" }, true);
    await h.commit("owner", "d.txt", true);
    assert.equal(h.head(), "Owner Person <person@example.com>|Owner Person <person@example.com>");
    const { execFileSync } = await import("node:child_process");
    assert.equal(execFileSync("git", ["-C", h.repo, "config", "--local", "user.name"], { encoding: "utf8" }).trim(), "Checkout Owner", "no profile is written to the checkout");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("conflict preview route reads only a chat the requester may view", async () => {
  const previewed: string[] = [];
  const viewed: string[] = [];
  const route = isolationRoutes({
    isolation: {
      conflictPreview: async (sessionId: string) => {
        previewed.push(sessionId);
        return { targetBranch: "main", recorded: [], target: "a", source: "b", mergeBase: "c", files: [] };
      },
    } as unknown as IsolationService,
    scopedSessions: () => ({
      snapshot: async (sessionId: string) => {
        viewed.push(sessionId);
        if (sessionId !== "mine") throw Object.assign(new Error("session not found"), { code: "not-found" });
        return { id: sessionId } as SessionProjection;
      },
    }) as never,
  });
  const call = (sessionId: string) => {
    const url = new URL(`http://x/api/isolation/${sessionId}/conflicts`);
    let payload: unknown;
    return route({
      req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "GET",
      body: async () => ({}),
      json: (_status: number, data: unknown) => { payload = data; },
    } as never).then((handled) => ({ handled, payload }));
  };
  await assert.rejects(() => call("foreign"), { code: "not-found" });
  assert.deepEqual(previewed, []);
  const own = await call("mine");
  assert.equal(own.handled, true);
  assert.deepEqual(previewed, ["mine"]);
  assert.deepEqual(viewed, ["foreign", "mine"]);
  assert.equal((own.payload as { targetBranch: string }).targetBranch, "main");
});

test("isolation lifecycle routes resolve the session in the requester's Space and check their access", async () => {
  const calls: string[] = [];
  const isolation = new Proxy({}, {
    get: (_target, name) => async () => { calls.push(String(name)); return { ok: true }; },
  }) as unknown as IsolationService;
  const rows: Record<string, SessionProjection> = {
    own: { id: "own", projectId: "p1", title: "Own", status: "idle", createdAt: 1, updatedAt: 1 },
    viewer: {
      id: "viewer", projectId: "p1", title: "Shared", status: "idle", createdAt: 1, updatedAt: 1,
      sharing: { visibility: "space", access: "view", shared: true },
    } as SessionProjection,
    collaborator: {
      id: "collaborator", projectId: "p1", title: "Shared", status: "idle", createdAt: 1, updatedAt: 1,
      sharing: { visibility: "space", access: "collaborate", shared: true },
    } as SessionProjection,
  };
  const route = isolationRoutes({
    isolation,
    scopedSessions: () => ({
      snapshot: async (id: string) => {
        const row = rows[id];
        // A session of another Space is indistinguishable from an unknown one.
        if (!row) throw Object.assign(new Error("session not found"), { code: "not-found" });
        return row;
      },
    }) as never,
  });
  const call = (method: "GET" | "POST", path: string) => {
    const url = new URL(`http://x${path}`);
    return route({
      req: {}, res: {}, space: { userId: "u1", spaceId: "s1" }, url, path: url.pathname, method,
      body: async () => ({}),
      json: () => {},
    } as never);
  };

  for (const [method, path] of [
    ["GET", "/api/isolation/foreign"],
    ["GET", "/api/isolation/foreign/conflicts"],
    ["POST", "/api/isolation/foreign/merge"],
    ["POST", "/api/isolation/foreign/discard"],
    ["POST", "/api/isolation/foreign/recover"],
    ["POST", "/api/isolation/foreign/abandon"],
    ["POST", "/api/isolation/foreign/push"],
  ] as const) {
    await assert.rejects(() => call(method, path), { code: "not-found" }, `${method} ${path}`);
  }
  assert.deepEqual(calls, [], "a foreign session never reaches the isolation service");

  await call("GET", "/api/isolation/viewer");
  await assert.rejects(() => call("POST", "/api/isolation/viewer/discard"), { code: "forbidden" });
  await assert.rejects(() => call("POST", "/api/isolation/viewer/resolve"), { code: "forbidden" });
  await call("POST", "/api/isolation/collaborator/resolve");
  await assert.rejects(() => call("POST", "/api/isolation/collaborator/merge"), { code: "forbidden" });
  await call("POST", "/api/isolation/own/discard");
  assert.deepEqual(calls, ["getStatus", "resolveWithAgent", "discard"]);
});
