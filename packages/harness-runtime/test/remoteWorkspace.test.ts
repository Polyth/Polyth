import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteProcessHost } from "../src/remoteHost.ts";
import { applyRemoteWorkspaceEdit, createRemoteWorkspace, resolveRemoteWorkspacePath } from "../src/remoteWorkspace.ts";

// The fake host runs the remote argv locally in the requested directory, the
// way the SSH transport's raw-pipe process command does on the far side.
const host: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand: (argv, opts) => ({ command: "sh", args: ["-c", 'cd "$0" || exit 78; exec "$@"', opts?.cwd ?? "/", ...argv] }),
};

const project = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-workspace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "README.md"), "# Shop\n\nSecond line\n");
  writeFileSync(join(dir, "src", "price.py"), "def total(items):\n    return sum(items)\n\ndef tax(x):\n    return x * 0.2\n");
  writeFileSync(join(dir, "src", "cart.py"), "from price import total\n");
  return dir;
};

test("paths resolve against the project root and never above the filesystem root", () => {
  assert.equal(resolveRemoteWorkspacePath("/srv/app", "src/a.py"), "/srv/app/src/a.py");
  assert.equal(resolveRemoteWorkspacePath("/srv/app", "./src/../b"), "/srv/app/b");
  assert.equal(resolveRemoteWorkspacePath("/srv/app", "../other/x"), "/srv/other/x");
  assert.equal(resolveRemoteWorkspacePath("/srv/app", "/etc/hosts"), "/etc/hosts");
  assert.equal(resolveRemoteWorkspacePath("/srv/app", "../../../../x"), "/x");
  assert.equal(resolveRemoteWorkspacePath("/srv/app"), "/srv/app");
});

test("an edit replaces one exact match and keeps a CRLF file's line endings", () => {
  assert.deepEqual(applyRemoteWorkspaceEdit("a\nb\n", "b", "c", false), { ok: true, next: "a\nc\n", replacements: 1 });
  assert.deepEqual(applyRemoteWorkspaceEdit("x x x", "x", "y", true), { ok: true, next: "y y y", replacements: 3 });
  assert.deepEqual(applyRemoteWorkspaceEdit("x x", "x", "y", false), { ok: false, reason: "ambiguous", matches: 2 });
  assert.deepEqual(applyRemoteWorkspaceEdit("x", "z", "y", false), { ok: false, reason: "not-found", matches: 0 });
  assert.deepEqual(applyRemoteWorkspaceEdit("x", "x", "x", false), { ok: false, reason: "identical", matches: 0 });
  assert.deepEqual(
    applyRemoteWorkspaceEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "1\n2", false),
    { ok: true, next: "1\r\n2\r\nthree\r\n", replacements: 1 },
  );
  // `$&` in the replacement is text, not a back-reference.
  assert.deepEqual(applyRemoteWorkspaceEdit("cost", "cost", "$& and $1", false), { ok: true, next: "$& and $1", replacements: 1 });
});

test("bash runs in the project root, merges stderr and reports the exit code", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());

  assert.deepEqual(await workspace.call("bash", { command: "pwd && ls src | sort" }), { text: `${dir}\ncart.py\nprice.py\n` });
  assert.deepEqual(await workspace.call("bash", { command: "true" }), { text: "(no output)" });
  const failed = await workspace.call("bash", { command: "echo out; echo err >&2; exit 3" });
  assert.equal(failed.isError, true);
  assert.equal(failed.text, "out\nerr\n[exit code 3]");
  // The command is one argument: quotes and metacharacters need no escaping.
  assert.deepEqual(await workspace.call("bash", { command: `printf '%s' "it's \\"quoted\\" $HOME" | wc -c` }), {
    text: `${`it's "quoted" ${process.env.HOME}`.length}\n`,
  });
  const slow = await workspace.call("bash", { command: "sleep 5; echo late", timeout: 1_000 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /timed out after 1s/);
  assert.deepEqual(await workspace.call("bash", {}), { text: "command is required.", isError: true });
});

test("read numbers lines, pages with offset and limit, and names what is missing", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());

  assert.equal((await workspace.call("read", { file_path: "README.md" })).text, "     1\t# Shop\n     2\t\n     3\tSecond line");
  assert.equal(
    (await workspace.call("read", { file_path: join(dir, "src/price.py"), offset: 2, limit: 2 })).text,
    "     2\t    return sum(items)\n     3\t\n… [showing lines 2-3 of 5; pass offset and limit for the rest]",
  );
  assert.deepEqual(await workspace.call("read", { file_path: "gone.txt" }), { text: `File does not exist: ${dir}/gone.txt`, isError: true });
  assert.equal((await workspace.call("read", { file_path: "src" })).isError, true);
  writeFileSync(join(dir, "empty"), "");
  assert.equal((await workspace.call("read", { file_path: "empty" })).text, "(file is empty)");
  assert.match((await workspace.call("read", { file_path: "README.md", offset: 40 })).text, /no lines at offset 40; the file has 3 lines/);
});

test("write creates parents, replaces atomically and keeps the file mode", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());

  assert.equal((await workspace.call("write", { file_path: "docs/deep/new.md", content: "hello\n" })).isError, undefined);
  assert.equal(readFileSync(join(dir, "docs/deep/new.md"), "utf8"), "hello\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  await workspace.call("write", { file_path: "run.sh", content: "#!/bin/sh\necho hi\n" });
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(statSync(join(dir, "run.sh")).mode & 0o777, 0o755);
  // No temporary file is left next to the target.
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".polyth-edit-")), []);
  assert.equal((await workspace.call("write", { file_path: "x" })).isError, true);
});

test("edit changes the file on the host and refuses stale or unclear replacements", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());
  const file = join(dir, "src/price.py");

  assert.deepEqual(await workspace.call("edit", { file_path: "src/price.py", old_string: "x * 0.2", new_string: "x * 0.25" }), {
    text: `Edited ${file}: 1 replacement.`,
  });
  assert.match(readFileSync(file, "utf8"), /return x \* 0\.25\n$/);
  const ambiguous = await workspace.call("edit", { file_path: "src/price.py", old_string: "return", new_string: "yield" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /Found 2 matches/);
  assert.match((await workspace.call("edit", { file_path: "src/price.py", old_string: "nope", new_string: "x" })).text, /not found/);
  assert.match((await workspace.call("edit", { file_path: "missing.py", old_string: "a", new_string: "b" })).text, /does not exist/);
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  assert.match((await workspace.call("edit", { file_path: "blob.bin", old_string: "A", new_string: "B" })).text, /not valid UTF-8/);
  assert.deepEqual(readFileSync(join(dir, "blob.bin")), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
});

test("an edit never overwrites a file that changed on the host after it was read", async (t) => {
  const dir = project(t);
  const file = join(dir, "README.md");
  let reads = 0;
  // The file changes between the edit's read and its write.
  const racing: RemoteProcessHost = {
    ...host,
    processCommand(argv, opts) {
      if (argv[2]?.includes("exec cat")) reads += 1;
      else if (reads === 1 && argv[2]?.includes("mktemp")) writeFileSync(file, "# Shop\n\nChanged elsewhere\n");
      return host.processCommand(argv, opts);
    },
  };
  const workspace = createRemoteWorkspace(racing, dir);
  t.after(() => workspace.close());

  const result = await workspace.call("edit", { file_path: "README.md", old_string: "Second line", new_string: "Edited" });
  assert.equal(result.isError, true);
  assert.match(result.text, /changed on the host since it was read/);
  assert.equal(readFileSync(file, "utf8"), "# Shop\n\nChanged elsewhere\n");
});

test("grep and glob search the project and report nothing found plainly", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());

  const files = (await workspace.call("grep", { pattern: "total" })).text.split("\n").sort();
  assert.deepEqual(files, ["src/cart.py", "src/price.py"]);
  assert.match((await workspace.call("grep", { pattern: "def tax", output_mode: "content" })).text, /src\/price\.py:4:def tax\(x\):/);
  assert.equal((await workspace.call("grep", { pattern: "DEF TAX", case_insensitive: true })).text, "src/price.py");
  assert.equal((await workspace.call("grep", { pattern: "total", glob: "cart.*" })).text, "src/cart.py");
  assert.equal((await workspace.call("grep", { pattern: "no-such-text-anywhere" })).text, "No matches found.");
  // A pattern that looks like an option is still a pattern.
  assert.equal((await workspace.call("grep", { pattern: "-rf" })).text, "No matches found.");

  assert.deepEqual((await workspace.call("glob", { pattern: "**/*.py" })).text.split("\n").sort(), ["src/cart.py", "src/price.py"]);
  assert.equal((await workspace.call("glob", { pattern: "*.py", path: "src" })).text.split("\n").length, 2);
  assert.equal((await workspace.call("glob", { pattern: "*.rs" })).text, "No files found.");
  assert.match((await workspace.call("glob", { pattern: "*", path: "nowhere" })).text, /Directory does not exist/);
});

test("values that look like shell never run as shell", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  t.after(() => workspace.close());
  const marker = join(dir, "pwned");

  await workspace.call("read", { file_path: `x"; touch ${marker}; echo "` });
  await workspace.call("read", { file_path: `$(touch ${marker})` });
  await workspace.call("write", { file_path: "`touch pwned`.txt", content: "$(touch pwned)" });
  await workspace.call("grep", { pattern: `'; touch ${marker}; '`, glob: `$(touch ${marker})` });
  await workspace.call("glob", { pattern: `*; touch ${marker}` });
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(dir, "`touch pwned`.txt"), "utf8"), "$(touch pwned)");
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a cancelled, timed-out or closed command stops on the host too", async (t) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  // Each command would leave a marker two seconds in, well after it is stopped.
  const later = (name: string) => `sleep 2; touch ${join(dir, name)}; sleep 20`;

  const controller = new AbortController();
  const started = Date.now();
  const running = workspace.call("bash", { command: later("after-cancel") }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  assert.deepEqual(await running, { text: "Cancelled.", isError: true });
  assert.ok(Date.now() - started < 1_500, "the caller is released at once");

  const timed = await workspace.call("bash", { command: later("after-timeout"), timeout: 1_000 });
  assert.match(timed.text, /timed out after 1s/);

  const closing = workspace.call("bash", { command: later("after-close") });
  setTimeout(() => workspace.close(), 200);
  assert.equal((await closing).isError, true);
  assert.deepEqual(await workspace.call("bash", { command: "echo late" }), { text: "Cancelled.", isError: true });

  await sleep(3_500);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("after-")), []);
});

test("an unreachable host is reported as such, not as a tool result", async (t) => {
  const dir = project(t);
  const down: RemoteProcessHost = {
    ...host,
    processCommand: () => ({ command: "sh", args: ["-c", "echo 'ssh: connect to host remote port 22: Connection refused' >&2; exit 255"] }),
  };
  const workspace = createRemoteWorkspace(down, dir);
  t.after(() => workspace.close());
  for (const [tool, input] of [
    ["bash", { command: "ls" }],
    ["read", { file_path: "README.md" }],
    ["write", { file_path: "a", content: "b" }],
    ["edit", { file_path: "README.md", old_string: "a", new_string: "b" }],
    ["glob", { pattern: "*" }],
  ] as const) {
    const result = await workspace.call(tool, input);
    assert.equal(result.isError, true, tool);
    assert.match(result.text, /Could not reach dev@remote: ssh: connect to host remote port 22: Connection refused/, tool);
  }
});
