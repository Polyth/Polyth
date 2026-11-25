// Second windows: one chat, or a project's code (Files, Edit, Changes), in a
// browser or desktop window of its own, so a person with two screens can keep
// code on one and the chats on the other.
//
// A second window is the same client with a role (`?window=chat|pane`):
// - chat: the chat named by the URL, full width, no navigator or work panes;
// - pane: one workspace window (`&surface=`, e.g. the project's files) shown
//   full size — the "code window". It follows the chat the main window shows
//   (its project and checkout) until the person pins it. With `&resource=` it
//   is a window for that one thing (a package's item, such as a saved app):
//   one window per surface and resource, named by its content, following
//   nothing.
//
// Windows of one origin find each other over a BroadcastChannel: each one
// announces what it shows, so the main window can mark chats open elsewhere
// and a second window can hand its content back. Presence is presentation
// only: nothing here appends a SessionEvent or touches a runtime, and a second
// window never writes the main window's shell preferences (navigation hints,
// pane and workbench layout): `isSecondaryWindow()` guards those writers.
import { useSyncExternalStore } from "react";
import { formatAppUrl } from "./router.ts";

export type WindowRole = "main" | "chat" | "pane";

export const WINDOW_PARAM = "window";
export const WINDOW_SURFACE_PARAM = "surface";
export const WINDOW_RESOURCE_PARAM = "resource";
const ROLE_KEY = "polyth.window.role.v1";
const SURFACE_KEY = "polyth.window.surface.v1";
const RESOURCE_KEY = "polyth.window.resource.v1";
const CHANNEL = "polyth.windows.v1";
const SURFACE_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
/** A resource in a window URL is an id, never free text. */
const RESOURCE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const TITLE_MAX = 120;
/** Heartbeat and expiry: a window that crashed stops counting after this. */
const HEARTBEAT_MS = 15_000;
const EXPIRE_MS = 40_000;

/** The role a URL asks for; null for a main window URL. */
export function parseWindowRole(search: string): Exclude<WindowRole, "main"> | null {
  const value = new URLSearchParams(search.startsWith("?") || search.length === 0 ? search : `?${search}`).get(WINDOW_PARAM);
  return value === "chat" || value === "pane" ? value : null;
}

/** The workspace surface a pane window URL names, bounded. */
export function parseWindowSurface(search: string): string | null {
  const value = new URLSearchParams(search.startsWith("?") || search.length === 0 ? search : `?${search}`).get(WINDOW_SURFACE_PARAM);
  return value && SURFACE_ID.test(value) ? value : null;
}

/** The one thing a pane window URL asks its surface to show, bounded. */
export function parseWindowResource(search: string): string | null {
  const value = new URLSearchParams(search.startsWith("?") || search.length === 0 ? search : `?${search}`).get(WINDOW_RESOURCE_PARAM);
  return value && RESOURCE_ID.test(value) ? value : null;
}

/** URL of a second window: the canonical chat URL plus its role. */
export function secondWindowUrl(
  role: Exclude<WindowRole, "main">,
  projectId: string | null,
  sessionId: string | null,
  surface?: string | null,
  resource?: string | null,
): string {
  const base = formatAppUrl(projectId, sessionId);
  const params = new URLSearchParams();
  params.set(WINDOW_PARAM, role);
  if (role === "pane" && surface && SURFACE_ID.test(surface)) {
    params.set(WINDOW_SURFACE_PARAM, surface);
    if (resource && RESOURCE_ID.test(resource)) params.set(WINDOW_RESOURCE_PARAM, resource);
  }
  return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
}

/** Window target names: opening the same chat twice brings its window
 *  forward, and so does opening the same resource of a surface. */
export function secondWindowName(
  role: Exclude<WindowRole, "main">,
  sessionId: string | null,
  surface?: string | null,
  resource?: string | null,
): string {
  if (role === "chat") return `polyth-chat-${sessionId ?? "new"}`;
  return surface && resource && SURFACE_ID.test(surface) && RESOURCE_ID.test(resource)
    ? `polyth-pane-${surface}-${resource}`
    : "polyth-pane";
}

/** Keep the role in the address the URL sync writes, so a reload keeps it. */
export function withWindowRole(
  path: string,
  role: WindowRole = windowRole(),
  surface: string | null = windowSurface(),
  resource: string | null = windowResource(),
): string {
  if (role === "main") return path;
  const params = new URLSearchParams();
  params.set(WINDOW_PARAM, role);
  if (role === "pane" && surface) {
    params.set(WINDOW_SURFACE_PARAM, surface);
    if (resource) params.set(WINDOW_RESOURCE_PARAM, resource);
  }
  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
}

function sessionStore(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

// A window opened by window.open starts with a copy of its opener's
// sessionStorage, so the stored role is only a reload memory for a window
// whose URL lost the parameter; the URL always wins.
function bootRole(): { role: WindowRole; surface: string | null; resource: string | null } {
  if (typeof location === "undefined") return { role: "main", surface: null, resource: null };
  const fromUrl = parseWindowRole(location.search);
  const store = sessionStore();
  if (fromUrl) {
    const surface = fromUrl === "pane" ? parseWindowSurface(location.search) : null;
    const resource = surface ? parseWindowResource(location.search) : null;
    try {
      store?.setItem(ROLE_KEY, fromUrl);
      if (surface) store?.setItem(SURFACE_KEY, surface);
      else store?.removeItem(SURFACE_KEY);
      if (resource) store?.setItem(RESOURCE_KEY, resource);
      else store?.removeItem(RESOURCE_KEY);
    } catch { /* reload memory only */ }
    return { role: fromUrl, surface, resource };
  }
  const stored = store?.getItem(ROLE_KEY);
  // Only a reload of this very window can lack the parameter: a window the
  // person opened from a second window's link starts as a main window.
  const reloaded = typeof performance !== "undefined"
    && typeof performance.getEntriesByType === "function"
    && (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
  if ((stored === "chat" || stored === "pane") && reloaded) {
    const storedSurface = stored === "pane" ? store?.getItem(SURFACE_KEY) ?? null : null;
    const surface = storedSurface && SURFACE_ID.test(storedSurface) ? storedSurface : null;
    const storedResource = surface ? store?.getItem(RESOURCE_KEY) ?? null : null;
    const resource = storedResource && RESOURCE_ID.test(storedResource) ? storedResource : null;
    return { role: stored, surface, resource };
  }
  try { store?.removeItem(ROLE_KEY); store?.removeItem(SURFACE_KEY); store?.removeItem(RESOURCE_KEY); } catch { /* reload memory only */ }
  return { role: "main", surface: null, resource: null };
}

const boot = bootRole();
let role: WindowRole = boot.role;
let surface: string | null = boot.surface;
let resource: string | null = boot.resource;
// What a resource window's content calls itself (a saved app's name).
let contentTitle: string | null = null;

export function windowRole(): WindowRole {
  return role;
}

/** A chat or pane window: it must not write the main window's shell prefs. */
export function isSecondaryWindow(): boolean {
  return role !== "main";
}

export function windowSurface(): string | null {
  return surface;
}

/** The one thing this pane window was opened for; null for the code window
 *  and for every other role. */
export function windowResource(): string | null {
  return role === "pane" ? resource : null;
}

/** The pane window shows another surface: kept for a reload of this window.
 *  It is then no longer the window of one resource. */
export function setWindowSurface(next: string): void {
  if (role !== "pane" || !SURFACE_ID.test(next) || next === surface) return;
  surface = next;
  resource = null;
  contentTitle = null;
  try {
    sessionStore()?.setItem(SURFACE_KEY, next);
    sessionStore()?.removeItem(RESOURCE_KEY);
  } catch { /* reload memory only */ }
  emit();
}

/** A resource window is named by its content. Ignored everywhere else, so a
 *  surface can report its title without knowing which window it is in. */
export function setWindowContentTitle(title: string | null): void {
  if (windowResource() === null) return;
  const next = typeof title === "string"
    ? title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || null
    : null;
  if (next === contentTitle) return;
  contentTitle = next;
  emit();
}

export function windowContentTitle(): string | null {
  return windowResource() === null ? null : contentTitle;
}

/** Test seam: set the role a module instance reports. */
export function setWindowRoleForTest(next: WindowRole, nextSurface: string | null = null, nextResource: string | null = null): void {
  role = next;
  surface = nextSurface;
  resource = nextResource;
  contentTitle = null;
  emit();
}

// ---- opening ----------------------------------------------------------------------

function windowFeatures(): string {
  // A second window sized like a code editor; the browser may ignore it (and
  // opens a tab instead), which still gives the person a movable surface.
  const width = 1200;
  const height = 860;
  const screenX = typeof window !== "undefined" ? (window.screenX ?? 0) + 48 : 0;
  const screenY = typeof window !== "undefined" ? (window.screenY ?? 0) + 48 : 0;
  return `popup=yes,width=${width},height=${height},left=${screenX},top=${screenY}`;
}

function openWindow(url: string, name: string): boolean {
  if (typeof window === "undefined" || typeof window.open !== "function") return false;
  // Not `noopener`: a named target only brings an existing window forward
  // inside one browsing-context group, and the desktop shell adopts the
  // window as its own child. Same origin, same client: no foreign opener.
  const opened = window.open(url, name, windowFeatures());
  // The desktop shell answers window.open itself (apps/desktop
  // secondWindows.ts): it opens the window natively and the page gets null.
  if (!opened) return (window as { polythDesktop?: unknown }).polythDesktop !== undefined;
  try { opened.focus(); } catch { /* the browser decides */ }
  return true;
}

/** Open a chat in a window of its own. False when the browser blocked it. */
export function openChatWindow(sessionId: string, projectId: string | null): boolean {
  return openWindow(secondWindowUrl("chat", projectId, sessionId), secondWindowName("chat", sessionId));
}

/** Open a workspace window (the project's files, its changes, the browser…)
 *  in a window of its own. With `resourceId` it is that one thing's window,
 *  beside the code window instead of in its place. False when the browser
 *  blocked it or the ids are not ids. */
export function openPaneWindow(projectId: string | null, sessionId: string | null, surfaceId: string, resourceId?: string | null): boolean {
  if (!SURFACE_ID.test(surfaceId) || (resourceId != null && !RESOURCE_ID.test(resourceId))) return false;
  return openWindow(
    secondWindowUrl("pane", projectId, sessionId, surfaceId, resourceId),
    secondWindowName("pane", null, surfaceId, resourceId),
  );
}

// ---- presence ---------------------------------------------------------------------

export interface WindowPresence {
  id: string;
  role: WindowRole;
  projectId: string | null;
  sessionId: string | null;
  /** Pane window: it stays on its chat instead of following the main window. */
  pinned: boolean;
  /** When this window last had focus (ms epoch); 0 when never. */
  focusedAt: number;
}

export type WindowMessage =
  | { t: "presence"; window: WindowPresence }
  | { t: "gone"; id: string }
  | { t: "ask" }
  /** A second window hands its content back to the main window last focused. */
  | { t: "return"; to: string; role: Exclude<WindowRole, "main">; projectId: string | null; sessionId: string | null; surface: string | null; resource?: string | null };

export interface PeerRecord {
  presence: WindowPresence;
  seenAt: number;
}

/** Pure: apply one message to the peer table. */
export function applyWindowMessage(
  peers: ReadonlyMap<string, PeerRecord>,
  message: WindowMessage,
  now: number,
  selfId: string,
): ReadonlyMap<string, PeerRecord> {
  if (message.t === "presence") {
    if (message.window.id === selfId) return peers;
    const next = new Map(peers);
    next.set(message.window.id, { presence: message.window, seenAt: now });
    return next;
  }
  if (message.t === "gone") {
    if (!peers.has(message.id)) return peers;
    const next = new Map(peers);
    next.delete(message.id);
    return next;
  }
  return peers;
}

/** Pure: drop peers not heard from within the expiry. */
export function expirePeers(peers: ReadonlyMap<string, PeerRecord>, now: number, expireMs = EXPIRE_MS): ReadonlyMap<string, PeerRecord> {
  let next: Map<string, PeerRecord> | null = null;
  for (const [id, record] of peers) {
    if (now - record.seenAt <= expireMs) continue;
    next ??= new Map(peers);
    next.delete(id);
  }
  return next ?? peers;
}

/** Pure: chats shown in a chat window somewhere else. */
export function chatWindowSessions(peers: ReadonlyMap<string, PeerRecord>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const { presence } of peers.values()) {
    if (presence.role === "chat" && presence.sessionId) out.add(presence.sessionId);
  }
  return out;
}

/** Pure: the main window a pane window follows — the one focused last. */
export function leadMainWindow(peers: ReadonlyMap<string, PeerRecord>, self?: WindowPresence): WindowPresence | null {
  let lead: WindowPresence | null = self?.role === "main" ? self : null;
  for (const { presence } of peers.values()) {
    if (presence.role !== "main") continue;
    if (lead === null || presence.focusedAt > lead.focusedAt) lead = presence;
  }
  return lead;
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const selfId = randomId();
let self: WindowPresence = { id: selfId, role, projectId: null, sessionId: null, pinned: false, focusedAt: 0 };
let peers: ReadonlyMap<string, PeerRecord> = new Map();
let channel: BroadcastChannel | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const returnHandlers = new Set<(message: Extract<WindowMessage, { t: "return" }>) => void>();

interface PresenceSnapshot {
  self: WindowPresence;
  peers: ReadonlyMap<string, PeerRecord>;
  role: WindowRole;
  surface: string | null;
  resource: string | null;
  contentTitle: string | null;
}
let snapshot: PresenceSnapshot = { self, peers, role, surface, resource: windowResource(), contentTitle: null };

function emit(): void {
  snapshot = { self, peers, role, surface, resource: windowResource(), contentTitle: windowContentTitle() };
  for (const listener of [...listeners]) listener();
}

function post(message: WindowMessage): void {
  try { channel?.postMessage(message); } catch { /* channel closed */ }
}

function announce(): void {
  post({ t: "presence", window: self });
}

function onMessage(message: WindowMessage): void {
  if (!message || typeof message !== "object" || typeof (message as { t?: unknown }).t !== "string") return;
  if (message.t === "ask") {
    announce();
    return;
  }
  if (message.t === "return") {
    if (message.to === selfId) for (const handler of [...returnHandlers]) handler(message);
    return;
  }
  const next = applyWindowMessage(peers, message, Date.now(), selfId);
  if (next !== peers) {
    peers = next;
    emit();
  }
}

/** Join the window channel. Idempotent; a browser without BroadcastChannel
 *  simply has no peers (second windows still open, nothing is marked). */
export function startWindowPresence(): () => void {
  if (channel !== null || typeof BroadcastChannel !== "function") return stopWindowPresence;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<WindowMessage>) => onMessage(event.data);
  if (typeof document !== "undefined" && document.hasFocus?.()) self = { ...self, focusedAt: Date.now() };
  announce();
  post({ t: "ask" });
  heartbeat = setInterval(() => {
    announce();
    const next = expirePeers(peers, Date.now());
    if (next !== peers) {
      peers = next;
      emit();
    }
  }, HEARTBEAT_MS);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
  }
  emit();
  return stopWindowPresence;
}

function onFocus(): void {
  updateWindowPresence({ focusedAt: Date.now() });
}

function onPageHide(): void {
  post({ t: "gone", id: selfId });
}

export function stopWindowPresence(): void {
  if (channel === null) return;
  post({ t: "gone", id: selfId });
  if (heartbeat !== null) clearInterval(heartbeat);
  heartbeat = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", onPageHide);
  }
  channel.close();
  channel = null;
  peers = new Map();
  emit();
}

/** What this window shows changed: tell the others. */
export function updateWindowPresence(patch: Partial<Omit<WindowPresence, "id" | "role">>): void {
  const next = { ...self, ...patch };
  if (next.projectId === self.projectId && next.sessionId === self.sessionId
    && next.pinned === self.pinned && next.focusedAt === self.focusedAt) return;
  self = next;
  announce();
  emit();
}

/** Hand this window's content back to the main window focused last. False
 *  when no main window is listening (the caller then keeps the window). */
export function returnToMainWindow(): boolean {
  if (role === "main") return false;
  const lead = leadMainWindow(peers);
  if (!lead) return false;
  post({ t: "return", to: lead.id, role, projectId: self.projectId, sessionId: self.sessionId, surface, resource: windowResource() });
  return true;
}

/** Main window: act on content a second window hands back. */
export function onWindowReturn(handler: (message: Extract<WindowMessage, { t: "return" }>) => void): () => void {
  returnHandlers.add(handler);
  return () => { returnHandlers.delete(handler); };
}

export function subscribeWindowPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): PresenceSnapshot {
  return snapshot;
}

export function useWindowPresence(): PresenceSnapshot {
  return useSyncExternalStore(subscribeWindowPresence, getSnapshot, getSnapshot);
}

/** Chats open in a chat window elsewhere (for navigator and split marks). */
export function useChatWindowSessions(): ReadonlySet<string> {
  const { peers: current } = useWindowPresence();
  return chatWindowSessionsMemo(current);
}

let memoPeers: ReadonlyMap<string, PeerRecord> | null = null;
let memoSessions: ReadonlySet<string> = new Set();
function chatWindowSessionsMemo(current: ReadonlyMap<string, PeerRecord>): ReadonlySet<string> {
  if (current !== memoPeers) {
    memoPeers = current;
    memoSessions = chatWindowSessions(current);
  }
  return memoSessions;
}

export function getWindowPeers(): ReadonlyMap<string, PeerRecord> {
  return peers;
}

export function getSelfPresence(): WindowPresence {
  return self;
}
