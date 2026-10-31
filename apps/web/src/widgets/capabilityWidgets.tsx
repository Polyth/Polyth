// Widget-areas (WA3): every workspace capability that can appear in the top
// rail or the right rail is also a placeable mini-widget. This is what makes
// the rails configurable widget areas — drag "Git", "Usage", "Terminal", …
// into any area from the Widget Library, or off the rail entirely.
//
// The capability-tier system (capabilityLayout.ts) still drives the DEFAULT
// rail contents; these widgets are an additional, opt-in placement layered on
// top (`defaultVisible: false`). Retiring the tier system is a later step.
import { listCapabilities, subscribeCapabilities } from "../capabilities.ts";
import { railIconFor } from "../railIcons.ts";
import { isCapabilityActive, toggleCapability } from "../builtinCapabilities.ts";
import { useStore } from "../store.ts";
import { useWorkspaceMode } from "./workspaceMode.ts";
import { tr } from "../i18n/index.ts";
import { registerWidget, type WidgetDef } from "./catalog.ts";

/** Areas a capability launcher makes sense in — every icon row/column. */
const CAPABILITY_WIDGET_SLOTS = [
  "app.header.center",
  "app.header.leading",
  "app.header.actions",
  "workspace.rail",
  "sidebar.toolbar",
  "sidebar.rail",
  "sidebar.footer",
  "composer.leading",
  "composer.trailing",
  "session.footer",
  "app.statusbar.leading",
  "app.statusbar.trailing",
] as const;

/** Chat is `core.chat`; a `capability:session` launcher would be redundant. */
const SKIP = new Set(["session"]);

function CapabilityLauncher({ id }: { id: string }) {
  const RailIcon = railIconFor(id);
  const capability = listCapabilities().find((item) => item.id === id);
  const storeActive = useStore((state) => isCapabilityActive(id, state));
  const editing = useWorkspaceMode() === "edit";
  const active = id === "workspace-edit" ? editing : storeActive;
  if (!capability || !capability.available()) return null;
  return (
    <button
      type="button"
      className={`capability-launcher${active ? " active" : ""}`}
      title={capability.label}
      aria-label={capability.label}
      aria-pressed={capability.kind === "command" ? undefined : active}
      data-pane-launcher={id}
      onClick={() => toggleCapability(id, capability.open)}
    >
      <RailIcon />
      <span className="capability-launcher-label">{capability.label}</span>
    </button>
  );
}

function capabilityWidgetDef(id: string, label: string): WidgetDef {
  return {
    id: `capability:${id}`,
    pluginId: "capabilities",
    pluginName: tr("widgets.capabilitywidgets.workspaceTools"),
    title: label,
    description: tr("widgets.capabilitywidgets.opensValue", { value: label }),
    kind: "mini-widget",
    defaultSlot: "workspace.rail",
    supportedSlots: [...CAPABILITY_WIDGET_SLOTS],
    defaultVisible: false,
    recommended: true,
    resizable: false,
    audience: "standard",
    category: "Workspace",
    render: () => <CapabilityLauncher id={id} />,
  };
}

let installed = false;
const active = new Map<string, { label: string; dispose: () => void }>();

/** Reconcile the registered `capability:*` widgets with the live capability
 * registry — packages register capabilities asynchronously at boot. */
function sync(): void {
  const capabilities = listCapabilities().filter((capability) => !SKIP.has(capability.id) && capability.launcherWidget !== false);
  const wanted = new Map(capabilities.map((capability) => [`capability:${capability.id}`, capability.label]));
  for (const [widgetId, entry] of [...active]) {
    if (!wanted.has(widgetId)) {
      entry.dispose();
      active.delete(widgetId);
    }
  }
  for (const [widgetId, label] of wanted) {
    const entry = active.get(widgetId);
    if (entry?.label === label) continue;
    // A renamed capability (a custom action, say) replaces its definition in
    // place, so the widget never leaves the catalog in between.
    active.set(widgetId, { label, dispose: registerWidget(capabilityWidgetDef(widgetId.slice("capability:".length), label)) });
    entry?.dispose();
  }
}

export function installCapabilityWidgets(): void {
  if (installed) return;
  installed = true;
  sync();
  subscribeCapabilities(sync);
}
