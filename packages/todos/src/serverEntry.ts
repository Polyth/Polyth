import type { AgentCapabilityContributionRegistry, Disposable, RouteHandler } from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import {
  localOnlyRemoteAccess,
  SERVER_BEHAVIOR_SECTIONS,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createTodoAgentTool, todoSkill } from "./agentTool.ts";
import { TODOS_PACKAGE_ID, todoRuleSection } from "./rule.ts";
import { createTodoRuleSettingsStore } from "./settingsStore.ts";

export const TODO_RULE_SETTINGS_PATH = "/api/todos/rule";

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "unavailable";
  const message = cause instanceof Error ? cause.message : "Todos is unavailable";
  if (code === "invalid-input") return { status: 400, code, message };
  if (code === "conflict") return { status: 409, code, message };
  if (code === "forbidden") return { status: 403, code, message };
  return { status: 503, code: "unavailable", message: "Todo rule settings are unavailable" };
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const store = createTodoRuleSettingsStore(host.storageDir);
  let registration: Disposable | undefined;
  let capabilities: Disposable[] = [];
  const todoTool = createTodoAgentTool({
    events: (spaceId, sessionId) => host.forSpace(host.systemSpaceContext(spaceId)).sessions.events(sessionId),
    append: (sessionId, data) => host.events.append(sessionId, "task/snapshot", data, { producerPlugin: TODOS_PACKAGE_ID }),
  });

  const section = (): string => {
    try {
      return todoRuleSection(store.read().settings);
    } catch (error) {
      // Unreadable settings must not break every harness's behavior text.
      console.error("[polyth] todo rule settings unreadable", error);
      return "";
    }
  };

  const refresh = async (): Promise<void> => {
    await host.services.get(SERVER_BEHAVIOR_SECTIONS)?.changed();
  };

  const routes: RouteHandler = async (request) => {
    const { path, method, body, json } = request;
    if (path !== TODO_RULE_SETTINGS_PATH) return false;
    try {
      if (method === "GET") {
        json(200, { ...store.read(), active: registration !== undefined });
        return true;
      }
      if (method === "PUT") {
        requireInstanceOwnerAuthority(request, "the todo rule changes global behavior and requires the instance owner");
        const payload = await body();
        const input = payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {};
        const before = store.read();
        const saved = store.save(input.settings, Number(input.expectedRevision));
        if (saved.revision !== before.revision) await refresh();
        json(200, { ...saved, active: registration !== undefined });
        return true;
      }
    } catch (cause) {
      const error = publicError(cause);
      json(error.status, { error: error.code, message: error.message });
      return true;
    }
    return false;
  };

  return {
    remoteAccess: localOnlyRemoteAccess([TODOS_PACKAGE_ID]),
    routes,
    async onEnable() {
      const registry = host.services.get(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      if (registry && capabilities.length === 0) {
        capabilities.push(registry.register(TODOS_PACKAGE_ID, todoSkill));
        capabilities.push(registry.register(TODOS_PACKAGE_ID, todoTool));
      }
      const sections = host.services.get(SERVER_BEHAVIOR_SECTIONS);
      if (!sections) return;
      registration = sections.register(TODOS_PACKAGE_ID, section);
      if (store.read().settings.enabled) await refresh();
    },
    async onDisable() {
      for (const capability of capabilities.toReversed()) await capability.dispose();
      capabilities = [];
      const enabled = registration !== undefined && section() !== "";
      registration?.dispose();
      registration = undefined;
      if (enabled) await refresh();
    },
  };
}
