import { Component, createElement, type ComponentType, type JSX, type ReactNode } from "react";
import type { WidgetDef } from "./widgets/catalog.ts";
import { capabilityIcon } from "./capabilities.ts";
import type { LucideIcon } from "./components/ui/icons.ts";
import {
  AddIcon,
  AssistIcon,
  BellIcon,
  BotIcon,
  BranchIcon,
  ChartIcon,
  ChatIcon,
  ClockIcon,
  CoachIcon,
  CombineIcon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  DocsIcon,
  EditIcon,
  FileDiffIcon,
  FileIcon,
  FindInTextIcon,
  FolderIcon,
  GithubIcon,
  GitlabIcon,
  GlobeIcon,
  GoogleIcon,
  HistoryIcon,
  ImageIcon,
  InfrastructureIcon,
  LayersIcon,
  MicIcon,
  MonitoringIcon,
  VoiceModeIcon,
  PackageIcon,
  PlaygroundIcon,
  CreativeStudioIcon,
  PluginIcon,
  QrCodeIcon,
  RecapIcon,
  RouteIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  TargetIcon,
  TasksIcon,
  TerminalIcon,
  UsageIcon,
  WebSearchIcon,
  WorkflowIcon,
  ZapIcon,
} from "./components/ui/icons.ts";

export type RailIcon = () => JSX.Element;

const glyph = (Glyph: LucideIcon): RailIcon => () => createElement(Glyph, {
  size: 15,
  strokeWidth: 1.8,
  "aria-hidden": true,
});

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
  schedule: glyph(BotIcon),
  usage: glyph(UsageIcon),
  github: glyph(GithubIcon),
  knowledge: glyph(DocsIcon),
  context: glyph(DatabaseIcon),
  voice: glyph(MicIcon),
  "voice-mode": glyph(VoiceModeIcon),
  "models-agents": glyph(CpuIcon),
  "workspace-edit": glyph(EditIcon),
  events: glyph(HistoryIcon),
  // Extension diagnostics opens the package library; the shield belongs to permissions.
  diagnostics: glyph(PluginIcon),
  permissions: glyph(ShieldIcon),
  tracks: glyph(TasksIcon),
  "notification-centre": glyph(BellIcon),
  gitlab: glyph(GitlabIcon),
  "workspace-search": glyph(SearchIcon),
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
  // Polyth Link (pair a phone / remote access) registers as `tunnel`.
  tunnel: glyph(QrCodeIcon),
  "task-trackers": glyph(TasksIcon),
  "personal-coach": glyph(CoachIcon),
  monitoring: glyph(MonitoringIcon),
  docker: glyph(ContainerIcon),
  terraform: glyph(InfrastructureIcon),
  google: glyph(GoogleIcon),
  "web-search": glyph(WebSearchIcon),
  playground: glyph(PlaygroundIcon),
  "creative-studio": glyph(CreativeStudioIcon),
  "custom-action": glyph(ZapIcon),
  gallery: glyph(ImageIcon),
  recap: glyph(RecapIcon),
  // Find-in-conversation: the capability and its widget plugin.
  "conversation-find": glyph(FindInTextIcon),
  conversation: glyph(FindInTextIcon),
  // Server connection status widget (widgets/systemWidgets.tsx).
  system: glyph(ServerIcon),
  // Built-in shell actions (widgets/builtinMiniWidgets.tsx), resolved by widget id.
  "shell.search": glyph(SearchIcon),
  "shell.history": glyph(ClockIcon),
  "shell.settings": glyph(SettingsIcon),
  "shell.add-project": glyph(AddIcon),
  // Status-bar segments (widgets/statusbarWidgets.tsx), resolved by widget id.
  "statusbar.project": glyph(FolderIcon),
  "statusbar.branch": glyph(BranchIcon),
  "statusbar.editor": glyph(FileIcon),
  "statusbar.changes": glyph(FileDiffIcon),
  "statusbar.model": glyph(CpuIcon),
  "statusbar.agent": glyph(AssistIcon),
  "statusbar.workflow": glyph(WorkflowIcon),
  "statusbar.view": glyph(ChatIcon),
};

/** A package mark that throws must not take the rail down with it. */
class PackageMarkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? createElement(WidgetFallbackGlyph) : this.props.children;
  }
}

/** Marks supplied at runtime by managed plugins (`export const icon`), keyed by
 *  package id. They render with the same size/stroke as the host vocabulary. */
const packageIcons = new Map<string, RailIcon>();

export function registerPackageIcon(packageId: string, Mark: ComponentType<Record<string, unknown>>): () => void {
  const icon: RailIcon = () => createElement(PackageMarkBoundary, null, createElement(Mark, {
    size: 15,
    strokeWidth: 1.8,
    "aria-hidden": true,
  }));
  packageIcons.set(packageId, icon);
  return () => {
    if (packageIcons.get(packageId) === icon) packageIcons.delete(packageId);
  };
}

/** One stable RailIcon per capability mark, so a re-render never remounts it. */
const capabilityMarks = new WeakMap<ComponentType<Record<string, unknown>>, RailIcon>();

function capabilityMark(id: string): RailIcon | undefined {
  const Mark = capabilityIcon(id) as ComponentType<Record<string, unknown>> | undefined;
  if (!Mark) return undefined;
  let icon = capabilityMarks.get(Mark);
  if (!icon) {
    icon = () => createElement(PackageMarkBoundary, null, createElement(Mark, {
      size: 15,
      strokeWidth: 1.8,
      "aria-hidden": true,
    }));
    capabilityMarks.set(Mark, icon);
  }
  return icon;
}

const iconOf = (id: string): RailIcon | undefined => capabilityMark(id) ?? RAIL_ICONS[id] ?? packageIcons.get(id);

/** Every exact id first, then each id's package (`slot:` bridge prefix and
 *  `.sub` suffix stripped), so every page of a package shares its mark. */
export function railIconMatch(ids: readonly (string | undefined)[]): RailIcon | undefined {
  const bare = ids.filter((id): id is string => !!id)
    .map((id) => id.startsWith("slot:") ? id.slice("slot:".length) : id);
  for (const id of bare) {
    const icon = iconOf(id);
    if (icon) return icon;
  }
  for (const id of bare) {
    const icon = iconOf(id.split(".")[0] ?? "");
    if (icon) return icon;
  }
  return undefined;
}

/** Extensions without an icon get a neutral monochrome package glyph. */
export function railIconFor(id: string): RailIcon {
  return railIconMatch([id]) ?? WidgetFallbackGlyph;
}

/** Widget pickers use the same domain mark as panels and launchers. */
export function widgetIconFor(widget: Pick<WidgetDef, "id" | "pluginId" | "capabilities">): RailIcon {
  return railIconMatch([...(widget.capabilities ?? []), widget.id, widget.pluginId]) ?? WidgetFallbackGlyph;
}
