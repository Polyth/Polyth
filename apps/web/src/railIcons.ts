import { createElement, type JSX } from "react";
import type { WidgetDef } from "./widgets/catalog.ts";
import type { LucideIcon } from "./components/ui/icons.ts";
import {
  BellIcon,
  BrainIcon,
  BranchIcon,
  ChartIcon,
  ChatIcon,
  CombineIcon,
  CompassIcon,
  CpuIcon,
  DatabaseIcon,
  DocsIcon,
  FolderIcon,
  GithubIcon,
  GitlabIcon,
  GlobeIcon,
  HistoryIcon,
  LayersIcon,
  MicIcon,
  PackageIcon,
  QrCodeIcon,
  RouteIcon,
  ScheduleIcon,
  SessionIcon,
  ShieldIcon,
  TargetIcon,
  TasksIcon,
  TerminalIcon,
  UsageIcon,
  WorkflowIcon,
} from "./components/ui/icons.ts";

export type RailIcon = () => JSX.Element;

const glyph = (Glyph: LucideIcon): RailIcon => () => createElement(Glyph, {
  size: 15,
  strokeWidth: 1.8,
  "aria-hidden": true,
});

const AgentGlyph = glyph(SessionIcon);
const EffortGlyph = glyph(BrainIcon);
const WidgetFallbackGlyph = glyph(PackageIcon);

/** Canonical monochrome icon vocabulary for built-in capabilities and package
 * surfaces. Related sub-surfaces intentionally share their package identity. */
export const RAIL_ICONS: Readonly<Record<string, RailIcon>> = {
  session: glyph(ChatIcon),
  files: glyph(FolderIcon),
  git: glyph(BranchIcon),
  terminal: glyph(TerminalIcon),
  browser: glyph(GlobeIcon),
  goals: glyph(TargetIcon),
  multirun: glyph(LayersIcon),
  workflow: glyph(WorkflowIcon),
  fusion: glyph(CombineIcon),
  walkthrough: glyph(RouteIcon),
  schedule: glyph(ScheduleIcon),
  usage: glyph(UsageIcon),
  github: glyph(GithubIcon),
  knowledge: glyph(DocsIcon),
  context: glyph(DatabaseIcon),
  voice: glyph(MicIcon),
  "models-agents": glyph(CpuIcon),
  events: glyph(HistoryIcon),
  diagnostics: glyph(ShieldIcon),
  tracks: glyph(TasksIcon),
  "notification-centre": glyph(BellIcon),
  gitlab: glyph(GitlabIcon),
  "chat-workspace": glyph(ChatIcon),
  markets: glyph(ChartIcon),
  "markets.overview": glyph(ChartIcon),
  "markets.technicals": glyph(ChartIcon),
  "markets.calendar": glyph(ChartIcon),
  "markets.screener": glyph(ChartIcon),
  "markets.heatmap": glyph(ChartIcon),
  "markets.compare": glyph(ChartIcon),
  "markets.portfolio": glyph(ChartIcon),
  "markets.earnings": glyph(ChartIcon),
  "markets.filings": glyph(ChartIcon),
  "polyth-link": glyph(QrCodeIcon),
  "task-trackers": glyph(TasksIcon),
  "personal-coach": glyph(CompassIcon),
};

/** Extensions without an icon get a neutral monochrome package glyph. */
export function railIconFor(id: string): RailIcon {
  return RAIL_ICONS[id] ?? WidgetFallbackGlyph;
}

/** Widget pickers use the same domain mark as panels and launchers. */
export function widgetIconFor(widget: Pick<WidgetDef, "id" | "pluginId" | "capabilities">): RailIcon {
  if (widget.id === "composer.agent") return AgentGlyph;
  if (widget.id === "composer.effort") return EffortGlyph;
  const candidates = [...(widget.capabilities ?? []), widget.id, widget.pluginId, widget.id.split(".")[0] ?? ""];
  return candidates.map((id) => RAIL_ICONS[id]).find(Boolean) ?? WidgetFallbackGlyph;
}
