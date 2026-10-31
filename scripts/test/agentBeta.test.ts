import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const BASE_TYPESCRIPT_FILES = [
  "scripts/agent-beta.ts",
  "packages/harness-runtime/src/agentBeta.ts",
  "packages/server/src/index.ts",
  "packages/server/src/sessions.ts",
  "packages/server/src/routeRegistry.ts",
  "packages/server/src/routes/browse.ts",
  "packages/server/src/routes/projects.ts",
  "packages/files/src/index.ts",
  "packages/files/src/remote.ts",
  "packages/git/src/index.ts",
  "packages/terminal/src/index.ts",
];

/** Discovered harness backends' beta entry points, so the launcher check works
 *  whether or not a given removable backend package is installed. */
function backendTypescriptFiles(): string[] {
  const candidates = [
    "src/index.ts",
    "src/serverEntry.ts",
    "src/runtime.ts",
    "src/bridgeSource.ts",
    "src/delegation.ts",
    "src/endpoint.ts",
  ];
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("backend-")) continue;
    if (!existsSync(join(ROOT, "packages", entry.name, "package.json"))) continue;
    for (const candidate of candidates) {
      const relative = `packages/${entry.name}/${candidate}`;
      if (existsSync(join(ROOT, relative))) files.push(relative);
    }
  }
  return files;
}

const BETA_TYPESCRIPT_FILES = [...new Set([...BASE_TYPESCRIPT_FILES, ...backendTypescriptFiles()])];

test("agent beta TypeScript entry points parse under the repository Node contract", () => {
  for (const file of BETA_TYPESCRIPT_FILES) {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "--check",
      file,
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});


const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : port ? resolvePort(port) : reject(new Error("no free port")));
  });
});

const readyFrom = (child: ChildProcess): Promise<{ url: string; dataDir: string }> => new Promise((resolveReady, rejectReady) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error?: Error, value?: { url: string; dataDir: string }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? rejectReady(error) : resolveReady(value!);
  };
  const inspect = () => {
    const match = stdout.match(/^POLYTH_AGENT_BETA_READY (\{[^\n]+\})$/m);
    if (!match) return;
    try {
      const value = JSON.parse(match[1]!) as { url?: unknown; dataDir?: unknown };
      if (typeof value.url !== "string" || typeof value.dataDir !== "string") throw new Error("invalid ready payload");
      finish(undefined, { url: value.url, dataDir: value.dataDir });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); inspect(); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", (error) => finish(error));
  child.once("exit", (code, signal) => {
    if (!settled) finish(new Error(`agent beta exited before ready (${signal ?? code ?? "unknown"}): ${stderr.slice(-4000)}`));
  });
  const timer = setTimeout(() => {
    finish(new Error(`agent beta ready timeout: ${stderr.slice(-4000)}`));
  }, 45_000);
  timer.unref?.();
});

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10_000)),
  ]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await exited;
  }
};

test("agent beta launcher serves no-login UI state, keeps settings writable, blocks workspace writes, and cleans up", async () => {
  const port = await freePort();
  const blockedPath = `.agent-beta-write-${randomUUID()}.tmp`;
  const blockedAbsolute = join(ROOT, blockedPath);
  let child: ChildProcess | undefined;
  let dataDir = "";
  try {
    child = spawn(process.execPath, [
      "--experimental-strip-types",
      "scripts/agent-beta.ts",
      "--no-build",
      "--port", String(port),
      "--project", ROOT,
    ], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const ready = await readyFrom(child);
    dataDir = ready.dataDir;
    assert.equal(ready.url, `http://127.0.0.1:${port}`);

    const statusResponse = await fetch(`${ready.url}/api/auth/status`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { authorized?: boolean; scope?: string };
    assert.equal(status.authorized, true);
    // Loopback-only local trust (agent beta / debug agent access) mints one
    // reusable owner session so the no-login UI has a usable identity, and the
    // status reports that session scope. `local-user` is reserved for loopback
    // trust without a local-only origin (packages/identity/test/http.test.ts).
    assert.equal(status.scope, "ui-session");

    const projectsResponse = await fetch(`${ready.url}/api/projects`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json() as Array<{ id: string; path: string }>;
    const project = projects.find((item) => item.path === ROOT) ?? projects[0];
    assert.ok(project?.id, "beta project was not registered");

    const settingsUrl = `${ready.url}/api/projects/${encodeURIComponent(project.id)}/settings`;
    const settingsResponse = await fetch(settingsUrl, { signal: AbortSignal.timeout(5_000) });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json() as { revision?: number };
    const savedSettings = await fetch(settingsUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: { workspaceMode: "widgets" },
        expectedRevision: settings.revision ?? 0,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(savedSettings.status, 200, await savedSettings.text());

    const readResponse = await fetch(
      `${ready.url}/api/files/read?projectId=${encodeURIComponent(project.id)}&path=package.json`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(readResponse.status, 200);
    const read = await readResponse.json() as { content?: string };
    assert.match(read.content ?? "", /"name"\s*:\s*"polyth"/);

    const writeResponse = await fetch(`${ready.url}/api/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        path: blockedPath,
        content: "must not be written\n",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(writeResponse.status, 403, await writeResponse.text());
    assert.equal(existsSync(blockedAbsolute), false);
  } finally {
    if (child) await stopChild(child);
    if (existsSync(blockedAbsolute)) rmSync(blockedAbsolute, { force: true });
  }
  assert.ok(dataDir, "beta data directory was not reported");
  assert.equal(existsSync(dataDir), false, "beta data directory must be removed after launcher exit");
});
