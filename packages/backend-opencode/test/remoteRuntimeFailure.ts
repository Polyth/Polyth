/**
 * Test-only owned-SSH fixture. Reuses `createFakeRemoteHost` + remote prepare
 * so matrix cells inject the same breaks as `fakeRemoteRuntime.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEndpoint } from "@polyth/contracts";
import { createOwnedSshEndpointLease, prepareRemoteOpenCodeRuntime } from "../src/index.ts";
import type { PreparedRemoteOpenCodeRuntime } from "../src/remoteStorage.ts";
import {
  createFakeRemoteHost,
  TEST_REMOTE_DIGEST,
  type FakeRemoteHost,
  type RemoteIdentityBreak,
} from "./fakeRemoteRuntime.ts";

export interface RemoteOwnedBoot {
  prepared: PreparedRemoteOpenCodeRuntime;
  lease: Awaited<ReturnType<typeof createOwnedSshEndpointLease>>;
  endpoint: RuntimeEndpoint;
}

export interface RemoteOwnedFixture {
  directory: string;
  runtimeDir: string;
  fake: FakeRemoteHost;
  boot(): Promise<RemoteOwnedBoot>;
  inject(breakKind: RemoteIdentityBreak): void;
  dispose(): Promise<void>;
}

export const createRemoteOwnedFixture = async (options: {
  runtimeDir?: string;
  projectId?: string;
  remotePath?: string;
  connection?: string;
  binaryDigest?: string;
} = {}): Promise<RemoteOwnedFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-failure-"));
  const runtimeDir = options.runtimeDir ?? "/var/lib/polyth/runtimes/matrix";
  const projectId = options.projectId ?? "project-a";
  const remotePath = options.remotePath ?? "/srv/project";
  const connection = options.connection ?? "conn-a";
  const fake = createFakeRemoteHost({
    stubPort: 1,
    runtimeDir,
    binaryDigest: options.binaryDigest ?? TEST_REMOTE_DIGEST,
  });
  const stateFile = join(directory, "ssh.lease.json");
  let activeLease: Awaited<ReturnType<typeof createOwnedSshEndpointLease>> | undefined;

  const identityOf = (prepared: PreparedRemoteOpenCodeRuntime) => ({
    connection,
    host: fake.host.label,
    remotePath,
    runtimeDir: prepared.runtimeDir,
    engine: prepared.engineIdentity.engine,
    version: prepared.engineIdentity.version,
    binaryDigest: prepared.engineIdentity.binaryDigest,
    protocolGeneration: prepared.engineIdentity.protocolGeneration,
    storageId: prepared.storageId,
  });

  return {
    directory,
    runtimeDir,
    fake,
    async boot() {
      await activeLease?.dispose();
      activeLease = undefined;
      const prepared = await prepareRemoteOpenCodeRuntime({
        host: fake.host,
        runtimeDir,
        projectId,
        cwd: remotePath,
        bin: "opencode",
        version: "1.18.18",
        binarySource: "path",
      });
      fake.storage.dbKind = "file";
      if (!fake.storage.dbEntries.includes("opencode.db")) {
        fake.storage.dbEntries.push("opencode.db");
      }
      fake.storage.dbContent = fake.storage.dbContent ?? "opaque-remote-opencode-db";
      const lease = await createOwnedSshEndpointLease({
        location: { directory: remotePath },
        stateFile,
        runtimeIdentity: identityOf(prepared),
        async start(instanceToken, incarnation) {
          await prepared.recordOpen(incarnation);
          return {
            url: "http://127.0.0.1:1",
            instanceIdentity: instanceToken,
            async stop() {},
          };
        },
      });
      activeLease = lease;
      return {
        prepared,
        lease,
        endpoint: await lease.endpoint(),
      };
    },
    inject(breakKind) {
      fake.inject(breakKind);
    },
    async dispose() {
      await activeLease?.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
};
