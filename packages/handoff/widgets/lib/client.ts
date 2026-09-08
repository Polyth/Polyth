import type { ContextBundleDto, HandoffPresetDto, HandoffResultImportedData, SessionProjection } from "@polyth/contracts";
import type { ApiTransport, WebPackageHost } from "@polyth/web-sdk";
export { estimateTokens } from "../../src/tokens.ts";
export { hashText } from "../../src/hash.ts";

export type HandoffTarget = "current-session" | "queue" | "new-session" | "draft";

export interface HandoffClient {
  listPresets(): Promise<HandoffPresetDto[]>;
  listSources(projectId: string, sessionId: string): Promise<Array<{ id: string; label: string; description: string; tokens: number; defaultOn?: boolean }>>;
  createBundle(input: {
    projectId: string;
    sessionId: string;
    presetId: string;
    instruction: string;
    label: string;
    sources: Array<{ id: string; params?: Record<string, unknown> }>;
    warnTokenThreshold?: number;
  }): Promise<ContextBundleDto>;
  getBundle(projectId: string, id: string): Promise<ContextBundleDto | null>;
  checkStale(projectId: string, sessionId: string, id: string): Promise<{ stale: boolean; staleSources: Array<{ id: string; reason: string }> }>;
  recordImport(sessionId: string, provenance: HandoffResultImportedData["provenance"], textHash: string): Promise<void>;
  defaultTarget(session: SessionProjection | null): HandoffTarget;
  executeTarget(target: HandoffTarget, projectId: string, sessionId: string | null, text: string): Promise<void>;
  listTargets(): Array<{ id: HandoffTarget; label: string }>;
}

export function createHandoffClient(transport: ApiTransport, host?: WebPackageHost): HandoffClient {
  const targets = () => host?.handoffTargets.list() ?? [];

  return {
    async listPresets() {
      const res = await transport.get<{ presets: HandoffPresetDto[] }>("/api/handoff/presets");
      return res.presets;
    },
    async listSources(projectId, sessionId) {
      const res = await transport.get<{ sources: Array<{ id: string; label: string; description: string; tokens: number; defaultOn?: boolean }> }>(
        `/api/handoff/sources?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      return res.sources;
    },
    async createBundle(input) {
      return transport.post<ContextBundleDto>("/api/handoff/bundles", input);
    },
    async getBundle(projectId, id) {
      try {
        return await transport.get<ContextBundleDto>(`/api/handoff/bundles/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`);
      } catch {
        return null;
      }
    },
    async checkStale(projectId, sessionId, id) {
      return transport.get(`/api/handoff/bundles/${encodeURIComponent(id)}/check?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`);
    },
    async recordImport(sessionId, provenance, textHash) {
      await transport.post("/api/handoff/imports", { sessionId, provenance, textHash });
    },
    defaultTarget(session) {
      if (!session) return "new-session";
      if (session.status === "working") return "queue";
      return "current-session";
    },
    listTargets() {
      return targets()
        .filter((item) => item.available())
        .map((item) => ({ id: item.id as HandoffTarget, label: item.label }));
    },
    async executeTarget(target, projectId, sessionId, text) {
      const registration = targets().find((item) => item.id === target);
      if (!registration?.available()) {
        throw new Error(`Handoff target "${target}" is not available`);
      }
      await registration.send({ projectId, sessionId, text });
    },
  };
}
