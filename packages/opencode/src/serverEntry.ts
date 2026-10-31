import { DEFAULT_OPENCODE_RUNTIME_POLICY, type RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, SERVER_OPENCODE_RUNTIME_POLICY, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createOpenCodeRuntimePolicyStore } from "./runtimePolicyStore.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const store = createOpenCodeRuntimePolicyStore((space) => host.spaceStorage(space));
  const listeners = new Set<(spaceId?: string) => void>();
  let enabled = false;
  const changed = (spaceId?: string): void => {
    for (const listener of listeners) {
      try { listener(spaceId); } catch { /* A retention observer cannot roll back a persisted preference. */ }
    }
  };
  host.services.provide(SERVER_OPENCODE_RUNTIME_POLICY, {
    read: (space) => enabled ? store.read(space).settings : { ...DEFAULT_OPENCODE_RUNTIME_POLICY },
    onChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  });
  const routes: RouteHandler = async ({ path, method, space, body, json }) => {
    if (path !== "/api/opencode/runtime-policy") return false;
    if (method !== "GET" && method !== "PUT") return false;
    try {
      if (method === "GET") json(200, store.read(space));
      else {
        const value = await body();
        const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const saved = store.save(space, input.settings, input.expectedRevision);
        changed(space.spaceId);
        json(200, saved);
      }
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      const status = code === "invalid-input" ? 400 : code === "conflict" ? 409 : 503;
      json(status, { error: code === "invalid-input" || code === "conflict" ? code : "unavailable", message: cause instanceof Error ? cause.message : "OpenCode runtime policy unavailable" });
    }
    return true;
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["opencode"]),
    routes,
    onEnable() { enabled = true; changed(); },
    onDisable() { enabled = false; changed(); },
  };
}
