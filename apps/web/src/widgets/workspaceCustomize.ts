import type { WidgetDef } from "./catalog.ts";
import type {
  WidgetAudience,
  WidgetLayoutMutation,
  WidgetZone,
} from "./widgetLayout.ts";
import { tr } from "../i18n/index.ts";

export interface WorkspaceCustomizePlan {
  mutations: WidgetLayoutMutation[];
  density?: "comfortable" | "balanced" | "compact";
  message: string;
}

const ZONE_TERMS: Array<[WidgetZone, readonly string[]]> = [
  ["header", ["header", "top"]],
  ["left", ["left"]],
  ["main", ["main", "center"]],
  ["right", ["right"]],
  ["bottom", ["bottom"]],
  ["floating", ["floating", "float"]],
];

function findWidget(widgets: readonly WidgetDef[], text: string): WidgetDef | undefined {
  const normalized = text.trim().toLowerCase();
  return widgets.find((widget) =>
    `${widget.id} ${widget.title} ${widget.description}`.toLowerCase().includes(normalized));
}

export function planWorkspaceCustomization(
  request: string,
  widgets: readonly WidgetDef[],
): WorkspaceCustomizePlan {
  const text = request.trim().toLowerCase();
  if (!text) {
    return {
      mutations: [],
      message: tr("widgets.workspacecustomize.describeOneOrMoreWorkspaceChanges"),
    };
  }
  const mutations: WidgetLayoutMutation[] = [];

  const audience = (["simple", "standard", "power"] as const).find((value) => text.includes(value));
  if (audience) mutations.push({ type: "audience", audience: audience as WidgetAudience });

  const visibility = text.match(/\b(hide|show|add|remove)\s+([\w /&-]+)/);
  const target = visibility?.[2]
    ?.split(/\b(?:in|to|from|and|with)\b/)[0]
    ?.trim();
  const widget = target ? findWidget(widgets, target) : undefined;
  if (visibility && widget) {
    mutations.push({
      type: "visibility",
      id: widget.id,
      visible: visibility[1] === "show" || visibility[1] === "add",
    });
  }

  const move = text.match(/\bmove\s+([\w /&-]+?)\s+(?:to|into)\s+(?:the\s+)?([\w-]+)/);
  const movedWidget = move?.[1] ? findWidget(widgets, move[1]) : undefined;
  const zone = move?.[2]
    ? ZONE_TERMS.find(([, terms]) => terms.includes(move[2]!.toLowerCase()))?.[0]
    : undefined;
  if (movedWidget && zone) mutations.push({ type: "move", id: movedWidget.id, zone });

  const density = text.includes("compact")
    ? "compact"
    : text.includes("comfortable")
      ? "comfortable"
      : undefined;
  const count = mutations.length + (density ? 1 : 0);
  return {
    mutations,
    ...(density ? { density } : {}),
    message: count > 0
      ? tr("widgets.workspacecustomize.workspaceChangesReady", { count })
      : tr("widgets.workspacecustomize.tryCustomizationExamples"),
  };
}
