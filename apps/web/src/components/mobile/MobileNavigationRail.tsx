import { useRef, useState } from "react";
import {
  PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY,
} from "../../builtinCapabilities.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { railIconFor } from "../../railIcons.ts";
import {
  openSettingsPage, setRailPlugin, toggleRailPlugin, useStore,
} from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { useDismissibleMenu } from "../a11y/Menu.ts";
import { useRailSurfaceModel } from "../ContextRail.tsx";

interface NavigationItem {
  id: string;
  label: string;
  icon: () => React.JSX.Element;
  active: boolean;
  group: NavigationGroup;
  open: () => void;
}

type NavigationGroup = "views" | "workspace" | "automation" | "settings";

const AUTOMATION_ITEMS = new Set([
  "goals", "multirun", "workflow", "fusion", "walkthrough", "schedule",
]);
const SETTINGS_ITEMS = new Set(["models-agents", "diagnostics"]);

function navigationGroup(id: string, hasView: boolean): NavigationGroup {
  if (SETTINGS_ITEMS.has(id)) return "settings";
  if (AUTOMATION_ITEMS.has(id)) return "automation";
  if (hasView) return "views";
  return "workspace";
}

function focusDestinationHeading(attempt = 0): void {
  requestAnimationFrame(() => {
    const heading = document.querySelector<HTMLElement>(
      ".rail-fullscreen .rail-title, .main .view-title, .main h1",
    );
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
      return;
    }
    // External-store updates may commit after the click's first animation
    // frame. Retry briefly instead of dropping the required focus handoff.
    if (attempt < 3) focusDestinationHeading(attempt + 1);
  });
}

/** The compact shell's single navigation entry point. It mirrors the desktop
 * top/right rails from the shared capability and surface registries instead
 * of maintaining another hard-coded mobile destination list. */
export default function MobileNavigationRail() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resolved = useResolvedCapabilities();
  const { rail, surfaces } = useRailSurfaceModel();
  const view = useStore((state) => state.activeView);
  const ui = useUiSettings();
  const onMenuKey = useDismissibleMenu({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });

  const items: NavigationItem[] = resolved
    .filter((capability) => capability.descriptor.available())
    .map((capability) => {
      const id = capability.descriptor.id;
      const destinationView = VIEW_OF_CAPABILITY[id];
      const pane = PANE_OF_CAPABILITY[id];
      const panel = PANEL_OF_CAPABILITY[id];
      return {
        id,
        label: capability.descriptor.label,
        icon: railIconFor(id),
        group: navigationGroup(id, destinationView !== undefined),
        active: destinationView !== undefined
          ? view === destinationView && rail === null
          : pane !== undefined
            ? rail === pane
            : panel !== undefined && rail === panel,
        open: capability.descriptor.open,
      };
    });

  // Slot-contributed surfaces (notably Notifications) may not own a
  // capability descriptor. They still belong in the same mobile rail.
  for (const surface of surfaces) {
    const id = surface.capabilityId ?? surface.id;
    if (items.some((item) => item.id === id)) continue;
    items.push({
      id,
      label: surface.title,
      icon: surface.icon ?? railIconFor(id),
      group: "workspace",
      active: rail === surface.id,
      open: () => toggleRailPlugin(surface.id),
    });
  }

  const activate = (item: NavigationItem) => {
    setOpen(false);
    item.open();
    focusDestinationHeading();
  };
  const groups: Array<{ id: NavigationGroup; label: string }> = [
    { id: "views", label: "Views" },
    { id: "workspace", label: tr("header.workspace") },
    { id: "automation", label: "Automation" },
    { id: "settings", label: tr("common.settings") },
  ];
  const navigationLabel = tr("header.application");

  return (
    <div className="mobile-navigation-menu">
      <button
        ref={triggerRef}
        className={`icon-btn mobile-header-action mobile-navigation-trigger${open ? " active" : ""}`}
        aria-label={navigationLabel}
        title={navigationLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon.widgets />
      </button>
      {open && (
        <>
          <div className="mobile-navigation-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <nav
            ref={menuRef}
            className="mobile-navigation-rail"
            aria-label={navigationLabel}
            onKeyDown={onMenuKey}
          >
            <div className="mobile-navigation-title">{navigationLabel}</div>
            <div role="menu">
              {groups.map((group) => {
                const groupItems = items.filter((item) => item.group === group.id);
                if (groupItems.length === 0 && group.id !== "settings") return null;
                return (
                  <section className="mobile-navigation-section" key={group.id}>
                    <h2>{group.label}</h2>
                    {groupItems.length > 0 && (
                      <div className="mobile-navigation-grid">
                        {groupItems.map((item) => (
                          <button
                            key={item.id}
                            className={item.active ? "active" : ""}
                            role="menuitem"
                            aria-current={item.active ? "page" : undefined}
                            onClick={() => activate(item)}
                          >
                            <span className="mobile-navigation-icon" aria-hidden="true"><item.icon /></span>
                            <span>{item.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
            <div className="mobile-navigation-utilities" role="menu" aria-label={tr("common.settings")}>
              <button
                role="menuitemcheckbox"
                aria-checked={ui.showDictate}
                onClick={() => setUiSettings({ showDictate: !ui.showDictate })}
              >
                <Icon.mic />
                <span>{tr("header.microphone")}</span>
                <span className={`mobile-control-switch${ui.showDictate ? " on" : ""}`} aria-hidden="true"><i /></span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setRailPlugin(null);
                  openSettingsPage("access");
                }}
              >
                <Icon.shield />
                <span>{tr("header.accessAmpSecurity")}</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setRailPlugin(null);
                  openSettingsPage("about");
                }}
              >
                <Icon.session />
                <span>{tr("header.aboutPolyth")}</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setRailPlugin(null);
                  window.dispatchEvent(new CustomEvent("polyth:open-settings"));
                }}
              >
                <Icon.gear />
                <span>{tr("header.allSettings")}</span>
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
