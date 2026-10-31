import type { PackagesPageMatches, PackagesPageSlotContext } from "@polyth/web-sdk";

/** Contribution id of the library in `settings.packages.content`; the host
 *  keys this contribution's reported matches and detail state by it. */
export const LIBRARY_OWNER = "plugins.package-library";

const noop = (): void => {};

/** Reads the host's Settings → Packages context defensively: a host that does
 *  not provide it (or an older one) gets an unfiltered, standalone library. */
export function readPackagesContext(raw: Readonly<Record<string, unknown>>): PackagesPageSlotContext {
  const status = raw.packagesStatus;
  return {
    packagesQuery: typeof raw.packagesQuery === "string" ? raw.packagesQuery : "",
    packagesStatus: status === "enabled" || status === "disabled" ? status : "all",
    packagesCategory: typeof raw.packagesCategory === "string" ? raw.packagesCategory : null,
    reportPackageMatches: typeof raw.reportPackageMatches === "function"
      ? raw.reportPackageMatches as (owner: string, matches: PackagesPageMatches) => void
      : noop,
    setPackageDetailOpen: typeof raw.setPackageDetailOpen === "function"
      ? raw.setPackageDetailOpen as (owner: string, open: boolean) => void
      : noop,
  };
}
