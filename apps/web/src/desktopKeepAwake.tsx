// Desktop keep-awake: tells the desktop main process whether any agent is
// working, and offers the state as a status-bar segment (a coffee cup, green
// while the blocker is held; a click turns keep-awake on or off). Main owns
// the blocker and the decision; this file only reports activity and shows
// what main says. Shells older than keep-awake modes have no activity API, so
// nothing is installed there.
import { useSyncExternalStore } from "react";
import type { DesktopKeepAwakeState, PolythDesktopApi } from "./desktopBridge.ts";
import { tr } from "./i18n/index.ts";
import { getState, subscribeStore } from "./store.ts";
import { CoffeeIcon, Icon } from "./components/ui/index.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./widgets/catalog.ts";

/** Any session this window knows is running a turn. */
export function agentsWorking(sessions: readonly { status?: string }[]): boolean {
  return sessions.some((session) => session.status === "working");
}

let state: DesktopKeepAwakeState | null = null;
const listeners = new Set<() => void>();
const publish = (next: DesktopKeepAwakeState): void => {
  state = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useKeepAwakeState(): DesktopKeepAwakeState | null {
  return useSyncExternalStore(subscribe, () => state, () => null);
}

type KeepAwakeView = "off" | "armed" | "active";

export function keepAwakeView(current: DesktopKeepAwakeState): KeepAwakeView {
  if (current.active) return "active";
  return current.enabled ? "armed" : "off";
}

function keepAwakeTitle(current: DesktopKeepAwakeState): string {
  const view = keepAwakeView(current);
  if (view === "off") return tr("statusbar.keepAwakeOff");
  if (current.mode === "always") return tr("statusbar.keepAwakeAlways");
  return tr(view === "active" ? "statusbar.keepAwakeActive" : "statusbar.keepAwakeArmed");
}

export function KeepAwakeSegment({ api }: { api: Pick<PolythDesktopApi, "setSettings"> }) {
  const current = useKeepAwakeState();
  if (!current) return null;
  const view = keepAwakeView(current);
  const title = keepAwakeTitle(current);
  return (
    <button
      type="button"
      className="sb sb-action sb-keep-awake"
      data-state={view}
      title={title}
      aria-label={title}
      aria-pressed={current.enabled}
      onClick={() => { void api.setSettings({ keepAwake: !current.enabled }).catch(() => undefined); }}
    >
      <Icon icon={CoffeeIcon} size="sm" />
      {view === "active" && <span className="sb-text">{tr("statusbar.keepAwakeAwake")}</span>}
    </button>
  );
}

export function installDesktopKeepAwake(api: PolythDesktopApi): () => void {
  const { getKeepAwakeState, setAgentActivity, onKeepAwakeState } = api;
  if (!getKeepAwakeState || !setAgentActivity || !onKeepAwakeState) return () => {};
  let disposed = false;
  void getKeepAwakeState.call(api).then((next) => { if (!disposed) publish(next); }).catch(() => undefined);
  const offState = onKeepAwakeState.call(api, publish);

  // Report only changes: a session's status flips a few times per turn, while
  // the store notifies on every streamed chunk.
  let reported: boolean | null = null;
  const report = () => {
    const working = agentsWorking(getState().sessions);
    if (working === reported) return;
    reported = working;
    void setAgentActivity.call(api, working).then((next) => { if (!disposed) publish(next); }).catch(() => {
      reported = null;
    });
  };
  report();
  const offStore = subscribeStore(report);

  const offWidgets = registerWidgetPlugin(defineWidgetPlugin({
    id: "desktop-keep-awake",
    name: tr("statusbar.label"),
    widgets: [{
      id: "desktop.keep-awake",
      title: tr("statusbar.widgetKeepAwake"),
      description: tr("statusbar.widgetKeepAwakeHint"),
      kind: "mini-widget",
      defaultSlot: "app.statusbar.trailing",
      supportedSlots: ["app.statusbar.leading", "app.statusbar.trailing"],
      defaultVisible: true,
      recommended: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 90,
      render: () => <KeepAwakeSegment api={api} />,
    }],
  }));

  return () => {
    disposed = true;
    offWidgets();
    offStore();
    offState();
    // The page is going away: it can no longer vouch for a working agent.
    if (reported) void setAgentActivity.call(api, false).catch(() => undefined);
  };
}
