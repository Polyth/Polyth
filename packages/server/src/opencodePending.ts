import type {
  OpenCodePendingChangeDto,
  OpenCodePendingChangeKind,
  OpenCodePendingResponseDto,
  OpenCodePluginConfigEntry,
} from "@polyth/contracts";
import {
  normalizePluginEntries,
  type BackendConfigApplier,
  type McpApplyEntry,
  type ProviderVisibilityApply,
} from "@polyth/backend-opencode";

interface PendingTask extends OpenCodePendingChangeDto {
  apply(): Promise<void>;
  onApplied?(): void;
}

export interface OpenCodePendingService {
  stage(task: PendingTask): void;
  list(): OpenCodePendingResponseDto;
  applyAndRestart(): Promise<{ applied: number; restarted: number }>;
}

export function createOpenCodePendingService(opts: {
  restart(): Promise<number>;
}): OpenCodePendingService {
  const tasks = new Map<string, PendingTask>();
  let applying = false;

  return {
    stage(task) {
      tasks.set(task.id, task);
    },

    list() {
      const changes = [...tasks.values()].map(({ id, kind, label }) => ({ id, kind, label }));
      return { changes, count: changes.length };
    },

    async applyAndRestart() {
      if (applying) {
        throw Object.assign(new Error("OpenCode changes are already being applied"), { code: "conflict" });
      }
      const batch = [...tasks.values()];
      if (batch.length === 0) return { applied: 0, restarted: 0 };
      applying = true;
      try {
        for (const task of batch) await task.apply();
        const restarted = await opts.restart();
        for (const task of batch) {
          if (tasks.get(task.id) !== task) continue;
          tasks.delete(task.id);
          task.onApplied?.();
        }
        return { applied: batch.length, restarted };
      } finally {
        applying = false;
      }
    },
  };
}

export interface DeferredConfigApplier extends BackendConfigApplier {
  enableStaging(): void;
}

const pluginSpec = (entry: OpenCodePluginConfigEntry): string =>
  typeof entry === "string" ? entry : entry[0];

const clonePlugins = (plugins: OpenCodePluginConfigEntry[]): OpenCodePluginConfigEntry[] =>
  structuredClone(plugins);

/** Defers every OpenCode-facing config write behind one pending-restart queue.
 * Reads still use the real adapter; plugin reads additionally project the
 * staged desired list so settings update immediately without touching disk. */
export function createDeferredConfigApplier(
  actual: BackendConfigApplier,
  pending: OpenCodePendingService,
): DeferredConfigApplier {
  let staging = false;
  let stagedPlugins: OpenCodePluginConfigEntry[] | null = null;

  const stage = (
    id: string,
    kind: OpenCodePendingChangeKind,
    label: string,
    apply: () => Promise<void>,
    onApplied?: () => void,
  ): void => pending.stage({ id, kind, label, apply, ...(onApplied ? { onApplied } : {}) });

  const desiredPlugins = async (): Promise<OpenCodePluginConfigEntry[]> =>
    clonePlugins(stagedPlugins ?? await actual.listPlugins());

  const stagePlugins = (plugins: OpenCodePluginConfigEntry[]): OpenCodePluginConfigEntry[] => {
    const desired = clonePlugins(plugins);
    stagedPlugins = desired;
    stage(
      "plugins",
      "plugins",
      "OpenCode plugins",
      async () => { await actual.replacePlugins(desired); },
      () => {
        if (stagedPlugins === desired) stagedPlugins = null;
      },
    );
    return clonePlugins(desired);
  };

  return {
    enableStaging() {
      staging = true;
    },
    behaviorPath: () => actual.behaviorPath(),
    configPath: () => actual.configPath(),
    readConfig: () => actual.readConfig(),

    // Behavior instructions are read for each turn and their revision is
    // logged at admission time, so they do not require a process restart.
    applyBehavior: (text) => actual.applyBehavior(text),

    applyMcp(entries: McpApplyEntry[]) {
      if (!staging) return actual.applyMcp(entries);
      const desired = structuredClone(entries);
      stage("mcp", "mcp", "MCP servers", async () => { await actual.applyMcp(desired); });
      return Promise.resolve();
    },

    applyProviderVisibility(value: ProviderVisibilityApply) {
      if (!staging) return actual.applyProviderVisibility(value);
      const desired = structuredClone(value);
      stage(
        "provider-visibility",
        "provider-visibility",
        "Provider and model visibility",
        async () => { await actual.applyProviderVisibility(desired); },
      );
      return Promise.resolve();
    },

    applyAgent(name, role) {
      if (!staging) return actual.applyAgent(name, role);
      const desired = structuredClone(role);
      stage(
        `agent:${name}`,
        "agent",
        `Agent role: ${name}`,
        async () => { await actual.applyAgent(name, desired); },
      );
      return Promise.resolve();
    },

    async listPlugins() {
      return desiredPlugins();
    },

    async applyPlugins(raw) {
      if (!staging) return actual.applyPlugins(raw);
      const imported = normalizePluginEntries(raw);
      const current = await desiredPlugins();
      const merged = [...current];
      const positions = new Map(current.map((entry, index) => [pluginSpec(entry), index]));
      for (const entry of imported) {
        const spec = pluginSpec(entry);
        const position = positions.get(spec);
        if (position === undefined) {
          positions.set(spec, merged.length);
          merged.push(entry);
        } else {
          merged[position] = entry;
        }
      }
      return stagePlugins(merged);
    },

    async replacePlugins(raw) {
      if (!staging) return actual.replacePlugins(raw);
      return stagePlugins(normalizePluginEntries(raw));
    },

    async removePlugin(rawSpec) {
      if (!staging) return actual.removePlugin(rawSpec);
      const normalized = normalizePluginEntries([rawSpec])[0]!;
      const spec = pluginSpec(normalized);
      const current = await desiredPlugins();
      const plugins = current.filter((entry) => pluginSpec(entry) !== spec);
      const removed = plugins.length !== current.length;
      if (removed) stagePlugins(plugins);
      return { plugins, removed };
    },
  };
}
