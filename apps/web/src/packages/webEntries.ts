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
  /** Merge the host's `/api/package-assets` mirror into the catalog.
   *  Default: only on a Polyth Link loopback origin. */
  viaHostApi?: boolean;
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

/** The native app's WebView sits on the Link proxy's loopback origin
 *  (`http://127.0.0.1:<port>`), whose non-/api paths are answered from the
 *  bundle inside the app. The mobile sync step copies the web build's packages
 *  next to the shell (`apps/mobile/scripts/bundle-package-assets.mjs`), so the
 *  bundled `/packages-manifest.json` and `/packages/*` are one build with the
 *  bundled `/shell-api/*` they import. Packages only the host has (installed
 *  after the app was built, or newer) are read through the authenticated
 *  `/api/package-assets` mirror, which is the only path the proxy forwards. */
const onLinkLoopbackOrigin = (): boolean => {
  const location = (globalThis as { location?: { protocol?: string; hostname?: string } }).location;
  return location?.protocol === "http:" && location.hostname === "127.0.0.1";
};

const HOST_API_ASSETS = "/api/package-assets/";
const viaHostApi = (options: WebEntryLoaderOptions): boolean =>
  options.viaHostApi ?? onLinkLoopbackOrigin();
const hostApiUrl = (url: string): string => url.replace(/^\/packages\//, HOST_API_ASSETS);

async function fetchManifest(fetchImpl: typeof fetch, url: string): Promise<WebPackageAsset[]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`web package manifest failed: HTTP ${response.status}`);
  }
  const parsed = await response.json() as Partial<WebPackageManifest>;
  if (!Array.isArray(parsed.packages) || !parsed.packages.every(validAsset)) {
    throw new Error("web package manifest is invalid");
  }
  return parsed.packages;
}

/** Bundled packages keep their bundled URLs; packages only the host lists load
 *  through the mirror. A failed mirror (an older host) or a failed bundled
 *  manifest never empties the catalog while the other is available. */
export function mergePackageCatalogs(
  bundled: WebPackageAsset[] | Error,
  mirrored: WebPackageAsset[] | Error,
): WebPackageAsset[] {
  const mirror = Array.isArray(mirrored)
    ? mirrored.map((asset) => ({ ...asset, module: hostApiUrl(asset.module), styles: asset.styles.map(hostApiUrl) }))
    : [];
  if (!Array.isArray(bundled)) {
    if (mirror.length === 0 && mirrored instanceof Error) throw bundled;
    return mirror;
  }
  const known = new Set(bundled.map((asset) => asset.id));
  return [...bundled, ...mirror.filter((asset) => !known.has(asset.id))];
}

/** Cheap metadata only. Does not import modules, run factories, or attach CSS. */
export async function loadWebPackageCatalog(
  options: WebEntryLoaderOptions = {},
): Promise<WebPackageAsset[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!viaHostApi(options)) return fetchManifest(fetchImpl, "/packages-manifest.json");
  const attempt = (url: string) => fetchManifest(fetchImpl, url).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)));
  const [bundled, mirrored] = await Promise.all([
    attempt("/packages-manifest.json"),
    attempt(`${HOST_API_ASSETS}manifest`),
  ]);
  return mergePackageCatalogs(bundled, mirrored);
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
