// Package windows as new-chat shortcuts. Every placeable capability with a
// registered window (the same destinations the right rail opens) can be
// pinned into the Shortcuts row; its chip opens that window instead of
// inserting a prompt. The capability registry stays the one source of truth,
// so a package that unloads or stops being relevant drops out of the picker
// and its pinned chip stops resolving until it returns.
import { getCapability, type ResolvedCapability, useResolvedCapabilities } from "./capabilities.ts";
import { placeableCapabilities, railDestinationIds } from "./railPlacement.ts";
import { useSurfaceVersion } from "./surfaces.ts";
import type { StarterPackage } from "./starters.ts";

/** Edit workspace is a mode with a rail destination, not a window. */
const NOT_A_WINDOW = new Set(["workspace-edit"]);

/** Pure: launchable capabilities that open a window, in resolved order. */
export function windowPackages(
  resolved: readonly ResolvedCapability[],
  destinations: ReadonlySet<string>,
): StarterPackage[] {
  return placeableCapabilities(resolved)
    .filter(({ descriptor }) => destinations.has(descriptor.id) && !NOT_A_WINDOW.has(descriptor.id))
    .map(({ descriptor }) => ({
      id: descriptor.id,
      label: descriptor.label,
      ...(descriptor.plainDescription ? { description: descriptor.plainDescription } : {}),
    }));
}

/** React view: re-reads as packages register windows and capabilities. */
export function useWindowPackages(): StarterPackage[] {
  const resolved = useResolvedCapabilities();
  useSurfaceVersion();
  return windowPackages(resolved, railDestinationIds());
}

/** Open a package shortcut's window. False when it is not available now. */
export function openPackageWindow(capabilityId: string): boolean {
  const capability = getCapability(capabilityId);
  if (!capability || !capability.available()) return false;
  capability.open();
  return true;
}
