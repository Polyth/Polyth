import { join } from "node:path";
import { startDesktopChatWorkspaceWorker, type DesktopChatWorkspaceWorker } from "./chatWorkspaceDeviceWorker.ts";
import {
  installChatWorkspaceSurfaceIpc,
  uninstallChatWorkspaceSurfaceIpc,
} from "./chatWorkspaceSurface.ts";
import {
  startPolythLinkClientManager,
  type PolythLinkClientManager,
  type PolythLinkPairingAttempt,
  type PolythLinkPairingPreview,
} from "./polythLinkClient.ts";

export interface DesktopChatWorkspaceRemoteCoordinator {
  listConnections(): Promise<unknown[]>;
  parsePairingTicket(ticket: string): Promise<PolythLinkPairingPreview>;
  beginPairing(ticket: string, label: string): Promise<PolythLinkPairingAttempt>;
  confirmPairing(attemptId: string): Promise<{ connectionId: string; origin: string }>;
  cancelPairing(attemptId: string): Promise<void>;
  connect(connectionId: string): Promise<{ connectionId: string; origin: string }>;
  recover(connectionId: string): Promise<unknown>;
  status(connectionId: string): Promise<unknown>;
  forget(connectionId: string): Promise<void>;
  disconnect(): Promise<void>;
  activeConnectionId(): string | null;
  close(): Promise<void>;
}

export async function startDesktopChatWorkspaceRemoteCoordinator(input: {
  linkClientBinary: string;
  dataDir: string;
  runtimeDir: string;
  webDist?: string;
  deviceName?: string;
  log?(message: string, error?: unknown): void;
}): Promise<DesktopChatWorkspaceRemoteCoordinator> {
  installChatWorkspaceSurfaceIpc();
  let link: PolythLinkClientManager;
  try {
    link = await startPolythLinkClientManager({
      binary: input.linkClientBinary,
      dataDir: join(input.dataDir, "polyth-link-client"),
      socketPath: join(input.runtimeDir, "polyth-link-client.sock"),
      ...(input.webDist ? { webDist: input.webDist } : {}),
      ...(input.log ? { log: input.log } : {}),
    });
  } catch (error) {
    uninstallChatWorkspaceSurfaceIpc();
    throw error;
  }

  let activeConnection: string | null = null;
  let worker: DesktopChatWorkspaceWorker | null = null;
  let closed = false;
  let switchGeneration = 0;

  const stopWorker = async (): Promise<void> => {
    const current = worker;
    worker = null;
    await current?.close().catch((error) => input.log?.("Chat Workspace worker shutdown failed", error));
  };

  const startWorkerFor = async (connected: {
    connectionId: string;
    origin: string;
    bootstrapUrl: string;
  }, generation: number): Promise<{ connectionId: string; origin: string }> => {
    if (generation !== switchGeneration || closed) {
      await link.disconnect(connected.connectionId).catch(() => {});
      throw Object.assign(new Error("Chat Workspace remote connection was superseded"), { code: "connection-superseded" });
    }

    let nextWorker: DesktopChatWorkspaceWorker | null = null;
    try {
      nextWorker = await startDesktopChatWorkspaceWorker({
        origin: connected.origin,
        bootstrapUrl: connected.bootstrapUrl,
        connectionId: connected.connectionId,
        dataDir: input.dataDir,
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      });
    } catch (error) {
      await link.disconnect(connected.connectionId).catch(() => {});
      throw error;
    }

    if (generation !== switchGeneration || closed) {
      await nextWorker.close().catch(() => {});
      await link.disconnect(connected.connectionId).catch(() => {});
      throw Object.assign(new Error("Chat Workspace remote connection was superseded"), { code: "connection-superseded" });
    }

    worker = nextWorker;
    activeConnection = connected.connectionId;
    return { connectionId: connected.connectionId, origin: connected.origin };
  };

  return {
    listConnections: () => link.connections(),
    parsePairingTicket: (ticket) => link.parsePairingTicket(ticket),
    beginPairing: (ticket, label) => link.beginPairing(ticket, label),

    async confirmPairing(attemptId) {
      if (closed) throw Object.assign(new Error("Chat Workspace remote coordinator is closed"), { code: "coordinator-closed" });
      const generation = ++switchGeneration;
      await stopWorker();
      if (activeConnection) {
        const previous = activeConnection;
        activeConnection = null;
        await link.disconnect(previous).catch(() => {});
      }
      return startWorkerFor(await link.confirmPairing(attemptId), generation);
    },

    cancelPairing: (attemptId) => link.cancelPairing(attemptId),

    async connect(connectionId) {
      if (closed) throw Object.assign(new Error("Chat Workspace remote coordinator is closed"), { code: "coordinator-closed" });
      const generation = ++switchGeneration;
      await stopWorker();
      if (activeConnection && activeConnection !== connectionId) {
        await link.disconnect(activeConnection).catch(() => {});
      }
      return startWorkerFor(await link.connect(connectionId), generation);
    },

    recover: (connectionId) => link.recover(connectionId),
    status: (connectionId) => link.status(connectionId),

    async forget(connectionId) {
      if (activeConnection === connectionId) {
        switchGeneration += 1;
        activeConnection = null;
        await stopWorker();
      }
      await link.forget(connectionId);
    },

    async disconnect() {
      switchGeneration += 1;
      const connectionId = activeConnection;
      activeConnection = null;
      await stopWorker();
      if (connectionId) await link.disconnect(connectionId).catch(() => {});
    },

    activeConnectionId() {
      return activeConnection;
    },

    async close() {
      if (closed) return;
      closed = true;
      switchGeneration += 1;
      const connectionId = activeConnection;
      activeConnection = null;
      await stopWorker();
      if (connectionId) await link.disconnect(connectionId).catch(() => {});
      await link.close();
      uninstallChatWorkspaceSurfaceIpc();
    },
  };
}
