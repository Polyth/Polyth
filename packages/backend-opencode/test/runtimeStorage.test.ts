import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  inspectOpenCodeEngine,
  OPEN_CODE_QUARANTINE_TTL_MS,
  OPEN_CODE_RUNTIME_STALE_TTL_MS,
  OPENCODE_UPDATE_DISABLE_ENV,
  POLYTH_OPENCODE_BIN_ENV,
  prepareOpenCodeRuntime,
  resolveOpenCodeBinary,
  sweepOpenCodeRuntimes,
} from "../src/index.ts";

const TEST_ENGINE = {
  engine: "opencode" as const,
  version: "1.18.18",
  binaryDigest: "a".repeat(64),
  protocolGeneration: 1,
};

const TEST_BINARY = {
  executablePath: "/test-opencode-binaries/opencode",
  binarySource: "path" as const,
};

const metadata = (
  projectId: string,
  cwd: string,
  lastOpenedAt: number,
) => ({
  engine: "opencode",
  version: "1.18.18",
  binaryDigest: "a".repeat(64),
  protocolGeneration: 1,
  storageId: "11111111-1111-4111-8111-111111111111",
  runtimeAuthority: `owned:${projectId}`,
  runtimeLocation: { projectId, cwd },
  createdAt: new Date(lastOpenedAt).toISOString(),
  lastOpenedAt: new Date(lastOpenedAt).toISOString(),
});

test("runtime GC removes only stale missing worktrees and expires quarantine independently", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-runtime-gc-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, "runtimes", "opencode");
  const liveCwd = join(directory, "live-worktree");
  const liveRuntime = join(root, "live");
  const missingRuntime = join(root, "missing");
  const now = Date.UTC(2026, 7, 28);
  const staleOpenedAt = now - OPEN_CODE_RUNTIME_STALE_TTL_MS - 1;
  await mkdir(liveCwd, { recursive: true });
  await Promise.all([
    mkdir(join(liveRuntime, "quarantine", `${now - OPEN_CODE_QUARANTINE_TTL_MS - 1}-old`), {
      recursive: true,
    }),
    mkdir(join(liveRuntime, "quarantine", `${now - OPEN_CODE_QUARANTINE_TTL_MS + 1}-recent`), {
      recursive: true,
    }),
    mkdir(missingRuntime, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(liveRuntime, "runtime.json"),
      JSON.stringify(metadata("live", liveCwd, staleOpenedAt)),
    ),
    writeFile(
      join(missingRuntime, "runtime.json"),
      JSON.stringify(metadata("missing", join(directory, "gone"), staleOpenedAt)),
    ),
  ]);

  assert.deepEqual(await sweepOpenCodeRuntimes(root, { now }), {
    runtimesRemoved: 1,
    quarantinesRemoved: 1,
  });
  assert.equal(JSON.parse(await readFile(join(liveRuntime, "runtime.json"), "utf8")).engine, "opencode");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await assert.rejects(
    () => stat(missingRuntime),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assert.rejects(
    () => stat(join(liveRuntime, "quarantine", `${now - OPEN_CODE_QUARANTINE_TTL_MS - 1}-old`)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.ok(await stat(join(liveRuntime, "quarantine", `${now - OPEN_CODE_QUARANTINE_TTL_MS + 1}-recent`)));
});

test("engine version and DB-path probes both use the isolated probe DB", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-engine-probe-env-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const executable = join(directory, "opencode-test");
  const capture = join(directory, "probe-env.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$1" "$OPENCODE_DB" "$OPENCODE_DISABLE_AUTOUPDATE" >> "$POLYTH_PROBE_CAPTURE"
if [ "$1" = "--version" ]; then
  printf '1.18.18\\n'
elif [ "$1" = "db" ] && [ "$2" = "path" ]; then
  printf '%s\\n' "$OPENCODE_DB"
else
  exit 2
fi
`);
  await chmod(executable, 0o700);

  const previousCapture = process.env.POLYTH_PROBE_CAPTURE;
  process.env.POLYTH_PROBE_CAPTURE = capture;
  try {
    const identity = await inspectOpenCodeEngine(executable);
    assert.equal(identity.version, "1.18.18");
  } finally {
    if (previousCapture === undefined) delete process.env.POLYTH_PROBE_CAPTURE;
    else process.env.POLYTH_PROBE_CAPTURE = previousCapture;
  }

  const invocations = (await readFile(capture, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  assert.deepEqual(
    [...invocations.map(([argument]) => argument)].sort(),
    ["--version", "db"].sort(),
  );
  assert.ok(invocations[0]![1], "the version probe must receive OPENCODE_DB");
  assert.ok(invocations[1]![1], "the db-path probe must receive OPENCODE_DB");
  assert.match(invocations[0]![1]!, /polyth-opencode-db-probe-.+\/probe\.db$/);
  assert.match(invocations[1]![1]!, /polyth-opencode-db-probe-.+\/probe\.db$/);
  assert.notEqual(
    invocations[0]![1],
    invocations[1]![1],
    "version and db-path probes must not share a probe DB",
  );
  assert.deepEqual(invocations.map((fields) => fields[2]).sort(), ["true", "true"]);
});

test("engine inspect caches identity for an unchanged binary and coalesces in-flight probes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-engine-inspect-cache-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const executable = join(directory, "opencode-test");
  const capture = join(directory, "probe-env.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$1" >> "$POLYTH_PROBE_CAPTURE"
if [ "$1" = "--version" ]; then
  printf '1.18.18\\n'
elif [ "$1" = "db" ] && [ "$2" = "path" ]; then
  printf '%s\\n' "$OPENCODE_DB"
else
  exit 2
fi
`);
  await chmod(executable, 0o700);

  const previousCapture = process.env.POLYTH_PROBE_CAPTURE;
  process.env.POLYTH_PROBE_CAPTURE = capture;
  try {
    const [first, second] = await Promise.all([
      inspectOpenCodeEngine(executable),
      inspectOpenCodeEngine(executable),
    ]);
    assert.deepEqual(first, second);
    const third = await inspectOpenCodeEngine(executable);
    assert.deepEqual(third, first);
  } finally {
    if (previousCapture === undefined) delete process.env.POLYTH_PROBE_CAPTURE;
    else process.env.POLYTH_PROBE_CAPTURE = previousCapture;
  }

  const invocations = (await readFile(capture, "utf8")).trim().split("\n");
  assert.equal(
    invocations.length,
    2,
    "an unchanged binary must not relaunch --version or db path",
  );
});

test("binary resolution prefers desktop absolute paths, then override, configured, and PATH", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-binary-resolution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pathDirectory = join(directory, "path-bin");
  await mkdir(pathDirectory);
  const pathBinary = join(pathDirectory, "opencode");
  const overrideBinary = join(directory, "override-opencode");
  const bundledBinary = join(directory, "bundled-opencode");
  for (const binary of [pathBinary, overrideBinary, bundledBinary]) {
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o700);
  }
  const env = {
    PATH: pathDirectory,
    [POLYTH_OPENCODE_BIN_ENV]: overrideBinary,
  };

  assert.deepEqual(
    await resolveOpenCodeBinary({
      bin: bundledBinary,
      binarySource: "bundled",
      env,
    }),
    {
      executablePath: resolve(bundledBinary),
      binarySource: "bundled",
    },
  );
  assert.deepEqual(
    await resolveOpenCodeBinary({ env }),
    {
      executablePath: resolve(overrideBinary),
      binarySource: "override",
      binaryOverrideEnv: POLYTH_OPENCODE_BIN_ENV,
    },
  );
  assert.deepEqual(
    await resolveOpenCodeBinary({
      bin: "opencode",
      env: { PATH: pathDirectory },
    }),
    {
      executablePath: resolve(pathBinary),
      binarySource: "configured",
    },
  );
  assert.deepEqual(
    await resolveOpenCodeBinary({ env: { PATH: pathDirectory } }),
    {
      executablePath: resolve(pathBinary),
      binarySource: "path",
    },
  );
});

test("override resolution failures name the env and attempted binary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-binary-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing-opencode");
  const nonExecutable = join(directory, "non-executable-opencode");
  await writeFile(nonExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(nonExecutable, 0o600);

  for (const attempted of [missing, nonExecutable]) {
    await assert.rejects(
      () => resolveOpenCodeBinary({
        env: {
          PATH: "",
          [POLYTH_OPENCODE_BIN_ENV]: attempted,
        },
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "unavailable");
        assert.match(error.message, new RegExp(POLYTH_OPENCODE_BIN_ENV));
        assert.ok(error.message.includes(attempted));
        return true;
      },
    );
  }
  assert.equal(OPENCODE_UPDATE_DISABLE_ENV, "OPENCODE_DISABLE_AUTOUPDATE");
});

test("prepare refuses a symlink runtimeDir and does not write through it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-runtime-dir-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const victim = join(directory, "victim");
  const alias = join(directory, "alias");
  await mkdir(victim, { recursive: true, mode: 0o700 });
  await writeFile(join(victim, "opencode.db"), "victim-db", { mode: 0o600 });
  await symlink(victim, alias);

  await assert.rejects(
    () => prepareOpenCodeRuntime({
      runtimeDir: alias,
      projectId: "attacker",
      cwd: join(directory, "cwd"),
      engineIdentity: TEST_ENGINE,
      binary: TEST_BINARY,
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /symlink/);
      return true;
    },
  );
  assert.equal(await readFile(join(victim, "opencode.db"), "utf8"), "victim-db");
  await assert.rejects(() => stat(join(victim, "runtime.json")));
});

test("prepare treats a symlink runtime.json as invalid metadata and mints a new storageId", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-runtime-json-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDir = join(directory, "runtime");
  const cwd = join(directory, "cwd");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true });
  const stolen = metadata("project-a", cwd, Date.now());
  const foreign = join(directory, "stolen-runtime.json");
  await writeFile(foreign, JSON.stringify(stolen));
  await writeFile(join(runtimeDir, "opencode.db"), "current-db", { mode: 0o600 });
  await symlink(foreign, join(runtimeDir, "runtime.json"));

  const prepared = await prepareOpenCodeRuntime({
    runtimeDir,
    projectId: "project-a",
    cwd,
    engineIdentity: TEST_ENGINE,
    binary: TEST_BINARY,
  });
  assert.notEqual(prepared.storageId, stolen.storageId);
  await prepared.recordOpen({ authorityId: "owned:new", generation: 1 });
  assert.equal((await lstat(join(runtimeDir, "runtime.json"))).isSymbolicLink(), false);
  assert.equal(JSON.parse(await readFile(foreign, "utf8")).storageId, stolen.storageId);
});
