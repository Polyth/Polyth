import type {
  OpenCodePendingChangeDto,
  OpenCodePendingChangeKind,
  OpenCodePendingResponseDto,
  OpenCodePluginConfigEntry,
} from "@polyth/contracts";
import {
  inspectProviderEntry,
  normalizePluginEntries,
  projectConfig,
  type BackendConfigApplier,
  type McpApplyEntry,
  type ProviderVisibilityApply,
  type StagedProviderOp,
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
  canRestart?(state?: unknown): Promise<{ safe: true } | { safe: false; reason: string }>;
  /** One critical section spanning safety, writes, replacement, and
   * reconciliation. The server admission gate and owned lifecycle generation
   * installation locks are held for its full lifetime. */
  withAdmissionBarrier?<T>(action: () => Promise<T>): Promise<T>;
  captureRestartState?(): Promise<unknown>;
  restart(state?: unknown): Promise<number>;
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
        const apply = async () => {
          // Capture only after admission, runtime creation, and owned lifecycle
          // generation installation are fenced. Generation inequality alone
          // cannot prove whether a successor loaded pre- or post-write config.
          const restartState = await opts.captureRestartState?.();
          const safety = await opts.canRestart?.(restartState);
          if (safety && !safety.safe) {
            throw Object.assign(new Error(`OpenCode restart deferred: ${safety.reason}`), {
              code: "restart-deferred",
            });
          }
          for (const task of batch) await task.apply();
          const restarted = await opts.restart(restartState);
          for (const task of batch) {
            if (tasks.get(task.id) !== task) continue;
            tasks.delete(task.id);
            task.onApplied?.();
          }
          return { applied: batch.length, restarted };
        };
        return opts.withAdmissionBarrier
          ? await opts.withAdmissionBarrier(apply)
          : await apply();
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
 * staged desired list so settings update immediately without touching disk.
 * Custom-provider mutations use a projected view of actual + staged ops. */
export function createDeferredConfigApplier(
  actual: BackendConfigApplier,
  pending: OpenCodePendingService,
): DeferredConfigApplier {
  let staging = false;
  let stagedPlugins: OpenCodePluginConfigEntry[] | null = null;
  let providerOps: StagedProviderOp[] = [];

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

  const projectedConfig = async (): Promise<Record<string, unknown>> => {
    const physical = await actual.readConfig();
    if (!staging || providerOps.length === 0) return physical;
    return projectConfig(physical, providerOps);
  };

  const restageProviders = (): void => {
    const ops = providerOps;
    if (ops.length === 0) return;
    const last = ops[ops.length - 1]!;
    const label = last.kind === "upsert"
      ? `Custom provider: ${last.input.name || last.input.id}`
      : last.kind === "remove"
        ? `Remove custom provider: ${last.id}`
        : last.kind === "mergeDiscovered"
        ? `Discover models: ${last.id}`
        : last.kind === "dropModel"
          ? `Remove model: ${last.id}/${last.modelId}`
          : `Add model: ${last.id}`;
    stage(
      "provider-config",
      "provider-config",
      label,
      async () => {
        await actual.applyStagedProviderOps([...ops]);
      },
      () => {
        if (providerOps === ops) providerOps = [];
      },
    );
  };

  const pushProviderOp = (op: StagedProviderOp, immediate: () => Promise<void>): Promise<void> => {
    if (!staging) return immediate();
    providerOps = [...providerOps, op];
    restageProviders();
    return Promise.resolve();
  };

  return {
    enableStaging() {
      staging = true;
    },
    behaviorPath: () => actual.behaviorPath(),
    configPath: () => actual.configPath(),
    ...(actual.configTargetId
      ? { configTargetId: () => actual.configTargetId!() }
      : {}),
    ...(actual.configAuthority
      ? { configAuthority: () => actual.configAuthority!() }
      : {}),
    readConfig: () => projectedConfig(),

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

    async applyCustomProvider(input) {
      await pushProviderOp({ kind: "upsert", input: structuredClone(input) }, () => actual.applyCustomProvider(input));
    },

    async removeCustomProvider(id) {
      const providerId = id.trim();
      await pushProviderOp({ kind: "remove", id: providerId }, () => actual.removeCustomProvider(providerId));
    },

    async applyStagedProviderOps(ops) {
      if (!staging) return actual.applyStagedProviderOps(ops);
      for (const op of ops) {
        await pushProviderOp(op, () => actual.applyStagedProviderOps([op]));
      }
    },

    async inspectProvider(id) {
      const trimmed = id.trim();
      if (!trimmed) return undefined;
      const projected = await projectedConfig();
      const providerRaw = projected.provider;
      const provider = providerRaw && typeof providerRaw === "object" && !Array.isArray(providerRaw)
        ? providerRaw as Record<string, unknown>
        : {};
      let overlay: { owned?: boolean; authMode?: "api-key" | "none" } = {};
      for (const op of providerOps) {
        const matches = op.kind === "upsert" ? op.input.id === trimmed : op.id === trimmed;
        if (!matches) continue;
        if (op.kind === "remove") overlay = {};
        else if (op.kind === "upsert") {
          overlay = {
            owned: true,
            ...(op.input.authMode ? { authMode: op.input.authMode } : overlay.authMode ? { authMode: overlay.authMode } : {}),
          };
        }
      }
      return inspectProviderEntry(trimmed, provider[trimmed], overlay);
    },

    async mergeDiscoveredModels(id, discovered) {
      const providerId = id.trim();
      await pushProviderOp(
        { kind: "mergeDiscovered", id: providerId, discovered: structuredClone(discovered) },
        () => actual.mergeDiscoveredModels(providerId, discovered),
      );
    },

    async addManualModel(id, model) {
      const providerId = id.trim();
      await pushProviderOp(
        { kind: "addManual", id: providerId, model: structuredClone(model) },
        () => actual.addManualModel(providerId, model),
      );
    },

    async removeConfiguredModel(id, modelId) {
      const providerId = id.trim();
      const trimmedModel = modelId.trim();
      await pushProviderOp(
        { kind: "dropModel", id: providerId, modelId: trimmedModel },
        () => actual.removeConfiguredModel(providerId, trimmedModel),
      );
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
