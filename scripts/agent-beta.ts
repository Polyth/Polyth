import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCanonicalSecurity } from "../packages/server/src/canonicalSecurity.ts";

const exec = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Options = {
  port?: number;
  project: string;
  build: boolean;
};

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const args = process.argv.slice(2);
const options: Options = { project: process.cwd(), build: true };
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--port") {
    const value = Number(args[++i]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) invalid("--port requires a valid TCP port");
    options.port = value;
  } else if (arg === "--project") {
    const value = args[++i];
    if (!value) invalid("--project requires a path");
    options.project = resolve(value);
  } else if (arg === "--no-build") {
    options.build = false;
  } else {
    invalid(`unknown option: ${arg}`);
  }
}

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : port ? resolvePort(port) : reject(new Error("no free port")));
  });
});

const run = (
  command: string,
  commandArgs: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: sourceRoot },
): Promise<void> => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, commandArgs, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", rejectRun);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${command} exited with ${signal ?? code ?? "unknown"}`));
  });
});

const registerProject = async (origin: string, projectPath: string): Promise<void> => {
  const response = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath, name: basename(projectPath) || "Agent Beta" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`agent beta project registration failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
  }
};

const waitForHealth = async (url: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error("agent beta server exited before becoming healthy");
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Keep polling until the bounded deadline.
    }
    if (Date.now() >= deadline) throw new Error("agent beta server did not become healthy");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
};

const initialize = async (dataDir: string, origin: string): Promise<void> => {
  const security = createCanonicalSecurity({ dataDir, origin, localOnly: true });
  try {
    const claim = security.identity.setup.issueClaim();
    const binding = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    security.identity.setup.bindClaim(claim.token, binding);
    const recovery = security.identity.setup.prepareRecovery(claim.token, binding);
    const owner = await security.identity.setup.complete({
      claimToken: claim.token,
      browserBinding: binding,
      name: "Agent Beta",
      organizationName: "Agent Beta",
      login: `agent-beta-${randomUUID().slice(0, 8)}`,
      password: `AgentBeta-${randomUUID()}-${randomUUID()}`,
      recoverySetId: recovery.setId,
      recoveryAcknowledged: true,
    });
    void owner;
  } finally {
    security.close();
  }
};

let tempRoot = "";
let server: ChildProcess | undefined;
let shuttingDown = false;

const cleanup = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server && server.exitCode === null && !server.signalCode) {
    const exited = new Promise<void>((resolveExit) => server!.once("exit", () => resolveExit()));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5_000)),
    ]);
    if (server.exitCode === null && !server.signalCode) server.kill("SIGKILL");
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
};

const main = async (): Promise<void> => {
  const requestedProject = resolve(options.project);
  const gitRoot = await exec("git", ["-C", requestedProject, "rev-parse", "--show-toplevel"], {
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  }).then(({ stdout }) => stdout.trim()).catch(() => "");
  const projectPath = gitRoot ? resolve(gitRoot) : requestedProject;

  if (options.build) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:web"], { cwd: sourceRoot });
  }

  const port = options.port ?? await freePort();
  const origin = `http://127.0.0.1:${port}`;
  tempRoot = await mkdtemp(join(tmpdir(), "polyth-agent-beta-"));
  const dataDir = join(tempRoot, "data");
  await initialize(dataDir, origin);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    POLYTH_AGENT_BETA: "1",
    POLYTH_DATA_DIR: dataDir,
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  };
  delete env.POLYTH_PUBLIC_ORIGIN;
  delete env.POLYTH_DEBUG_AGENT_ACCESS;
  delete env.POLYTH_UI_PASSWORD;
  delete env.POLYTH_UI_PASSWORD_LOCALHOST;

  server = spawn(
    process.execPath,
    ["--experimental-strip-types", "packages/server/src/index.ts"],
    {
      cwd: sourceRoot,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  server.once("error", (error) => {
    console.error("[agent-beta] server error", error);
  });

  await waitForHealth(origin, server);
  await registerProject(origin, projectPath);
  console.log(`POLYTH_AGENT_BETA_READY ${JSON.stringify({
    url: origin,
    project: projectPath,
    dataDir,
    pid: server.pid ?? null,
  })}`);

  await new Promise<void>((resolveExit, rejectExit) => {
    server!.once("exit", (code, signal) => {
      if (shuttingDown || code === 0 || signal === "SIGTERM") resolveExit();
      else rejectExit(new Error(`agent beta server exited with ${signal ?? code ?? "unknown"}`));
    });
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(0));
  });
}

try {
  await main();
} finally {
  await cleanup();
}
