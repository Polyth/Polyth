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
  open: () => void;
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
      active: rail === surface.id,
      open: () => toggleRailPlugin(surface.id),
    });
  }

  const activate = (item: NavigationItem) => {
    setOpen(false);
    item.open();
  };

  return (
    <div className="mobile-navigation-menu">
      <button
        ref={triggerRef}
        className={`icon-btn mobile-header-action mobile-navigation-trigger${open ? " active" : ""}`}
        aria-label={tr("contextrail.workspacePanels")}
        title={tr("contextrail.workspacePanels")}
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
            aria-label={tr("contextrail.workspacePanels")}
            onKeyDown={onMenuKey}
          >
            <div className="mobile-navigation-title">{tr("contextrail.workspacePanels")}</div>
            <div className="mobile-navigation-grid" role="menu">
              {items.map((item) => (
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
            <div className="mobile-navigation-utilities" role="menu">
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
