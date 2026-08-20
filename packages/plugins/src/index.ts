// Managed plugin registry (WP9). Server-owned lifecycle for locally trusted
// plugins: install from a trusted directory (or npm with fixed argv), staged
// atomic activation, kernel-scoped enable/disable/reload so disposal removes
// every capability/listener/contribution, bounded logs with secret redaction.
//
// Plugins here are DESCRIPTOR packages: a polyth-plugin.json manifest declares
// identity, trust class, and slot contributions. Executable UI modules resolve
// through the web app's allowlisted module registry, never from manifest text.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createContext, type KernelContext } from "@polyth/kernel";
import type { InstalledPluginDto, TrustClass, UiSlotItem } from "@polyth/contracts";

const execFileAsync = promisify(execFile);

const TRUST_CLASSES: TrustClass[] = ["ui-only", "pure", "workspace", "network", "device", "privileged", "credentialed"];

/** Grant text shown at install/enable time; the UI must render it verbatim. */
export const TRUST_GRANTS: Record<TrustClass, string> = {
  "ui-only": "No workspace, network, or device access.",
  pure: "No workspace, network, or device access.",
  workspace: "Project-scoped file and process access, gated by permission checks.",
  network: "Network access to the origins it declares.",
  device: "Browser/device APIs (camera, microphone, clipboard).",
  privileged: "Broad access. Requires explicit confirmation at install and runtime.",
  credentialed: "Holds credentials. Requires explicit confirmation at install and runtime.",
};

export interface ManagedPluginManifest {
  id: string;
  name: string;
  version: string;
  trust: TrustClass;
  capabilities?: string[];
  /** Slot descriptors; `module` names an entry in the UI's allowlisted registry. */
  contributions?: Array<{ slot: string; id: string; module: string }>;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

export function parseManifest(raw: string): ManagedPluginManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw err("invalid-input", "polyth-plugin.json is not valid JSON");
  }
  const m = data as Partial<ManagedPluginManifest>;
  if (!m || typeof m !== "object") throw err("invalid-input", "manifest must be an object");
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id)) {
    throw err("invalid-input", "manifest id must be a short lowercase identifier");
  }
  if (typeof m.name !== "string" || !m.name.trim()) throw err("invalid-input", "manifest name required");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    throw err("invalid-input", "manifest version must be semver");
  }
  if (!TRUST_CLASSES.includes(m.trust as TrustClass)) {
    throw err("invalid-input", `manifest trust must be one of: ${TRUST_CLASSES.join(", ")}`);
  }
  const capabilities = Array.isArray(m.capabilities)
    ? m.capabilities.filter((c): c is string => typeof c === "string")
    : [];
  const contributions: ManagedPluginManifest["contributions"] = [];
  for (const c of Array.isArray(m.contributions) ? m.contributions : []) {
    const item = c as { slot?: unknown; id?: unknown; module?: unknown };
    if (typeof item.slot !== "string" || typeof item.id !== "string" || typeof item.module !== "string") {
      throw err("invalid-input", "each contribution needs slot, id, and module strings");
    }
    contributions.push({ slot: item.slot, id: item.id, module: item.module });
  }
  return { id: m.id, name: m.name.trim(), version: m.version, trust: m.trust as TrustClass, capabilities, contributions };
}

// ---- secret redaction -----------------------------------------------------------

const SECRET_PATTERNS = [
  /(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,               // API key shapes
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                  // GitHub tokens
  /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{12,}/g,        // Authorization bearer values
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.?[A-Za-z0-9_-]*/g, // JWTs
  /(?<=(password|token|secret|apikey|api_key)[=:]\s?)[^\s"']{6,}/gi,
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

// ---- registry -------------------------------------------------------------------

interface StoredPlugin {
  manifest: ManagedPluginManifest;
  source: string;
  enabled: boolean;
  status: InstalledPluginDto["status"];
  lastError?: string;
  integrity: string;
}

export interface PluginLogEntry { at: number; line: string }

export interface PluginRegistryOptions {
  /** Data dir where plugins are installed (owned by the registry). */
  dir: string;
  /** File-source installs must live under this directory. */
  trustedDir?: string;
  /** UI slot sink; contributions land here while a plugin is enabled. */
  slots?: { add(item: UiSlotItem): { dispose(): void } };
  /** npm executable override (tests point this at a stub). */
  npmBin?: string;
}

export interface PluginRegistry {
  list(): InstalledPluginDto[];
  install(source: string): Promise<InstalledPluginDto>;
  enable(id: string): Promise<InstalledPluginDto>;
  disable(id: string): Promise<InstalledPluginDto>;
  reload(id: string): Promise<InstalledPluginDto>;
  remove(id: string): Promise<boolean>;
  logs(id: string, opts?: { after?: number; limit?: number }): PluginLogEntry[];
  log(id: string, line: string): void;
  /** Kernel scope inspection (tests verify dispose cleanliness). */
  scopeState(id: string): { providers: string[]; listeners: string[]; contributions: number } | null;
  dispose(): Promise<void>;
}

const MAX_LOG_LINES = 500;

const integrityOf = (dir: string): string => {
  // Digest over the manifest and package.json: enough to detect tampering of
  // the descriptor surface (the only thing the server ever interprets).
  const hash = createHash("sha256");
  for (const f of ["polyth-plugin.json", "package.json"]) {
    const p = join(dir, f);
    if (existsSync(p)) hash.update(readFileSync(p));
  }
  return hash.digest("hex").slice(0, 16);
};

export function createPluginRegistry(opts: PluginRegistryOptions): PluginRegistry {
  mkdirSync(opts.dir, { recursive: true });
  const stateFile = join(opts.dir, "registry.json");
  const stagingRoot = join(opts.dir, ".staging");

  const loadState = (): StoredPlugin[] => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as StoredPlugin[];
    } catch {
      return [];
    }
  };

  const plugins = new Map<string, StoredPlugin>(loadState().map((p) => [p.manifest.id, p]));
  const scopes = new Map<string, KernelContext>();
  const logsBuf = new Map<string, PluginLogEntry[]>();

  const persist = () => {
    const tmp = `${stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...plugins.values()], null, 2));
    renameSync(tmp, stateFile);
  };

  const toDto = (p: StoredPlugin): InstalledPluginDto => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    source: p.source,
    trust: p.manifest.trust,
    enabled: p.enabled,
    status: p.status,
    capabilities: p.manifest.capabilities ?? [],
    contributions: (p.manifest.contributions ?? []).map((c) => ({
      slot: c.slot as UiSlotItem["slot"], id: c.id, module: c.module,
    })),
    ...(p.lastError ? { lastError: p.lastError } : {}),
  });

  const installDirOf = (id: string) => join(opts.dir, id);

  /** Activate: fresh kernel scope, contribute every slot item. Atomic — any
   *  failure disposes the half-built scope and reports error status. */
  const activate = async (p: StoredPlugin): Promise<void> => {
    p.status = "loading";
    const scope = createContext(`plugin:${p.manifest.id}`);
    try {
      const disk = installDirOf(p.manifest.id);
      if (!existsSync(join(disk, "polyth-plugin.json"))) throw new Error("plugin files missing on disk");
      if (integrityOf(disk) !== p.integrity) throw new Error("plugin files changed since install (integrity mismatch)");
      for (const c of p.manifest.contributions ?? []) {
        // `module` is a registry KEY the web shell resolves through its
        // allowlist — never executable content from the manifest.
        const item: UiSlotItem = { slot: c.slot as UiSlotItem["slot"], id: c.id, module: c.module };
        const d = opts.slots ? opts.slots.add(item) : scope.contribute(item);
        scope.effect(() => d.dispose());
      }
      scopes.set(p.manifest.id, scope);
      p.status = "ready";
      delete p.lastError;
    } catch (e) {
      await scope.dispose();
      p.status = "error";
      p.lastError = (e as Error).message;
      throw e;
    }
  };

  const deactivate = async (id: string): Promise<void> => {
    const scope = scopes.get(id);
    if (scope) {
      await scope.dispose();
      scopes.delete(id);
    }
  };

  const get = (id: string): StoredPlugin => {
    const p = plugins.get(id);
    if (!p) throw err("not-found", `plugin not installed: ${id}`);
    return p;
  };

  const registry: PluginRegistry = {
    list: () => [...plugins.values()].map(toDto),

    async install(source: string): Promise<InstalledPluginDto> {
      if (typeof source !== "string" || !source.trim()) throw err("invalid-input", "install source required");
      rmSync(stagingRoot, { recursive: true, force: true });
      mkdirSync(stagingRoot, { recursive: true });
      const staging = join(stagingRoot, `install-${Date.now()}`);

      try {
        let pkgDir: string;
        if (source.startsWith("file:")) {
          const rel = source.slice(5);
          if (!opts.trustedDir) throw err("invalid-input", "file installs are disabled (no trusted plugin directory configured)");
          if (isAbsolute(rel)) throw err("invalid-path", "file source must be relative to the trusted plugin directory");
          const base = resolve(opts.trustedDir);
          const target = normalize(resolve(base, rel));
          if (target !== base && !target.startsWith(base + sep)) {
            throw err("invalid-path", "file source escapes the trusted plugin directory");
          }
          if (!existsSync(target)) throw err("not-found", `no plugin at ${rel}`);
          cpSync(target, staging, { recursive: true });
          pkgDir = staging;
        } else if (source.startsWith("npm:")) {
          const spec = source.slice(4);
          if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=-]+)?$/i.test(spec)) {
            throw err("invalid-input", "npm source must be a plain package spec");
          }
          mkdirSync(staging, { recursive: true });
          writeFileSync(join(staging, "package.json"), '{"name":"polyth-plugin-install","private":true}');
          // Fixed argv; registry metadata is never executed (scripts ignored).
          await execFileAsync(opts.npmBin ?? "npm", [
            "install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", spec,
          ], { timeout: 120_000 });
          const modules = join(staging, "node_modules");
          const scopeOrPkg = readdirSync(modules).filter((d) => !d.startsWith("."));
          let found: string | null = null;
          for (const entry of scopeOrPkg) {
            const p1 = join(modules, entry);
            if (existsSync(join(p1, "polyth-plugin.json"))) { found = p1; break; }
            if (entry.startsWith("@")) {
              for (const inner of readdirSync(p1)) {
                if (existsSync(join(p1, inner, "polyth-plugin.json"))) { found = join(p1, inner); break; }
              }
            }
            if (found) break;
          }
          if (!found) throw err("invalid-input", "installed package has no polyth-plugin.json manifest");
          pkgDir = found;
        } else {
          throw err("invalid-input", 'source must be "npm:name@version" or "file:relative-path"');
        }

        const manifestPath = join(pkgDir, "polyth-plugin.json");
        if (!existsSync(manifestPath)) throw err("invalid-input", "plugin has no polyth-plugin.json manifest");
        const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
        if (plugins.has(manifest.id)) throw err("conflict", `plugin already installed: ${manifest.id}`);

        // Stage → atomic rename into place, then register.
        const dest = installDirOf(manifest.id);
        rmSync(dest, { recursive: true, force: true });
        if (pkgDir !== staging) {
          const hop = join(stagingRoot, manifest.id);
          cpSync(pkgDir, hop, { recursive: true });
          renameSync(hop, dest);
        } else {
          renameSync(staging, dest);
        }
        const stored: StoredPlugin = {
          manifest,
          source,
          enabled: false,
          status: "installed",
          integrity: integrityOf(dest),
        };
        plugins.set(manifest.id, stored);
        persist();
        return toDto(stored);
      } finally {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    },

    async enable(id: string): Promise<InstalledPluginDto> {
      const p = get(id);
      if (p.enabled && p.status === "ready") return toDto(p);
      try {
        await activate(p);
        p.enabled = true;
      } finally {
        persist();
      }
      return toDto(p);
    },

    async disable(id: string): Promise<InstalledPluginDto> {
      const p = get(id);
      await deactivate(id);
      p.enabled = false;
      p.status = "disabled";
      delete p.lastError;
      persist();
      return toDto(p);
    },

    async reload(id: string): Promise<InstalledPluginDto> {
      const p = get(id);
      const wasEnabled = p.enabled;
      await deactivate(id);
      // Re-read the manifest so an on-disk fix is picked up; keep the previous
      // manifest when the reread fails so a healthy install can't be bricked.
      try {
        const manifest = parseManifest(readFileSync(join(installDirOf(id), "polyth-plugin.json"), "utf8"));
        if (manifest.id !== id) throw err("invalid-input", "manifest id changed on disk");
        p.manifest = manifest;
        p.integrity = integrityOf(installDirOf(id));
      } catch (e) {
        p.status = "error";
        p.lastError = (e as Error).message;
        persist();
        throw e;
      }
      if (wasEnabled) {
        try {
          await activate(p);
        } finally {
          persist();
        }
      } else {
        p.status = "installed";
        persist();
      }
      return toDto(p);
    },

    async remove(id: string): Promise<boolean> {
      const p = plugins.get(id);
      if (!p) return false;
      await deactivate(id);
      plugins.delete(id);
      logsBuf.delete(id);
      rmSync(installDirOf(id), { recursive: true, force: true });
      persist();
      return true;
    },

    logs(id: string, o: { after?: number; limit?: number } = {}): PluginLogEntry[] {
      const all = logsBuf.get(id) ?? [];
      const after = o.after ?? 0;
      const limit = Math.min(Math.max(o.limit ?? 200, 1), MAX_LOG_LINES);
      return all.filter((e) => e.at > after).slice(0, limit);
    },

    log(id: string, line: string): void {
      let buf = logsBuf.get(id);
      if (!buf) {
        buf = [];
        logsBuf.set(id, buf);
      }
      buf.push({ at: Date.now(), line: redactSecrets(line.slice(0, 4000)) });
      if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
    },

    scopeState(id: string) {
      return scopes.get(id)?.state() ?? null;
    },

    async dispose(): Promise<void> {
      for (const id of [...scopes.keys()]) await deactivate(id);
    },
  };

  // Boot: re-activate plugins that were enabled when the process stopped.
  for (const p of plugins.values()) {
    if (p.enabled) {
      void activate(p).catch(() => persist());
    } else if (p.status !== "installed") {
      p.status = p.enabled ? p.status : "disabled";
    }
  }

  return registry;
}
