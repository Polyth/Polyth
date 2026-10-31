// Polyth composition kernel: scoped context, plugin loader, profile resolver.
// Erasable TS only (no enums/namespaces). Local imports use explicit .ts.

import { CAP } from "@polyth/contracts";
import type {
  CapabilityKey,
  Disposable,
  JsonObject,
  Plugin,
  PluginContext,
  PluginManifest,
  UiContributionRegistry,
  UiSlotItem,
} from "@polyth/contracts";

export interface ScopeConfig {
  config?: JsonObject;
  capabilities?: Array<CapabilityKey<unknown>>;
}

type Listener = (payload: never) => void;

interface ProviderEntry {
  key: string;
  value: unknown;
  priority: number;
  order: number; // global registration counter; ties → last wins
}

interface Contribution {
  item: UiSlotItem;
  disposable: Disposable;
}

export interface KernelContext extends PluginContext {
  /** residual state (for tests / dispose verification) */
  state(): { providers: string[]; listeners: string[]; contributions: number };
  dispose(): Promise<void>;
  contributions(): UiSlotItem[];
}

let providerOrder = 0;

class ScopeContext implements KernelContext {
  private disposed = false;
  private readonly providers = new Map<string, ProviderEntry[]>();
  private readonly listeners = new Map<string, Listener[]>();
  private readonly effects: Array<() => void | Promise<void>> = [];
  private readonly contributionList: Contribution[] = [];
  private readonly children = new Set<ScopeContext>();
  private readonly id: string;
  private readonly parent: ScopeContext | null;
  private readonly configValue: JsonObject;

  constructor(id: string, parent: ScopeContext | null, opts: ScopeConfig = {}) {
    this.id = id;
    this.parent = parent;
    this.configValue = opts.config ?? {};
    for (const capKey of opts.capabilities ?? []) {
      // Pre-registered capabilities expose themselves under their own id.
      this.addProvider(capKey.id, capKey, 0);
    }
  }

  private addProvider(id: string, value: unknown, priority: number): ProviderEntry {
    const entry: ProviderEntry = { key: id, value, priority, order: providerOrder++ };
    let list = this.providers.get(id);
    if (!list) {
      list = [];
      this.providers.set(id, list);
    }
    list.push(entry);
    return entry;
  }

  // Highest priority wins; priority ties → last registered wins.
  private findProvider(id: string): ProviderEntry | undefined {
    const list = this.providers.get(id);
    if (!list || list.length === 0) return undefined;
    let best = list[0]!;
    for (const e of list) if (e.priority >= best.priority) best = e;
    return best;
  }

  // ------------------------------------------------------------- provide/inject

  provide<T>(key: CapabilityKey<T>, value: T, priority = 0): Disposable {
    this.assertAlive();
    const entry = this.addProvider(key.id, value, priority);
    const disposable: Disposable = {
      dispose: () => {
        // Only remove if this exact registration is still present.
        const list = this.providers.get(key.id);
        if (list) {
          const i = list.indexOf(entry);
          if (i >= 0) list.splice(i, 1);
        }
      },
    };
    this.effect(() => disposable.dispose());
    return disposable;
  }

  inject<T>(key: CapabilityKey<T>): T {
    this.assertAlive();
    const found = this.lookup(key.id);
    if (found === undefined) {
      throw new Error(
        `capability not provided: ${key.id} (required version ${key.version})`,
      );
    }
    return found as T;
  }

  optional<T>(key: CapabilityKey<T>): T | undefined {
    if (this.disposed) return undefined;
    return this.lookup(key.id) as T | undefined;
  }

  private lookup(id: string): unknown {
    const entry = this.findProvider(id);
    if (entry) return entry.value;
    return this.parent ? this.parent.lookup(id) : undefined;
  }

  // ------------------------------------------------------------- events

  on(event: string, cb: Listener): Disposable {
    this.assertAlive();
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(cb);
    return {
      dispose: () => {
        const arr = this.listeners.get(event);
        if (arr) {
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        }
      },
    };
  }

  emit(event: string, payload: JsonObject): void {
    this.assertAlive();
    for (const cb of this.listeners.get(event) ?? []) cb(payload as never);
    for (const child of this.children) child.emit(event, payload);
  }

  async waterfall<T>(event: string, value: T): Promise<T> {
    this.assertAlive();
    let current: unknown = value;
    for (const cb of this.listeners.get(event) ?? []) {
      const next = await (cb as (p: unknown) => unknown | Promise<unknown>)(current);
      if (next !== undefined) current = next;
    }
    for (const child of this.children) {
      current = await child.waterfall(event, current);
    }
    return current as T;
  }

  // ------------------------------------------------------------- effects / dispose

  effect(disposer: () => void | Promise<void>): void {
    this.assertAlive();
    this.effects.push(disposer);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];

    // Children first (deepest cleanup before parents), then own disposers LIFO.
    for (const child of [...this.children]) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.children.clear();

    for (let i = this.effects.length - 1; i >= 0; i--) {
      try {
        await this.effects[i]!();
      } catch (error) {
        errors.push(error);
      }
    }
    this.effects.length = 0;

    // Revoke contributions registered through this scope. Each disposable
    // removes itself from the list, so pop from the end to avoid skipping the
    // item that shifts into a disposed entry's index.
    while (this.contributionList.length > 0) {
      try {
        await this.contributionList.at(-1)!.disposable.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    this.providers.clear();
    this.listeners.clear();

    this.parent?.children.delete(this);

    if (errors.length > 0) {
      throw new AggregateError(errors, `dispose: ${this.id}`);
    }
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error(`context disposed: ${this.id}`);
    }
  }

  // ------------------------------------------------------------- contributions

  contribute(item: UiSlotItem): Disposable {
    this.assertAlive();
    const registry = this.optional<UiContributionRegistry>(
      (CAP.ui as CapabilityKey<UiContributionRegistry>),
    );
    const downstream = registry?.addSlot(item);
    // Track both forwarded and locally buffered contributions in this scope:
    // plugin disposal must revoke external slot registrations as well.
    const disposable: Disposable = {
      dispose: async () => {
        const i = this.contributionList.findIndex((c) => c.disposable === disposable);
        if (i < 0) return;
        this.contributionList.splice(i, 1);
        await downstream?.dispose();
      },
    };
    this.contributionList.push({ item, disposable });
    return disposable;
  }

  contributions(): UiSlotItem[] {
    return this.contributionList.map((c) => c.item);
  }

  // ------------------------------------------------------------- config / scope

  config<T = JsonObject>(): T {
    return this.configValue as T;
  }

  scope(id: string, opts: ScopeConfig = {}): PluginContext {
    this.assertAlive();
    const child = new ScopeContext(`${this.id}/${id}`, this, opts);
    this.children.add(child);
    return child;
  }

  log(level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject): void {
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "info"
            ? console.info
            : console.debug;
    fn(`[${this.id}] ${msg}`, data ?? "");
  }

  state() {
    return {
      providers: [...this.providers.keys()],
      listeners: [...this.listeners.keys()],
      contributions: this.contributionList.length,
    };
  }
}

// ------------------------------------------------------------- public API

export function createContext(id = "root", parent?: PluginContext, opts: ScopeConfig = {}): KernelContext {
  return new ScopeContext(id, (parent as ScopeContext) ?? null, opts);
}

export async function loadPlugin(
  ctx: PluginContext,
  plugin: Plugin,
  config: JsonObject = {},
): Promise<Disposable> {
  const manifest: PluginManifest = plugin.manifest;

  const provided = new Set<string>(manifest.provides ?? []);
  const missing: string[] = [];
  for (const req of manifest.requires ?? []) {
    const val = ctx.optional({ id: req, version: "1" } as CapabilityKey<unknown>);
    if (val === undefined && !provided.has(req)) missing.push(req);
  }
  if (missing.length > 0) {
    throw new Error(
      `plugin ${manifest.id} missing required capabilities: ${missing.join(", ")}`,
    );
  }

  const child = ctx.scope(`plugin:${manifest.id}`, { config });
  try {
    const widgetIds = new Set<string>();
    for (const widget of manifest.widgets ?? []) {
      if (widgetIds.has(widget.id)) {
        throw new Error(`plugin ${manifest.id} declares duplicate widget: ${widget.id}`);
      }
      widgetIds.add(widget.id);
      if (!widget.supportedSlots.includes(widget.defaultSlot)) {
        throw new Error(
          `plugin ${manifest.id} widget ${widget.id} does not support its default slot ${widget.defaultSlot}`,
        );
      }
      const { module, defaultSlot: _defaultSlot, supportedSlots: _supportedSlots, ...metadata } = widget;
      child.contribute({
        slot: "widget.catalog",
        id: widget.id,
        module,
        order: widget.order,
        props: {
          ...metadata,
          pluginId: manifest.id,
          defaultSlot: widget.defaultSlot,
          supportedSlots: [...widget.supportedSlots],
        } as unknown as JsonObject,
      });
    }
    await plugin.setup(child, config);
  } catch (error) {
    await (child as ScopeContext).dispose();
    throw error;
  }
  return {
    dispose: async () => {
      await (child as ScopeContext).dispose();
    },
  };
}

// ------------------------------------------------------------- profile resolver

export interface ResolveProfileInput {
  bundles?: Record<string, string[]>;
  bundleOrder: string[];
  plugins?: string[];
  patches?: Array<{ id: string; config: JsonObject }>;
}

export interface ResolvedProfile {
  plugins: string[]; // ordered, deduped
  configs: Map<string, JsonObject>; // keyed by patch id prefix before "/"
}

export function resolveProfile(profile: ResolveProfileInput): ResolvedProfile {
  const seen = new Set<string>();
  const plugins: string[] = [];
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      plugins.push(id);
    }
  };

  for (const bundleId of profile.bundleOrder ?? []) {
    for (const pid of profile.bundles?.[bundleId] ?? []) push(pid);
  }
  for (const pid of profile.plugins ?? []) push(pid);

  const configs = new Map<string, JsonObject>();
  for (const patch of profile.patches ?? []) {
    const prefix = patch.id.split("/")[0]!;
    configs.set(prefix, patch.config);
  }

  return { plugins, configs };
}

// ------------------------------------------------------------- test helper

export async function assertDisposedClean(
  ctx: KernelContext,
): Promise<{ providers: string[]; listeners: string[]; contributions: number }> {
  await ctx.dispose();
  return ctx.state();
}
