#!/usr/bin/env node
// Boot the Polyth server from source against a given OpenCode executable with
// a fresh data dir, then ask for the model catalog exactly as a new chat's
// composer does. Passes only when OpenCode answers with at least one model.
//
// The desktop startup smoke stops at the first-run setup server, so it never
// reaches harness discovery; this check covers the "works out of the box"
// promise on each platform the desktop app ships for. Every harness probe is
// timed separately so a hang names the harness that caused it.
//
//   node scripts/ci/opencode-catalog-smoke.mjs --opencode <path-to-opencode[.exe]>
//   node scripts/ci/opencode-catalog-smoke.mjs --desktop <unpacked Polyth executable>
//
// --desktop launches the packaged app instead, with its own bundled OpenCode.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const desktop = option("--desktop", "") && resolve(option("--desktop", ""));
const bundledInDesktop = desktop
  ? join(dirname(desktop), "resources", "opencode", `${process.platform}-${process.arch}`, process.platform === "win32" ? "opencode.exe" : "opencode")
  : "";
const opencode = option("--opencode", bundledInDesktop || process.env.POLYTH_OPENCODE_BUNDLED_BIN || "");
const logDirs = [];
const budgetMs = Number(option("--timeout-ms", "240000"));
if (!opencode || !existsSync(opencode)) {
  console.error(`opencode-catalog-smoke: OpenCode executable is missing: ${opencode || "<not provided>"}`);
  process.exit(2);
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (message) => console.log(`[catalog-smoke +${elapsed()}] ${message}`);

const work = mkdtempSync(join(tmpdir(), "polyth-catalog-smoke-"));
const project = join(work, "project");
spawnSync("git", ["init", "-q", project], { stdio: "ignore" });

let beta;
let ready;
let dataDir = "";
let failed = false;

const killTree = (child) => {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};

const timed = async (label, path, timeoutMs) => {
  const at = Date.now();
  try {
    const response = await fetch(`${ready.url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
    return { label, ms: Date.now() - at, status: response.status, body };
  } catch (error) {
    return { label, ms: Date.now() - at, error: error?.name === "TimeoutError" ? `no answer within ${timeoutMs}ms` : String(error?.message ?? error) };
  }
};

const summarize = (result) => {
  if (result.error) return `${result.label}: ${result.error} after ${result.ms}ms`;
  if (!Array.isArray(result.body)) return `${result.label}: HTTP ${result.status} after ${result.ms}ms ${JSON.stringify(result.body).slice(0, 400)}`;
  const rows = result.body.map((row) => {
    const models = row.catalog?.models ?? [];
    return `${row.identity?.id}=${row.availability?.state}${row.availability?.installed === false ? "(not installed)" : ""}`
      + ` models=${models.length}${row.message ? ` "${String(row.message).slice(0, 300)}"` : ""}`;
  });
  return `${result.label}: HTTP ${result.status} after ${result.ms}ms [${rows.join("; ") || "no rows"}]`;
};

const tailLogs = (dir, depth = 0) => {
  if (!dir || depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { tailLogs(path, depth + 1); continue; }
    if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
    try {
      if (statSync(path).size === 0) continue;
      const contents = readFileSync(path, "utf8");
      console.log(`--- ${path} (last 6000 chars) ---\n${contents.slice(-6000)}`);
    } catch {}
  }
};

const main = async () => {
  say(`OpenCode: ${opencode}`);
  const version = spawnSync(opencode, ["--version"], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  say(`opencode --version -> status=${version.status} signal=${version.signal ?? "none"} out=${(version.stdout || version.stderr || "").trim().slice(0, 200)}`);

  // --fresh-home hides this machine's own OpenCode/harness config, as on a
  // new install. CI runners are already clean, so it stays opt-in.
  const home = join(work, "home");
  const freshHome = args.includes("--fresh-home")
    ? {
        HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
        POLYTH_HARNESS_SHELL_PROBE: "0", POLYTH_OPENCODE_SHELL_PROBE: "0",
      }
    : {};
  ready = desktop ? await launchDesktop(freshHome) : await launchSource(freshHome);
  dataDir = ready.dataDir;
  say(`server ready at ${ready.url}`);

  const projects = await timed("projects", "/api/projects", 15_000);
  let list = Array.isArray(projects.body) ? projects.body : projects.body?.projects ?? [];
  if (list.length === 0) {
    const created = await fetch(`${ready.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project, name: "Catalog smoke" }),
      signal: AbortSignal.timeout(15_000),
    });
    say(`registered project: HTTP ${created.status}`);
    const again = await timed("projects", "/api/projects", 15_000);
    list = Array.isArray(again.body) ? again.body : again.body?.projects ?? [];
  }
  await probeCatalog(list[0]?.id, projects);
};

const output = (tag) => (chunk) => process.stdout.write(chunk.toString().replace(/^/gm, `  [${tag}] `));

const launchSource = (freshHome) => {
  beta = spawn(process.execPath, ["--experimental-strip-types", "scripts/agent-beta.ts", "--no-build", "--project", project], {
    cwd: root,
    env: { ...process.env, ...freshHome, POLYTH_OPENCODE_BUNDLED_BIN: resolve(opencode) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return new Promise((resolveReady, rejectReady) => {
    let buffer = "";
    const timer = setTimeout(() => rejectReady(new Error("server did not become ready within 120s")), 120_000);
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text.replace(/^/gm, "  [server] "));
      buffer += text;
      const match = buffer.match(/POLYTH_AGENT_BETA_READY (\{.*\})/);
      if (match) { clearTimeout(timer); resolveReady(JSON.parse(match[1])); }
    };
    beta.stdout.on("data", onData);
    beta.stderr.on("data", (chunk) => process.stdout.write(chunk.toString().replace(/^/gm, "  [server] ")));
    beta.once("exit", (code) => { clearTimeout(timer); rejectReady(new Error(`server exited early with ${code}`)); });
  });
};

const freePort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

// The packaged app runs the server inside Electron with its packaged
// resources. Complete first-run setup ahead of time (as scripts/agent-beta.ts
// does) and pin the port the app will reuse, so it boots straight to a ready
// server instead of the setup form.
const launchDesktop = async (freshHome) => {
  const userData = join(work, "user-data");
  const data = join(work, "data");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(userData, "desktop"), { recursive: true });
  writeFileSync(join(userData, "desktop", "server-port.json"), `${JSON.stringify({ port })}\n`);
  const security = pathToFileURL(join(root, "packages", "server", "src", "canonicalSecurity.ts")).href;
  const init = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { randomUUID } from "node:crypto";
    import { createCanonicalSecurity } from ${JSON.stringify(security)};
    const security = createCanonicalSecurity({ dataDir: process.env.SMOKE_DATA, origin: process.env.SMOKE_ORIGIN, localOnly: true });
    try {
      const setup = security.identity.setup;
      const claim = setup.issueClaim();
      const binding = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      setup.bindClaim(claim.token, binding);
      const recovery = setup.prepareRecovery(claim.token, binding);
      await setup.complete({
        claimToken: claim.token, browserBinding: binding, name: "Catalog Smoke", organizationName: "Catalog Smoke",
        login: "catalog-smoke-" + randomUUID().slice(0, 8), password: "CatalogSmoke-" + randomUUID() + "-" + randomUUID(),
        recoverySetId: recovery.setId, recoveryAcknowledged: true,
      });
    } finally { security.close(); }
  `], { cwd: root, env: { ...process.env, SMOKE_DATA: data, SMOKE_ORIGIN: url }, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`could not pre-complete setup: ${init.stderr || init.stdout}`);
  say(`launching packaged app ${desktop}`);
  beta = spawn(desktop, process.platform === "win32" ? ["--no-sandbox", "--disable-gpu"] : [], {
    env: {
      ...process.env,
      ...freshHome,
      ELECTRON_ENABLE_LOGGING: "1",
      POLYTH_DESKTOP_USER_DATA: userData,
      POLYTH_DATA_DIR: data,
      // Loopback-only owner access for this probe (packages/server/src/index.ts).
      POLYTH_AGENT_BETA: "1",
      POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  beta.stdout.on("data", output("desktop"));
  beta.stderr.on("data", output("desktop"));
  logDirs.push(userData);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (beta.exitCode !== null) throw new Error(`packaged app exited early with ${beta.exitCode}`);
    try {
      if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("packaged app server did not answer /api/health within 120s");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return { url, dataDir: data };
};

const probeCatalog = async (projectId, projects) => {
  if (!projectId) throw new Error(`no project registered: ${JSON.stringify(projects).slice(0, 500)}`);
  const query = (extra) => `/api/harnesses/snapshots?${new URLSearchParams({ projectId, ...extra })}`;

  const roster = await timed("roster", `/api/harnesses/roster?projectId=${projectId}`, 15_000);
  const ids = Array.isArray(roster.body) ? roster.body.map((row) => row.identity.id) : [];
  say(`harnesses: ${ids.join(", ")}`);

  // One request per harness, concurrently, so a hang names its harness.
  const probes = await Promise.all(ids.map((id) => timed(`probe ${id}`, query({ harnessId: id }), 60_000)));
  for (const probe of probes) say(summarize(probe));

  const detail = await timed("opencode detail", query({ harnessId: "opencode", detail: "1" }), 150_000);
  say(summarize(detail));
  // The exact request a new chat's composer makes for the Auto route.
  const auto = await timed("composer auto route", query({ auto: "1", detail: "1" }), 150_000);
  say(summarize(auto));
  const diagnostics = await timed("runtime diagnostics", "/api/runtime/diagnostics", 15_000);
  console.log(`runtime diagnostics: ${JSON.stringify(diagnostics.body ?? diagnostics.error, null, 2).slice(0, 8000)}`);

  // OpenCode must list models itself, and the Auto route must offer some
  // model (on a machine with another signed-in harness Auto may prefer it).
  const models = (Array.isArray(detail.body) ? detail.body[0]?.catalog?.models : undefined) ?? [];
  const autoModels = (Array.isArray(auto.body) ? auto.body[0]?.catalog?.models : undefined) ?? [];
  if (models.length === 0 || autoModels.length === 0) {
    failed = true;
    console.error(`opencode-catalog-smoke: FAILED — OpenCode models=${models.length}, Auto route models=${autoModels.length}`);
  } else {
    say(`PASS — OpenCode answered with ${models.length} models (${models.slice(0, 5).map((model) => `${model.providerID}/${model.id ?? model.modelID}`).join(", ")})`);
  }
};

const deadline = setTimeout(() => {
  failed = true;
  console.error(`opencode-catalog-smoke: FAILED — no verdict within ${budgetMs}ms`);
  finish();
}, budgetMs);

let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (failed) {
    tailLogs(dataDir);
    for (const dir of logDirs) tailLogs(dir);
    tailLogs(join(homedir(), ".local", "share", "opencode", "log"));
  }
  killTree(beta);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  failed = true;
  console.error(`opencode-catalog-smoke: FAILED — ${error?.stack ?? error}`);
}).finally(finish);
