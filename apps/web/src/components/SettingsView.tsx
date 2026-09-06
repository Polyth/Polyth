// OC-style settings: modal with a left page nav and one focused page at a
// time. Plugins inject extra pages through the "settings.pages" slot. Search
// (WP9) matches individual settings rows through the item registry and jumps
// to the exact row; page-title filtering remains the fallback for plugin
// pages without item metadata.
import {
  Fragment, useEffect, useMemo, useRef, useState,
  type ReactNode, type TouchEvent as ReactTouchEvent,
} from "react";
import { consumePendingSettingsPage, setOverlay } from "../store.ts";
import { listSlots } from "../slots.ts";
import { isPackageEnabled, subscribePackages } from "../packages/registry.ts";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import { usePrefs } from "../prefs.ts";
import {
  registerSettingsItems, searchSettingsItems,
  type SettingsSearchHit, type SettingsSearchItem,
} from "../settings/registry.ts";
import {
  AboutPage, AppearancePage, BehaviorPage, ChatPage, GeneralPage,
  NotificationsPage, ProjectsPage,
} from "./settings/pages.tsx";
import ViewErrorBoundary from "./ViewErrorBoundary.ts";
import SessionsPage from "./settings/SessionsPage.tsx";
import AccessPage from "./settings/AccessPage.tsx";
import PackagesPage from "./settings/PackagesPage.tsx";
import WidgetsPage from "./settings/WidgetsPage.tsx";
import PackageTourOverlay from "./PackageTourOverlay.tsx";
import { maybeAutoShowPackageTour } from "../packages/onboarding/controller.ts";
import { settingsPageToPackageId } from "../packages/onboarding/pageMap.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";
import { tapFeedback } from "../haptics.ts";
import { isEdgeBackSwipe, type GesturePoint } from "../mobileGestures.ts";
import { Button, IconButton, TextInput } from "./ui/index.ts";
import { BackIcon, CloseIcon } from "./ui/icons.ts";

interface PageDef {
  id: string;
  label: string;
  group: "Workspace" | "Engineering" | "Customize" | "System";
  icon?: string;
  nav?: boolean;
  render: () => ReactNode;
}

type MobileStage = "nav" | "page";

function useMobileSettings() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}

const BUILTIN: PageDef[] = [
  { id: "general", label: tr("settingsview.general"), group: "Workspace", render: () => <GeneralPage /> },
  { id: "appearance", label: tr("settingsview.appearance"), group: "Workspace", render: () => <AppearancePage /> },
  { id: "chat", label: tr("settingsview.chat"), group: "Workspace", render: () => <ChatPage /> },
  { id: "notifications", label: tr("settingsview.notifications"), group: "Workspace", render: () => <NotificationsPage /> },
  { id: "sessions", label: tr("settingsview.sessions"), group: "Workspace", render: () => <SessionsPage /> },
  { id: "projects", label: tr("settingsview.projects"), group: "Engineering", render: () => <ProjectsPage /> },
  { id: "behavior", label: tr("settingsview.behavior"), group: "Engineering", render: () => <BehaviorPage /> },
  { id: "widgets", label: tr("settingsview.widgetsLayout"), group: "Customize", icon: "◇", render: () => <WidgetsPage /> },
  { id: "packages", label: tr("settingsview.packages"), group: "Customize", icon: "📦", render: () => <PackagesPage /> },
  { id: "access", label: tr("settingsview.access"), group: "System", nav: false, render: () => <AccessPage /> },
  { id: "about", label: tr("settingsview.about"), group: "System", nav: false, render: () => <AboutPage /> },
];

const GROUP_LABELS: Record<PageDef["group"], string> = {
  Workspace: tr("settingsview.workspace"),
  Engineering: tr("settingsview.engineering"),
  Customize: tr("settingsview.customize"),
  System: tr("settingsview.system"),
};

const SETTINGS_ICON_BY_PAGE: Record<string, keyof typeof Icon> = {
  general: "gear",
  appearance: "palette",
  chat: "chat",
  notifications: "bell",
  sessions: "session",
  shortcuts: "keyboard",
  projects: "files",
  behavior: "pencil",
  widgets: "widgets",
  packages: "package",
  desktop: "sliders",
  voice: "mic",
  usage: "usage",
  git: "branch",
  models: "context",
  agents: "session",
  mcp: "plug",
  commands: "term",
  skills: "puzzle",
  integrations: "link",
  plugins: "puzzle",
  "secure-safe": "shield",
  "home-assistant": "home",
};

function SettingsNavIcon({ pageId }: { pageId: string }) {
  const Glyph = Icon[SETTINGS_ICON_BY_PAGE[pageId] ?? "puzzle"];
  return <Glyph />;
}

export default function SettingsView({ onClose = () => setOverlay(null) }: { onClose?: () => void }) {
  const prefs = usePrefs();
  const mobile = useMobileSettings();
  // Deep link (e.g. "Change shortcut…" palette rows land on the Shortcuts page).
  const [active, setActive] = useState(() => consumePendingSettingsPage() ?? "general");
  const [mobileStage, setMobileStage] = useState<MobileStage>("nav");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const previousMobile = useRef(mobile);
  const backSwipeStartRef = useRef<GesturePoint | null>(null);

  const returnFocusTarget = (opener: HTMLElement | null) =>
    document.querySelector<HTMLElement>(".mobile-shortcut-settings")
      ?? (opener?.isConnected ? opener : null)
      ?? document.querySelector<HTMLElement>(".header-profile");
  const closeSettings = () => onClose();
  const requestClose = () => {
    if (mobile && mobileStage === "page") setMobileStage("nav");
    else closeSettings();
  };

  useModalSurface({
    open: true,
    onClose: requestClose,
    containerRef: modalRef,
    isolationRootRef: scrimRef,
    initialFocus: "[data-settings-focus-target]",
    resolveRestoreFocus: returnFocusTarget,
  });

  useEffect(() => {
    // A settings modal opened on mobile starts on the navigation stage, but
    // crossing the breakpoint while a desktop page is already open should
    // preserve that page instead of replacing it with the navigation list.
    if (mobile && !previousMobile.current) setMobileStage("page");
    previousMobile.current = mobile;
  }, [mobile]);

  // Plugin-contributed pages (settings.pages slot): one nav entry per item.
  // Slot props may carry `settingsItems` descriptors for item-level search.
  // Version-keyed so late registration/disposal re-renders and the list keeps
  // a stable identity between slot changes.
  const slotsAt = useSlotVersion();
  const slotItems = useMemo(() => listSlots("settings.pages"), [slotsAt]);
  const [packagesAt, setPackagesAt] = useState(0);
  useEffect(() => subscribePackages(() => setPackagesAt((value) => value + 1)), []);
  const visibleSlotItems = useMemo(
    () => slotItems.filter((item) => {
      const packageId = (item.meta as { packageId?: unknown } | undefined)?.packageId;
      return typeof packageId !== "string" || isPackageEnabled(packageId);
    }),
    [packagesAt, slotItems],
  );
  const pages = useMemo<PageDef[]>(() => {
    const extra = visibleSlotItems.map((item): PageDef => {
      const meta = item.meta as {
        label?: unknown;
        group?: unknown;
        icon?: unknown;
        pageId?: unknown;
      } | undefined;
      const group = meta?.group;
      return {
        id: typeof meta?.pageId === "string" ? meta.pageId : `slot:${item.id}`,
        label: typeof meta?.label === "string"
          ? meta.label
          : item.id.replace(/^[^.]*\./, "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
        group: group === "Workspace" || group === "Engineering" || group === "Customize" || group === "System"
          ? group
          : "Customize",
        ...(typeof meta?.icon === "string" ? { icon: meta.icon } : {}),
        render: () => <>{item.render({ prefs })}</>,
      };
    });
    const groupOrder = ["Workspace", "Engineering", "Customize", "System"];
    return [...BUILTIN, ...extra].sort(
      (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
    );
  }, [prefs, visibleSlotItems]);

  // First visit to a package's settings page auto-opens its tour (unless the
  // user skipped it, skipped all onboardings, or already saw it this session).
  useEffect(() => {
    const packageId = settingsPageToPackageId(active, visibleSlotItems);
    if (packageId) maybeAutoShowPackageTour(packageId);
  }, [active, visibleSlotItems]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const pageId = (event as CustomEvent<unknown>).detail;
      if (typeof pageId !== "string" || !pages.some((page) => page.id === pageId)) return;
      setActive(pageId);
      if (mobile) setMobileStage("page");
      setFilter("");
      setCursor(0);
    };
    window.addEventListener("polyth:settings-page", navigate);
    return () => window.removeEventListener("polyth:settings-page", navigate);
  }, [mobile, pages]);

  useEffect(() => {
    const contributed: SettingsSearchItem[] = [];
    for (const item of visibleSlotItems) {
      const list = (item.meta as { settingsItems?: SettingsSearchItem[] } | undefined)?.settingsItems;
      if (!Array.isArray(list)) continue;
      const pageId = typeof item.meta?.pageId === "string" ? item.meta.pageId : `slot:${item.id}`;
      for (const si of list) {
        if (si && typeof si.id === "string" && typeof si.label === "string") {
          contributed.push({
            ...si,
            pageId,
            ...(typeof item.meta?.packageId === "string"
              ? { ownerPackageId: item.meta.packageId }
              : {}),
          });
        }
      }
    }
    if (contributed.length === 0) return;
    return registerSettingsItems(contributed); // disposed plugin items vanish with the slot
  }, [visibleSlotItems]);

  const pageLabels = useMemo(
    () => Object.fromEntries(pages.map((p) => [p.id, p.label])),
    [pages],
  );

  const q = filter.trim();
  const itemHits = useMemo<SettingsSearchHit[]>(
    () => (q ? searchSettingsItems(q, pageLabels) : []),
    [q, pageLabels],
  );
  // Fallback: pages whose TITLE matches but that had no item hits.
  const pageHits = q
    ? pages.filter((p) =>
        p.label.toLowerCase().includes(q.toLowerCase()) &&
        !itemHits.some((h) => h.item.pageId === p.id))
    : [];
  const resultCount = itemHits.length + pageHits.length;

  const current = pages.find((p) => p.id === active) ?? pages[0]!;

  const gotoItem = (hit: SettingsSearchHit) => {
    setActive(hit.item.pageId);
    if (mobile) setMobileStage("page");
    setFilter("");
    setCursor(0);
    // Focus + flash after the page renders.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = paneRef.current?.querySelector<HTMLElement>(`[data-settings-item="${hit.item.focusTarget}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1600);
        row.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
      });
    });
  };

  const gotoPage = (id: string) => {
    setActive(id);
    if (mobile) setMobileStage("page");
    setFilter("");
    setCursor(0);
  };
  const startBackSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!mobile || mobileStage !== "page" || !touch) return;
    backSwipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const finishBackSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = backSwipeStartRef.current;
    const touch = event.changedTouches[0];
    backSwipeStartRef.current = null;
    if (!start || !touch || !isEdgeBackSwipe(start, { x: touch.clientX, y: touch.clientY })) return;
    tapFeedback();
    setMobileStage("nav");
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (!q) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, resultCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor < itemHits.length) {
        const hit = itemHits[cursor];
        if (hit) gotoItem(hit);
      } else {
        const p = pageHits[cursor - itemHits.length];
        if (p) gotoPage(p.id);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setFilter("");
      setCursor(0);
    }
  };

  return (
    <div ref={scrimRef} className="scrim settings-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeSettings(); }}>
      <div
        className={`modal settings-shell settings-page-${current.id}${mobile ? ` settings-mobile-${mobileStage}` : ""}`}
        ref={modalRef}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={tr("common.settings")}
        aria-describedby={mobile ? undefined : "settings-close-hint"}
      >
        <nav className="modal-nav settings-nav">
          <div className="settings-mobile-nav-head">
            <strong data-settings-focus-target tabIndex={-1}>{tr("common.settings")}</strong>
            <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
          </div>
          <TextInput
            className="settings-nav-search"
            uiSize="sm"
            value={filter}
            placeholder={tr("settingsview.searchSettingsK")}
            onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
            onKeyDown={onSearchKey}
            aria-label={tr("settingsview.searchSettings")}
          />
          {q ? (
            <div className="settings-results" role="listbox" aria-label={tr("settingsview.settingsSearchResults")}>
              {itemHits.map((hit, i) => (
                <button
                  key={hit.item.id}
                  className={`settings-result ${cursor === i ? "cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === i}
                  onClick={() => gotoItem(hit)}
                >
                  <span className="settings-result-label">{hit.item.label}</span>
                  {hit.item.description && <span className="settings-result-hint">{hit.item.description}</span>}
                  <span className="settings-result-page">{hit.pageLabel}</span>
                </button>
              ))}
              {pageHits.map((p, i) => (
                <button
                  key={p.id}
                  className={`settings-result page-only ${cursor === itemHits.length + i ? "cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === itemHits.length + i}
                  onClick={() => gotoPage(p.id)}
                >
                  <span className="settings-result-label">{p.label}</span>
                  <span className="settings-result-page">{tr("settingsview.page")}</span>
                </button>
              ))}
              {resultCount === 0 && <div className="palette-empty">{tr("settingsview.noMatches")}</div>}
            </div>
          ) : (
            <nav className="settings-nav-list" aria-label={tr("settingsview.settingsPages")}>
              {pages.filter((page) => page.nav !== false).map((p, index, navPages) => (
                <Fragment key={p.id}>
                  {(index === 0 || navPages[index - 1]!.group !== p.group) && (
                    <div className="settings-nav-group">{GROUP_LABELS[p.group]}</div>
                  )}
                  <button
                    className={`settings-nav-item ${current.id === p.id ? "active" : ""}`}
                    aria-current={current.id === p.id ? "page" : undefined}
                    onClick={() => {
                      setActive(p.id);
                      if (mobile) setMobileStage("page");
                    }}
                  >
                    <span className="settings-nav-icon" aria-hidden="true"><SettingsNavIcon pageId={p.id} /></span>
                    {p.label}
                  </button>
                </Fragment>
              ))}
            </nav>
          )}
          <div className="nav-foot">
            <SlotHost slot="settings.footer" />
          </div>
        </nav>
        <div
          className="modal-main settings-pane"
          onTouchStart={startBackSwipe}
          onTouchEnd={finishBackSwipe}
          onTouchCancel={() => { backSwipeStartRef.current = null; }}
        >
          <div className="modal-head settings-pane-head">
            {mobile ? (
              <div className="settings-pane-head-bar">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  iconStart={BackIcon}
                  className="settings-mobile-back"
                  onClick={() => setMobileStage("nav")}
                  aria-label={tr("settingsview.backToSettings")}
                >
                  {tr("common.back")}
                </Button>
                <span className="settings-mobile-title">{current.label}</span>
                <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
              </div>
            ) : (
              <>
                <div className="settings-pane-head-copy">
                  <h1 className="modal-title settings-pane-title" data-settings-focus-target tabIndex={-1}>
                    {current.label}
                  </h1>
                </div>
                <span className="dialog-hint" id="settings-close-hint"><kbd>{tr("settingsview.esc")}</kbd> {tr("settingsview.close")}</span>
                <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
              </>
            )}
          </div>
          <div className="modal-body settings-pane-body" ref={paneRef}>
            {/* A page that throws must not white-screen the whole app —
                Settings renders outside App's main view boundary. */}
            <ViewErrorBoundary resetKey={current.id} inline>{current.render()}</ViewErrorBoundary>
          </div>
        </div>
      </div>
      {/* Package tour layers above the settings modal; renders null when closed. */}
      <PackageTourOverlay />
    </div>
  );
}
