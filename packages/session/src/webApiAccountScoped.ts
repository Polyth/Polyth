// Browser API boundary for account-owned agent presets. A preset id is private
// account state: resolve it through the authenticated preset endpoint, convert
// it to ordinary model/agent options, and never send the private id into the
// shared session service.
import type { JsonObject } from "@polyth/contracts";
import { api as baseApi } from "./webApi.ts";
import { createLifecycleFence } from "./lifecycleFence.ts";

export * from "./webApi.ts";

const sessionLifecycleFence = createLifecycleFence();

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
