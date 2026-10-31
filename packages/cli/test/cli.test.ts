import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, seconds, UsageError } from "../src/args.ts";
import { openRequests, operationIdFor, type SessionEvent } from "../src/api.ts";
import { exitCodeFor, PolythError } from "../src/client.ts";
import { diffSession } from "../src/follow.ts";
import { completionScript, main } from "../src/main.ts";
import { controlSocketPath, desktopDataDir, normalizeUrl, readConfig, resolveTarget, writeConfig } from "../src/target.ts";

test("argv parser: long/short/clustered flags, --flag=value, --no-x, -- rest, unknown flags", () => {
  const specs = [
    { name: "project", short: "p", value: true },
    { name: "follow", short: "f" },
    { name: "yes", short: "y" },
    { name: "type", value: true, multiple: true },
  ];
  const parsed = parseArgs(["show", "-fy", "-p", "api", "--type=a,b", "--type", "c", "x", "--", "cmd", "--json"], specs);
  assert.deepEqual(parsed.positionals, ["show", "x"]);
  assert.equal(parsed.flags.project, "api");
  assert.equal(parsed.flags.follow, true);
  assert.equal(parsed.flags.yes, true);
  assert.deepEqual(parsed.flags.type, ["a,b", "c"]);
  assert.deepEqual(parsed.rest, ["cmd", "--json"]);
  assert.equal(parseArgs(["--no-follow"], specs).flags.follow, false);
  assert.equal(parseArgs(["-papi"], specs).flags.project, "api");
  assert.throws(() => parseArgs(["--nope"], specs), UsageError);
  assert.throws(() => parseArgs(["--project"], specs), UsageError);
  assert.throws(() => parseArgs(["--follow=1"], specs), UsageError);
  assert.equal(seconds(parseArgs(["--t", "5m"], [{ name: "t", value: true }]), "t", 0), 300);
  assert.equal(seconds(parseArgs(["--t", "2h"], [{ name: "t", value: true }]), "t", 0), 7200);
});

test("control socket path matches the server's derivation on every platform", () => {
  // Server: packages/server/src/indexCore.ts (POLYTH_CONTROL_SOCKET default).
  const server = readFileSync(new URL("../../server/src/indexCore.ts", import.meta.url), "utf8");
  assert.match(server, /\\\\\\\\\.\\\\pipe\\\\polyth-control-\$\{createHash\("sha256"\)\.update\(dataDir\)\.digest\("hex"\)\.slice\(0, 12\)\}/);
  assert.match(server, /join\(dataDir, "control\.sock"\)/);
  assert.equal(controlSocketPath("/srv/polyth/data", "linux"), "/srv/polyth/data/control.sock");
  assert.match(controlSocketPath("C:\\Polyth\\data", "win32"), /^\\\\\.\\pipe\\polyth-control-[a-f0-9]{12}$/);
});

test("desktop data directory follows Electron userData for product Polyth", () => {
  assert.equal(desktopDataDir({ POLYTH_DESKTOP_USER_DATA: "/tmp/ud" }, "linux"), "/tmp/ud/data");
  assert.equal(desktopDataDir({ XDG_CONFIG_HOME: "/x" }, "linux"), "/x/Polyth/data");
  assert.match(desktopDataDir({}, "darwin"), /Library\/Application Support\/Polyth\/data$/);
  assert.match(desktopDataDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"), /Polyth[\\/]data$/);
});

test("target resolution: flag > env > saved default > discovery; tokens stay in a 0600 file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "cfg", "cli.json");
  const token = `pth_${"a".repeat(64)}`;
  writeConfig({ current: "home", targets: { home: { url: "https://polyth.example.com/", token }, box: { dataDir: "/srv/data" } } }, file);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const config = readConfig(file);
  assert.equal(config.targets.home?.url, "https://polyth.example.com/");

  const saved = resolveTarget({ config, env: {} });
  assert.deepEqual(saved.kind === "http" && [saved.name, saved.url, saved.token], ["home", "https://polyth.example.com", token]);
  const byFlag = resolveTarget({ config, env: {}, url: "polyth.example.com" });
  assert.equal(byFlag.kind === "http" ? byFlag.token : null, token, "a URL matching a saved target reuses its token");
  const envToken = resolveTarget({ config, env: { POLYTH_URL: "https://other.example", POLYTH_TOKEN: "pth_env" } });
  assert.deepEqual(envToken.kind === "http" && [envToken.url, envToken.token], ["https://other.example", "pth_env"]);
  const socket = resolveTarget({ config, env: {}, target: "box" });
  assert.deepEqual(socket.kind === "socket" && socket.socketPath, controlSocketPath("/srv/data"));
  const dataDir = resolveTarget({ config, env: { POLYTH_DATA_DIR: "rel" }, cwd: dir });
  assert.equal(dataDir.kind === "socket" && dataDir.dataDir, resolve("rel"));
  assert.throws(() => resolveTarget({ config, env: {}, target: "nope" }), /no saved target/);
  assert.throws(() => normalizeUrl("https://user:pw@host"), /credentials/);
  assert.equal(normalizeUrl("polyth.example.com:8443/x"), "https://polyth.example.com:8443");
});

const summary = (over: Record<string, unknown>) => ({
  id: "s1", projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1, ...over,
}) as Parameters<typeof diffSession>[1];

test("feed diff: created, started, finished (incl. via waiting), request pending, archived", () => {
  assert.deepEqual(diffSession(undefined, summary({})).map((e) => e.type), ["session.created"]);
  assert.deepEqual(diffSession(summary({}), summary({ status: "working", updatedAt: 2 })).map((e) => e.type), ["turn.started"]);
  assert.deepEqual(diffSession(summary({ status: "working" }), summary({ status: "waiting", updatedAt: 2, attention: { permissions: 1, questions: 0, unread: 0 } })).map((e) => e.type), ["request.pending"]);
  assert.deepEqual(diffSession(summary({ status: "waiting" }), summary({ status: "idle", updatedAt: 3 })).map((e) => e.type), ["turn.finished"]);
  assert.deepEqual(diffSession(summary({ status: "working" }), summary({ status: "archived", updatedAt: 3 })).map((e) => e.type), ["session.archived"]);
  assert.deepEqual(diffSession(summary({}), summary({ updatedAt: 5, title: "renamed" })).map((e) => e.type), ["session.updated"]);
  const finished = diffSession(summary({ status: "working" }), summary({ status: "idle", updatedAt: 9 }))[0]!;
  assert.equal(finished.cursor, 9);
  assert.equal(finished.previousStatus, "working");
});

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent => ({ id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data });

test("open requests are derived from history and close when resolved", () => {
  const open = openRequests([
    ev(1, "permission/requested", { requestId: "p1", permission: "Bash", patterns: ["rm -rf build"] }),
    ev(2, "question/asked", { requestId: "q1", questions: [{ id: "q0", title: "Pick", prompt: "Which?", options: [{ value: "a", label: "A" }] }] }),
    ev(3, "permission/requested", { requestId: "p2", permission: "Edit" }),
    ev(4, "permission/resolved", { requestId: "p2", reply: "once" }),
  ]);
  assert.deepEqual(open.map((r) => [r.kind, r.requestId]), [["permission", "p1"], ["question", "q1"]]);
  assert.equal(open[1]!.questionId, "q0");
  assert.deepEqual(open[1]!.options, [{ value: "a", label: "A" }]);
  assert.equal(openRequests([...[ev(1, "question/asked", { requestId: "q" })], ev(2, "question/answered", { requestId: "q" })]).length, 0);
});

test("idempotency keys map to stable UUIDs", async () => {
  const a = await operationIdFor("job-42");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await operationIdFor("job-42"), a);
  assert.notEqual(await operationIdFor("job-43"), a);
});

test("exit codes are stable for scripts", () => {
  assert.equal(exitCodeFor(new UsageError("x")), 2);
  assert.equal(exitCodeFor(new PolythError(401, "unauthorized", "x")), 3);
  assert.equal(exitCodeFor(new PolythError(403, "forbidden", "x")), 3);
  assert.equal(exitCodeFor(new PolythError(404, "not-found", "x")), 4);
  assert.equal(exitCodeFor(new PolythError(0, "unreachable", "x")), 5);
  assert.equal(exitCodeFor(new PolythError(409, "conflict", "x")), 6);
  assert.equal(exitCodeFor(Object.assign(new Error("t"), { code: "timeout" })), 7);
});

test("help, version and completion run without a server", async () => {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["--version"]), 0);
    assert.equal(await main(["help", "new"]), 0);
    assert.equal(await main(["nope"]), 2);
  } finally {
    process.stdout.write = original;
  }
  assert.match(writes.join(""), /0\.1\.0/);
  assert.match(writes.join(""), /Create a session and send it a prompt/);
  assert.match(completionScript("bash"), /complete -o default -F _polyth polyth/);
  assert.match(completionScript("fish"), /__fish_use_subcommand/);
  assert.match(completionScript("zsh"), /compdef _polyth polyth/);
});
