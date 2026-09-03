import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import {
  setPolythLinkNative,
  type ConnectionMetadata,
} from "./polythLink.ts";

/** Node-only helper for tests and Linux shells. Not imported by the browser bundle. */
export async function attachLinkClientBinary(binary: string, dataDir: string, socketPath: string): Promise<void> {
  spawn(binary, ["serve", dataDir, socketPath], { stdio: ["ignore", "ignore", "pipe"] });
  const started = Date.now();
  while (!existsSync(socketPath)) {
    if (Date.now() - started > 12_000) {
      throw Object.assign(new Error("Polyth Link client did not start"), { code: "unavailable" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { code?: string } };
        if (typeof parsed.id === "number") {
          const waiter = pending.get(parsed.id);
          if (!waiter) continue;
          pending.delete(parsed.id);
          if (parsed.error) waiter.reject(Object.assign(new Error(parsed.error.code ?? "unavailable"), { code: parsed.error.code ?? "unavailable" }));
          else waiter.resolve(parsed.result ?? {});
        }
      } catch {
        // ignore malformed control lines
      }
    }
  });
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  setPolythLinkNative({
    async parsePairingTicket(raw) {
      const result = await request("pairing.parse", { ticket: raw });
      return {
        hostLabel: String(result.hostLabel ?? "Polyth"),
        hostFingerprint: String(result.hostFingerprint ?? ""),
        expiresAt: String(result.expiresAt ?? ""),
      };
    },
    async beginPairing(raw, label) {
      const result = await request("pairing.begin", { ticket: raw, label });
      return {
        attemptId: String(result.attemptId ?? ""),
        safetyPhrase: Array.isArray(result.safetyPhrase) ? result.safetyPhrase.map(String) : undefined,
        state: String(result.state ?? "safety-ready"),
      };
    },
    async confirmPairing(attemptId) {
      const result = await request("pairing.confirm", { attemptId });
      return {
        origin: String(result.bootstrap ?? result.origin ?? ""),
        connectionId: String(result.connectionId ?? ""),
      };
    },
    async cancelPairing(attemptId) { await request("pairing.cancel", { attemptId }); },
    async listConnections() {
      const result = await request("connections.list");
      return (Array.isArray(result) ? result : result.connections ?? []) as ConnectionMetadata[];
    },
    async connect(connectionId) {
      const result = await request("connect", { connectionId });
      return { origin: String(result.bootstrap ?? result.origin ?? ""), connectionId: String(result.connectionId ?? connectionId) };
    },
    async disconnect(connectionId) { await request("disconnect", { connectionId }); },
    async forgetConnection(connectionId) { await request("forget", { connectionId }); },
    async getStatus(connectionId) {
      const result = await request("status", { connectionId });
      return {
        state: String(result.state ?? "disconnected"),
        ...(result.transport === "direct" || result.transport === "relay" ? { transport: result.transport } : {}),
      };
    },
  });
}
