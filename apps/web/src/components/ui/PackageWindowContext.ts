import { createContext, useContext } from "react";

/** Portals retain React context even though their DOM leaves the window.
 * Marking them lets dynamic-window outside-click handling treat them as owned. */
export const PackageWindowContext = createContext<string | null>(null);

export function usePackageWindowOwner(): string | null {
  return useContext(PackageWindowContext);
}

/** Every launcher (top rail, right rail, placed launcher widgets) marks itself
 * with `data-pane-launcher=<capability id>`. Pressing the launcher of the open
 * window is not an outside click: its own click toggles the window closed. If
 * pointerdown dismissed it first, that click would see it inactive and reopen
 * it. Launcher ids are capability ids, which need not equal the surface id
 * (a package home stays active while one of its pages is open), so callers
 * pass the same active rule the launchers render with. */
export function pathBelongsToPackageWindow(
  path: readonly EventTarget[],
  id: string,
  isActiveLauncher: (launcherId: string) => boolean = (launcherId) => launcherId === id,
): boolean {
  if (isForeignOverlay(path)) return true;
  return path.some((node) => {
    const element = node as EventTarget & {
      getAttribute?: (name: string) => string | null;
      classList?: { contains: (name: string) => boolean };
    };
    const role = element.getAttribute?.("role");
    const launcher = element.getAttribute?.("data-pane-launcher");
    return element.getAttribute?.("data-package-window-owner") === id
      || (typeof launcher === "string" && (launcher === id || isActiveLauncher(launcher)))
      || role === "dialog" || role === "menu" || role === "listbox"
      || element.classList?.contains("dialog-backdrop") === true
      || element.classList?.contains("ui-popover") === true
      || element.classList?.contains("sheet") === true;
  });
}

/** Browser extensions (Grammarly, LanguageTool, password managers) inject
 * their suggestion cards as custom elements straight under `<body>`/`<html>`.
 * Accepting a suggestion edits the window's own field, so pressing one is not
 * an outside click; dismissing on it threw away what the user was typing.
 * Polyth defines no custom elements, so a hyphenated top-level tag is foreign. */
function isForeignOverlay(path: readonly EventTarget[]): boolean {
  const name = (node: EventTarget | undefined) =>
    ((node as { nodeName?: string } | undefined)?.nodeName ?? "").toLowerCase();
  const root = path.findIndex((node) => name(node) === "body" || name(node) === "html");
  return root > 0 && name(path[root - 1]).includes("-");
}
