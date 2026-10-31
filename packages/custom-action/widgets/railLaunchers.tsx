// Every action is also a launcher of its own: a `command` capability with the
// action's glyph, so it sits on any rail (top, header, right, sidebar,
// composer, status bar) and in search exactly like a package icon. A press
// runs the action in the active project without opening or closing a pane,
// and its result floats in a short-lived card (ResultCards.tsx); a Terminal
// action opens its Terminal tab instead.
//
// A launcher is opt-in: a new action waits under Technical (searchable, one
// click away in the rail editor) until the person adds it to the right rail
// from its menu (`setOnRail`). Actions that predate that rule keep their old
// right-rail default through `legacyStandardTier`, so nothing in place moves.
import { createElement, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import type { CapabilityDefinition, WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { actionAvailableIn, type CustomActionDto } from "../src/actionModel.ts";
import { glyphFor } from "./icons.ts";
import { getSnapshot, showCard, startAction, subscribe, useActions } from "./store.ts";
import { tileIsTransient, tileView, type TileState } from "./tileState.ts";
import { useNow } from "./time.ts";

const PREFIX = "custom-action.run.";
/** Right after the Custom actions window's own launcher. */
const BASE_RANK = 24;

export const actionCapabilityId = (actionId: string): string => `${PREFIX}${actionId}`;

type MarkProps = { size?: number; strokeWidth?: number; "aria-hidden"?: boolean };

function useActiveProjectId(host: WebPackageHost): string | null {
  const read = () => host.store.getSnapshot().activeProjectId;
  return useSyncExternalStore(host.store.subscribe, read, read);
}

const BADGE: Partial<Record<TileState, "busy" | "success" | "danger">> = {
  starting: "busy",
  running: "busy",
  chat: "busy",
  done: "success",
  opened: "success",
  failed: "danger",
};

/** The glyph itself is the mark (rails size it as their direct `svg`
 *  child); the run state is a dot drawn inside the same SVG. */
function ActionMark({ host, actionId, size = 15, strokeWidth = 1.8 }: MarkProps & { host: WebPackageHost; actionId: string }) {
  const snapshot = useActions();
  const projectId = useActiveProjectId(host);
  const transient = tileIsTransient(tileView(snapshot, actionId, projectId, Date.now()));
  const now = useNow(transient);
  const action = snapshot.actions.find((item) => item.id === actionId);
  const badge = BADGE[tileView(snapshot, actionId, projectId, now).state];
  return createElement(
    glyphFor(action?.icon),
    { size, strokeWidth, "aria-hidden": true, className: "ca-rail-mark" },
    badge ? createElement("circle", { className: "ca-rail-mark-badge", "data-tone": badge, cx: 19.5, cy: 4.5, r: 4 }) : null,
  );
}

/** Press from a rail: the same rules as a tile, with a result card standing
 *  in for the tile's run sheet. */
export function pressFromRail(host: WebPackageHost, actionId: string): void {
  const snapshot = getSnapshot();
  const action = snapshot.actions.find((item) => item.id === actionId);
  if (!action) return;
  const state = host.store.getSnapshot();
  const projectId = state.activeProjectId;
  if (!projectId || !actionAvailableIn(action, projectId)) {
    host.errors.show?.(tr("customaction.chooseProjectFirst"), undefined, { kind: "warning" });
    return;
  }
  const view = tileView(snapshot, action.id, projectId, Date.now());
  if (view.run && (view.state === "running" || view.state === "chat" || (view.state === "failed" && !view.launch))) {
    showCard(view.run.id);
    return;
  }
  if (view.state === "starting") return;
  void startAction(action, { projectId, sessionId: state.activeSessionId }, { card: true }).catch((cause) => {
    host.errors.show?.(host.errors.friendly(tr("customaction.error.start", { name: action.name }), cause));
  });
}

/** What a registered launcher shows; a change re-registers it. */
const signature = (action: CustomActionDto, index: number): string =>
  JSON.stringify([action.name, action.projectId, index]);

function definition(host: WebPackageHost, action: CustomActionDto, index: number, mark: ComponentType<MarkProps>): CapabilityDefinition {
  return {
    id: actionCapabilityId(action.id),
    kind: "command",
    icon: mark,
    label: action.name,
    plainDescription: tr("customaction.launcher.description", { name: action.name }),
    keywords: [action.name, "custom action", "action", "run", "command"],
    // Opt-in: a new action waits under Technical until added to a rail. Actions
    // that predate the rule were on the right rail (More); the host keeps them
    // there for projects that already saw them (`legacyStandardTier`).
    standardTier: "technical",
    legacyStandardTier: "more",
    standardRank: BASE_RANK + (index + 1) / 1_000,
    // The capability's generated `capability:<id>` widget is what carries it
    // into the other icon rows (header, sidebar, composer, status bar).
    open: () => pressFromRail(host, action.id),
    available: () => {
      const { canRun, actions } = getSnapshot();
      const current = actions.find((item) => item.id === action.id);
      return canRun && !!current && actionAvailableIn(current, host.store.getSnapshot().activeProjectId);
    },
  };
}

/** Keep one launcher per action in the library. Returns the disposer. */
export function installActionLaunchers(host: WebPackageHost): () => void {
  const registered = new Map<string, { signature: string; dispose: () => void }>();
  const marks = new Map<string, ComponentType<MarkProps>>();
  const markFor = (actionId: string): ComponentType<MarkProps> => {
    let mark = marks.get(actionId);
    if (!mark) {
      mark = (props: MarkProps) => createElement(ActionMark, { ...props, host, actionId });
      marks.set(actionId, mark);
    }
    return mark;
  };
  let canRun = getSnapshot().canRun;

  const sync = () => {
    const { actions } = getSnapshot();
    const wanted = new Set(actions.map((action) => action.id));
    for (const [id, entry] of [...registered]) {
      if (wanted.has(id)) continue;
      entry.dispose();
      registered.delete(id);
      marks.delete(id);
    }
    actions.forEach((action, index) => {
      const next = signature(action, index);
      const entry = registered.get(action.id);
      if (entry?.signature === next) return;
      // Same id, same owner: the new descriptor replaces the old in place, so
      // the launcher keeps its placement; the old disposer is then a no-op.
      const dispose = host.capabilities.register(definition(host, action, index, markFor(action.id)));
      registered.set(action.id, { signature: next, dispose });
      entry?.dispose();
    });
    if (getSnapshot().canRun !== canRun) {
      canRun = getSnapshot().canRun;
      host.capabilities.notify();
    }
  };

  // `available()` follows the active project.
  let projectId = host.store.getSnapshot().activeProjectId;
  const offStore = host.store.subscribe(() => {
    const next = host.store.getSnapshot().activeProjectId;
    if (next === projectId) return;
    projectId = next;
    host.capabilities.notify();
  });
  const offActions = subscribe(sync);
  sync();

  return () => {
    offActions();
    offStore();
    for (const entry of registered.values()) entry.dispose();
    registered.clear();
    marks.clear();
  };
}

/** Whether an action's launcher has a rail home in the active project;
 *  `null` when the host offers no placement seam (or the launcher is unknown). */
export function railState(host: WebPackageHost, actionId: string): boolean | null {
  return host.capabilities?.placement?.(actionCapabilityId(actionId))?.onRail ?? null;
}

/** Put an action's launcher on the right rail, or take it off every rail. */
export function setOnRail(host: WebPackageHost, actionId: string, on: boolean): void {
  host.capabilities?.place?.(actionCapabilityId(actionId), on ? "more" : "technical");
}

/** The notification id that confirms a new action. */
export const createdNotificationId = (actionId: string): string => `created.${actionId}`;

/**
 * Confirm a new action through the host stack, with the one rail step that
 * fits: undo the placement the editor just made, or offer it when the editor
 * left it off and the action can run in the open project. Silent on hosts
 * without the shared stack.
 */
export function announceCreated(
  host: WebPackageHost,
  action: Pick<CustomActionDto, "id" | "name">,
  rail: { placed: boolean; canPlace: boolean },
): void {
  const notifications = host.notifications;
  if (!notifications) return;
  notifications.show({
    id: createdNotificationId(action.id),
    kind: "success",
    title: tr("customaction.created.title", { name: action.name }),
    ...(rail.placed ? { body: tr("customaction.created.onRail") } : {}),
    ...(rail.placed
      ? { actions: [{ label: tr("customaction.created.removeFromRail"), run: () => setOnRail(host, action.id, false) }] }
      : rail.canPlace
        ? { actions: [{ label: tr("customaction.created.addToRail"), run: () => setOnRail(host, action.id, true) }] }
        : {}),
  });
}

/** Re-render when any launcher's rail placement changes. */
export function useRailPlacementVersion(host: WebPackageHost | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => host?.capabilities?.subscribePlacement?.(() => setVersion((value) => value + 1)), [host]);
  return version;
}
