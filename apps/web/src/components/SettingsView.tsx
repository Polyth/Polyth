// OC-style settings: modal with a left page nav and one focused page at a
// time. Plugins inject extra pages through the "settings.pages" slot. Search
// matches individual settings rows through the item registry and jumps
// to the exact row; page-title filtering remains the fallback for plugin
// pages without item metadata.
import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from "react";
import { consumePendingSettingsNavigation, setOverlay, type PendingSettingsNavigation } from "../store.ts";
import { accountStorageGet, accountStorageSet } from "../accountStorage.ts";
import { listSlots } from "../slots.ts";
import { isPackageEnabled, subscribePackages, whenPackagesSettled } from "../packages/registry.ts";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import { isImeComposing } from "./input/editorCore.ts";
import { usePrefs } from "../prefs.ts";
import { modKeyLabel } from "../settings.ts";
import {
  registerSettingsItems, searchSettingsItems, searchSettingsPages,
  type SettingsSearchHit, type SettingsSearchItem,
} from "../settings/registry.ts";
import {
  AboutPage, AppearancePage, BehaviorPage, ChatPage, GeneralPage,
  NotificationsPage, ProjectsPage,
} from "./settings/pages.tsx";
import ViewErrorBoundary from "./ViewErrorBoundary.ts";
import SessionsPage from "./settings/SessionsPage.tsx";
import UsersPage from "./settings/UsersPage.tsx";
import CommandLinePage from "./settings/CommandLinePage.tsx";
import PackagesPage from "./settings/PackagesPage.tsx";
import { PackageGlyph } from "./settings/packageIcons.tsx";
import PackageTourOverlay from "./PackageTourOverlay.tsx";
import { openPackageTour } from "../packages/onboarding/controller.ts";
import { settingsPageToPackageId } from "../packages/onboarding/pageMap.ts";
import { getPackageOnboarding, subscribePackageOnboardings } from "../packages/onboarding/registry.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { tr } from "../i18n/index.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { swipeZoneInHost } from "../shellSwipe.ts";
import { attachSwipeSurface, parkLeavingLayer } from "../swipeSurface.ts";
import { useEdgeSwipeBack } from "../useEdgeSwipeBack.ts";
import { motionIsReduced, scheduleSurfaceExit } from "../motionPresence.ts";
import { useExitGhost } from "../exitGhost.ts";
import { setSettingsBackHandler, takeSettingsOrigin, type SettingsOrigin } from "../settingsPresentation.ts";
import { Button, Icon, IconButton, TextInput } from "./ui/index.ts";
import { BackIcon, ChevronRightIcon, CloseIcon, HelpIcon, SearchIcon } from "./ui/icons.ts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { guardedSettingsPageVisible, useGuardrails } from "../guardrails.ts";

type DeclaredGroup = "Workspace" | "Engineering" | "Customize" | "System";
type NavGroup = "Workspace" | "Agents" | "Code" | "Integrations" | "Customize" | "System";

interface PageDef {
  id: string;
  label: string;
  group: NavGroup;
  order: number;
  icon?: string;
  nav?: boolean;
  redirect?: { pageId: string; target?: SettingsNavigationTarget };
  render: (settingsTarget?: SettingsNavigationTarget) => ReactNode;
}

function normalizeSettingsNavigation(navigation: PendingSettingsNavigation): PendingSettingsNavigation {
  const parts = navigation.pageId.split("/");
  if (parts.length >= 2 && parts.length <= 3 && parts[0] && parts[1]) {
    return {
      pageId: parts[0],
      target: { itemId: parts[1], ...(parts[2] ? { sectionId: parts[2] } : {}) },
    };
  }
  return navigation;
}

type MobileStage = "nav" | "page";
/** How the phone stages are moving: a page pushed over the list, popped off it, or at rest. */
type StageMotion = "rest" | "push" | "pop";

/**
 * Whether Settings is the surface a swipe belongs to: nothing modal, no menu
 * and no popover is open over it (they own their own gestures). Surfaces in
 * the background are inert while Settings is open; exit ghosts are inert too.
 */
function settingsOnTop(shell: HTMLElement | null): boolean {
  if (!shell) return false;
  for (const el of document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="menu"], .ui-popover')) {
    if (el === shell || el.closest("[inert], [hidden]")) continue;
    if (el.getClientRects().length > 0) return false;
  }
  return true;
}

// A plain open resumes where Settings was last left: this browser only, never
// synced. The phone stage is remembered so closing from the nav list reopens
// on the nav list, and closing from a page reopens that page.
const LAST_PAGE_KEY = "polyth.settings.lastPage";
interface LastSettingsPage { pageId: string; stage: MobileStage }

function readLastSettingsPage(): LastSettingsPage | null {
  try {
    const value = JSON.parse(accountStorageGet(LAST_PAGE_KEY) ?? "null") as Partial<LastSettingsPage> | null;
    if (!value || typeof value.pageId !== "string" || !value.pageId) return null;
    return { pageId: value.pageId, stage: value.stage === "page" ? "page" : "nav" };
  } catch {
    return null;
  }
}

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

// The host owns the settings navigation: grouping, order and icons. Package
// metas declare a coarse group; first-party pages get a curated place here so
// the nav reads as task groups, not one long "Engineering" list.
const NAV_LAYOUT: Readonly<Record<NavGroup, readonly string[]>> = {
  Workspace: ["general", "appearance", "chat", "notifications", "sessions", "voice", "voice-mode", "recap", "personal-coach", "usage"],
  Agents: ["harnesses", "behavior", "permissions", "mcp", "skills", "commands", "judgment", "custom-titles", "todos"],
  Code: ["projects", "files", "git", "ssh", "task-trackers", "monitoring"],
  Integrations: ["browser", "web-search", "secure-safe", "home-assistant"],
  Customize: ["shortcuts", "packages"],
  System: ["users", "command-line", "tunnel", "about"],
};

const PAGE_PLACEMENT: ReadonlyMap<string, { group: NavGroup; order: number }> = new Map(
  (Object.entries(NAV_LAYOUT) as [NavGroup, readonly string[]][]).flatMap(([group, ids]) =>
    ids.map((id, order) => [id, { group, order }] as const)),
);

/** Unknown (third-party) pages keep their declared group; "Engineering" is
 *  retired from the nav and maps to Code. They sort after curated pages. */
function placePage(id: string, declared: DeclaredGroup): { group: NavGroup; order: number } {
  return PAGE_PLACEMENT.get(id) ?? { group: declared === "Engineering" ? "Code" : declared, order: 1000 };
}

const BUILTIN: PageDef[] = ([
  { id: "general", label: tr("settingsview.general"), declared: "Workspace", render: () => <GeneralPage /> },
  { id: "appearance", label: tr("settingsview.appearance"), declared: "Workspace", render: (target) => <AppearancePage {...(target ? { settingsTarget: target } : {})} /> },
  { id: "chat", label: tr("settingsview.chat"), declared: "Workspace", render: () => <ChatPage /> },
  { id: "notifications", label: tr("settingsview.notifications"), declared: "Workspace", render: () => <NotificationsPage /> },
  { id: "sessions", label: tr("settingsview.sessions"), declared: "Workspace", render: () => <SessionsPage /> },
  { id: "projects", label: tr("settingsview.projects"), declared: "Engineering", render: () => <ProjectsPage /> },
  { id: "behavior", label: tr("settingsview.behavior"), declared: "Engineering", render: () => <BehaviorPage /> },
  { id: "packages", label: tr("settingsview.packages"), declared: "Customize", render: () => <PackagesPage /> },
  { id: "users", label: tr("settingsview.users"), declared: "System", render: (target) => <UsersPage {...(target ? { settingsTarget: target } : {})} /> },
  { id: "command-line", label: tr("settingsview.commandLine"), declared: "System", render: () => <CommandLinePage /> },
  { id: "about", label: tr("settingsview.about"), declared: "System", render: () => <AboutPage /> },
] as (Omit<PageDef, "group" | "order"> & { declared: DeclaredGroup })[]).map(({ declared, ...page }) => ({
  ...page,
  ...placePage(page.id, declared),
}));

const GROUP_ORDER: NavGroup[] = ["Workspace", "Agents", "Code", "Integrations", "Customize", "System"];

const GROUP_LABELS: Record<NavGroup, string> = {
  Workspace: tr("settingsview.workspace"),
  Agents: tr("settingsview.agents"),
  Code: tr("settingsview.code"),
  Integrations: tr("settingsview.integrations"),
  Customize: tr("settingsview.customize"),
  System: tr("settingsview.system"),
};

// Curated, distinct glyph per first-party page; wins over the package meta so
// two pages never share an icon in the nav. Third-party pages use their meta.
const SETTINGS_ICON_BY_PAGE: Readonly<Record<string, string>> = {
  general: "settings",
  appearance: "palette",
  chat: "chat",
  notifications: "bell",
  sessions: "layers",
  voice: "mic",
  "voice-mode": "voice-mode",
  recap: "recap",
  "personal-coach": "coach",
  usage: "usage",
  harnesses: "cpu",
  behavior: "brain",
  permissions: "shield",
  mcp: "server",
  skills: "knowledge",
  commands: "command",
  judgment: "circle-check",
  "custom-titles": "edit",
  todos: "check",
  projects: "files",
  files: "file",
  git: "git",
  ssh: "terminal",
  "task-trackers": "tasks",
  monitoring: "activity",
  browser: "globe",
  "web-search": "telescope",
  "secure-safe": "lock",
  "home-assistant": "home",
  shortcuts: "keyboard",
  packages: "package",
  users: "user",
  "command-line": "terminal",
  tunnel: "qr",
  about: "info",
  desktop: "network",
  models: "database",
  integrations: "link",
  plugins: "plugin",
};

function SettingsNavIcon({ pageId, icon }: { pageId: string; icon?: string }) {
  return <PackageGlyph icon={SETTINGS_ICON_BY_PAGE[pageId] ?? icon ?? "settings"} size={16} strokeWidth={1.8} />;
}

// Package pages register asynchronously after boot. Until the first boot has
// settled, the nav shows a stable skeleton instead of a partial list that
// reflows as pages pop in. Later opens start settled.
let packagesSettledOnce = false;
const NAV_SKELETON_ROWS = 14;

/** Flat, cursor-addressable search result model: a page header followed by
 *  its matching rows (capped), grouped by page. */
type SearchEntry =
  | { kind: "page"; page: PageDef; hidden: number }
  | { kind: "item"; hit: SettingsSearchHit };
const MAX_RESULT_PAGES = 8;
const MAX_ITEMS_PER_PAGE = 4;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export default function SettingsView({ onClose = () => setOverlay(null) }: { onClose?: () => void }) {
  const prefs = usePrefs();
  const mobile = useMobileSettings();
  // Deep links may carry a page-local item and section target.
  // An explicit route (deep link, openSettingsPage) opens its page directly on
  // phones too; a plain open resumes the last page and phone stage.
  const [initialNavigation] = useState(() => {
    const pending = consumePendingSettingsNavigation();
    if (!pending) {
      const last = readLastSettingsPage();
      return last
        ? { pageId: last.pageId, ...(last.stage === "page" ? { explicit: true as const } : {}) }
        : { pageId: "general" };
    }
    const navigation = normalizeSettingsNavigation(pending);
    return !navigation.target && navigation.pageId !== "general"
      ? { ...navigation, explicit: true as const }
      : navigation;
  });
  const [active, setActive] = useState(() => initialNavigation.pageId);
  const [settingsTarget, setSettingsTarget] = useState<SettingsNavigationTarget | undefined>(
    () => "target" in initialNavigation ? initialNavigation.target : undefined,
  );
  const [mobileStage, setMobileStage] = useState<MobileStage>(() =>
    ("target" in initialNavigation && initialNavigation.target) || "explicit" in initialNavigation ? "page" : "nav",
  );
  // The edge phone Settings arrived from (settingsPresentation.ts): it leaves
  // that way, and a swipe toward that edge dismisses it.
  const [origin] = useState<SettingsOrigin>(() => takeSettingsOrigin());
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  // Closing unmounts Settings at once; its last frame still leaves toward the
  // edge it came from, from wherever a swipe let go of it (exitGhost.ts).
  const scrimGhostRef = useExitGhost<HTMLDivElement>(() => ({ kind: "settings" }), scrimRef);
  const previousMobile = useRef(mobile);

  const returnFocusTarget = (opener: HTMLElement | null) =>
    document.querySelector<HTMLElement>(".mobile-shortcut-settings")
      ?? (opener?.isConnected ? opener : null)
      ?? document.querySelector<HTMLElement>(".header-profile");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeSettings = () => onCloseRef.current();
  const requestClose = () => {
    if (mobile && mobileStage === "page") setMobileStage("nav");
    else closeSettings();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const [packagesSettled, setPackagesSettled] = useState(packagesSettledOnce);
  useEffect(() => {
    if (packagesSettled) return;
    let live = true;
    const settle = () => {
      packagesSettledOnce = true;
      if (live) setPackagesSettled(true);
    };
    void whenPackagesSettled().then(settle, settle);
    return () => { live = false; };
  }, [packagesSettled]);

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

  // Phone stage motion: a page is pushed over the list and popped back off it
  // with the phone stack grammar. The list stays mounted under a page, so Back
  // (a tap, Escape, native Back or a swipe) reveals it already rendered.
  const [stageView, setStageView] = useState<{ stage: MobileStage; motion: StageMotion }>(
    () => ({ stage: mobileStage, motion: "rest" }),
  );
  let stageMotion = stageView.motion;
  if (stageView.stage !== mobileStage) {
    // With motion off a stage simply swaps: the page that leaves must not
    // stay drawn over the list for a frame.
    stageMotion = mobile && !motionIsReduced() ? (mobileStage === "page" ? "push" : "pop") : "rest";
    setStageView({ stage: mobileStage, motion: stageMotion });
  }
  useEffect(() => {
    if (stageView.motion !== "pop") return;
    // The page that left is out of view once its exit has run.
    return scheduleSurfaceExit(
      () => setStageView((view) => (view.motion === "pop" ? { ...view, motion: "rest" } : view)),
      "--motion-stack",
    );
  }, [stageView]);

  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  const swipeZoneRef = useRef(swipeZone);
  swipeZoneRef.current = swipeZone;
  const stageRef = useRef(mobileStage);
  stageRef.current = mobileStage;
  // Native Back (Android) takes a phone page back to its list before it closes
  // Settings, like the Back button and Escape. Anything open over Settings (a
  // sheet or dialog a page opened) is not a page: Back closes Settings then.
  useEffect(() => {
    setSettingsBackHandler(() => {
      if (!mobile || stageRef.current !== "page" || !settingsOnTop(modalRef.current)) return false;
      setMobileStage("nav");
      return true;
    });
    return () => setSettingsBackHandler(null);
  }, [mobile]);
  const settingsNav = () => modalRef.current?.querySelector<HTMLElement>(":scope > .settings-nav") ?? null;

  // Back from a page follows the finger toward the inline end while the list
  // settles in behind it (edgeSwipeBack.ts); the release carries on into the
  // same pop a tap on Back plays.
  useEdgeSwipeBack({
    enabled: mobile && swipeZone !== null && mobileStage === "page",
    ...(swipeZone ? { zone: swipeZone } : {}),
    canStart: () => settingsOnTop(modalRef.current),
    layer: () => modalRef.current?.querySelector<HTMLElement>(":scope > .settings-pane") ?? null,
    under: settingsNav,
    underMotion: settingsNav,
    onBack: () => setMobileStage("nav"),
  });

  // Dismissal follows the finger toward the edge Settings came from: toward
  // the inline start when it took the Navigator's place (from either stage,
  // like the Navigator itself), toward the inline end for a pushed Settings
  // (from its list; a page goes Back first). A release past the commit point
  // hands its position and pace to the exit; anything else springs home.
  const closeSwipeOn = mobile && swipeZone !== null;
  useEffect(() => {
    if (!closeSwipeOn) return;
    return attachSwipeSurface({
      surface: () => modalRef.current,
      direction: origin === "start" ? "toward-start" : "toward-end",
      zone: () => swipeZoneRef.current ?? "edge",
      enabled: () => swipeZoneRef.current !== null
        && (origin === "start" || stageRef.current === "nav")
        && settingsOnTop(modalRef.current),
      motion: "--motion-stack",
      begin: ({ rtl }) => {
        const shell = modalRef.current;
        if (!shell) return null;
        // Physical direction of the travel: toward the edge Settings came from.
        const sign = (origin === "start" ? -1 : 1) * (rtl ? -1 : 1);
        // The entrance has long finished; it must never replay over the inline
        // transform when a drag that springs home lets go (see the CSS).
        shell.setAttribute("data-dragged", "");
        shell.setAttribute("data-swiping", "true");
        shell.style.willChange = "transform";
        const clear = () => {
          shell.removeAttribute("data-swiping");
          shell.style.removeProperty("transform");
          shell.style.removeProperty("will-change");
        };
        return {
          paint(travel) {
            shell.style.transform = `translate3d(${sign * travel}px, 0, 0)`;
          },
          cancel: clear,
          commit({ travel, settleMs }) {
            // The exit ghost carries these on (and the inline position until
            // its animation takes over); with motion off Settings just goes.
            shell.style.setProperty("--settings-from", `${sign * travel}px`);
            if (settleMs > 0) shell.style.setProperty("--settings-settle", `${settleMs}ms`);
            else parkLeavingLayer(shell, `translate3d(${sign * 100}%, 0, 0)`);
            closeSettings();
          },
        };
      },
    });
  }, [closeSwipeOn, origin]);

  // Phone stage swaps unmount the focused nav button / back button. Move focus
  // to the new stage's heading so focus never falls to <body>, where the
  // global shell Escape would close all of Settings instead of going back.
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current) { firstStage.current = false; return; }
    if (!mobile) return;
    const selector = mobileStage === "page" ? ".settings-mobile-title" : ".settings-mobile-nav-head [data-settings-focus-target]";
    const frame = requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mobile, mobileStage]);

  // Settings-scoped keys, captured before the global shell keymap:
  // Mod+K and "/" focus this search instead of opening the workspace palette;
  // an Escape whose focus has escaped the dialog still goes back/closes here.
  useEffect(() => {
    const focusSearch = () => {
      const focusInput = () => {
        const input = modalRef.current?.querySelector<HTMLInputElement>(".settings-nav-search");
        input?.focus();
        input?.select();
      };
      // Desktop: the input is mounted now, so focus synchronously and keys
      // typed right after the shortcut land in it. Phone: the nav stage must
      // mount first.
      if (!mobile) { focusInput(); return; }
      setMobileStage("nav");
      requestAnimationFrame(focusInput);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeComposing(e)) return;
      // A newer modal (package tour, confirm dialog) owns its own keys.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.length > 0 && modals[modals.length - 1] !== modalRef.current) return;
      const modK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target);
      if (modK || slash) {
        e.preventDefault();
        e.stopImmediatePropagation();
        focusSearch();
        return;
      }
      // First Escape in a non-empty search clears it. The dialog's native
      // Escape listener fires before React's, so this must run in capture.
      const searchInput = e.target instanceof HTMLInputElement && e.target.classList.contains("settings-nav-search")
        ? e.target
        : null;
      if (e.key === "Escape" && searchInput?.value) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFilter("");
        setCursor(0);
        return;
      }
      if (e.key === "Escape" && !(e.target instanceof Node && modalRef.current?.contains(e.target))) {
        const target = e.target as HTMLElement | null;
        if (target && target !== document.body && target !== document.documentElement) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        requestCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
  const guardrails = useGuardrails();
  const pages = useMemo<PageDef[]>(() => {
    // Built-in and workspace pages claim their ids first; a managed package page that asks
    // for a taken id keeps its slot id instead of shadowing the other page.
    const managed = (item: (typeof visibleSlotItems)[number]) =>
      typeof (item.meta as { pluginId?: unknown } | undefined)?.pluginId === "string";
    const taken = new Set<string>(BUILTIN.map((page) => page.id));
    for (const item of visibleSlotItems) {
      const pageId = (item.meta as { pageId?: unknown } | undefined)?.pageId;
      if (!managed(item) && typeof pageId === "string") taken.add(pageId);
    }
    const extra = visibleSlotItems.map((item): PageDef => {
      const meta = item.meta as {
        label?: unknown;
        group?: unknown;
        icon?: unknown;
        pageId?: unknown;
        nav?: unknown;
        redirect?: unknown;
      } | undefined;
      const group = meta?.group;
      let id = typeof meta?.pageId === "string" ? meta.pageId : `slot:${item.id}`;
      if (managed(item)) {
        if (taken.has(id)) id = `slot:${item.id}`;
        taken.add(id);
      }
      return {
        id,
        label: typeof meta?.label === "string"
          ? meta.label
          : item.id.replace(/^[^.]*\./, "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
        ...placePage(id, group === "Workspace" || group === "Engineering" || group === "Customize" || group === "System"
          ? group
          : "Customize"),
        ...(typeof meta?.icon === "string" ? { icon: meta.icon } : {}),
        ...(meta?.nav === false ? { nav: false } : {}),
        ...(meta?.redirect && typeof meta.redirect === "object" && typeof (meta.redirect as { pageId?: unknown }).pageId === "string"
          ? { redirect: meta.redirect as { pageId: string; target?: SettingsNavigationTarget } }
          : {}),
        render: (settingsTarget) => <>{item.render({ prefs, settingsTarget })}</>,
      };
    });
    return [...BUILTIN, ...extra].filter((page) => guardedSettingsPageVisible(guardrails, page.id)).sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
        || a.order - b.order
        || a.label.localeCompare(b.label),
    );
  }, [prefs, visibleSlotItems, guardrails]);

  useEffect(() => {
    const redirect = pages.find((page) => page.id === active)?.redirect;
    if (!redirect || !pages.some((page) => page.id === redirect.pageId)) return;
    setActive(redirect.pageId);
    setSettingsTarget(redirect.target);
    if (mobile) setMobileStage("page");
  }, [active, mobile, pages]);

  useEffect(() => {
    // A remembered package page registers after boot; keep waiting for it
    // until packages settle instead of falling back to the first page.
    if (!packagesSettled || pages.some((page) => page.id === active) || !pages[0]) return;
    setActive(pages[0].id);
    setSettingsTarget(undefined);
  }, [active, pages, packagesSettled]);

  useEffect(() => {
    // Only a phone has a meaningful stage; desktop keeps the stored one.
    if (!pages.some((page) => page.id === active && !page.redirect)) return;
    const stage = mobile ? mobileStage : readLastSettingsPage()?.stage ?? "nav";
    accountStorageSet(LAST_PAGE_KEY, JSON.stringify({ pageId: active, stage } satisfies LastSettingsPage));
  }, [active, mobile, mobileStage, pages]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const navigation = normalizeSettingsNavigation(
        typeof detail === "string"
          ? { pageId: detail }
          : detail && typeof detail === "object" && typeof (detail as { pageId?: unknown }).pageId === "string"
            ? detail as PendingSettingsNavigation
            : { pageId: "" },
      );
      if (!pages.some((page) => page.id === navigation.pageId)) return;
      consumePendingSettingsNavigation();
      setActive(navigation.pageId);
      setSettingsTarget(navigation.target);
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
  // Results grouped by page: every page whose title/synonyms match or that
  // owns a matching row gets a header entry (it opens the page), followed by
  // up to MAX_ITEMS_PER_PAGE row hits. Title matches rank first.
  const searchEntries = useMemo<SearchEntry[]>(() => {
    if (!q) return [];
    const itemHits = searchSettingsItems(q, pageLabels);
    const byPage = new Map<string, SettingsSearchHit[]>();
    for (const hit of itemHits) {
      const list = byPage.get(hit.item.pageId);
      if (list) list.push(hit);
      else byPage.set(hit.item.pageId, [hit]);
    }
    const ordered: PageDef[] = [];
    for (const page of searchSettingsPages(q, pages)) {
      if (!page.redirect) ordered.push(page);
    }
    for (const page of pages) {
      if (byPage.has(page.id) && !ordered.includes(page)) ordered.push(page);
    }
    const entries: SearchEntry[] = [];
    for (const page of ordered.slice(0, MAX_RESULT_PAGES)) {
      const hits = byPage.get(page.id) ?? [];
      entries.push({ kind: "page", page, hidden: Math.max(0, hits.length - MAX_ITEMS_PER_PAGE) });
      for (const hit of hits.slice(0, MAX_ITEMS_PER_PAGE)) entries.push({ kind: "item", hit });
    }
    return entries;
  }, [q, pageLabels, pages]);
  const resultCount = searchEntries.length;

  const current = pages.find((p) => p.id === active) ?? pages[0]!;
  const navPages = pages.filter((page) => page.nav !== false);
  const tourId = settingsPageToPackageId(current.id, visibleSlotItems);
  const tour = useSyncExternalStore(subscribePackageOnboardings, () => tourId ? getPackageOnboarding(tourId) : undefined, () => undefined);
  const tourHelp = tour && <IconButton icon={HelpIcon} label={tr("settings.packagespage.previewTheValueTour", { name: current.label })} onClick={() => openPackageTour(tour.packageId, "preview")} />;

  // A routed item target (openSettingsPage(page, { itemId })) lands on its
  // row: pages that own richer targeting may also read settingsTarget.
  const targetItemId = settingsTarget?.itemId;
  useEffect(() => {
    if (!targetItemId || typeof requestAnimationFrame !== "function") return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const row = [...(paneRef.current?.querySelectorAll<HTMLElement>("[data-settings-item]") ?? [])]
          .find((candidate) => candidate.dataset.settingsItem === targetItemId);
        if (!row) return;
        row.scrollIntoView({ block: "start" });
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1600);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [active, targetItemId]);

  const gotoItem = (hit: SettingsSearchHit) => {
    setActive(hit.item.pageId);
    setSettingsTarget(undefined);
    if (mobile) setMobileStage("page");
    setFilter("");
    setCursor(0);
    // Focus + flash after the page renders.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = paneRef.current?.querySelector<HTMLElement>(`[data-settings-item="${hit.item.focusTarget}"]`);
        // A row behind one of the page's own tabs is not rendered yet: hand
        // the page the item as its target so it can reveal it; the routed
        // target effect above then scrolls to it and flashes it.
        if (!row) {
          setSettingsTarget({ itemId: hit.item.focusTarget });
          return;
        }
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1600);
        row.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
      });
    });
  };

  const gotoPage = (id: string) => {
    setActive(id);
    setSettingsTarget(undefined);
    if (mobile) setMobileStage("page");
    setFilter("");
    setCursor(0);
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
      const entry = searchEntries[cursor];
      if (entry) openEntry(entry);
    }
  };
  const openEntry = (entry: SearchEntry) => {
    if (entry.kind === "item") gotoItem(entry.hit);
    else gotoPage(entry.page.id);
  };
  const clearSearch = () => {
    setFilter("");
    setCursor(0);
    modalRef.current?.querySelector<HTMLInputElement>(".settings-nav-search")?.focus();
  };
  const navigateTo = (id: string) => {
    setActive(id);
    setSettingsTarget(undefined);
    if (mobile) setMobileStage("page");
  };
  const searchHint = tr("settingsview.searchPlaceholder");
  const shortcutHint = `${modKeyLabel()}${modKeyLabel() === "⌘" ? "" : "+"}K`;
  const activeOption = q && resultCount > 0 ? `settings-search-option-${cursor}` : undefined;

  return (
    <div ref={scrimGhostRef} className="scrim settings-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeSettings(); }}>
      <div
        className={`modal settings-shell settings-page-${current.id}${mobile ? ` settings-mobile-${mobileStage}` : ""}`}
        data-origin={origin}
        data-stage-motion={mobile ? stageMotion : undefined}
        ref={modalRef}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={tr("common.settings")}
        aria-describedby={mobile ? undefined : "settings-close-hint"}
      >
        <div className="modal-nav settings-nav">
          <div className="settings-mobile-nav-head">
            <strong data-settings-focus-target tabIndex={-1}>{tr("common.settings")}</strong>
            <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
          </div>
          <div className={`settings-nav-search-shell${mobile ? " ui-field-well" : ""}${filter ? " has-query" : ""}`}>
            <span className="settings-nav-search-icon" aria-hidden="true">
              <Icon icon={SearchIcon} size="sm" />
            </span>
            <TextInput
              className="settings-nav-search"
              uiSize="sm"
              type="search"
              value={filter}
              placeholder={searchHint}
              onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
              onKeyDown={onSearchKey}
              aria-label={tr("settingsview.searchSettings")}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={q ? true : false}
              aria-controls={q ? "settings-search-results" : undefined}
              aria-activedescendant={activeOption}
              autoComplete="off"
              spellCheck={false}
            />
            {filter ? (
              <IconButton className="settings-nav-search-clear" icon={CloseIcon} size="sm" label={tr("settingsview.clearSearch")} onClick={clearSearch} />
            ) : (
              !mobile && <kbd className="settings-nav-search-kbd" aria-hidden="true">{shortcutHint}</kbd>
            )}
          </div>
          {q ? (
            <div className="settings-results" id="settings-search-results" role="listbox" aria-label={tr("settingsview.settingsSearchResults")}>
              {searchEntries.map((entry, i) => entry.kind === "page" ? (
                <button
                  key={`page:${entry.page.id}`}
                  id={`settings-search-option-${i}`}
                  type="button"
                  tabIndex={-1}
                  className={`settings-result settings-result-pagehead${cursor === i ? " cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === i}
                  onClick={() => openEntry(entry)}
                  onPointerMove={() => setCursor(i)}
                >
                  <span className="settings-result-icon" aria-hidden="true"><SettingsNavIcon pageId={entry.page.id} icon={entry.page.icon} /></span>
                  <span className="settings-result-label">{entry.page.label}</span>
                  <span className="settings-result-page">
                    {entry.hidden > 0 ? tr("settingsview.moreInPage", { count: entry.hidden }) : tr("settingsview.pageResult")}
                  </span>
                </button>
              ) : (
                <button
                  key={`item:${entry.hit.item.id}`}
                  id={`settings-search-option-${i}`}
                  type="button"
                  tabIndex={-1}
                  className={`settings-result settings-result-item${cursor === i ? " cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === i}
                  onClick={() => openEntry(entry)}
                  onPointerMove={() => setCursor(i)}
                >
                  <span className="settings-result-label">{entry.hit.item.label}</span>
                  {entry.hit.item.description && <span className="settings-result-hint">{entry.hit.item.description}</span>}
                </button>
              ))}
              {resultCount === 0 && (
                <div className="settings-results-empty" role="status">
                  <strong>{tr("settingsview.noMatchesFor", { query: q })}</strong>
                  <span>{tr("settingsview.noMatchesHint")}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={clearSearch}>{tr("settingsview.clearSearch")}</Button>
                </div>
              )}
            </div>
          ) : (
            <nav className="settings-nav-list" aria-label={tr("settingsview.settingsPages")} aria-busy={!packagesSettled || undefined}>
              {packagesSettled ? GROUP_ORDER.map((group) => {
                const groupPages = navPages.filter((page) => page.group === group);
                if (groupPages.length === 0) return null;
                return (
                  <section className="settings-nav-section" key={group} aria-labelledby={`settings-nav-group-${group}`}>
                    <div className="settings-nav-group" id={`settings-nav-group-${group}`}>{GROUP_LABELS[group]}</div>
                    <div className="settings-nav-group-list">
                      {groupPages.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`settings-nav-item ${current.id === p.id ? "active" : ""}`}
                          aria-current={current.id === p.id ? "page" : undefined}
                          onClick={() => navigateTo(p.id)}
                        >
                          <span className="settings-nav-icon" aria-hidden="true"><SettingsNavIcon pageId={p.id} icon={p.icon} /></span>
                          <span className="settings-nav-label">{p.label}</span>
                          <Icon icon={ChevronRightIcon} size="sm" className="settings-nav-chevron" />
                        </button>
                      ))}
                    </div>
                  </section>
                );
              }) : (
                <div className="settings-nav-skeleton" role="status" aria-label={tr("settingsview.loadingPages")}>
                  {Array.from({ length: NAV_SKELETON_ROWS }, (_, i) => (
                    <span key={i} className={`settings-nav-skeleton-row${i % 5 === 0 ? " is-group" : ""}`} aria-hidden="true" />
                  ))}
                </div>
              )}
            </nav>
          )}
          <div className="nav-foot">
            <SlotHost slot="settings.footer" />
          </div>
        </div>
        <div className="modal-main settings-pane">
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
                <h1 className="settings-mobile-title" tabIndex={-1}>{current.label}</h1>
                <div className="settings-pane-head-actions">
                  <span className="settings-head-help-slot">{tourHelp}</span>
                  <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
                </div>
              </div>
            ) : (
              <>
                <div className="settings-pane-head-copy">
                  <h1 className="modal-title settings-pane-title" data-settings-focus-target tabIndex={-1}>
                    {current.label}
                  </h1>
                </div>
                <div className="settings-pane-head-actions">
                  <span className="dialog-hint" id="settings-close-hint"><kbd>{tr("settingsview.esc")}</kbd> {tr("settingsview.close")}</span>
                  {/* Fixed-width slot: the close button never shifts between
                      pages with and without a package tour. */}
                  <span className="settings-head-help-slot">{tourHelp}</span>
                  <IconButton icon={CloseIcon} label={tr("common.close")} onClick={closeSettings} />
                </div>
              </>
            )}
          </div>
          <div className="modal-body settings-pane-body" ref={paneRef}>
            {/* A page that throws must not white-screen the whole app —
                Settings renders outside App's main view boundary. */}
            <div className="settings-page-stage" key={current.id}>
              <ViewErrorBoundary resetKey={`${current.id}:${settingsTarget?.itemId ?? ""}:${settingsTarget?.sectionId ?? ""}`} inline>{current.render(settingsTarget)}</ViewErrorBoundary>
            </div>
          </div>
        </div>
      </div>
      {/* Package tour layers above the settings modal; renders null when closed. */}
      <PackageTourOverlay />
    </div>
  );
}
