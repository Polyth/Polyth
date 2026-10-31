// Generic composer contribution registry (host side of the web-sdk seam).
// Feature packages publish add-menu items and paste handlers here; the
// composer components read them. The host never names a removable package.
import type {
  ComposerAddMenuItem,
  ComposerMode,
  ComposerPasteHandler,
  ComposerSessionCreatedContext,
  ComposerSessionCreatedHook,
} from "@polyth/web-sdk";

const addMenuItems = new Map<string, ComposerAddMenuItem>();
const pasteHandlers = new Map<string, ComposerPasteHandler>();
const sessionCreatedHooks = new Map<string, ComposerSessionCreatedHook>();
const modes = new Map<string, ComposerMode>();
/** Mode each mounted composer is in, keyed by its session id ("" = new chat). */
const activeModes = new Map<string, string>();
/** A mounted composer answers a mode request for its session (true = taken). */
type ComposerModeRequestListener = (modeId: string | null, sessionId: string | undefined) => boolean;
const modeRequestListeners = new Set<ComposerModeRequestListener>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function subscribeComposerContributions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function composerContributionsVersion(): number {
  return version;
}

/** Register (or same-id replace) one Add-menu item. Returns an unregister that
 *  removes only its own registration. */
export function registerComposerAddMenuItem(item: ComposerAddMenuItem): () => void {
  addMenuItems.set(item.id, item);
  bump();
  return () => {
    if (addMenuItems.get(item.id) === item) {
      addMenuItems.delete(item.id);
      bump();
    }
  };
}

/** Ascending `order`, ties broken by id so re-registration never reorders. */
export function listComposerAddMenuItems(): ComposerAddMenuItem[] {
  return [...addMenuItems.values()].sort((left, right) =>
    (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
}

export function registerComposerPasteHandler(handler: ComposerPasteHandler): () => void {
  pasteHandlers.set(handler.id, handler);
  bump();
  return () => {
    if (pasteHandlers.get(handler.id) === handler) {
      pasteHandlers.delete(handler.id);
      bump();
    }
  };
}

/** Registration order is intentional: the first matching handler owns the paste. */
export function listComposerPasteHandlers(): ComposerPasteHandler[] {
  return [...pasteHandlers.values()];
}

/** Register (or same-id replace) one "after new session created" hook. A
 *  superseded registration's unregister is a no-op. */
export function registerComposerSessionCreatedHook(hook: ComposerSessionCreatedHook): () => void {
  sessionCreatedHooks.set(hook.id, hook);
  bump();
  return () => {
    if (sessionCreatedHooks.get(hook.id) === hook) {
      sessionCreatedHooks.delete(hook.id);
      bump();
    }
  };
}

/** Registration order. The composer awaits every hook before delivering. */
export function listComposerSessionCreatedHooks(): ComposerSessionCreatedHook[] {
  return [...sessionCreatedHooks.values()];
}

/** Run every registered hook sequentially in registration order. A rejection
 *  stops the sequence and reaches the composer's send path unchanged. */
export async function runComposerSessionCreatedHooks(context: ComposerSessionCreatedContext): Promise<void> {
  for (const hook of [...sessionCreatedHooks.values()]) await hook.run(context);
}

/** Register (or same-id replace) one composer mode. A superseded
 *  registration's unregister is a no-op. */
export function registerComposerMode(mode: ComposerMode): () => void {
  modes.set(mode.id, mode);
  bump();
  return () => {
    if (modes.get(mode.id) === mode) {
      modes.delete(mode.id);
      bump();
    }
  };
}

/** Ordered by id so re-registration never reorders. */
export function listComposerModes(): ComposerMode[] {
  return [...modes.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function composerMode(id: string): ComposerMode | undefined {
  return modes.get(id);
}

/** Mounted composers listen for package mode requests. */
export function listenComposerModeRequests(listener: ComposerModeRequestListener): () => void {
  modeRequestListeners.add(listener);
  return () => { modeRequestListeners.delete(listener); };
}

/** Ask the mounted composer of `sessionId` (any when omitted) to enter a mode
 *  or leave it (`null`). True when a composer took the request. */
export function requestComposerMode(modeId: string | null, options: { sessionId?: string } = {}): boolean {
  for (const listener of [...modeRequestListeners]) {
    if (listener(modeId, options.sessionId)) return true;
  }
  return false;
}

/** A mounted composer reports the mode it is in (`null` = none). */
export function publishComposerActiveMode(sessionId: string | null, modeId: string | null): void {
  const key = sessionId ?? "";
  if ((activeModes.get(key) ?? null) === modeId) return;
  if (modeId) activeModes.set(key, modeId);
  else activeModes.delete(key);
  bump();
}

export function composerActiveMode(sessionId: string | null): string | null {
  return activeModes.get(sessionId ?? "") ?? null;
}
