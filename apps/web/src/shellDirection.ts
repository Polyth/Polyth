// Mirrored shell ("mirror mode"). A profile may lay the wide shell out in the
// opposite inline direction from the document: the sidebar and its project
// rail at the end edge, the launcher strip and docked windows at the start
// edge. The host does not restyle each region for that. It sets `dir` on
// `.app-shell`, so every frame inherits the flipped direction: flex and grid
// order, logical borders, radii and insets, `:dir()` rules and the
// `--stack-dir` motion sign all mirror together. Each region's content root
// gets the document direction back, so text, inputs and scrollbars read as
// they always do. Frame CSS must therefore be logical (docs/dev/ui.md
// "Mirrored shell"); a physical left/right on a frame does not mirror.
import { useSyncExternalStore } from "react";
import { isRtl, subscribeLocale } from "./i18n/index.ts";

export type InlineDirection = "ltr" | "rtl";

export const flipDirection = (direction: InlineDirection): InlineDirection =>
  direction === "rtl" ? "ltr" : "rtl";

const documentDirection = (): InlineDirection => (isRtl() ? "rtl" : "ltr");

/** The document (locale) direction, re-read when the locale changes. */
export function useDocumentDirection(): InlineDirection {
  return useSyncExternalStore(subscribeLocale, documentDirection, () => "ltr");
}

// App.tsx decides (profile hint + wide shell) and publishes; shell regions
// read it. In-memory presentation only, never persisted.
let mirrored = false;
const listeners = new Set<() => void>();

export function setShellMirrored(next: boolean): void {
  if (next === mirrored) return;
  mirrored = next;
  for (const listener of [...listeners]) listener();
}

export function isShellMirrored(): boolean {
  return mirrored;
}

function subscribeShellMirrored(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ShellDirection {
  mirrored: boolean;
  /** The direction shell frames lay out in. */
  shell: InlineDirection;
  /** `dir` for `.app-shell` and for frame chrome rendered inside a content
   *  root (a resize handle); undefined when the shell is not mirrored. */
  frameDir: InlineDirection | undefined;
  /** `dir` for each region's content root; undefined when not mirrored. */
  contentDir: InlineDirection | undefined;
  /** Physical side of the shell's inline end: where the sidebar's and the
   *  launcher strip's flyouts open toward the content. */
  towardEnd: "left" | "right";
  towardStart: "left" | "right";
}

export function shellDirectionFor(isMirrored: boolean, document: InlineDirection): ShellDirection {
  const shell = isMirrored ? flipDirection(document) : document;
  return {
    mirrored: isMirrored,
    shell,
    frameDir: isMirrored ? shell : undefined,
    contentDir: isMirrored ? document : undefined,
    towardEnd: shell === "rtl" ? "left" : "right",
    towardStart: shell === "rtl" ? "right" : "left",
  };
}

export function useShellDirection(): ShellDirection {
  const isMirrored = useSyncExternalStore(subscribeShellMirrored, isShellMirrored, () => false);
  return shellDirectionFor(isMirrored, useDocumentDirection());
}
