import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Disposable,
  Plugin,
  PluginContext,
  RouteHandler,
} from "@polyth/contracts";
import { loadPlugin } from "@polyth/kernel";
import { parseManifest } from "./managedManifest.ts";

export interface TrustedServerPluginHost {
  pluginId: string;
  storageDir: string;
  routes: { add(handler: RouteHandler): Disposable };
  root: PluginContext;
}

export type ServerPluginFactory = (
  host: TrustedServerPluginHost,
) => Plugin | Promise<Plugin>;

type TrustedServerSpaceGate = (pluginId: string, spaceId: string) => boolean;
let trustedServerSpaceGate: TrustedServerSpaceGate | null = null;

/**
 * Bind the deployment's canonical package/Space enablement lookup. Trusted
 * Node packages register global HTTP handlers, so the host must stop a handler
 * before package code sees requests from Spaces where that package is disabled.
 * Missing gate is fail-closed; production package composition binds it before
 * any managed server entry can activate.
 */
export function bindTrustedServerSpaceGate(gate: TrustedServerSpaceGate): Disposable {
  trustedServerSpaceGate = gate;
  return {
    dispose() {
      if (trustedServerSpaceGate === gate) trustedServerSpaceGate = null;
    },
  };
}

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

export async function loadServerEntry(opts: {
  installDir: string;
  entryPath: string;
  integrity: string;
  host: TrustedServerPluginHost;
}): Promise<Disposable> {
  const installDir = await realpath(opts.installDir);
  const manifestPath = await realpath(resolve(installDir, "polyth-plugin.json"));
  if (!inside(installDir, manifestPath)) {
    throw new Error("plugin manifest escapes the plugin install directory");
  }
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  if (manifest.id !== opts.host.pluginId) {
    throw new Error(
      `installed manifest id "${manifest.id}" does not match package id "${opts.host.pluginId}"`,
    );
  }
  if (manifest.entries?.server !== opts.entryPath) {
    throw new Error("installed manifest server entry changed since activation was planned");
  }

  const requested = resolve(installDir, opts.entryPath);
  if (!inside(installDir, requested)) {
    throw new Error("server entry escapes the plugin install directory");
  }

  const entry = await realpath(requested);
  if (!inside(installDir, entry)) {
    throw new Error("server entry escapes the plugin install directory");
  }
  if (!(await stat(entry)).isFile()) {
    throw new Error("server entry must resolve to a file");
  }

  const moduleUrl = `${pathToFileURL(entry).href}?integrity=${encodeURIComponent(opts.integrity)}`;
  const loaded = await import(moduleUrl) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error("server entry default export must be a plugin factory");
  }

  const guardedHost: TrustedServerPluginHost = {
    ...opts.host,
    routes: {
      add(handler) {
        return opts.host.routes.add(async (request) => {
          const allowed = trustedServerSpaceGate?.(
            opts.host.pluginId,
            request.space.spaceId,
          ) === true;
          if (!allowed) return false;
          return handler(request);
        });
      },
    },
  };

  const plugin = await (loaded.default as ServerPluginFactory)(guardedHost);
  if (
    !plugin
    || typeof plugin !== "object"
    || !plugin.manifest
    || typeof plugin.manifest.id !== "string"
    || typeof plugin.setup !== "function"
  ) {
    throw new Error("server entry factory must return a Plugin");
  }
  if (plugin.manifest.id !== opts.host.pluginId) {
    throw new Error(
      `server entry plugin id "${plugin.manifest.id}" does not match installed manifest id "${opts.host.pluginId}"`,
    );
  }

  return loadPlugin(opts.host.root, plugin, {});
}
