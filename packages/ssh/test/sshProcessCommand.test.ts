import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSshService, REMOTE_HARNESS_PATH, remoteProcessScript } from "../src/index.ts";

test("remote process script enters the workspace and execs argv with quoted values", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-ssh-proc-")));
  const cwd = join(root, "it's a dir; $(touch pwned)");
  mkdirSync(cwd);
  const script = remoteProcessScript(
    ["sh", "-c", 'printf "%s|%s|%s" "$PWD" "$1" "$MARK"', "sh", "a b'c"],
    { cwd, env: { MARK: "x $(y) 'z'" } },
  );
  assert.ok(script.startsWith(REMOTE_HARNESS_PATH));
  // This is the line sshd hands to the remote login shell.
  const out = execFileSync("sh", ["-c", script], { encoding: "utf8" });
  assert.equal(out, `${cwd}|a b'c|x $(y) 'z'`);
});

test("remote process script refuses a missing workspace and malformed env names", () => {
  const script = remoteProcessScript(["true"], { cwd: "/definitely/not/here" });
  assert.throws(() => execFileSync("sh", ["-c", script], { stdio: "ignore" }), (error: { status?: number }) => error.status === 78);
  assert.throws(() => remoteProcessScript(["true"], { env: { "A=B": "x" } }), /invalid environment variable name/);
  assert.throws(() => remoteProcessScript([]), /remote command is required/);
});

test("a connection's host launches raw-pipe processes through the shared master", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ssh-proc-svc-"));
  const ssh = createSshService({ file: join(dir, "ssh.json"), socketDir: join(dir, "sock"), runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const conn = ssh.create({ host: "box.example", user: "dev", port: 2222 });
  const launch = ssh.host(conn.id).processCommand!(["codex", "app-server"], { cwd: "/srv/app" });
  assert.equal(launch.command, "ssh");
  const separator = launch.args.indexOf("--");
  assert.ok(launch.args.slice(0, separator).includes("-T"), "never allocates a TTY");
  assert.ok(launch.args.includes("BatchMode=yes"));
  assert.ok(launch.args.some((arg) => arg.startsWith("ControlPath=")));
  assert.deepEqual(launch.args.slice(separator + 1, separator + 2), ["dev@box.example"]);
  assert.match(launch.args.at(-1)!, /cd -- '\/srv\/app' \|\| exit 78; exec 'codex' 'app-server'$/);
});
