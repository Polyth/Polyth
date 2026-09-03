import { Icon } from "./icons.tsx";
import type { JSX } from "react";
import type { WidgetDef } from "./widgets/catalog.ts";

/**
 * Canonical icon vocabulary for every built-in item that can appear in the
 * workspace rail. Keeping this mapping in one place makes accidental reuse
 * visible and gives capability-only launchers the same icon as their surface.
 */
export const RAIL_ICONS = {
  session: Icon.chat,
  files: Icon.files,
  git: Icon.tree,
  terminal: Icon.term,
  browser: Icon.globe,
  goals: Icon.target,
  multirun: Icon.compare,
  workflow: Icon.hierarchy,
  fusion: Icon.fuse,
  walkthrough: Icon.select,
  schedule: Icon.clock,
  usage: Icon.usage,
  github: Icon.github,
  knowledge: Icon.book,
  context: Icon.context,
  voice: Icon.mic,
  "models-agents": Icon.gear,
  events: Icon.events,
  diagnostics: Icon.shield,
  tracks: Icon.plan,
  "notification-centre": Icon.bell,
} as const;

export type RailIcon = () => JSX.Element;

/** Extensions without an icon get a neutral plugin glyph, not Context's
 * semantic gauge. Extension authors should still provide a distinct icon. */
export function railIconFor(id: string): RailIcon {
  return RAIL_ICONS[id as keyof typeof RAIL_ICONS] ?? Icon.puzzle;
}

/** Widget pickers use the same domain mark as panels and launchers. */
export function widgetIconFor(widget: Pick<WidgetDef, "id" | "pluginId" | "capabilities">): RailIcon {
  if (widget.id === "composer.agent") return Icon.session;
  if (widget.id === "composer.effort") return Icon.brain;
  const candidates = [...(widget.capabilities ?? []), widget.id, widget.pluginId, widget.id.split(".")[0] ?? ""];
  return candidates.map((id) => RAIL_ICONS[id as keyof typeof RAIL_ICONS]).find(Boolean) ?? Icon.widgets;
}
