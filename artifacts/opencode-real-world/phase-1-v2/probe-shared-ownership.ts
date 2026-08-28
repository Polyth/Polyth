import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntime,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
  pidFileForDirectory,
} from "@polyth/backend-opencode";
import type { AgentRuntime } from "@polyth/contracts";

const sharedUrl = process.env.OPENCODE_URL ?? "http://127.0.0.1:45126";
const sharedPid = Number(process.env.OPENCODE_SHARED_PID ?? "0");
const sharedDirectory = process.env.PROBE_DIRECTORY
  ?? "/tmp/polyth-oc-phase1-v2/project";
const ownedDirectory = process.env.OWNED_DIRECTORY
  ?? "/tmp/polyth-oc-phase1-v2/project-owned-default";
const collisionDirectory = `${ownedDirectory}-collision`;
const output = process.env.PROBE_OUTPUT
  ?? "logs/opencode-real-world/phase-1-v2/shared-ownership.json";

await mkdir(ownedDirectory, { recursive: true });
await mkdir(collisionDirectory, { recursive: true });
await mkdir("/tmp/polyth-oc-phase1-v2/owned-config", { recursive: true });

const alive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const health = async (url: string) => {
  const response = await fetch(`${url}/global/health`);
  return {
    status: response.status,
    body: await response.json(),
  };
};

const capture = async (operation: () => unknown | Promise<unknown>) => {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined,
    };
  }
};

const borrowedLease = await createBorrowedExternalEndpointLease({
  url: sharedUrl,
  location: { directory: sharedDirectory },
  authorityId: "real-shared-opencode-1.18.18",
});
const borrowedLifecycle = await createOpenCodeRuntimeLifecycle({
  lease: borrowedLease,
  protocol: "auto",
});
const borrowedFacade = createOpenCodeRuntimeFacade({
  cwd: sharedDirectory,
  lifecycle: borrowedLifecycle,
}) as AgentRuntime;
const borrowedBefore = {
  endpoint: await borrowedLifecycle.endpoint(),
  protocol: await borrowedLifecycle.protocol(),
  facadeCapabilities: await borrowedFacade.capabilities(),
  sharedAlive: alive(sharedPid),
  health: await health(sharedUrl),
};
await borrowedFacade.dispose();
await borrowedLifecycle.dispose();
const borrowedAfter = {
  sharedAlive: alive(sharedPid),
  health: await health(sharedUrl),
};

const reconnectLease = await createBorrowedExternalEndpointLease({
  url: sharedUrl,
  location: { directory: sharedDirectory },
  authorityId: "real-shared-opencode-1.18.18",
});
const reconnectLifecycle = await createOpenCodeRuntimeLifecycle({
  lease: reconnectLease,
  protocol: "auto",
});
const reconnectFacade = createOpenCodeRuntimeFacade({
  cwd: sharedDirectory,
  lifecycle: reconnectLifecycle,
}) as AgentRuntime;
const reconnectEndpoint = await reconnectLifecycle.endpoint();
const reconnect = {
  endpoint: reconnectEndpoint,
  protocol: await reconnectLifecycle.protocol(),
  directSession: await (
    await fetch(`${sharedUrl}/api/session/ses_phase1v2_001`)
  ).json(),
  adapterSessions: await capture(() => reconnectFacade.sessions()),
  adapterHistory: await capture(() =>
    reconnectFacade.history("ses_phase1v2_001")
  ),
  adapterReconcile: await capture(() =>
    reconnectFacade.reconcile?.({
      canonicalSessionId: "canonical-phase1-v2",
      backendSessionId: "ses_phase1v2_001",
      authorityId: reconnectEndpoint.authorityId,
      generation: reconnectEndpoint.generation,
      continuity: reconnectEndpoint.continuity,
      location: reconnectEndpoint.location,
      protocol: "v2",
      reconciliationOrdinal: 1,
    })
  ),
};
await reconnectFacade.dispose();
await reconnectLifecycle.dispose();

let occupiedPortAttempt: unknown;
try {
  const collisionRuntime = await createOpenCodeRuntime({
    cwd: collisionDirectory,
    port: Number(new URL(sharedUrl).port),
    bin: "/home/ubuntu/.local/bin/opencode",
    dataDir: "/tmp/polyth-oc-phase1-v2/owned-config",
    protocol: "v2",
  });
  const endpoint = await (collisionRuntime as AgentRuntime & {
    endpoint(): Promise<{ url: string }>;
  }).endpoint();
  occupiedPortAttempt = { kind: "started", endpoint };
  await collisionRuntime.dispose();
} catch (error) {
  occupiedPortAttempt = {
    kind: "failed",
    ...(
      error instanceof Error
        ? {
          name: error.name,
          message: error.message,
          code: "code" in error ? String(error.code) : undefined,
        }
        : { message: String(error) }
    ),
  };
}

const owned = await createOpenCodeRuntime({
  cwd: ownedDirectory,
  bin: "/home/ubuntu/.local/bin/opencode",
  dataDir: "/tmp/polyth-oc-phase1-v2/owned-config",
  protocol: "v2",
});
const managed = owned as AgentRuntime & {
  endpoint(): Promise<{ url: string; control: unknown }>;
  protocol(): Promise<"legacy" | "v2">;
};
const ownedEndpoint = await managed.endpoint();
const pidRecordPath = pidFileForDirectory(ownedDirectory);
const pidRecord = JSON.parse(await readFile(pidRecordPath, "utf8")) as {
  child: { pid: number; startIdentity: string; executable: string; command: string };
};
const ownedDuring = {
  endpoint: ownedEndpoint,
  protocol: await managed.protocol(),
  facadeCapabilities: await managed.capabilities(),
  models: await managed.models(),
  ownedPid: pidRecord.child.pid,
  ownedPidIdentity: {
    startIdentity: pidRecord.child.startIdentity,
    executable: pidRecord.child.executable,
    command: pidRecord.child.command,
  },
  ownedAlive: alive(pidRecord.child.pid),
  sharedAlive: alive(sharedPid),
  sharedHealth: await health(sharedUrl),
};
await managed.dispose();
const ownedAfter = {
  ownedAlive: alive(pidRecord.child.pid),
  sharedAlive: alive(sharedPid),
  sharedHealth: await health(sharedUrl),
};

const result = {
  capturedAt: new Date().toISOString(),
  shared: {
    url: sharedUrl,
    pid: sharedPid,
    directory: sharedDirectory,
  },
  borrowedAttach: {
    before: borrowedBefore,
    afterDispose: borrowedAfter,
  },
  reconnectToSurvivingService: reconnect,
  normalOwnedRuntimeAtOccupiedSharedPort: {
    requestedPort: Number(new URL(sharedUrl).port),
    result: occupiedPortAttempt,
    sharedAliveAfterAttempt: alive(sharedPid),
  },
  normalOwnedRuntimeWithDefaultPort: {
    during: ownedDuring,
    afterDispose: ownedAfter,
  },
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
