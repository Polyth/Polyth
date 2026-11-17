// Smoke test of a packaged server archive, as a user gets it: unpack it, start
// it on a free loopback port with an empty data directory, complete first-run
// setup through the same HTTP API the setup page uses, restart into the full
// server (every package), sign in and make an authenticated request.
//   node --experimental-strip-types apps/server/smoke.ts [archive.tar.gz]
// Without an argument it takes the archive in apps/server/release.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releaseDir = join(import.meta.dirname, "release");
const archive = resolve(process.argv[2]
  ?? join(releaseDir, (existsSync(releaseDir) ? readdirSync(releaseDir) : []).find((file) => file.endsWith(".tar.gz")) ?? "missing.tar.gz"));
if (!existsSync(archive)) throw new Error(`no server archive at ${archive}`);

const freePort = () => new Promise<number>((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")));
  });
});

const check = (ok: unknown, what: string): void => {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`ok - ${what}`);
};

/** A browser's view of the server: its cookies and CSRF token. */
function browser(origin: string) {
  const jar = new Map<string, string>();
  let csrf = "";
  return async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        "content-type": "application/json",
        "x-polyth-csrf": csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(";")[0]!;
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof value.csrfToken === "string") csrf = value.csrfToken;
    return { status: response.status, value };
  };
}

const work = await mkdtemp(join(tmpdir(), "polyth-server-smoke-"));
const running = new Set<ChildProcess>();
try {
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", work], { stdio: "inherit" });
  check(unpacked.status === 0, "archive unpacks");
  const root = join(work, "polyth");
  const build = JSON.parse(await readFile(join(root, "BUILD.json"), "utf8")) as { version: string; target: string };
  check(build.target === `${process.platform}-${process.arch}`, `built for this machine (${build.target})`);
  const exe = process.platform === "win32" ? ".exe" : "";
  const linkHost = join(root, "resources", "polyth-link", `polyth-link-host${exe}`);
  check(existsSync(linkHost), "carries polyth-link-host");
  if (process.platform !== "win32") accessSync(linkHost, constants.X_OK);
  if (process.platform === "linux") {
    const supervisor = join(root, "resources", "runtime-supervisor", build.target, "polyth-supervisor");
    check(existsSync(supervisor), "carries the runtime supervisor");
    accessSync(supervisor, constants.X_OK);
  }
  const polyth = join(root, "bin", "polyth.mjs");
  const cli = spawnSync(process.execPath, [polyth, "--version"], { encoding: "utf8" });
  check(cli.status === 0 && cli.stdout.trim().length > 0, `the polyth command runs (${cli.stdout.trim()})`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A fresh install: nothing from the caller's own Polyth (public origin,
  // proxies, debug access, resources) may leak in.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("POLYTH_")));
  Object.assign(env, { HOST: "127.0.0.1", PORT: String(port), POLYTH_DATA_DIR: join(work, "data") });

  /** Starts `polyth server start` and waits for /api/health. */
  const start = async (label: string) => {
    const server = spawn(process.execPath, [polyth, "server", "start"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    running.add(server);
    let log = "";
    server.stdout!.on("data", (chunk: Buffer) => { log += chunk.toString(); });
    server.stderr!.on("data", (chunk: Buffer) => { log += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => server.once("exit", (code) => { running.delete(server); resolveExit(code); }));
    let health: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 120 && server.exitCode === null; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) { health = await response.json() as Record<string, unknown>; break; }
      } catch { /* not listening yet */ }
      await new Promise((wait) => setTimeout(wait, 500));
    }
    if (health?.ok !== true) process.stderr.write(log.slice(-6000));
    check(health?.ok === true, `${label}: answers /api/health`);
    const stop = async () => {
      server.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise<"timeout">((wait) => setTimeout(() => wait("timeout"), 30_000))]);
      if (code === "timeout") server.kill("SIGKILL");
      if (code !== 0) process.stderr.write(log.slice(-6000));
      check(code === 0, `${label}: stops on SIGTERM (exit ${String(code)})`);
    };
    return { health, stop };
  };

  const fresh = await start("first run");
  const page = await fetch(`${base}/`);
  check(page.ok && (await page.text()).includes("<html"), "first run: serves the web app");
  await fresh.stop();

  const claim = spawnSync(process.execPath, [polyth, "server", "setup-claim"], { encoding: "utf8", env });
  const claimToken = claim.status === 0 ? (JSON.parse(claim.stdout) as { claimToken?: string }).claimToken : undefined;
  check(typeof claimToken === "string", "polyth server setup-claim issues a first-run claim");

  const setup = await start("setup");
  const owner = browser(base);
  await owner("/api/auth/status");
  check((await owner("/api/auth/setup/claim", { claimToken })).status === 200, "setup: the claim binds to this browser");
  const recovery = await owner("/api/auth/setup/recovery", { claimToken });
  const completed = await owner("/api/auth/setup/complete", {
    claimToken, name: "Owner", organizationName: "Smoke", login: "owner", password: "smoke test passphrase",
    recoverySetId: recovery.value.setId, recoveryAcknowledged: true,
  });
  check(completed.status === 200, "setup: the owner account is created");
  await setup.stop();

  const full = await start("full server");
  const capabilities = Array.isArray(full.health?.capabilities) ? full.health.capabilities as string[] : [];
  check(
    ["polyth.sessions", "polyth.terminal", "polyth.git"].every((id) => capabilities.includes(id)),
    `full server: bundled packages are loaded (${capabilities.length} capabilities)`,
  );
  const signedIn = browser(base);
  await signedIn("/api/auth/status");
  check((await signedIn("/api/auth/login", { login: "owner", password: "smoke test passphrase" })).status === 200, "full server: the owner signs in");
  check((await signedIn("/api/projects")).status === 200, "full server: an authenticated API request succeeds");
  await full.stop();
  console.log(`smoke passed: ${archive}`);
} finally {
  for (const child of running) child.kill("SIGKILL");
  await rm(work, { recursive: true, force: true });
}
