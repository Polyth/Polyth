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
  return !!asset
    && typeof asset === "object"
    && typeof asset.id === "string"
    && typeof asset.module === "string"
    && asset.module.startsWith("/web-packages/")
    && Array.isArray(asset.styles)
    && asset.styles.every((style) =>
      typeof style === "string" && style.startsWith("/web-packages/"));
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
  const response = await fetchImpl("/web-packages/manifest.json");
  if (!response.ok) {
    throw new Error(`web package manifest failed: HTTP ${response.status}`);
  }
  const parsed = await response.json() as Partial<WebPackageManifest>;
  if (!Array.isArray(parsed.packages) || !parsed.packages.every(validAsset)) {
    throw new Error("web package manifest is invalid");
  }

  const installers = new Map<string, WebPackageInstaller>();
  for (const asset of parsed.packages) {
    installStyles(asset, options.document ?? globalThis.document);
    const loaded = await importModule(asset.module) as { default?: unknown };
    if (typeof loaded.default !== "function") {
      throw new Error(`web entry for "${asset.id}" must default-export a package factory`);
    }
    const installer = (loaded.default as WebPackageEntry)(host);
    if (typeof installer !== "function") {
      throw new Error(`web entry for "${asset.id}" must return an installer`);
    }
    installers.set(asset.id, installer);
  }
  return installers;
}
