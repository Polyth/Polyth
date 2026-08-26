import {
  PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY,
} from "../../builtinCapabilities.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { railIconFor } from "../../railIcons.ts";
import {
  setOverlay, setRailPlugin, toggleRailPlugin, useStore,
} from "../../store.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import { useRailSurfaceModel } from "../ContextRail.tsx";

interface ShortcutItem {
  id: string;
  label: string;
  icon: () => React.JSX.Element;
  active: boolean;
  open: () => void;
}

const MODAL_FOCUS_TARGET = [
  "[data-focus-destination]",
  "[autofocus]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
].join(", ");

function focusDestinationHeading(attempt = 0): void {
  requestAnimationFrame(() => {
    // Destination activation can synchronously open Settings and then layer a
    // package tour over it. Never move focus through either modal to an
    // obscured workspace heading. The last active modal is the topmost one in
    // the app's overlay render order (Settings renders its tour last).
    const activeModals = [...document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"]',
    )].filter((modal) =>
      !modal.hidden
      && modal.getAttribute("aria-hidden") !== "true"
      && !modal.closest('[aria-hidden="true"], [inert], [hidden]'));
    const modal = activeModals.at(-1);
    if (modal) {
      if (!modal.contains(document.activeElement)) {
        const target = modal.matches("[tabindex], button, input, select, textarea, a[href]")
          ? modal
          : modal.querySelector<HTMLElement>(MODAL_FOCUS_TARGET);
        target?.focus();
      }
      return;
    }
    const heading = [
      ".rail-fullscreen .rail-title",
      ".main .view-title",
      ".main h1",
    ].map((selector) => document.querySelector<HTMLElement>(selector))
      .find((candidate): candidate is HTMLElement => candidate !== null);
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

/** Phone-first shortcut rail. Settings owns the selected/order list; this
 * component resolves those durable ids against the live capability and
 * surface registries. Overflow is intentionally horizontal so a thumb swipe
 * reveals every configured shortcut without turning navigation into a modal. */
export default function MobileNavigationRail() {
  const resolved = useResolvedCapabilities();
  const { rail, surfaces } = useRailSurfaceModel();
  const view = useStore((state) => state.activeView);
  const ui = useUiSettings();
  const capabilityById = new Map(resolved
    .filter((capability) => capability.descriptor.available())
    .map((capability) => [capability.descriptor.id, capability]));
  const notificationSurface = surfaces.find((surface) =>
    (surface.capabilityId ?? surface.id).includes("notification-centre"));

  const items = ui.mobileShortcuts.flatMap((id): ShortcutItem[] => {
    if (id === "settings") {
      return [{
        id,
        label: tr("common.settings"),
        icon: Icon.gear,
        active: false,
        open: () => {
          setRailPlugin(null);
          setOverlay("settings");
        },
      }];
    }
    if (id === "notification-centre") {
      if (!notificationSurface) return [];
      return [{
        id,
        label: notificationSurface.title,
        icon: notificationSurface.icon ?? railIconFor(id),
        active: rail === notificationSurface.id,
        open: () => toggleRailPlugin(notificationSurface.id),
      }];
    }
    const capability = capabilityById.get(id);
    if (!capability) return [];
    const destinationView = VIEW_OF_CAPABILITY[id];
    const pane = PANE_OF_CAPABILITY[id];
    const panel = PANEL_OF_CAPABILITY[id];
    return [{
      id,
      label: capability.descriptor.label,
      icon: railIconFor(id),
      active: destinationView !== undefined
        ? view === destinationView && rail === null
        : pane !== undefined
          ? rail === pane
          : panel !== undefined && rail === panel,
      open: capability.descriptor.open,
    }];
  });

  return (
    <nav className="mobile-shortcut-rail" aria-label="Quick navigation">
      <div className="mobile-shortcut-track">
        {items.map((item) => (
          <button
            key={item.id}
            className={`rail-icon mobile-shortcut${item.active ? " active" : ""}${item.id === "settings" ? " mobile-shortcut-settings" : ""}`}
            title={item.label}
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
            onClick={() => {
              item.open();
              // Settings owns a modal focus trap and performs its own initial
              // focus handoff. Workspace destinations need this rail handoff.
              if (item.id !== "settings") focusDestinationHeading();
            }}
          >
            <item.icon />
          </button>
        ))}
      </div>
    </nav>
  );
}
