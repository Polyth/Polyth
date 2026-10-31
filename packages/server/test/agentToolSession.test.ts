import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { selectAgentToolSessionOwner, type AgentToolSessionDeps } from "../src/agentToolSession.ts";

const LEG = "leg-shared";
const OTHER_LEG = "leg-other";

const session = (
  id: string,
  input: {
    projectId?: string;
    spaceId?: string;
    harness?: string;
    legId?: string;
    cwd?: string;
    backendSessionId?: string;
  } = {},
): SessionProjection => ({
  id,
  projectId: input.projectId ?? "project-a",
  spaceId: input.spaceId ?? "space-a",
  resolvedHarnessId: input.harness ?? "pi",
  backendSessionId: input.backendSessionId ?? `backend-${id}`,
  ...(input.legId ? { runtimeLeg: { id: input.legId, harnessId: "pi", nativeSessionId: `${id}.jsonl`, startedAt: 1, canonicalThroughSeq: 0, bootstrap: "native-resume" } } : {}),
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

const deps = (
  sessions: SessionProjection[],
  live: string[],
  cwds: Record<string, string | undefined> = {},
): AgentToolSessionDeps => ({
  liveSessionIds: () => live,
  projection: async (sessionId) => sessions.find((item) => item.id === sessionId),
  projectSessions: async () => sessions,
  workspaceCwds: async (projection) => [cwds[projection.id] ?? "/work"],
});

// A Pi fork resumes the parent's native leg, so the parent's worker keeps the
// token minted for the parent while the child runs the turn. Every package tool
// used to fail with "No unambiguous active Polyth session owns this request".
test("a forked session is resolved through the runtime leg its grant was minted for", async () => {
  const parent = session("parent", { legId: LEG });
  const child = session("child", { legId: LEG });
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "parent" },
    deps([parent, child], ["child"]),
  );
  assert.equal(owner?.id, "child");
});

// The minted session is the grant's intent, so a live leg owner wins over a
// live leg mate instead of becoming ambiguous.
test("a live leg owner wins over a live leg mate", async () => {
  const parent = session("parent", { legId: LEG });
  const child = session("child", { legId: LEG });
  let scanned = false;
  const base = deps([parent, child], ["parent", "child"]);
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "parent" },
    { ...base, projectSessions: async () => { scanned = true; return [parent, child]; } },
  );
  assert.equal(owner?.id, "parent");
  assert.equal(scanned, false, "the steady-state path does not scan the project");
});

// A session that exists only on another leg is never reachable through the
// grant's leg, however live it is.
test("a live session on another leg is not selectable", async () => {
  const parent = session("parent", { legId: LEG });
  const stranger = session("stranger", { legId: OTHER_LEG });
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "parent" },
    deps([parent, stranger], ["stranger"]),
  );
  assert.equal(owner, undefined);
});

// Leg sharing is not a licence to guess: when the grant names an idle leg owner
// and several leg mates are live, ownership stays unresolved, exactly like two
// live sessions selected by occupancy alone.
test("an ambiguous leg-shared runtime fails closed", async () => {
  const parent = session("parent", { legId: LEG });
  const first = session("first", { legId: LEG });
  const second = session("second", { legId: LEG });
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "parent" },
    deps([parent, first, second], ["first", "second"]),
  );
  assert.equal(owner, undefined);
});

test("an idle leg resolves to nothing", async () => {
  const parent = session("parent", { legId: LEG });
  const child = session("child", { legId: LEG });
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "parent" },
    deps([parent, child], []),
  );
  assert.equal(owner, undefined);
});

test("a shared leg id from another Space or project is never selectable", async () => {
  const mine = session("mine", { legId: LEG });
  const foreignSpace = session("foreign-space", { legId: LEG, spaceId: "space-b" });
  const foreignProject = session("foreign-project", { legId: LEG, projectId: "project-b" });
  for (const live of [["foreign-space"], ["foreign-project"]]) {
    const owner = await selectAgentToolSessionOwner(
      { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "mine" },
      deps([mine, foreignSpace, foreignProject], live),
    );
    assert.equal(owner, undefined, live.join());
  }
});

test("a leg mate on another harness, checkout or without a leg is rejected", async () => {
  const mine = session("mine", { legId: LEG });
  const otherHarness = session("other-harness", { legId: LEG, harness: "claude" });
  const otherCwd = session("other-cwd", { legId: LEG });
  const noLeg = session("no-leg");
  const request = { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", sessionId: "mine" };
  assert.equal(await selectAgentToolSessionOwner(request,
    deps([mine, otherHarness], ["other-harness"])), undefined);
  assert.equal(await selectAgentToolSessionOwner(request,
    deps([mine, otherCwd], ["other-cwd"], { "other-cwd": "/worktree" })), undefined);
  assert.equal(await selectAgentToolSessionOwner(request,
    deps([mine, noLeg], ["no-leg"])), undefined);
});

// Project-scoped runtimes carry no session id at all; occupancy alone decides.
test("a grant without a session id resolves by unique live occupancy", async () => {
  const first = session("first", { legId: OTHER_LEG });
  const second = session("second", { legId: LEG });
  const request = { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi" };
  assert.equal((await selectAgentToolSessionOwner(request, deps([first, second], ["second"])))?.id, "second");
  assert.equal(await selectAgentToolSessionOwner(request, deps([first, second], ["first", "second"])), undefined);
});

test("MCP runtime-session metadata selects the exact live session on a shared runtime", async () => {
  const first = session("first", { legId: LEG, backendSessionId: "native-first" });
  const second = session("second", { legId: LEG, backendSessionId: "native-second" });
  const owner = await selectAgentToolSessionOwner(
    { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi", runtimeSessionId: "native-second" },
    deps([first, second], ["first", "second"]),
  );
  assert.equal(owner?.id, "second");
});

test("unknown or ambiguous MCP runtime-session metadata fails closed", async () => {
  const first = session("first", { legId: LEG, backendSessionId: "native-first" });
  const second = session("second", { legId: LEG, backendSessionId: "native-second" });
  const request = { spaceId: "space-a", projectId: "project-a", cwd: "/work", harnessId: "pi" };
  assert.equal(await selectAgentToolSessionOwner(
    { ...request, runtimeSessionId: "foreign" },
    deps([first, second], ["first", "second"]),
  ), undefined);
  const granted = session("granted", { legId: LEG, backendSessionId: "native-granted" });
  const foreignLive = session("foreign-live", { legId: OTHER_LEG, backendSessionId: "native-foreign" });
  assert.equal(await selectAgentToolSessionOwner(
    { ...request, sessionId: "granted", runtimeSessionId: "native-foreign" },
    deps([granted, foreignLive], ["granted", "foreign-live"]),
  ), undefined);
  const shared = session("shared-a", { legId: LEG, backendSessionId: "native-shared" });
  const sharedMate = session("shared-b", { legId: LEG, backendSessionId: "native-shared" });
  assert.equal(await selectAgentToolSessionOwner(
    { ...request, runtimeSessionId: "native-shared" },
    deps([shared, sharedMate], ["shared-a", "shared-b"]),
  ), undefined);
});
