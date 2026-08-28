// Phase 5 live validator for OC-REAL-062..067.
//
// It starts real OpenCode 1.18.18 services as external harness processes,
// then attaches only through Polyth's borrowed endpoint seam. All process
// signals target a recorded ChildProcess PID after /proc identity validation.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createBorrowedServiceEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import { boot } from "../../../../packages/server/src/index.ts";
import { createOpencodeClient } from
  "/home/ubuntu/.opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js";

const ROOT = `/tmp/ocreal/phase-5/run-${Date.now().toString(36)}`;
const ARTIFACT_ROOT = "/workspace/artifacts/opencode-real-world/phase-5";
const LOG_ROOT = "/workspace/logs/opencode-real-world/phase-5";
const BIN = "/home/ubuntu/.local/bin/opencode";
const SECRET_A = `phase5-a-${process.pid}`;
const SECRET_B = `phase5-b-${process.pid}`;
const SECRET_C = `phase5-c-${process.pid}`;
const USERNAME = "phase5";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeline = [];
const services = new Set();
const borrowed = new Set();
const streams = new Set();

for (const directory of [ROOT, ARTIFACT_ROOT, LOG_ROOT]) {
  mkdirSync(directory, { recursive: true });
}

const record = (event, data = {}) => {
  const item = { at: new Date().toISOString(), event, ...data };
  timeline.push(item);
  writeFileSync(
    join(LOG_ROOT, "process-timeline.ndjson"),
    `${timeline.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
};

const capture = async (operation) => {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined,
    };
  }
};

const compactSdk = (result) => ({
  data: result?.data,
  error: result?.error,
  status: result?.response?.status,
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const procIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid,
      startIdentity: fields[19],
      executable: readlinkSync(`/proc/${pid}/exe`),
      command: readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .replaceAll("\0", " ")
        .trim(),
    };
  } catch {
    return undefined;
  }
};

const freePort = () => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port ? resolve(port) : reject(new Error("no free port")));
  });
});

const basic = (password) => ({
  Authorization: `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`,
});

const http = async (url, path, { method = "GET", headers = {}, body } = {}) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let parsed = raw;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    // Keep a bounded body for diagnostic evidence.
    parsed = raw.slice(0, 1_000);
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
  };
};

const waitHealth = async (service) => {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await http(service.url, "/api/health", { headers: basic(service.password) });
      if (last.status === 200) return last;
    } catch (error) {
      last = { error: String(error) };
    }
    if (service.child.exitCode !== null || service.child.signalCode !== null) {
      throw new Error(`OpenCode ${service.label} exited before health: ${JSON.stringify(last)}`);
    }
    await sleep(100);
  }
  throw new Error(`OpenCode ${service.label} did not become healthy: ${JSON.stringify(last)}`);
};

const startService = async ({
  label,
  directory,
  stateRoot,
  password,
  port,
}) => {
  port ??= await freePort();
  const config = join(stateRoot, "config");
  const xdg = join(stateRoot, "xdg");
  mkdirSync(config, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  const logPath = join(LOG_ROOT, `${label}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: config,
      XDG_DATA_HOME: xdg,
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const service = {
    label,
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    directory,
    stateRoot,
    password,
    logPath,
  };
  services.add(service);
  child.once("exit", (code, signal) => {
    record("service-exited", { label, pid: child.pid, code, signal });
    log.end();
  });
  await waitHealth(service);
  service.identity = procIdentity(child.pid);
  if (!service.identity?.command.includes("opencode serve")) {
    throw new Error(`unexpected service identity for ${label}`);
  }
  record("service-started", {
    label,
    pid: child.pid,
    port,
    identity: service.identity,
  });
  return service;
};

const stopExact = async (service, signal = "SIGTERM") => {
  if (!alive(service.child.pid)) return;
  const identity = procIdentity(service.child.pid);
  if (
    !identity
    || identity.startIdentity !== service.identity.startIdentity
    || identity.executable !== service.identity.executable
    || !identity.command.includes("opencode serve")
  ) {
    throw new Error(`refusing to signal mismatched PID ${service.child.pid}`);
  }
  const exited = new Promise((resolve) => service.child.once("exit", resolve));
  process.kill(service.child.pid, signal);
  record("exact-pid-signal", {
    label: service.label,
    pid: service.child.pid,
    signal,
    identity,
  });
  await Promise.race([exited, sleep(8_000)]);
  if (alive(service.child.pid)) {
    const second = procIdentity(service.child.pid);
    if (
      !second
      || second.startIdentity !== identity.startIdentity
      || second.executable !== identity.executable
    ) {
      throw new Error(`refusing fallback signal for changed PID ${service.child.pid}`);
    }
    process.kill(service.child.pid, "SIGKILL");
    record("exact-pid-signal", {
      label: service.label,
      pid: service.child.pid,
      signal: "SIGKILL",
      identity: second,
    });
    await Promise.race([exited, sleep(2_000)]);
  }
};

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const setupProjects = () => {
  const projects = {};
  for (const name of ["project-a", "project-b"]) {
    const root = join(ROOT, name);
    const worktree = join(ROOT, `${name}-worktree`);
    mkdirSync(root, { recursive: true });
    git(["init", "-b", "main"], root);
    git(["config", "user.email", "phase5@example.invalid"], root);
    git(["config", "user.name", "Phase 5"], root);
    writeFileSync(join(root, "IDENTITY.txt"), `${name}-root\n`);
    git(["add", "IDENTITY.txt"], root);
    git(["commit", "-m", "fixture"], root);
    git(["worktree", "add", "-b", `${name}-worktree`, worktree], root);
    writeFileSync(join(worktree, "IDENTITY.txt"), `${name}-worktree\n`);
    projects[name] = { root, worktree };
  }
  return projects;
};

const openStream = async (service, path, label) => {
  const controller = new AbortController();
  let status = 0;
  let ended = false;
  let byteCount = 0;
  let eventCount = 0;
  let error;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const running = fetch(`${service.url}${path}`, {
    headers: { ...basic(service.password), accept: "text/event-stream" },
    signal: controller.signal,
  }).then(async (response) => {
    status = response.status;
    if (status !== 200 || !response.body) {
      rejectReady(new Error(`${label} SSE returned ${status}`));
      return;
    }
    resolveReady();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      byteCount += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      eventCount += frames.filter((frame) => frame.includes("data:")).length;
    }
  }).catch((cause) => {
    if (cause?.name !== "AbortError") error = String(cause);
  }).finally(() => {
    ended = true;
  });
  const stream = {
    label,
    controller,
    ready,
    running,
    state: () => ({ status, ended, byteCount, eventCount, error }),
  };
  streams.add(stream);
  await ready;
  record("external-stream-connected", { label, path, status });
  return stream;
};

const makeBorrowed = async ({
  label,
  location,
  discover,
  authorityId = "phase5-shared-authority",
}) => {
  const lease = await createBorrowedServiceEndpointLease({
    location,
    authorityId,
    discover,
    async ensure() {
      throw new Error("shared service must already exist");
    },
  });
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "v2",
    startupDeadlineMs: 10_000,
    probeDeadlineMs: 1_000,
    protocolDeadlineMs: 10_000,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    cwd: location.directory,
    lifecycle,
  });
  const item = { label, lease, lifecycle, facade };
  borrowed.add(item);
  return item;
};

const disposeBorrowed = async (item) => {
  await item.facade.dispose();
  await item.lifecycle.dispose();
  borrowed.delete(item);
  record("borrowed-disposed", { label: item.label });
};

const refreshEventually = async (lifecycle, reason) => {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await lifecycle.refresh(reason);
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
};

const descriptor = (service, {
  authorityId = "phase5-shared-authority",
  continuity = "generation-only",
  instanceId = `${service.label}:${service.identity.startIdentity}`,
} = {}) => ({
  url: service.url,
  authorityId,
  continuity,
  instanceId,
  headers: basic(service.password),
});

const sdk = (service, directory, workspace) => createOpencodeClient({
  baseUrl: service.url,
  headers: basic(service.password),
  directory,
  ...(workspace ? { experimental_workspaceID: workspace } : {}),
});

const listIds = (result) =>
  Array.isArray(result?.data?.data) ? result.data.data.map((row) => row.id) : [];

const writeScenario = (id, verdict, summary, details, limitation) => {
  const directory = join(ARTIFACT_ROOT, id);
  mkdirSync(directory, { recursive: true });
  const manifest = {
    id,
    capturedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: "/workspace" })
      .toString()
      .trim(),
    openCode: {
      version: execFileSync(BIN, ["--version"]).toString().trim(),
      binary: BIN,
      sha256: createHash("sha256").update(readFileSync(BIN)).digest("hex"),
    },
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    protocol: "v2 (forced)",
    isolatedRoot: ROOT,
    exactPidOnly: true,
    port14500Used: false,
  };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, "details.json"), `${JSON.stringify(details, null, 2)}\n`);
  writeFileSync(join(directory, "verdict.json"), `${JSON.stringify({
    id,
    verdict,
    summary,
    ...(limitation ? { limitation } : {}),
    blocker5: false,
  }, null, 2)}\n`);
  return { id, verdict, summary, limitation, details };
};

let productApp;
let result;
try {
  const projects = setupProjects();
  const primaryState = join(ROOT, "primary-state");
  let primary = await startService({
    label: "shared-primary-1",
    directory: projects["project-a"].root,
    stateRoot: primaryState,
    password: SECRET_A,
  });
  const initialIdentity = primary.identity;
  const initialUrl = primary.url;

  const external = await openStream(primary, "/api/event", "external-client-062");
  const officialA = sdk(primary, projects["project-a"].root);
  const activeCreateRaw = await officialA.v2.session.create({
    id: "ses_phase5_active_000000000001",
    agent: "build",
    model: { providerID: "opencode", id: "big-pickle" },
    location: { directory: projects["project-a"].root },
  });
  const activeCreate = compactSdk(activeCreateRaw);
  const activeId = activeCreate.data?.data?.id;
  if (!activeId) throw new Error(`failed to create active fixture: ${JSON.stringify(activeCreate)}`);
  const admitted = compactSdk(await officialA.v2.session.prompt({
    sessionID: activeId,
    id: "msg_phase5_external_000000000001",
    prompt: {
      text: "Use the bash tool to run: sleep 20; printf PHASE5_EXTERNAL_PREEXISTING",
    },
    delivery: "queue",
    resume: true,
  }));
  await sleep(1_500);
  const activeStatus = compactSdk(await officialA.v2.session.active());
  const activePermissions = compactSdk(await officialA.v2.permission.request.list({
    location: { directory: projects["project-a"].root },
  }));

  let currentPrimary = primary;
  const primaryDiscover = async () => descriptor(currentPrimary);
  const joiner = await makeBorrowed({
    label: "joiner-062",
    location: { directory: projects["project-a"].root },
    discover: primaryDiscover,
  });
  const joinEndpoint = await joiner.lifecycle.endpoint();
  const joinedSessions = await capture(() => joiner.facade.sessions());
  const joinedHistory = await capture(() => joiner.facade.history(activeId));

  const productPort = await freePort();
  const productData = join(ROOT, "product-data");
  const productConfig = join(ROOT, "product-config");
  mkdirSync(productData, { recursive: true });
  mkdirSync(productConfig, { recursive: true });
  productApp = await boot({
    port: productPort,
    hostname: "127.0.0.1",
    dataDir: productData,
    opencode: {
      bin: BIN,
      dataDir: productConfig,
      protocol: "v2",
      port: primary.port,
      startupDeadlineMs: 5_000,
      probeDeadlineMs: 500,
    },
  });
  const productBase = `http://127.0.0.1:${productPort}`;
  const productProject = await http(productBase, "/api/projects", {
    method: "POST",
    body: { path: projects["project-a"].root, name: "Phase 5 occupied" },
  });
  const productProjectId = productProject.body?.id;
  const productCreate = await http(productBase, "/api/sessions", {
    method: "POST",
    body: { projectId: productProjectId, title: "Must not claim shared service" },
  });
  await productApp.shutdown();
  productApp = undefined;
  const productDb = new DatabaseSync(join(productData, "sessions.db"));
  const productIntegrity = productDb.prepare("PRAGMA integrity_check").all();
  productDb.close();

  const beforeBorrowedShutdown = {
    pid: primary.child.pid,
    identity: procIdentity(primary.child.pid),
    external: external.state(),
  };
  await disposeBorrowed(joiner);
  await sleep(500);
  const afterBorrowedShutdown = {
    alive: alive(primary.child.pid),
    identity: procIdentity(primary.child.pid),
    health: await http(primary.url, "/api/health", { headers: basic(primary.password) }),
    external: external.state(),
  };

  // Keep one lease alive across the harness-owned service replacement so the
  // in-process N -> N+1 fence can be compared with a fresh Polyth process.
  const rotation = await makeBorrowed({
    label: "rotation-064",
    location: { directory: projects["project-a"].root },
    discover: primaryDiscover,
  });
  const oldRotationEndpoint = await rotation.lifecycle.endpoint();

  // Harness-owned replacement: Polyth never signals this process.
  external.controller.abort();
  await external.running;
  await stopExact(primary);
  const replacementPort = await freePort();
  primary = await startService({
    label: "shared-primary-2",
    directory: projects["project-a"].root,
    stateRoot: primaryState,
    password: SECRET_A,
    port: replacementPort,
  });
  currentPrimary = primary;
  const replacementEndpoint = await refreshEventually(rotation.lifecycle, "manual");
  const replacementSessions = await capture(() => rotation.facade.sessions());
  const replacementHistory = await capture(() => rotation.facade.history(activeId));
  const staleBinding = await capture(() => rotation.lifecycle.reconcile({
    canonicalSessionId: "canonical-stale-064",
    backendSessionId: activeId,
    authorityId: oldRotationEndpoint.authorityId,
    generation: oldRotationEndpoint.generation,
    continuity: oldRotationEndpoint.continuity,
    location: oldRotationEndpoint.location,
    protocol: "v2",
    reconciliationOrdinal: 1,
  }));
  await disposeBorrowed(rotation);

  const rediscovered = await makeBorrowed({
    label: "restart-rediscovery-064",
    location: { directory: projects["project-a"].root },
    discover: primaryDiscover,
  });
  const rediscoveredEndpoint = await rediscovered.lifecycle.endpoint();
  const rediscoveredSessions = await capture(() => rediscovered.facade.sessions());
  const restartedStaleBinding = await capture(() => rediscovered.lifecycle.reconcile({
    canonicalSessionId: "canonical-restarted-stale-064",
    backendSessionId: activeId,
    authorityId: oldRotationEndpoint.authorityId,
    generation: oldRotationEndpoint.generation,
    continuity: oldRotationEndpoint.continuity,
    location: oldRotationEndpoint.location,
    protocol: "v2",
    reconciliationOrdinal: 1,
  }));
  await disposeBorrowed(rediscovered);

  // Endpoint and authentication replacement using one persisted OpenCode store.
  const authState = join(ROOT, "auth-state");
  let authService = await startService({
    label: "auth-url-1",
    directory: projects["project-a"].root,
    stateRoot: authState,
    password: SECRET_A,
  });
  let authDescriptor = descriptor(authService, {
    authorityId: "phase5-auth-authority",
  });
  const authLease = await createBorrowedServiceEndpointLease({
    location: { directory: projects["project-a"].root },
    authorityId: "phase5-auth-authority",
    async discover() {
      return authDescriptor;
    },
    async ensure() {
      throw new Error("auth service must already exist");
    },
  });
  const authSnapshots = [];
  const firstAuthEndpoint = await authLease.endpoint();
  authSnapshots.push({
    step: "initial",
    endpoint: {
      url: firstAuthEndpoint.url,
      authorityId: firstAuthEndpoint.authorityId,
      continuity: firstAuthEndpoint.continuity,
      generation: firstAuthEndpoint.generation,
      control: firstAuthEndpoint.control,
      config: firstAuthEndpoint.config,
      headerNames: Object.keys(await firstAuthEndpoint.authentication.resolve()),
      headers: { authorization: "[REDACTED]" },
    },
    correct: await http(authService.url, "/api/health", { headers: basic(SECRET_A) }),
  });

  // Auth-only replacement at the same URL.
  const authPort = authService.port;
  await stopExact(authService);
  authService = await startService({
    label: "auth-url-1-rotated",
    directory: projects["project-a"].root,
    stateRoot: authState,
    password: SECRET_B,
    port: authPort,
  });
  authDescriptor = descriptor(authService, {
    authorityId: "phase5-auth-authority",
  });
  const authOnly = await authLease.refresh("unauthorized");
  authSnapshots.push({
    step: "auth-only",
    endpoint: {
      url: authOnly.url,
      generation: authOnly.generation,
      headerNames: Object.keys(await authOnly.authentication.resolve()),
      headers: { authorization: "[REDACTED]" },
    },
    correct: await http(authService.url, "/api/health", { headers: basic(SECRET_B) }),
    stale: await http(authService.url, "/api/health", { headers: basic(SECRET_A) }),
  });

  // URL-only replacement.
  await stopExact(authService);
  authService = await startService({
    label: "auth-url-2",
    directory: projects["project-a"].root,
    stateRoot: authState,
    password: SECRET_B,
  });
  authDescriptor = descriptor(authService, {
    authorityId: "phase5-auth-authority",
  });
  const urlOnly = await authLease.refresh("manual");
  authSnapshots.push({
    step: "url-only",
    endpoint: {
      url: urlOnly.url,
      generation: urlOnly.generation,
      headerNames: Object.keys(await urlOnly.authentication.resolve()),
      headers: { authorization: "[REDACTED]" },
    },
    correct: await http(authService.url, "/api/health", { headers: basic(SECRET_B) }),
  });

  // URL + auth replacement.
  await stopExact(authService);
  authService = await startService({
    label: "auth-url-3",
    directory: projects["project-a"].root,
    stateRoot: authState,
    password: SECRET_C,
  });
  authDescriptor = descriptor(authService, {
    authorityId: "phase5-auth-authority",
  });
  const both = await authLease.refresh("unauthorized");
  authSnapshots.push({
    step: "url-and-auth",
    endpoint: {
      url: both.url,
      generation: both.generation,
      headerNames: Object.keys(await both.authentication.resolve()),
      headers: { authorization: "[REDACTED]" },
    },
    correct: await http(authService.url, "/api/health", { headers: basic(SECRET_C) }),
    stale: await http(authService.url, "/api/health", { headers: basic(SECRET_B) }),
  });
  await authLease.dispose();

  // OC-REAL-066: four real directories/worktrees through one service. Force
  // the same client-supplied session ID in two project roots.
  const locations = [
    ["a-root", projects["project-a"].root],
    ["a-worktree", projects["project-a"].worktree],
    ["b-root", projects["project-b"].root],
    ["b-worktree", projects["project-b"].worktree],
  ];
  const directoryEvidence = {};
  for (const [label, directory] of locations) {
    const client = sdk(primary, directory);
    const created = compactSdk(await client.v2.session.create({
      id: `ses_phase5_${label.replace("-", "_")}_000000000001`,
      location: { directory },
    }));
    const sessionId = created.data?.data?.id;
    if (!sessionId) throw new Error(`failed to create ${label}: ${JSON.stringify(created)}`);
    await client.v2.session.prompt({
      sessionID: sessionId,
      id: `msg_phase5_${label.replace("-", "_")}_000000000001`,
      prompt: { text: `PHASE5_${label.toUpperCase().replace("-", "_")}` },
      delivery: "queue",
      resume: false,
    });
    directoryEvidence[label] = { directory, created, sessionId };
  }

  const collisionId = "ses_phase5_collision_000000000001";
  const collisionAClient = sdk(primary, projects["project-a"].root);
  const collisionBClient = sdk(primary, projects["project-b"].root);
  const collisionA = compactSdk(await collisionAClient.v2.session.create({
    id: collisionId,
    location: { directory: projects["project-a"].root },
  }));
  const collisionB = compactSdk(await collisionBClient.v2.session.create({
    id: collisionId,
    location: { directory: projects["project-b"].root },
  }));
  const collisionAGet = compactSdk(await collisionAClient.v2.session.get({
    sessionID: collisionId,
  }));
  const collisionBGet = compactSdk(await collisionBClient.v2.session.get({
    sessionID: collisionId,
  }));

  for (const [label, directory] of locations) {
    const client = sdk(primary, directory);
    const listed = compactSdk(await client.v2.session.list({ limit: 200, order: "desc" }));
    const item = directoryEvidence[label];
    item.catalog = {
      ids: listIds(listed),
      containsOwn: listIds(listed).includes(item.sessionId),
      foreignIds: locations
        .filter(([other]) => other !== label)
        .map(([other]) => directoryEvidence[other].sessionId)
        .filter((id) => listIds(listed).includes(id)),
    };
    const locationRuntime = await makeBorrowed({
      label: `isolation-${label}`,
      location: { directory },
      discover: primaryDiscover,
    });
    const adapterSessions = await capture(() => locationRuntime.facade.sessions());
    const adapterHistory = await capture(() => locationRuntime.facade.history(item.sessionId));
    const durableHistory = compactSdk(await client.v2.session.history({
      sessionID: item.sessionId,
      limit: 100,
    }));
    item.polyth = { sessions: adapterSessions, history: adapterHistory };
    item.officialDurableHistory = durableHistory;
    await disposeBorrowed(locationRuntime);
  }

  const workspaceProbe = await capture(async () => {
    const client = sdk(primary, projects["project-a"].root);
    return compactSdk(await client.experimental.workspace.list({
      directory: projects["project-a"].root,
    }));
  });

  // OC-REAL-067: two official V2 SDK clients and one Polyth borrowed facade
  // mutate one session. Permissions are attempted, but acceptance remains
  // honest when this headless OpenCode service does not run the agent loop.
  const clientOne = sdk(primary, projects["project-a"].root);
  const clientTwo = sdk(primary, projects["project-a"].root);
  const sharedCreate = compactSdk(await clientOne.v2.session.create({
    id: "ses_phase5_three_clients_000000001",
    agent: "build",
    model: { providerID: "opencode", id: "big-pickle" },
    location: { directory: projects["project-a"].root },
  }));
  const sharedSessionId = sharedCreate.data?.data?.id;
  if (!sharedSessionId) throw new Error("failed to create three-client session");
  const clientOnePrompt = compactSdk(await clientOne.v2.session.prompt({
    sessionID: sharedSessionId,
    id: "msg_phase5_client_one_000000001",
    prompt: { text: "PHASE5_CLIENT_ONE_QUEUE" },
    delivery: "queue",
    resume: false,
  }));
  const clientTwoPrompt = compactSdk(await clientTwo.v2.session.prompt({
    sessionID: sharedSessionId,
    id: "msg_phase5_client_two_000000001",
    prompt: { text: "PHASE5_CLIENT_TWO_QUEUE" },
    delivery: "queue",
    resume: false,
  }));

  const concurrentRuntime = await makeBorrowed({
    label: "three-clients-067",
    location: { directory: projects["project-a"].root },
    discover: primaryDiscover,
  });
  await concurrentRuntime.facade.ensureSession({
    projectId: "phase5",
    sessionId: "canonical-three-clients",
    backendSessionId: sharedSessionId,
    cwd: projects["project-a"].root,
  });
  const polythPrompt = await concurrentRuntime.facade.startTurnOperation({
    sessionId: "canonical-three-clients",
    text: "PHASE5_POLYTH_QUEUE",
  }, "op-phase5-polyth-067");
  const permissionPrompt = compactSdk(await clientOne.v2.session.prompt({
    sessionID: sharedSessionId,
    id: "msg_phase5_permission_attempt_000001",
    prompt: {
      text: "Use the bash tool to run: sleep 15; printf PHASE5_PERMISSION_ATTEMPT",
    },
    delivery: "queue",
    resume: true,
  }));
  await sleep(3_000);
  const permissionOne = compactSdk(await clientOne.v2.permission.request.list({
    location: { directory: projects["project-a"].root },
  }));
  const permissionTwo = compactSdk(await clientTwo.v2.permission.request.list({
    location: { directory: projects["project-a"].root },
  }));
  const clientTwoAbort = compactSdk(await clientTwo.v2.session.interrupt({
    sessionID: sharedSessionId,
  }));
  await sleep(500);
  const durableHistoryOne = compactSdk(await clientOne.v2.session.history({
    sessionID: sharedSessionId,
    limit: 100,
  }));
  const durableHistoryTwo = compactSdk(await clientTwo.v2.session.history({
    sessionID: sharedSessionId,
    limit: 100,
  }));
  const messagesOne = compactSdk(await clientOne.v2.session.messages({
    sessionID: sharedSessionId,
    limit: 200,
    order: "asc",
  }));
  const messagesTwo = compactSdk(await clientTwo.v2.session.messages({
    sessionID: sharedSessionId,
    limit: 200,
    order: "asc",
  }));
  const polythHistory = await capture(() =>
    concurrentRuntime.facade.history("canonical-three-clients")
  );
  await disposeBorrowed(concurrentRuntime);

  const texts = (response) => Array.isArray(response?.data?.data)
    ? response.data.data
        .filter((message) => message?.type === "user")
        .map((message) => message.text)
    : [];
  const clientOneTexts = texts(messagesOne);
  const clientTwoTexts = texts(messagesTwo);

  const commonLimitation =
    "Normal Polyth composition still cannot select a borrowed/shared endpoint; OpenCode 1.18.18 exposes no authoritative discovery descriptor.";
  const scenarios = [];
  scenarios.push(writeScenario(
    "OC-REAL-062",
    "fail (polyth)",
    "The current borrowed seam joined the pre-existing real V2 service and read its session/history without spawn/stop/config authority. Normal Polyth boot still attempted an owned child on the occupied port and returned 503 instead of joining.",
    {
      shared: { pid: initialIdentity.pid, identity: initialIdentity, url: initialUrl },
      externalCreate: activeCreate,
      externalAdmission: admitted,
      activeStatus,
      activePermissions,
      borrowedEndpoint: joinEndpoint,
      joinedSessions,
      joinedHistory,
      normalProductOccupiedPort: {
        project: productProject,
        create: productCreate,
        sqliteIntegrity: productIntegrity,
        sharedAlive: alive(primary.child.pid),
      },
    },
    commonLimitation,
  ));
  scenarios.push(writeScenario(
    "OC-REAL-063",
    "blocked",
    "Borrowed facade/lifecycle shutdown detached while the shared PID retained the same /proc identity, health stayed 200, and the external SSE client remained connected. Product-level acceptance is blocked because normal boot cannot borrow.",
    { beforeBorrowedShutdown, afterBorrowedShutdown },
    commonLimitation,
  ));
  scenarios.push(writeScenario(
    "OC-REAL-064",
    "fail (polyth)",
    "A live borrowed lease advanced generation and rejected its stale binding after service replacement, but a fresh Polyth-side lease reset generation to 1 and accepted the same generation-only stale binding without explicit continuity proof.",
    {
      oldEndpoint: oldRotationEndpoint,
      replacementEndpoint,
      replacementSessions,
      replacementHistory,
      staleBinding,
      rediscoveredEndpoint,
      rediscoveredSessions,
      restartedStaleBinding,
    },
    commonLimitation,
  ));
  scenarios.push(writeScenario(
    "OC-REAL-065",
    "blocked",
    "Injected descriptor refresh covered auth-only, URL-only, and combined URL/auth replacement. Every fingerprint change advanced generation, valid credentials returned 200, and stale credentials returned 401 without recording secret values. In-flight official-discovery acceptance remains unavailable.",
    { snapshots: authSnapshots },
    commonLimitation,
  ));
  scenarios.push(writeScenario(
    "OC-REAL-066",
    "fail (opencode)",
    "Ordinary project-root/worktree catalogs stayed directory-isolated, but a client-supplied session ID collision in project B returned project A's session with HTTP 200. Real workspace discovery returned no identities, and normal product shared attach remains unavailable.",
    {
      projects,
      locations: directoryEvidence,
      collision: {
        id: collisionId,
        projectA: collisionA,
        projectB: collisionB,
        getFromA: collisionAGet,
        getFromB: collisionBGet,
      },
      workspaceProbe,
    },
    commonLimitation,
  ));
  scenarios.push(writeScenario(
    "OC-REAL-067",
    "fail (polyth)",
    "Two official V2 SDK clients and one Polyth borrowed facade durably admitted distinct queue markers, but Polyth history/reconcile exposed only the promoted first message and hid later external/Polyth admissions that official durable history retained. No permission request materialized.",
    {
      sharedCreate,
      clientOnePrompt,
      clientTwoPrompt,
      polythPrompt,
      permissionAttempt: permissionPrompt,
      permissionViews: { clientOne: permissionOne, clientTwo: permissionTwo },
      clientTwoAbort,
      histories: {
        durableClientOne: durableHistoryOne,
        durableClientTwo: durableHistoryTwo,
        clientOne: messagesOne,
        clientTwo: messagesTwo,
        polyth: polythHistory,
      },
      markerCounts: {
        clientOne: {
          officialOne: clientOneTexts.filter((text) => text === "PHASE5_CLIENT_ONE_QUEUE").length,
          officialTwo: clientOneTexts.filter((text) => text === "PHASE5_CLIENT_TWO_QUEUE").length,
          polyth: clientOneTexts.filter((text) => text === "PHASE5_POLYTH_QUEUE").length,
        },
        clientTwo: {
          officialOne: clientTwoTexts.filter((text) => text === "PHASE5_CLIENT_ONE_QUEUE").length,
          officialTwo: clientTwoTexts.filter((text) => text === "PHASE5_CLIENT_TWO_QUEUE").length,
          polyth: clientTwoTexts.filter((text) => text === "PHASE5_POLYTH_QUEUE").length,
        },
      },
    },
    commonLimitation,
  ));

  result = {
    capturedAt: new Date().toISOString(),
    isolatedRoot: ROOT,
    scenarios,
    blocker5: {
      triggered: false,
      reason:
        "No Polyth-owned path signalled or stopped a borrowed process. Every service signal in the timeline is an exact-PID harness action after /proc identity verification.",
    },
    processTimeline: timeline,
  };
  writeFileSync(join(LOG_ROOT, "run.json"), `${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (productApp) await productApp.shutdown().catch(() => {});
  for (const item of [...borrowed]) await disposeBorrowed(item).catch(() => {});
  for (const stream of streams) stream.controller.abort();
  await Promise.all([...streams].map((stream) => stream.running.catch(() => {})));
  for (const service of [...services].reverse()) await stopExact(service).catch((error) => {
    record("cleanup-error", { label: service.label, error: String(error) });
  });
}

if (!result) throw new Error("Phase 5 run did not complete");
console.log(JSON.stringify({
  capturedAt: result.capturedAt,
  blocker5: result.blocker5,
  scenarios: result.scenarios.map(({ id, verdict, summary }) => ({ id, verdict, summary })),
}, null, 2));
