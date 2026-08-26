import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Disposable,
  Plugin,
  PluginContext,
  RouteHandler,
} from "@polyth/contracts";
import { loadPlugin } from "@polyth/kernel";

export interface TrustedServerPluginHost {
  pluginId: string;
  storageDir: string;
  routes: { add(handler: RouteHandler): Disposable };
  root: PluginContext;
}

export type ServerPluginFactory = (
  host: TrustedServerPluginHost,
) => Plugin | Promise<Plugin>;

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

export async function loadServerEntry(opts: {
  installDir: string;
  entryPath: string;
  integrity: string;
  host: TrustedServerPluginHost;
}): Promise<Disposable> {
  const installDir = await realpath(opts.installDir);
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

  const plugin = await (loaded.default as ServerPluginFactory)(opts.host);
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
