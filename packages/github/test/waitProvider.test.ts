import assert from "node:assert/strict";
import test from "node:test";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ExecFn } from "../src/index.ts";
import { createGithubRunWaitProvider } from "../src/waitProvider.ts";

const host = {
  projects: { get: async (id: string) => id === "p1" ? { id, path: "/repo", spaceId: "s1" } : undefined },
  personSpaceContext: (userId: string, spaceId: string) => userId === "u1" ? { spaceId, userId, role: "member" } : undefined,
} as unknown as ServerPackageHost;
const ctx = { spaceId: "s1", projectId: "p1", sessionId: "c1", actorUserId: "u1", cwd: "/repo" };

function provider(run: Record<string, unknown> | Error, decision: "personal" | "refused" = "personal") {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args, opts) => {
    calls.push([...args, `cwd=${opts.cwd}`]);
    if (run instanceof Error) throw run;
    return { stdout: JSON.stringify(run), stderr: "" };
  };
  return {
    calls,
    provider: createGithubRunWaitProvider({
      host, exec,
      remoteHosts: async () => ["github.com"],
      decide: () => decision === "personal" ? { kind: "installation" } : { kind: "refused", reason: "Connect your GitHub account." },
    }),
  };
}

test("start checks the person's access to the run and labels it", async () => {
  const { provider: p, calls } = provider({ status: "in_progress", name: "CI" });
  const started = await p.start({ id: 42, repo: "o/r" }, ctx);
  assert.deepEqual(started.target, { id: 42, repo: "o/r" });
  assert.equal(started.label, 'GitHub Actions run #42 "CI"');
  assert.deepEqual(calls[0], ["run", "view", "42", "--repo", "o/r", "--json", "status,conclusion,name,url,displayTitle", "cwd=/repo"]);
});

test("start refuses bad input, an unreachable run and a person without an account", async () => {
  await assert.rejects(provider({}).provider.start({ id: -1 }, ctx), /positive integer/);
  await assert.rejects(provider({}).provider.start({ id: 1, repo: "--evil" }, ctx), /owner\/name/);
  await assert.rejects(provider(new Error("HTTP 404")).provider.start({ id: 1 }, ctx), /cannot reach run 1/);
  await assert.rejects(provider({}, "refused").provider.start({ id: 1 }, ctx), /Connect your GitHub account/);
  await assert.rejects(provider({}).provider.start({ id: 1 }, { ...ctx, actorUserId: "u2" }), /no longer a member/);
});

test("poll stays pending until the run is completed, then reports its conclusion and URL", async () => {
  const record = { id: "w_1", spaceId: "s1", projectId: "p1", actorUserId: "u1", label: "x", target: { id: 42 } };
  assert.deepEqual(await provider({ status: "queued" }).provider.poll(record), { done: false });
  assert.deepEqual(await provider(new Error("network")).provider.poll(record), { done: false });
  assert.deepEqual(await provider({}, "refused").provider.poll(record), { done: false });
  const done = await provider({ status: "completed", conclusion: "failure", name: "CI", url: "https://github.com/o/r/actions/runs/42" }).provider.poll(record);
  assert.deepEqual(done, { done: true, outcome: "completed", text: 'The GitHub Actions run #42 "CI" finished: failure. https://github.com/o/r/actions/runs/42' });
});
