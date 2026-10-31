export type HeroWidgetId = "starters" | "recent" | "apps";

/** Which projects the fresh-chat Recent list draws from. */
export type HeroRecentScope = "current" | "all" | "selected";
/** Status filter: every session, only live/attention work, or only unread. */
export type HeroRecentFilter = "all" | "active" | "unread";
export type HeroRecentSize = "sm" | "md" | "lg";

export interface HeroRecentPrefs {
  limit: number;
  filter: HeroRecentFilter;
  /** Delegated child sessions (parentId) are nested under their parent in the
   *  navigator, so Recent leaves them out unless asked. */
  subagents: boolean;
  scope: HeroRecentScope;
  /** Used only when scope is "selected". */
  projectIds: string[];
  size: HeroRecentSize;
}

/** Fixed pieces of the new-chat screen. They are not reorderable widgets,
 *  but each can be switched off from the screen's Customize panel. */
export interface HeroChromePrefs {
  /** The "What are we working on in <project>." headline. */
  greeting: boolean;
  /** The project / repositories / checkout row above a fresh composer. */
  location: boolean;
  /** The Isolate switch in that row (shown only when the project offers it).
   *  Hiding it never changes the value: the project's default still applies. */
  isolation: boolean;
}

/** The Apps widget: package windows pinned onto the screen as icon tiles. */
export interface HeroAppsPrefs {
  /** Capability ids in display order. A package that is not loaded keeps its
   *  place here and simply does not render until it returns. */
  ids: string[];
  /** Name under each tile. */
  labels: boolean;
}

export interface HeroWidgetPrefs {
  order: HeroWidgetId[];
  hidden: HeroWidgetId[];
  recent: HeroRecentPrefs;
  chrome: HeroChromePrefs;
  apps: HeroAppsPrefs;
}

export const HERO_WIDGET_KEY = "polyth.heroWidgets.v1";
export const HERO_WIDGET_IDS: readonly HeroWidgetId[] = ["starters", "recent", "apps"];
export const HERO_RECENT_LIMITS: readonly number[] = [3, 5, 8, 12];
export const HERO_RECENT_DEFAULTS: HeroRecentPrefs = {
  limit: 3,
  filter: "all",
  subagents: false,
  scope: "current",
  projectIds: [],
  size: "md",
};
export const HERO_CHROME_DEFAULTS: HeroChromePrefs = { greeting: true, location: true, isolation: true };
/** No apps pinned: the widget renders nothing until the user picks some. */
export const HERO_APPS_DEFAULTS: HeroAppsPrefs = { ids: [], labels: true };
const FILTERS: readonly HeroRecentFilter[] = ["all", "active", "unread"];
const SCOPES: readonly HeroRecentScope[] = ["current", "all", "selected"];
const SIZES: readonly HeroRecentSize[] = ["sm", "md", "lg"];
const listeners = new Set<() => void>();

function defaults(): HeroWidgetPrefs {
  return {
    order: [...HERO_WIDGET_IDS],
    hidden: [],
    recent: { ...HERO_RECENT_DEFAULTS, projectIds: [] },
    chrome: { ...HERO_CHROME_DEFAULTS },
    apps: { ...HERO_APPS_DEFAULTS, ids: [] },
  };
}

function widgetIds(value: unknown): HeroWidgetId[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is HeroWidgetId => HERO_WIDGET_IDS.includes(id as HeroWidgetId)))]
    : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** Tolerant reader: unknown or missing fields fall back to the defaults so an
 *  older synced value (no `recent`) or a hand-edited one never breaks the hero. */
export function normalizeHeroRecentPrefs(value: unknown): HeroRecentPrefs {
  const raw = value && typeof value === "object" ? value as Partial<Record<keyof HeroRecentPrefs, unknown>> : {};
  const limit = typeof raw.limit === "number" && HERO_RECENT_LIMITS.includes(raw.limit) ? raw.limit : HERO_RECENT_DEFAULTS.limit;
  return {
    limit,
    filter: oneOf(raw.filter, FILTERS, HERO_RECENT_DEFAULTS.filter),
    subagents: typeof raw.subagents === "boolean" ? raw.subagents : HERO_RECENT_DEFAULTS.subagents,
    scope: oneOf(raw.scope, SCOPES, HERO_RECENT_DEFAULTS.scope),
    projectIds: Array.isArray(raw.projectIds)
      ? [...new Set(raw.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [],
    size: oneOf(raw.size, SIZES, HERO_RECENT_DEFAULTS.size),
  };
}

export function normalizeHeroChromePrefs(value: unknown): HeroChromePrefs {
  const raw = value && typeof value === "object" ? value as Partial<Record<keyof HeroChromePrefs, unknown>> : {};
  const flag = (key: keyof HeroChromePrefs) => typeof raw[key] === "boolean" ? raw[key] as boolean : HERO_CHROME_DEFAULTS[key];
  return { greeting: flag("greeting"), location: flag("location"), isolation: flag("isolation") };
}

export function normalizeHeroAppsPrefs(value: unknown): HeroAppsPrefs {
  const raw = value && typeof value === "object" ? value as Partial<Record<keyof HeroAppsPrefs, unknown>> : {};
  return {
    ids: Array.isArray(raw.ids)
      ? [...new Set(raw.ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [],
    labels: typeof raw.labels === "boolean" ? raw.labels : HERO_APPS_DEFAULTS.labels,
  };
}

export function isDefaultHeroRecentPrefs(value: HeroRecentPrefs): boolean {
  const base = HERO_RECENT_DEFAULTS;
  return value.limit === base.limit
    && value.filter === base.filter
    && value.subagents === base.subagents
    && value.scope === base.scope
    && value.size === base.size
    && (value.scope !== "selected" || value.projectIds.length === 0);
}

/** Everything on the screen is as shipped: the built-in widgets shown in
 *  their original order, Recent untouched, no apps pinned, and every fixed
 *  piece on. */
export function isDefaultHeroWidgetPrefs(value: HeroWidgetPrefs): boolean {
  return value.hidden.length === 0
    && value.order.every((id, index) => id === HERO_WIDGET_IDS[index])
    && isDefaultHeroRecentPrefs(value.recent)
    && value.apps.ids.length === 0
    && value.apps.labels === HERO_APPS_DEFAULTS.labels
    && (Object.keys(HERO_CHROME_DEFAULTS) as Array<keyof HeroChromePrefs>)
      .every((key) => value.chrome[key] === HERO_CHROME_DEFAULTS[key]);
}

/** The shipped arrangement. Recent's chosen projects survive so switching
 *  back to Selected later starts from the same set. */
export function defaultHeroWidgetPrefs(current: HeroWidgetPrefs = prefs): HeroWidgetPrefs {
  return { ...defaults(), recent: { ...HERO_RECENT_DEFAULTS, projectIds: current.recent.projectIds } };
}

function read(): HeroWidgetPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(HERO_WIDGET_KEY) ?? "") as Partial<HeroWidgetPrefs>;
    const order = widgetIds(raw.order);
    return {
      order: [...order, ...HERO_WIDGET_IDS.filter((id) => !order.includes(id))],
      hidden: widgetIds(raw.hidden),
      recent: normalizeHeroRecentPrefs(raw.recent),
      chrome: normalizeHeroChromePrefs(raw.chrome),
      apps: normalizeHeroAppsPrefs(raw.apps),
    };
  } catch {
    return defaults();
  }
}

let prefs = read();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getHeroWidgetPrefs(): HeroWidgetPrefs {
  return prefs;
}

export function setHeroWidgetPrefs(value: HeroWidgetPrefs): void {
  const order = [...new Set(value.order)].filter((id) => HERO_WIDGET_IDS.includes(id));
  prefs = {
    // A widget newer than the stored order (or a synced value from an older
    // client) joins at the end rather than vanishing from the list.
    order: [...order, ...HERO_WIDGET_IDS.filter((id) => !order.includes(id))],
    hidden: [...new Set(value.hidden)].filter((id) => HERO_WIDGET_IDS.includes(id)),
    recent: normalizeHeroRecentPrefs(value.recent),
    chrome: normalizeHeroChromePrefs(value.chrome),
    apps: normalizeHeroAppsPrefs(value.apps),
  };
  try { localStorage.setItem(HERO_WIDGET_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  notify();
}

export function setHeroRecentPrefs(patch: Partial<HeroRecentPrefs>): void {
  setHeroWidgetPrefs({ ...prefs, recent: { ...prefs.recent, ...patch } });
}

export function setHeroChromePrefs(patch: Partial<HeroChromePrefs>): void {
  setHeroWidgetPrefs({ ...prefs, chrome: { ...prefs.chrome, ...patch } });
}

export function setHeroAppsPrefs(patch: Partial<HeroAppsPrefs>): void {
  setHeroWidgetPrefs({ ...prefs, apps: { ...prefs.apps, ...patch } });
}

/** Move `id` to `index` within `list` (clamped). Pure; shared by every
 *  reorderable list on the screen and in its Customize panel. */
export function moveListItem<T>(list: readonly T[], id: T, index: number): T[] {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  const next = list.filter((item) => item !== id);
  next.splice(Math.max(0, Math.min(next.length, index)), 0, id);
  return next;
}

export function replaceHeroWidgetPrefs(value: unknown): void {
  const raw = value && typeof value === "object" ? value as Partial<HeroWidgetPrefs> : {};
  setHeroWidgetPrefs({
    order: Array.isArray(raw.order) ? widgetIds(raw.order) : [...HERO_WIDGET_IDS],
    hidden: widgetIds(raw.hidden),
    // A synced value written by a client that predates Recent settings keeps
    // this device's choices instead of resetting them.
    recent: raw.recent === undefined ? prefs.recent : normalizeHeroRecentPrefs(raw.recent),
    // Likewise for a client that predates the screen's fixed-piece switches.
    chrome: raw.chrome === undefined ? prefs.chrome : normalizeHeroChromePrefs(raw.chrome),
    // And for one that predates pinned apps.
    apps: raw.apps === undefined ? prefs.apps : normalizeHeroAppsPrefs(raw.apps),
  });
}

export function subscribeHeroWidgetPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
