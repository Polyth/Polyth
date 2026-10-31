// The first-open interface tour. After sign-in the shell walks
// a new account through the workspace with a spotlight and an arrow pointing at
// the real controls: the composer (work can start at once, in the personal
// project — no folder to choose), the chat list and the optional add-project
// button, the top and right tool rails, drag-to-move, and the functional /
// visual customization entry points.
//
// Ownership: the step list, the account-synced "seen" record, the admission
// decision and the pure placement geometry live here; App executes the
// decision and ShellIntroTour renders it. The record is a UI preference
// (`core.shell-intro` in settingsSync.ts), never session history.
//
// Any close — Done, Skip, Escape, an in-tour shortcut — marks the tour seen, so
// it is shown once per account. It can be replayed from the user menu or the
// command palette ("Interface tour"). The add-project step's button suspends
// the tour instead: once the project dialog closes it picks up again, on a
// "your project is ready" step when a project was added, else on the next step.
import type { TranslationKey } from "./i18n/types.ts";

export const SHELL_INTRO_PREFS_KEY = "polyth.shellIntro.v1";
export const SHELL_INTRO_PREFERENCE_ID = "core.shell-intro";
/** Bump to show a substantially reworked tour to accounts that saw an older one. */
export const SHELL_INTRO_VERSION = 1;
/** Pause between the add-project dialog closing and the tour resuming. */
export const SHELL_INTRO_RESUME_DELAY_MS = 360;

export type ShellIntroPlacement = "right" | "left" | "bottom" | "top";
export type ShellIntroArt = "shell" | "drag";
export type ShellIntroStepId =
  | "welcome"
  | "start"
  | "projects"
  | "add-project"
  | "project-ready"
  | "top-rail"
  | "right-rail"
  | "drag"
  | "customize"
  | "appearance";

export interface ShellIntroStep {
  id: ShellIntroStepId;
  title: TranslationKey;
  body: TranslationKey;
  /** CSS selectors tried in order; the first visible element is the target.
   *  An empty list, or no visible match, centres the card without an arrow. */
  anchors: readonly string[];
  /** Side of the target the card prefers when it fits there. */
  prefer: ShellIntroPlacement;
  art?: ShellIntroArt;
  /** Phone shell differences: projects sit behind the navigation button,
   *  tools open as full-screen layers, and there is no right rail or Edit
   *  mode. "skip" drops a step that has nothing to point at there. */
  phone?: "skip" | { title?: TranslationKey; body?: TranslationKey; anchors?: readonly string[] };
  /** Shown only when the tour resumes after the person added a project. */
  onlyAfterProjectAdded?: boolean;
  /** A wide window whose tools left the top bar (Window layout "No bar"):
   *  one launcher strip holds every tool, so the two rail steps become one.
   *  "skip" drops a step that has nothing to point at there. */
  barless?: "skip" | { title?: TranslationKey; body?: TranslationKey; anchors?: readonly string[] };
}

// Anchors name real shell controls. Desktop selectors come first; tablet
// fallbacks follow (the project rail lives in a drawer there, so the drawer
// trigger stands in for it). Phone targets and copy are in `phone`.
// `data-intro-anchor` marks controls whose class alone is ambiguous.
export const SHELL_INTRO_STEPS: readonly ShellIntroStep[] = [
  {
    id: "welcome",
    title: "shellintro.welcomeTitle",
    body: "shellintro.welcomeBody",
    anchors: [],
    prefer: "bottom",
    art: "shell",
  },
  {
    id: "start",
    title: "shellintro.startTitle",
    body: "shellintro.startBody",
    // The visible card, not the full-width dock around it.
    anchors: [".composer-chat .composer-card", ".composer"],
    prefer: "top",
  },
  {
    id: "projects",
    title: "shellintro.projectsTitle",
    body: "shellintro.projectsBody",
    // The whole Navigator: a new account's chats list flat in its sessions
    // column, and projects added later join the rail beside them.
    anchors: [
      ".sidebar:not(.collapsed) .sidebar-expanded-shell",
      ".sidebar-collapsed-rail",
      ".header-drawer-btn",
    ],
    prefer: "right",
    phone: {
      title: "shellintro.projectsPhoneTitle",
      body: "shellintro.projectsPhoneBody",
      anchors: [".mobile-float-navigation"],
    },
  },
  {
    id: "add-project",
    title: "shellintro.addProjectTitle",
    body: "shellintro.addProjectBody",
    anchors: [
      "[data-intro-anchor=\"add-project\"]",
      ".sidebar-add-project",
      ".sidebar .empty-state-action",
      ".header-drawer-btn",
    ],
    prefer: "right",
    phone: { body: "shellintro.addProjectPhoneBody", anchors: [".mobile-float-navigation"] },
  },
  {
    id: "project-ready",
    title: "shellintro.projectReadyTitle",
    body: "shellintro.projectReadyBody",
    // The new project is the active one: its rail tile, else its card.
    anchors: [
      ".sidebar-project-rail-item.active",
      ".project-card.active",
      ".header-drawer-btn",
    ],
    prefer: "right",
    onlyAfterProjectAdded: true,
    phone: { body: "shellintro.projectReadyPhoneBody", anchors: [".mobile-float-navigation"] },
  },
  {
    id: "top-rail",
    title: "shellintro.topRailTitle",
    body: "shellintro.topRailBody",
    anchors: [".view-switcher-pill", ".mobile-shortcut-rail"],
    prefer: "bottom",
    phone: {
      title: "shellintro.toolsPhoneTitle",
      body: "shellintro.toolsPhoneBody",
      anchors: ["[data-workspace-trigger]", ".mobile-float-actions"],
    },
    // The strip when it holds the tools (docked `end`, the default), else the
    // column that does; a project without tools there (the Personal one)
    // points at the strip's launchers. An empty dock is a sliver, never a target.
    barless: {
      title: "shellintro.toolsTitle",
      anchors: [
        ".plugin-strip:has(.shell-dock--tools [data-rail-item])",
        ".shell-dock--tools:has([data-rail-item])",
        ".plugin-strip",
      ],
    },
  },
  {
    id: "right-rail",
    title: "shellintro.rightRailTitle",
    body: "shellintro.rightRailBody",
    anchors: [".plugin-strip"],
    prefer: "left",
    phone: "skip",
    barless: "skip",
  },
  {
    id: "drag",
    title: "shellintro.dragTitle",
    body: "shellintro.dragBody",
    anchors: [".view-switcher-pill", ".plugin-strip", ".mobile-shortcut-rail"],
    prefer: "bottom",
    art: "drag",
    phone: "skip",
  },
  {
    id: "customize",
    title: "shellintro.customizeTitle",
    body: "shellintro.customizeBody",
    anchors: [".header-profile"],
    prefer: "bottom",
    phone: { body: "shellintro.customizePhoneBody", anchors: [] },
  },
  {
    id: "appearance",
    title: "shellintro.appearanceTitle",
    body: "shellintro.appearanceBody",
    anchors: [
      // The Settings rail item (`shell.settings`) wherever it lives.
      "[data-intro-anchor=\"settings\"]",
      "[data-rail-item=\"widget:shell.settings\"]",
      ".mobile-shortcut-settings",
      ".header-profile",
    ],
    prefer: "right",
  },
];

/** The steps this account and shell can act on: without permission to add
 *  projects the add-project step would point at a control that is not there,
 *  without any project there is no composer for the start step,
 *  and the phone shell and a wide window without the top bar (`barless`:
 *  its tools are docked into a column) swap in their own targets and copy. */
export function shellIntroSteps(options: {
  canAddProject: boolean;
  phone?: boolean;
  barless?: boolean;
  /** False while the registry holds no project (no Personal project could be
   *  made): there is no composer to start in, so that step is left out. */
  hasProject?: boolean;
  /** The tour resumed after the person added a project from it. */
  projectAdded?: boolean;
}): readonly ShellIntroStep[] {
  const steps: ShellIntroStep[] = [];
  for (const step of SHELL_INTRO_STEPS) {
    if (!options.canAddProject && step.id === "add-project") continue;
    if (step.onlyAfterProjectAdded && !options.projectAdded) continue;
    if (options.hasProject === false && step.id === "start") continue;
    const variant = options.phone ? step.phone : options.barless ? step.barless : undefined;
    if (!variant) {
      steps.push(step);
      continue;
    }
    if (variant === "skip") continue;
    steps.push({
      ...step,
      title: variant.title ?? step.title,
      body: variant.body ?? step.body,
      anchors: variant.anchors ?? step.anchors,
    });
  }
  return steps;
}

/** Where a resumed tour lands: the first rendered step after `afterId` in tour
 *  order. Indexing by id, not by the old position, keeps it right when the
 *  step list changed meanwhile (a project now exists, the layout moved). */
export function shellIntroResumeIndex(steps: readonly ShellIntroStep[], afterId: ShellIntroStepId): number {
  const order = (id: ShellIntroStepId): number => SHELL_INTRO_STEPS.findIndex((step) => step.id === id);
  const after = order(afterId);
  const index = steps.findIndex((step) => order(step.id) > after);
  return index >= 0 ? index : Math.max(0, steps.length - 1);
}

// ---- account-synced record ------------------------------------------------------

export interface ShellIntroPrefs {
  /** Highest tour version the account finished or dismissed; 0 = never. */
  seenVersion: number;
}

export function parseShellIntroPrefs(raw: string | null): ShellIntroPrefs {
  try {
    const data = JSON.parse(raw ?? "") as { seenVersion?: unknown } | null;
    const version = data && typeof data === "object" ? data.seenVersion : undefined;
    return {
      seenVersion: typeof version === "number" && Number.isInteger(version) && version > 0 ? version : 0,
    };
  } catch {
    return { seenVersion: 0 };
  }
}

const readPrefs = (): string | null => {
  try { return localStorage.getItem(SHELL_INTRO_PREFS_KEY); } catch { return null; }
};

let prefsCache: ShellIntroPrefs | null = null;
const prefsListeners = new Set<() => void>();

export function getShellIntroPrefs(): ShellIntroPrefs {
  prefsCache ??= parseShellIntroPrefs(readPrefs());
  return prefsCache;
}

export function replaceShellIntroPrefs(value: unknown): void {
  const next = parseShellIntroPrefs(JSON.stringify(value));
  // Seen is monotonic: a stale device cannot bring the tour back.
  if (next.seenVersion < getShellIntroPrefs().seenVersion) return;
  savePrefs(next);
}

export function subscribeShellIntroPrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => { prefsListeners.delete(listener); };
}

function savePrefs(next: ShellIntroPrefs): void {
  if (prefsCache && prefsCache.seenVersion === next.seenVersion) return;
  prefsCache = next;
  try { localStorage.setItem(SHELL_INTRO_PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of [...prefsListeners]) listener();
}

export function markShellIntroSeen(): void {
  if (getShellIntroPrefs().seenVersion >= SHELL_INTRO_VERSION) return;
  savePrefs({ seenVersion: SHELL_INTRO_VERSION });
}

export function isShellIntroSeen(): boolean {
  return getShellIntroPrefs().seenVersion >= SHELL_INTRO_VERSION;
}

// ---- admission ------------------------------------------------------------------

export type ShellIntroAdmission = "wait" | "open" | "done";

export interface ShellIntroAdmissionInput {
  /** The account settings snapshot has been applied (or could not be fetched). */
  settingsSettled: boolean;
  seen: boolean;
  registryStatus: "loading" | "failed" | "ready";
  /** Another overlay is open; the tour never stacks over one. */
  overlayOpen: boolean;
  /** The tour already opened automatically in this document. */
  offeredThisDocument: boolean;
}

/** `done` releases the first-run project picker; `wait` holds it, so a new
 *  account sees the tour first and the picker right after it. A failed
 *  registry is a recovery screen, not a tour moment. */
export function decideShellIntroAdmission(input: ShellIntroAdmissionInput): ShellIntroAdmission {
  if (input.seen || input.offeredThisDocument) return "done";
  if (!input.settingsSettled || input.registryStatus === "loading") return "wait";
  if (input.registryStatus === "failed") return "done";
  return input.overlayOpen ? "wait" : "open";
}

// ---- open/step state --------------------------------------------------------------

export interface ShellIntroState {
  step: number;
  /** Opened by the first-run coordinator rather than replayed by the user. */
  auto: boolean;
  /** Set by a resume until the next step change: the tour shows the first
   *  step after this one, resolved against the list it renders. */
  resumeAfter?: ShellIntroStepId;
  /** The tour resumed after the person added a project from it. */
  projectAdded?: boolean;
}

/** A tour paused while the person adds a project from its add-project step. */
interface SuspendedShellIntro {
  after: ShellIntroStepId;
  auto: boolean;
  /** Projects that existed when the tour paused; a new id means one was added. */
  projectIds: readonly string[];
}

let state: ShellIntroState | null = null;
let suspended: SuspendedShellIntro | null = null;
let offeredThisDocument = false;
const stateListeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...stateListeners]) listener();
}

export function getShellIntroState(): ShellIntroState | null {
  return state;
}

export function subscribeShellIntro(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function wasShellIntroOffered(): boolean {
  return offeredThisDocument;
}

export function openShellIntro(options: { auto?: boolean } = {}): void {
  if (options.auto) offeredThisDocument = true;
  suspended = null;
  state = { step: 0, auto: options.auto === true };
  emit();
}

/** Steps are indexed against the list the tour renders (see `shellIntroSteps`),
 *  so the caller passes its length. */
export function setShellIntroStep(step: number, total: number): void {
  if (!state) return;
  const next = Math.max(0, Math.min(total - 1, step));
  if (next === state.step && !state.resumeAfter) return;
  state = { step: next, auto: state.auto, ...(state.projectAdded ? { projectAdded: true } : {}) };
  emit();
}

/** Pause the tour while the person acts on a step (the add-project dialog).
 *  It counts as seen — a reload does not restart it — and App resumes it in
 *  this document once no overlay is open. */
export function suspendShellIntro(after: ShellIntroStepId, projectIds: readonly string[]): void {
  if (!state) return;
  suspended = { after, auto: state.auto, projectIds: [...projectIds] };
  state = null;
  markShellIntroSeen();
  emit();
}

export function isShellIntroSuspended(): boolean {
  return suspended !== null;
}

/** Continue a suspended tour after the step it paused on. `projectIds` is the
 *  registry now; any id it did not have before means a project was added. */
export function resumeShellIntro(projectIds: readonly string[]): void {
  if (!suspended || state) return;
  const before = new Set(suspended.projectIds);
  const projectAdded = projectIds.some((id) => !before.has(id));
  state = {
    step: 0,
    auto: suspended.auto,
    resumeAfter: suspended.after,
    ...(projectAdded ? { projectAdded: true } : {}),
  };
  suspended = null;
  emit();
}

export function closeShellIntro(): void {
  if (!state) return;
  state = null;
  markShellIntroSeen();
  emit();
}

/** Test seam only. */
export function resetShellIntroForTest(): void {
  state = null;
  suspended = null;
  offeredThisDocument = false;
  prefsCache = null;
  stateListeners.clear();
  prefsListeners.clear();
}

// ---- geometry -----------------------------------------------------------------------

export interface IntroRect { left: number; top: number; width: number; height: number }
export interface IntroSize { width: number; height: number }
export interface IntroPoint { x: number; y: number }

/** Room the arrow needs between the card and its target. */
export const INTRO_ARROW_GAP = 56;
export const INTRO_VIEWPORT_MARGIN = 12;

const clamp = (value: number, min: number, max: number): number =>
  max < min ? min : Math.min(Math.max(value, min), max);

function placementOrder(prefer: ShellIntroPlacement): ShellIntroPlacement[] {
  const opposite: Record<ShellIntroPlacement, ShellIntroPlacement> = {
    right: "left", left: "right", bottom: "top", top: "bottom",
  };
  const cross: ShellIntroPlacement[] = prefer === "right" || prefer === "left"
    ? ["bottom", "top"]
    : ["right", "left"];
  return [prefer, opposite[prefer], ...cross];
}

export interface IntroCardPlacement {
  side: ShellIntroPlacement | "center";
  left: number;
  top: number;
}

/** Put the card beside its target on the first side with room for the card
 *  plus the arrow gap, sliding along that side to stay on screen. Without a
 *  target, or when no side fits (a phone with a tall target), the card centres
 *  in the half of the viewport away from the target. */
export function placeIntroCard(
  target: IntroRect | null,
  card: IntroSize,
  viewport: IntroSize,
  prefer: ShellIntroPlacement,
): IntroCardPlacement {
  const m = INTRO_VIEWPORT_MARGIN;
  const centeredLeft = clamp((viewport.width - card.width) / 2, m, viewport.width - card.width - m);
  if (!target) {
    return { side: "center", left: centeredLeft, top: clamp((viewport.height - card.height) / 2, m, viewport.height - card.height - m) };
  }
  const gap = INTRO_ARROW_GAP;
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const alongY = clamp(target.top + target.height / 2 - card.height / 2, m, viewport.height - card.height - m);
  const alongX = clamp(target.left + target.width / 2 - card.width / 2, m, viewport.width - card.width - m);
  for (const side of placementOrder(prefer)) {
    if (side === "right" && right + gap + card.width + m <= viewport.width) {
      return { side, left: right + gap, top: alongY };
    }
    if (side === "left" && target.left - gap - card.width >= m) {
      return { side, left: target.left - gap - card.width, top: alongY };
    }
    if (side === "bottom" && bottom + gap + card.height + m <= viewport.height) {
      return { side, left: alongX, top: bottom + gap };
    }
    if (side === "top" && target.top - gap - card.height >= m) {
      return { side, left: alongX, top: target.top - gap - card.height };
    }
  }
  // Nothing fits beside the target: use the larger free band above or below.
  const targetMiddle = target.top + target.height / 2;
  const top = targetMiddle < viewport.height / 2
    ? viewport.height - card.height - m
    : m;
  return { side: "center", left: centeredLeft, top: clamp(top, m, viewport.height - card.height - m) };
}

function nearestPoint(rect: IntroRect, point: IntroPoint): IntroPoint {
  return {
    x: clamp(point.x, rect.left, rect.left + rect.width),
    y: clamp(point.y, rect.top, rect.top + rect.height),
  };
}

function centre(rect: IntroRect): IntroPoint {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export interface IntroArrow {
  /** The curved shaft. */
  line: string;
  /** The open chevron at the target end, drawn separately so it can appear
   *  after the shaft finishes drawing. */
  head: string;
}

/** A gently curved arrow from the card's edge to the target's edge, as SVG
 *  paths in viewport coordinates. Returns null when the two overlap or touch. */
export function introArrowPath(card: IntroRect, target: IntroRect, inset = 10): IntroArrow | null {
  const targetCentre = centre(target);
  const start = nearestPoint(card, targetCentre);
  const padded: IntroRect = {
    left: target.left - inset,
    top: target.top - inset,
    width: target.width + inset * 2,
    height: target.height + inset * 2,
  };
  const end = nearestPoint(padded, start);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 24) return null;
  // Bow the line sideways by a fraction of its length so it reads as a
  // hand-drawn pointer rather than a connector.
  const bow = Math.min(64, length * 0.22);
  const cx = start.x + dx / 2 - (dy / length) * bow;
  const cy = start.y + dy / 2 + (dx / length) * bow;
  const r = (n: number): number => Math.round(n * 10) / 10;
  // The head follows the curve's final tangent (control point → end).
  const tx = end.x - cx;
  const ty = end.y - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const size = 11;
  const spread = 0.55;
  const back = { x: end.x - ux * size, y: end.y - uy * size };
  const wing1 = { x: back.x - uy * size * spread, y: back.y + ux * size * spread };
  const wing2 = { x: back.x + uy * size * spread, y: back.y - ux * size * spread };
  return {
    line: `M ${r(start.x)} ${r(start.y)} Q ${r(cx)} ${r(cy)} ${r(end.x)} ${r(end.y)}`,
    head: `M ${r(wing1.x)} ${r(wing1.y)} L ${r(end.x)} ${r(end.y)} L ${r(wing2.x)} ${r(wing2.y)}`,
  };
}

/** First anchor selector whose element is rendered and on screen. */
export function resolveIntroAnchor(
  selectors: readonly string[],
  root: ParentNode,
  viewport: IntroSize,
): HTMLElement | null {
  for (const selector of selectors) {
    let elements: HTMLElement[];
    try { elements = [...root.querySelectorAll<HTMLElement>(selector)]; } catch { continue; }
    for (const element of elements) {
      // Kept-alive but hidden surfaces (a closed drawer, a folded tool) are
      // not anchors. The tour's own modal isolation marks the shell
      // aria-hidden, so visibility is judged by rendering, not by ARIA.
      if (typeof element.checkVisibility === "function"
        && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewport.width || rect.top >= viewport.height) continue;
      return element;
    }
  }
  return null;
}
