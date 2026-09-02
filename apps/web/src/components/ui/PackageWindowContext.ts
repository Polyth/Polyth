import { createContext, useContext } from "react";

/** Portals retain React context even though their DOM leaves the window.
 * Marking them lets dynamic-window outside-click handling treat them as owned. */
export const PackageWindowContext = createContext<string | null>(null);

export function usePackageWindowOwner(): string | null {
  return useContext(PackageWindowContext);
}

export function pathBelongsToPackageWindow(path: readonly EventTarget[], id: string): boolean {
  return path.some((node) => {
    const element = node as EventTarget & {
      getAttribute?: (name: string) => string | null;
      classList?: { contains: (name: string) => boolean };
    };
    const role = element.getAttribute?.("role");
    return element.getAttribute?.("data-package-window-owner") === id
      || element.getAttribute?.("data-pane-launcher") === id
      || role === "dialog" || role === "menu" || role === "listbox"
      || element.classList?.contains("dialog-backdrop") === true
      || element.classList?.contains("ui-popover") === true
      || element.classList?.contains("sheet") === true;
  });
}
