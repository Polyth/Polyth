import type {
  WebPackageEntry,
  WebPackageHost,
  WebPackageInstaller,
} from "@polyth/web-sdk";

export interface WebPackageAsset {
  id: string;
  module: string;
  styles: string[];
}

interface WebPackageManifest {
  packages: WebPackageAsset[];
}

export interface WebEntryLoaderOptions {
  fetch?: typeof fetch;
  importModule?: (url: string) => Promise<unknown>;
  document?: Document;
}

const validAsset = (value: unknown): value is WebPackageAsset => {
  const asset = value as Partial<WebPackageAsset> | null;
  const packageRoot = typeof asset?.id === "string"
    ? `/packages/${asset.id}/`
    : "";
  return !!asset
    && typeof asset === "object"
    && typeof asset.id === "string"
    && /^[a-z0-9][a-z0-9-]*$/.test(asset.id)
    && typeof asset.module === "string"
    && asset.module.startsWith(packageRoot)
    && Array.isArray(asset.styles)
    && asset.styles.every((style) =>
      typeof style === "string" && style.startsWith(packageRoot));
};

function installStyles(asset: WebPackageAsset, documentRef: Document | undefined): void {
  if (!documentRef) return;
  for (const href of asset.styles) {
    const id = `polyth-web-package-style:${asset.id}:${href}`;
    if ([...documentRef.querySelectorAll<HTMLLinkElement>("link[data-polyth-web-package-style]")]
      .some((link) => link.dataset.polythWebPackageStyle === id)) {
      continue;
    }
    const link = documentRef.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.polythWebPackageStyle = id;
    documentRef.head.appendChild(link);
  }
}

/** Load the build-generated package manifest and turn each browser entry into
 * a lifecycle installer. Entries receive only the bounded SDK host. */
export async function loadWebPackageInstallers(
  host: WebPackageHost,
  options: WebEntryLoaderOptions = {},
): Promise<Map<string, WebPackageInstaller>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const importModule = options.importModule
    ?? ((url: string) => import(url) as Promise<unknown>);
  const response = await fetchImpl("/packages-manifest.json");
  if (!response.ok) {
    throw new Error(`web package manifest failed: HTTP ${response.status}`);
  }
  const parsed = await response.json() as Partial<WebPackageManifest>;
  if (!Array.isArray(parsed.packages) || !parsed.packages.every(validAsset)) {
    throw new Error("web package manifest is invalid");
  }

  // Modules download in parallel (they are independent per-package bundles);
  // factories still run sequentially in manifest order afterwards so install
  // order stays deterministic. Per-package isolation: the manifest is baked
  // into the shell dist while each bundle lives in its own
  // packages/{id}/dist/web, so one stale or missing bundle must degrade to a
  // logged skip — never abort the loop and take every remaining package down
  // with it.
  const loadedModules = await Promise.all(parsed.packages.map(async (asset) => {
    try {
      return { asset, loaded: await importModule(asset.module) as { default?: unknown } };
    } catch (error) {
      console.error(`[polyth] web package "${asset.id}" failed to load`, error);
      return { asset, loaded: null };
    }
  }));
  const installers = new Map<string, WebPackageInstaller>();
  for (const { asset, loaded } of loadedModules) {
    if (loaded === null) continue;
    try {
      if (typeof loaded.default !== "function") {
        throw new Error(`web entry for "${asset.id}" must default-export a package factory`);
      }
      const installer = (loaded.default as WebPackageEntry)(host);
      if (typeof installer !== "function") {
        throw new Error(`web entry for "${asset.id}" must return an installer`);
      }
      installStyles(asset, options.document ?? globalThis.document);
      installers.set(asset.id, installer);
    } catch (error) {
      console.error(`[polyth] web package "${asset.id}" failed to load`, error);
    }
  }
  return installers;
}
