import { useSyncExternalStore } from "react";

const LAST_PACKAGE_KEY = "polyth.mobileWorkspace.lastPackage";

export interface MobileWorkspaceNavigationSnapshot {
  /** The root Workspace menu is currently visible. */
  homeOpen: boolean;
  /** Last package visited without navigating Back to Workspace. */
  lastPackageId: string | null;
}

const SERVER_SNAPSHOT: MobileWorkspaceNavigationSnapshot = {
  homeOpen: false,
  lastPackageId: null,
};

function loadLastPackage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_PACKAGE_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

let snapshot: MobileWorkspaceNavigationSnapshot = {
  homeOpen: false,
  lastPackageId: loadLastPackage(),
};
const listeners = new Set<() => void>();

function publish(next: MobileWorkspaceNavigationSnapshot): void {
  if (next.homeOpen === snapshot.homeOpen && next.lastPackageId === snapshot.lastPackageId) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function persistLastPackage(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(LAST_PACKAGE_KEY, id);
    else window.localStorage.removeItem(LAST_PACKAGE_KEY);
  } catch {
    // Browser-only navigation preference; private/full storage is non-fatal.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMobileWorkspaceNavigationSnapshot(): MobileWorkspaceNavigationSnapshot {
  return snapshot;
}

export function useMobileWorkspaceNavigation(): MobileWorkspaceNavigationSnapshot {
  return useSyncExternalStore(subscribe, getMobileWorkspaceNavigationSnapshot, () => SERVER_SNAPSHOT);
}

/** Opening a package makes it the mobile Workspace resume target. */
export function rememberMobileWorkspacePackage(id: string): void {
  if (!id) return;
  persistLastPackage(id);
  publish({ homeOpen: false, lastPackageId: id });
}

/** Back is navigation, not dismissal: return to Workspace and make it current. */
export function showMobileWorkspaceHome(): void {
  persistLastPackage(null);
  publish({ homeOpen: true, lastPackageId: null });
}

/** Dismiss Workspace without changing where the user last navigated. */
export function hideMobileWorkspaceHome(): void {
  if (!snapshot.homeOpen) return;
  publish({ ...snapshot, homeOpen: false });
}
