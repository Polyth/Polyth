import { hostname } from "node:os";
import { join } from "node:path";
import { createProfileRegistry } from "@polyth/browser";
import {
  CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
  connectChatWorkspaceDeviceRuntime,
  createChatWorkspaceDeviceWorkerRuntime,
  type ChatWorkspaceDeviceRuntimeClient,
} from "@polyth/chat-workspace";
import { createChatWorkspaceElectronProfileDriver } from "./chatWorkspaceElectronDriver.ts";

export interface DesktopChatWorkspaceWorker {
  close(): Promise<void>;
}

const bootstrapCookie = async (bootstrapUrl: string): Promise<string> => {
  const response = await fetch(bootstrapUrl, { redirect: "manual" });
  if (response.status !== 302 && response.status !== 303) {
    throw Object.assign(new Error(`Polyth Link bootstrap returned ${response.status}`), { code: "link-bootstrap-failed" });
  }
  const raw = response.headers.get("set-cookie") ?? "";
  const cookie = raw.split(";", 1)[0]?.trim() ?? "";
  if (!cookie || !cookie.includes("=")) {
    throw Object.assign(new Error("Polyth Link bootstrap did not issue a session cookie"), { code: "link-bootstrap-failed" });
  }
  return cookie;
};

const workerWsUrl = (origin: string): string => {
  const url = new URL("/ws/chat-workspace/device-runtime", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export async function startDesktopChatWorkspaceWorker(input: {
  origin: string;
  bootstrapUrl: string;
  connectionId: string;
  /** Informational only. The remote host replaces this value with the
   * authenticated Polyth Link device principal before routing. */
  deviceId?: string;
  dataDir: string;
  deviceName?: string;
}): Promise<DesktopChatWorkspaceWorker> {
  const profiles = createProfileRegistry({ driver: createChatWorkspaceElectronProfileDriver() });
  let client: ChatWorkspaceDeviceRuntimeClient | null = null;
  const runtime = createChatWorkspaceDeviceWorkerRuntime({
    profiles,
    dataDir: join(input.dataDir, "chat-workspace", input.connectionId),
    emit(event) {
      client?.sendEvent(event);
    },
  });
  const cookie = await bootstrapCookie(input.bootstrapUrl);
  client = connectChatWorkspaceDeviceRuntime({
    wsUrl: workerWsUrl(input.origin),
    headers: { Cookie: cookie },
    hello: {
      protocolVersion: CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
      deviceId: input.deviceId ?? "authenticated-by-polyth-link",
      deviceName: input.deviceName?.trim() || hostname(),
      platform: process.platform,
      arch: process.arch,
      capabilities: {
        localChromium: true,
        localRendering: true,
        persistentProfiles: true,
        explicitResponseHandoff: true,
      },
    },
    runtime,
  });
  try {
    await client.ready;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    close: () => client?.close() ?? Promise.resolve(),
  };
}
