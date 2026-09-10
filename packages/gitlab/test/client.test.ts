import assert from "node:assert/strict";
import test from "node:test";
import { createGitlabApiClient, createGlabApiClient, type GitlabHttpTransport, type GlabExec } from "../src/client.ts";
import { normalizeGitlabInstance } from "../src/remote.ts";

test("PAT client pins the bound origin, keeps token in a header, and rejects redirects", async () => {
  const instance = normalizeGitlabInstance("https://gitlab.example");
  const seen: Array<{ url: string; token?: string; body?: string }> = [];
  let status = 200;
  const transport: GitlabHttpTransport = async (url, _pin, init) => {
    seen.push({ url: url.toString(), token: init.headers.authorization, body: init.body });
    return { status, headers: new Headers(), body: Buffer.from(JSON.stringify([{ id: 1 }])) };
  };
  const client = createGitlabApiClient({
    instance, deployment: "server-trusted", token: "glpat-secret", transport,
    resolve: async () => ["93.184.216.34"],
  });
  assert.deepEqual(await client.list<{ id: number }>("projects/7/issues", 20), [{ id: 1 }]);
  assert.equal(seen[0]?.url, "https://gitlab.example/api/v4/projects/7/issues?per_page=20");
  assert.equal(seen[0]?.token, "Bearer glpat-secret");
  await assert.rejects(() => client.request("https://evil.example/api/v4/user"), /relative/);
  status = 302;
  await assert.rejects(() => client.request("user"), /redirects/);
  assert.equal(seen.length, 2);
});

test("glab client binds hostname and verifies the active per-host identity on every request", async () => {
  const calls: string[][] = [];
  const exec: GlabExec = async (_bin, args) => {
    calls.push(args);
    return { stdout: "oauth-token-from-keyring\n", stderr: "" };
  };
  const transport: GitlabHttpTransport = async (url, _pin, init) => ({
    status: 200,
    headers: new Headers(),
    body: Buffer.from(JSON.stringify(url.pathname.endsWith("/user") ? { username: "alice" } : { id: 7 })),
  });
  const client = createGlabApiClient({
    instance: normalizeGitlabInstance("https://gitlab.example"), deployment: "local-trusted",
    expectedUsername: "alice", exec, transport, resolve: async () => ["93.184.216.34"],
  });
  assert.deepEqual(await client.request("projects/7"), { id: 7 });
  assert.deepEqual(calls, [
    ["config", "get", "token", "--host", "gitlab.example", "--global"],
  ]);
});

test("glab account mismatch prevents the target request", async () => {
  let calls = 0;
  const exec: GlabExec = async () => {
    calls += 1;
    return { stdout: "oauth-token-from-keyring\n", stderr: "" };
  };
  const transport: GitlabHttpTransport = async () => ({
    status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify({ username: "mallory" })),
  });
  const client = createGlabApiClient({
    instance: normalizeGitlabInstance("https://gitlab.example"), deployment: "local-trusted",
    expectedUsername: "alice", exec, transport, resolve: async () => ["93.184.216.34"],
  });
  await assert.rejects(() => client.request("user"), /different GitLab account/);
  assert.equal(calls, 1);
});

test("transport loss after a mutation is an explicit unknown outcome with sanitized text", async () => {
  const client = createGitlabApiClient({
    instance: normalizeGitlabInstance("https://gitlab.example"),
    deployment: "server-trusted",
    token: "never-echo-this",
    resolve: async () => ["93.184.216.34"],
    transport: async () => { throw new Error("socket failed with never-echo-this"); },
  });
  await assert.rejects(
    () => client.request("projects/7/issues", { method: "POST", body: { title: "x" } }),
    (error: Error & { code?: string; outcome?: string }) => {
      assert.equal(error.code, "mutation-outcome-unknown");
      assert.equal(error.outcome, "unknown");
      assert.doesNotMatch(error.message, /never-echo-this|socket/);
      return true;
    },
  );
});

test("GitLab 401 is distinguished from a missing glab login", async () => {
  const client = createGitlabApiClient({
    instance: normalizeGitlabInstance("https://gitlab.example"),
    deployment: "server-trusted",
    token: "expired-token",
    resolve: async () => ["93.184.216.34"],
    transport: async () => ({ status: 401, headers: new Headers(), body: Buffer.alloc(0) }),
  });
  await assert.rejects(
    () => client.request("user"),
    (error: Error & { code?: string }) => error.code === "invalid-token",
  );
});

test("malformed transient glab credentials are rejected before HTTP", async () => {
  let transported = false;
  const client = createGlabApiClient({
    instance: normalizeGitlabInstance("https://gitlab.example"), deployment: "local-trusted",
    expectedUsername: "alice", resolve: async () => ["93.184.216.34"],
    exec: async () => ({ stdout: "token\0suffix", stderr: "" }),
    transport: async () => {
      transported = true;
      return { status: 200, headers: new Headers(), body: Buffer.from("{}") };
    },
  });
  await assert.rejects(
    () => client.request("user"),
    (error: Error & { code?: string }) => error.code === "auth-required",
  );
  assert.equal(transported, false);
});
