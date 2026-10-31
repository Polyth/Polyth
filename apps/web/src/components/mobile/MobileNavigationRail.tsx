import { useLayoutEffect, useRef, useState } from "react";
import {
  PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY, toggleCapability,
  isCapabilityActive,
} from "../../builtinCapabilities.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { uniquePackageLaunchers } from "../../packageLaunchers.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { railIconFor } from "../../railIcons.ts";
import { isRailLauncherId } from "../../railPlacement.ts";
import {
  openSettingsPage, setOverlay, setRailPlugin, toggleRailPlugin, useStore,
} from "../../store.ts";
import { MOBILE_SHORTCUT_IDS, useUiSettings } from "../../uiPrefs.ts";
import {
  COMPACT_SHORTCUTS_SETTINGS_ITEM, compactShortcutFit, compactTitleMin,
} from "../../compactHeaderFit.ts";
import { EditIcon, Menu, MoreIcon, SettingsIcon, type MenuEntry } from "../ui/index.ts";
import { getWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";
import { isPersonalProject, personalShortcutIds } from "../../personalProject.ts";
import { useRailSurfaceModel } from "../ContextRail.tsx";

interface ShortcutItem {
  id: string;
  ownerPackageId?: string;
  kind?: "destination" | "command";
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

/** Compact-shell shortcut rail for tablet widths. Phone widths use the
 * three-segment MobileSessionHeader instead. The user's ordered pinned set
 * (`ui.mobileShortcuts`, edited in Settings → Appearance) fills whole slots
 * beside the session title; whatever does not fit, every other launchable
 * tool, the editor and Settings live in the always-present More menu. No
 * shortcut is ever clipped or hidden behind a horizontal scroll.
 *
 * In a Personal project the pinned tools are the ones its own rails carry
 * (`personalShortcutIds`), so a tool that project keeps under More stays in
 * More here too. */
export default function MobileNavigationRail() {
  const resolved = useResolvedCapabilities();
  const { rail, surfaces } = useRailSurfaceModel();
  const view = useStore((state) => state.activeView);
  // A package page (Agents) lights its launcher while it is open.
  useStore((state) => state.activePage);
  const personal = useStore((state) =>
    isPersonalProject(state.projectRegistry.projects.find((project) => project.id === state.activeProjectId)));
  const ui = useUiSettings();
  const navRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  const capabilityById = new Map(resolved
    .filter((capability) => capability.descriptor.rail !== false && capability.descriptor.available())
    .map((capability) => [capability.descriptor.id, capability]));
  const notificationSurface = surfaces.find((surface) =>
    (surface.capabilityId ?? surface.id).includes("notification-centre"));

  const shortcut = (id: string): ShortcutItem[] => {
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
        ownerPackageId: notificationSurface.ownerPackageId,
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
    const workspaceSurface = getWorkspaceSurface(id);
    return [{
      id,
      ownerPackageId: capability.descriptor.ownerPackageId,
      ...(capability.descriptor.kind ? { kind: capability.descriptor.kind } : {}),
      label: capability.descriptor.label,
      icon: railIconFor(id),
      active: destinationView !== undefined
        ? view === destinationView && rail === null
        : pane !== undefined
          ? rail === pane
          : panel !== undefined
            ? rail === panel
            : workspaceSurface !== undefined
              ? view === id && rail === null
              : isCapabilityActive(id),
      open: () => toggleCapability(id, capability.descriptor.open),
    }];
  };

  const pinnedIds = personal
    ? personalShortcutIds(
      [...capabilityById.values()].map(({ descriptor, tier }) => ({ id: descriptor.id, tier })),
      isRailLauncherId,
    )
    : ui.mobileShortcuts;
  const items = uniquePackageLaunchers(pinnedIds.flatMap(shortcut), (item) => item);
  const pinned = new Set(items.map((item) => item.id));
  // Every other launchable tool stays one tap away in More, in the editor's
  // canonical order first and then any package capability beyond it.
  const others = uniquePackageLaunchers(
    [...new Set<string>([...MOBILE_SHORTCUT_IDS, ...capabilityById.keys()])]
      .filter((id) => id !== "settings" && !pinned.has(id))
      .flatMap(shortcut),
    (item) => item,
  );

  useLayoutEffect(() => {
    const nav = navRef.current;
    const header = nav?.closest<HTMLElement>(".header");
    if (!nav || !header) return;
    const px = (value: string) => Number.parseFloat(value) || 0;
    const measure = () => {
      const headerStyle = getComputedStyle(header);
      const inline = header.clientWidth - px(headerStyle.paddingInlineStart) - px(headerStyle.paddingInlineEnd);
      let reserved = 0;
      let slots = 0;
      for (const child of Array.from(header.children)) {
        if (!(child instanceof HTMLElement) || getComputedStyle(child).display === "none") continue;
        slots += 1;
        if (child.contains(nav)) {
          // The rail's own cluster: count its other members (header actions,
          // the user menu on non-chat surfaces), never the rail itself.
          const gap = px(getComputedStyle(child).columnGap);
          for (const member of Array.from(child.children)) {
            if (member === nav || !(member instanceof HTMLElement) || getComputedStyle(member).display === "none") continue;
            reserved += member.offsetWidth + gap;
          }
        } else if (!child.matches(".desktop-session-status, .header-compact-title, .header-spacer")) {
          reserved += child.offsetWidth;
        }
      }
      reserved += px(headerStyle.columnGap) * Math.max(0, slots - 1);
      const track = nav.querySelector<HTMLElement>(".mobile-shortcut-track");
      const more = nav.querySelector<HTMLElement>(".mobile-shortcut-more");
      const gap = track ? px(getComputedStyle(track).columnGap) : 0;
      const pitch = (more?.offsetWidth ?? 0) + gap;
      const titled = header.querySelector(".desktop-session-status, .header-compact-title") !== null;
      setFit(compactShortcutFit({
        headerInline: inline,
        reserved,
        titleMin: titled ? compactTitleMin(inline) : 0,
        pitch,
        moreInline: more?.offsetWidth ?? 0,
        count: Number.POSITIVE_INFINITY,
      }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    for (const child of Array.from(header.children)) {
      if (child !== nav && !child.matches(".desktop-session-status")) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [items.length]);

  const visible = items.slice(0, fit);
  const overflow = items.slice(visible.length);
  const settingsVisible = visible.some((item) => item.id === "settings");
  const activate = (item: ShortcutItem) => {
    item.open();
    // Settings owns a modal focus trap and performs its own initial focus
    // handoff. Workspace destinations need this rail handoff.
    if (item.id !== "settings") focusDestinationHeading();
  };
  const entry = (item: ShortcutItem): MenuEntry => ({
    id: `open:${item.id}`,
    label: item.label,
    icon: item.icon,
    ...(item.active ? { detail: tr("header.compactShortcutOpen") } : {}),
    onSelect: () => activate(item),
  });
  // Overflowed pinned tools first, then the editor and Settings — kept above
  // the long "More tools" list so they never hide below the fold.
  const moreEntries: MenuEntry[] = [
    ...overflow.filter((item) => item.id !== "settings").map(entry),
    ...(overflow.some((item) => item.id !== "settings") ? ["separator" as const] : []),
    {
      id: "customize-shortcuts",
      label: tr("header.compactCustomizeShortcuts"),
      icon: EditIcon,
      onSelect: () => openSettingsPage("appearance", { itemId: COMPACT_SHORTCUTS_SETTINGS_ITEM }),
    },
    ...(!settingsVisible
      ? [{
        id: "settings",
        label: tr("header.allSettings"),
        icon: SettingsIcon,
        onSelect: () => {
          setRailPlugin(null);
          setOverlay("settings");
        },
      }]
      : []),
    ...(others.length > 0
      ? ["separator" as const, { heading: tr("header.compactMoreTools") }, ...others.map(entry)]
      : []),
  ];
  const overflowActive = overflow.some((item) => item.active) || others.some((item) => item.active);

  return (
    <nav ref={navRef} className="mobile-shortcut-rail" aria-label={tr("header.compactQuickNavigation")}>
      <div className="mobile-shortcut-track">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ui-icon-btn ui-icon-btn--ghost ui-icon-btn--lg mobile-shortcut${item.active ? " active" : ""}${item.id === "settings" ? " mobile-shortcut-settings" : ""}`}
            title={item.label}
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
            onClick={() => activate(item)}
          >
            <item.icon />
          </button>
        ))}
        <Menu
          label={tr("header.compactMoreLabel")}
          title={tr("header.compactMoreTitle")}
          align="end"
          entries={moreEntries}
        >
          {(trigger) => (
            <button
              type="button"
              className={`ui-icon-btn ui-icon-btn--ghost ui-icon-btn--lg mobile-shortcut mobile-shortcut-more${overflowActive ? " active" : ""}`}
              title={tr("header.compactMoreTitle")}
              aria-label={tr("header.compactMoreLabel")}
              {...trigger}
            >
              <MoreIcon aria-hidden="true" />
            </button>
          )}
        </Menu>
      </div>
    </nav>
  );
}
