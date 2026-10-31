// The board's items on the new-chat screen: catalog widgets the person added
// from Customize, laid out as tiles of the hero grid next to the built-ins.
// Widgets an older client placed in the project's own layout are adopted here
// as items of that project, so the screen has one store and one order.
import { useEffect } from "react";
import type { JsonObject } from "@polyth/contracts";
import { useHeroArranging } from "../../heroEditing.ts";
import { useNewChatModel } from "../../composer/newChatModel.ts";
import { adoptLegacyHeroPlacements, heroItemsFor, updateHeroBoard, updateHeroBoardItem } from "../../heroBoard.ts";
import { presentationScopeId } from "../../projectInterfaceScope.ts";
import { getState } from "../../store.ts";
import { useWidgetCatalog, widgetIsAvailable } from "../../widgets/catalog.ts";
import {
  setWidgetVisible,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
} from "../../widgets/widgetLayout.ts";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { HeroWidget, useHeroBoard } from "./HeroWidgets.tsx";

export const HERO_SLOT = "session.empty.widgets";

/** Move visible `session.empty.widgets` placements of the active layout onto
 *  the board, then hide them there so nothing renders twice. */
function useAdoptLegacyPlacements(projectId: string | null): void {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  useEffect(() => {
    // The layout store follows the active project; never adopt another's.
    if (!projectId || getState().activeProjectId !== projectId) return;
    const byId = new Map(widgets.map((widget) => [widget.id, widget]));
    const placements = (layout.slotPlacements[HERO_SLOT] ?? []).flatMap((instanceId) => {
      const placement = layout.widgets[instanceId];
      const widget = byId.get(widgetDefinitionId(layout, instanceId));
      return placement?.visible && widget ? [{ instanceId, widget, config: placement.config ?? {} }] : [];
    });
    if (placements.length === 0) return;
    // A layout every project shares made the widget show everywhere.
    const scoped = presentationScopeId(projectId) === projectId ? projectId : undefined;
    updateHeroBoard((board) => adoptLegacyHeroPlacements(board, placements, scoped));
    updateWidgetLayout((current) => placements.reduce(
      (next, { instanceId }) => setWidgetVisible(next, instanceId, false), current));
  }, [projectId, widgets, layout]);
}

export function HeroBoardItems({ projectId }: { projectId: string | null }) {
  useAdoptLegacyPlacements(projectId);
  const board = useHeroBoard();
  const widgets = useWidgetCatalog();
  const editing = useHeroArranging();
  const composerModel = useNewChatModel();
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  return heroItemsFor(board, projectId).map((item) => {
    const widget = byId.get(item.widget);
    // A package that is not loaded keeps its item; it returns with the package.
    if (!widget) return null;
    const context = { projectId, sessionId: null, config: item.config, ...(composerModel ? { composerModel } : {}) };
    if (!editing && !widgetIsAvailable(widget, context)) return null;
    return (
      <HeroWidget key={item.id} id={item.id} size={item.size} title={widget.title}>
        <ViewErrorBoundary inline resetKey={`${item.id}:${projectId ?? ""}`}>
          {widget.render({
            ...context,
            editing,
            instanceId: item.id,
            panelSize: item.size,
            updateConfig: (config: JsonObject) => updateHeroBoard((current) => updateHeroBoardItem(current, item.id, { config })),
          })}
        </ViewErrorBoundary>
      </HeroWidget>
    );
  });
}
