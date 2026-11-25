import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentToolsShellLaunchers, AGENT_TOOLS_SHELL_COMMAND } from "../src/agentTools.ts";

const run = promisify(execFile);

/** A stand-in for the bridge's REST route: one tool, bearer-checked. */
async function toolServer(expectedToken: () => string) {
  const calls: Array<{ id: unknown; arguments: unknown }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${expectedToken()}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid tool token" } }));
        return;
      }
      if (req.method === "GET") {
        res.end(JSON.stringify({ tools: [{
          id: "harness-runtime.polyth-control",
          name: "polyth",
          description: "Control canonical Polyth sessions.\nSecond line.",
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: unknown; arguments: { action?: string } };
      calls.push({ id: body.id, arguments: body.arguments });
      if (body.arguments.action === "fail") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { code: "invalid-input", message: "unknown action" } }));
        return;
      }
      res.end(JSON.stringify({ output: `messages of ${JSON.stringify(body.arguments)}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/internal/agent-tools`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const cli = (env: NodeJS.ProcessEnv, args: string[]) => {
  const script = join(import.meta.dirname, "..", "src", "agentToolsMcp.mjs");
  return run(process.execPath, [script, "--cli", ...args], { env: { ...process.env, ...env } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
};

test("polyth-tools lists, describes and calls tools under the grant file's token, and follows a rewritten grant", async () => {
  let token = "first-token";
  const server = await toolServer(() => token);
  const dir = mkdtempSync(join(tmpdir(), "polyth-tools-"));
  try {
    const grant = join(dir, "grant.json");
    writeFileSync(grant, JSON.stringify({ url: server.url, token }));
    const env = { POLYTH_TOOLS_GRANT_FILE: grant };

    const list = await cli(env, ["list"]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.stdout, "polyth\tControl canonical Polyth sessions.\n");

    const described = await cli(env, ["describe", "polyth"]);
    assert.equal(described.code, 0);
    assert.match(described.stdout, /Second line\.[\s\S]*"action"/);

    const called = await cli(env, ["call", "polyth", '{"action":"session.messages","parameters":{"sessionId":"s2"}}']);
    assert.equal(called.code, 0, called.stderr);
    assert.match(called.stdout, /messages of \{"action":"session.messages"/);
    // The capability id, not the display name, goes to the bridge.
    assert.equal(server.calls[0]!.id, "harness-runtime.polyth-control");

    const failed = await cli(env, ["call", "polyth", '{"action":"fail"}']);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "unknown action\n");

    assert.equal((await cli(env, ["call", "polyth", "[1]"])).code, 2);
    assert.equal((await cli(env, ["call", "nope"])).code, 2);

    // A re-minted grant is read again on the next call.
    token = "second-token";
    assert.equal((await cli(env, ["list"])).code, 1);
    writeFileSync(grant, JSON.stringify({ url: server.url, token }));
    assert.equal((await cli(env, ["list"])).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("polyth-tools without a grant says so instead of guessing", async () => {
  const missing = await cli({ POLYTH_TOOLS_GRANT_FILE: join(tmpdir(), "polyth-no-such-grant.json") }, ["list"]);
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /not available in this shell/);
  const help = await cli({}, ["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /polyth-tools call <tool>/);
});

test("the POSIX launcher runs the bridge in CLI mode with this Node", { skip: process.platform === "win32" }, async () => {
  const launchers = agentToolsShellLaunchers();
  assert.deepEqual(launchers.map((item) => item.name), [AGENT_TOOLS_SHELL_COMMAND, `${AGENT_TOOLS_SHELL_COMMAND}.cmd`]);
  assert.match(launchers[1]!.content, /--cli %\*\r\n$/);
  const dir = mkdtempSync(join(tmpdir(), "polyth-tools-bin-"));
  try {
    const file = join(dir, launchers[0]!.name);
    writeFileSync(file, launchers[0]!.content);
    chmodSync(file, launchers[0]!.mode);
    assert.equal(statSync(file).mode & 0o777, 0o755);
    const { stdout } = await run(AGENT_TOOLS_SHELL_COMMAND, ["help"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    assert.match(stdout, /^polyth-tools — /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
