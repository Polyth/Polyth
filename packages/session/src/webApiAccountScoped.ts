// Browser API boundary for account-owned agent presets and project creation
// intents that must stay client-local until the canonical server mutation.
import type { JsonObject, Project, ProjectComposition } from "@polyth/contracts";
import { api as baseApi } from "./webApi.ts";
import { createLifecycleFence } from "./lifecycleFence.ts";

export * from "./webApi.ts";

const sessionLifecycleFence = createLifecycleFence();
let nextProjectComposition: ProjectComposition | undefined;

/** New-project onboarding owns this ephemeral value. It is intentionally not
 * persisted client-side and never changes package enablement or authorization. */
export function setNextProjectComposition(composition?: ProjectComposition): void {
  nextProjectComposition = composition === undefined ? undefined : structuredClone(composition);
}

async function setupProject(mode: "add" | "create", path: string, name?: string): Promise<Project> {
  const composition = nextProjectComposition;
  if (!composition) return mode === "add" ? baseApi.addProject(path, name) : baseApi.createProject(path, name);
  const response = await fetch("/api/projects/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, path, name, composition }),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("polyth:auth-required"));
    const raw = await response.text().catch(() => "");
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch { /* non-JSON error */ }
    throw Object.assign(new Error(message ?? `HTTP ${response.status}${raw ? `: ${raw}` : ""}`), {
      ...(code ? { code } : {}), status: response.status,
    });
  }
  return response.json() as Promise<Project>;
}

type SendBody = Parameters<typeof baseApi.sendMessage>[1];

async function resolvePreset(body: SendBody): Promise<SendBody> {
  const presetId = body.agentProfileId;
  if (presetId === undefined) return body;

  // `null` used to clear a session-owned profile. Presets are account-local now,
  // so clearing simply means no private preset information crosses the wire.
  if (presetId === null) {
    const { agentProfileId: _privatePresetId, ...rest } = body;
    return rest;
  }

  const preset = (await baseApi.listProfiles()).find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw Object.assign(new Error("agent preset not found"), { code: "not-found" });
  }

  const { agentProfileId: _privatePresetId, ...rest } = body;
  const model: JsonObject = {
    providerID: preset.providerID,
    modelID: preset.modelID,
    ...(preset.thinking ? { variant: preset.thinking } : {}),
  };
  return {
    ...rest,
    // Explicit per-send choices remain authoritative over the preset bundle.
    ...(body.model ? {} : { model }),
    ...(body.agent || !preset.agent ? {} : { agent: preset.agent }),
  };
}

export const api: typeof baseApi = {
  ...baseApi,
  addProject: (path, name) => setupProject("add", path, name),
  createProject: (path, name) => setupProject("create", path, name),
  // A list response that overlapped create/archive/restore/delete is stale even
  // when it arrives last. Retry behind the lifecycle idle barrier rather than
  // letting an older response resurrect or temporarily erase a session.
  listSessions: (projectId) => sessionLifecycleFence.readStable(
    () => baseApi.listSessions(projectId),
  ),
  createSession: (input) => sessionLifecycleFence.mutate(
    () => baseApi.createSession(input),
  ),
  archive: (id) => sessionLifecycleFence.mutate(
    () => baseApi.archive(id),
  ),
  restore: (id) => sessionLifecycleFence.mutate(
    () => baseApi.restore(id),
  ),
  deleteSession: (id) => sessionLifecycleFence.mutate(
    () => baseApi.deleteSession(id),
  ),
  sendMessage: async (id, body) => baseApi.sendMessage(id, await resolvePreset(body)),
};