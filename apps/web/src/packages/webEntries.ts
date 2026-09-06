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

export interface PackageActivationHandle {
  dispose(): void;
}

export interface ActivateWebPackageOptions extends WebEntryLoaderOptions {
  createActivation: (ownerPackageId: string) => {
    host: WebPackageHost;
    dispose(): void;
  };
  isCurrent: () => boolean;
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

/** Cheap metadata only. Does not import modules, run factories, or attach CSS. */
export async function loadWebPackageCatalog(
  options: WebEntryLoaderOptions = {},
): Promise<WebPackageAsset[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl("/packages-manifest.json");
  if (!response.ok) {
    throw new Error(`web package manifest failed: HTTP ${response.status}`);
  }
  const parsed = await response.json() as Partial<WebPackageManifest>;
  if (!Array.isArray(parsed.packages) || !parsed.packages.every(validAsset)) {
    throw new Error("web package manifest is invalid");
  }
  return parsed.packages;
}

/** Attach stylesheet links owned by this activation. The disposer removes
 *  exactly those link elements, never another activation's. */
export function attachPackageStyles(
  asset: WebPackageAsset,
  documentRef: Document | undefined,
): () => void {
  if (!documentRef) return () => undefined;
  const links: HTMLLinkElement[] = [];
  for (const href of asset.styles) {
    const link = documentRef.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.polythWebPackageStyle = `${asset.id}:${href}`;
    documentRef.head.appendChild(link);
    links.push(link);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const link of links) link.remove();
  };
}

/**
 * Activate one enabled package: attach CSS, import the module, create an
 * activation scope, invoke factory then installer, publish contributions.
 * Cancelled or failed attempts dispose any partial CSS and registrations.
 */
export async function activateWebPackage(
  asset: WebPackageAsset,
  options: ActivateWebPackageOptions,
): Promise<PackageActivationHandle> {
  const importModule = options.importModule
    ?? ((url: string) => import(url) as Promise<unknown>);
  const documentRef = options.document ?? globalThis.document;
  const empty: PackageActivationHandle = { dispose() {} };

  if (!options.isCurrent()) return empty;

  const detachStyles = attachPackageStyles(asset, documentRef);
  let scope: { host: WebPackageHost; dispose(): void } | null = null;
  let cleanup: (() => void) | undefined;

  const dispose = (): void => {
    cleanup?.();
    cleanup = undefined;
    scope?.dispose();
    scope = null;
    detachStyles();
  };

  try {
    if (!options.isCurrent()) {
      dispose();
      return empty;
    }
    const loaded = await importModule(asset.module) as { default?: unknown };
    if (!options.isCurrent()) {
      dispose();
      return empty;
    }
    if (typeof loaded.default !== "function") {
      throw new Error(`web entry for "${asset.id}" must default-export a package factory`);
    }
    scope = options.createActivation(asset.id);
    const installer = (loaded.default as WebPackageEntry)(scope.host);
    if (typeof installer !== "function") {
      throw new Error(`web entry for "${asset.id}" must return an installer`);
    }
    if (!options.isCurrent()) {
      dispose();
      return empty;
    }
    const returned = installer() as WebPackageInstaller | void;
    cleanup = typeof returned === "function" ? returned : undefined;
    if (!options.isCurrent()) {
      dispose();
      return empty;
    }
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
