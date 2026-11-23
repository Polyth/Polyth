// One-shot hand-over of an install link (`/?settings=packages&install=<source>`)
// from boot to Settings → Packages. The page passes it to its
// `settings.packages.content` contributions as `packagesInstallRequest`; the
// library opens its installer prefilled and clears it. Only the newest request
// is kept, and nothing installs without the person confirming in the dialog.

export const PACKAGES_INSTALL_REQUEST_EVENT = "polyth:packages-install-request";

let pending: string | null = null;

export function requestPackageInstall(source: string): void {
  pending = source;
  if (typeof window !== "undefined") window.dispatchEvent(new window.Event(PACKAGES_INSTALL_REQUEST_EVENT));
}

export function pendingPackageInstall(): string | null {
  return pending;
}

export function clearPackageInstall(): void {
  pending = null;
}
