// Folding the pending stack above the composer. Every line of the stack that
// can say what it holds in one short token registers it here, with an anchor
// element inside the line. When the person folds the stack, every line that
// registered a token hides and one spine line above the composer card shows
// the tokens in stack order; a line that registered none (a package row, a
// notice that must stay in sight) never folds. The stack folds only when it
// takes two rows or more: one line has nothing to fold into.
//
// Pure client UI state. The fold is a per-device preference (a phone starts
// folded, a desktop open), never session history. docs/dev/ui.md "Folding the
// pending stack".
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface PendingStackToken {
  /** One per kind of line in the stack ("waits", "queue", "suggestion"). */
  id: string;
  /** The line's own mark, drawn at the icon size of the stack's marks. */
  icon: ReactNode;
  /** The short value beside the mark: "3h 26m", "4". */
  value?: string;
  /** The words this line speaks when it is the most important one (lowest
   *  rank) in the folded spine; every other token shows its value only. */
  lead?: { text: string; rank: number; hint?: string };
  /** Something waits on the person: the mark carries an accent dot. */
  attention?: boolean;
  /** The mark keeps the accent ink (the suggested prompt). */
  accent?: boolean;
  /** The token in words, for the spine's accessible name. */
  label: string;
  /** Rows the line takes in the open stack: 1 by default, 0 for a token that
   *  shares a row another token already counts. */
  rows?: number;
}

export interface PendingStackEntry {
  key: string;
  token: PendingStackToken;
}

export interface PendingStackSnapshot {
  /** The person's preference. */
  folded: boolean;
  /** The open stack takes two rows or more. */
  foldable: boolean;
  /** Folded and foldable: the lines are hidden and the spine shows. */
  active: boolean;
  /** Tokens in stack order, top to bottom. */
  entries: readonly PendingStackEntry[];
  /** Where the open stack's fold control stands: the box of the first line
   *  that can hold it (null while folded or with nothing to fold). */
  foldHost: HTMLElement | null;
}

/** A fold container: the composer dock and the composer root. A line is the
 *  container's child that holds a token's anchor. */
export const PENDING_STACK_CONTAINER = "data-pending-stack";
const FOLDED = "data-stack-folded";
const MOVING = "data-stack-moving";
const FIRST = "data-stack-first";
const ANIMATION_ID = "pending-stack-fold";
const PREFERENCE_KEY = "polyth.composerStack.folded.v1";
const DURATION_MS = 240; // --motion-surface
const STAGGER_MS = 24;
const EASING = "cubic-bezier(0.2, 0.8, 0.3, 1)"; // --motion-ease

interface Registration {
  token: PendingStackToken | null;
  anchor: HTMLElement | null;
  seq: number;
}

function lineOf(anchor: HTMLElement | null): HTMLElement | null {
  let node = anchor;
  while (node?.parentElement) {
    if (node.parentElement.hasAttribute(PENDING_STACK_CONTAINER)) return node;
    node = node.parentElement;
  }
  return null;
}

/** A box the fold control can stand in: rendered, and not itself a control
 *  (a button inside a button is no longer a button to assistive tech). */
const INTERACTIVE = "button, a[href], input, select, textarea, summary, [role='button']";
function canHost(element: HTMLElement): boolean {
  return !element.hidden && !element.matches(INTERACTIVE);
}

function depthIn(element: HTMLElement, line: HTMLElement): number {
  let depth = 0;
  for (let node: HTMLElement | null = element; node && node !== line; node = node.parentElement) depth += 1;
  return depth;
}

function readPreference(fallback: boolean): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(PREFERENCE_KEY);
    return stored === "true" ? true : stored === "false" ? false : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(folded: boolean): void {
  try { globalThis.localStorage?.setItem(PREFERENCE_KEY, String(folded)); } catch { /* private mode */ }
}

function stopMotion(line: HTMLElement): void {
  for (const animation of line.getAnimations?.() ?? []) {
    if (animation.id === ANIMATION_ID) animation.cancel();
  }
  line.removeAttribute(MOVING);
}

/** The line's own box, so it can fold to nothing and open back to itself. */
function boxOf(line: HTMLElement): Keyframe {
  const style = getComputedStyle(line);
  return {
    height: `${line.getBoundingClientRect().height}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: 1,
    transform: "translateY(0)",
  };
}

const NONE: Keyframe = {
  height: "0px",
  paddingTop: "0px",
  paddingBottom: "0px",
  marginTop: "0px",
  marginBottom: "0px",
  opacity: 0,
  transform: "translateY(6px)",
};

export class PendingStackStore {
  private readonly records = new Map<string, Registration>();
  private readonly listeners = new Set<() => void>();
  private readonly applied = new Set<HTMLElement>();
  private readonly intent = new WeakMap<HTMLElement, boolean>();
  private host: HTMLElement | null = null;
  private seq = 0;
  private folded: boolean;
  private snapshot: PendingStackSnapshot;
  private notifyQueued = false;
  private readonly motion: () => boolean;

  constructor(options: { defaultFolded: boolean; motion?: () => boolean }) {
    this.folded = readPreference(options.defaultFolded);
    this.motion = options.motion ?? (() => true);
    this.snapshot = { folded: this.folded, foldable: false, active: false, entries: [], foldHost: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): PendingStackSnapshot => this.snapshot;

  set(key: string, token: PendingStackToken | null, anchor: HTMLElement | null): void {
    const record = this.records.get(key);
    if (record) {
      record.token = token;
      record.anchor = anchor;
    } else {
      this.records.set(key, { token, anchor, seq: this.seq++ });
    }
    this.recompute(false);
  }

  remove(key: string): void {
    if (!this.records.delete(key)) return;
    this.recompute(false);
  }

  setFolded(folded: boolean): void {
    if (folded === this.folded) return;
    this.folded = folded;
    writePreference(folded);
    this.recompute(true);
  }

  /** Releases every line it changed (the chat surface is leaving). */
  dispose(): void {
    for (const line of this.applied) {
      stopMotion(line);
      line.removeAttribute(FOLDED);
    }
    this.applied.clear();
    this.setHost(null);
    this.listeners.clear();
  }

  private recompute(animate: boolean): void {
    const live: Array<{ key: string; token: PendingStackToken; line: HTMLElement; anchor: HTMLElement; seq: number }> = [];
    for (const [key, record] of this.records) {
      const line = lineOf(record.anchor);
      if (record.token && record.anchor && line?.isConnected) {
        live.push({ key, token: record.token, line, anchor: record.anchor, seq: record.seq });
      }
    }
    live.sort((a, b) => {
      if (a.line === b.line) return a.seq - b.seq;
      return a.line.compareDocumentPosition(b.line) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const rows = live.reduce((sum, item) => sum + Math.max(0, item.token.rows ?? 1), 0);
    const foldable = rows >= 2;
    const active = this.folded && foldable;
    const lines = [...new Set(live.map((item) => item.line))];
    // The fold control stands on the first line that has a box for it: the
    // outermost anchor of that line, so it shares the line's start and end.
    let foldHost: HTMLElement | null = null;
    if (foldable && !active) {
      for (const line of lines) {
        const hosts = live.filter((item) => item.line === line && canHost(item.anchor)).map((item) => item.anchor);
        if (hosts.length === 0) continue;
        foldHost = hosts.reduce((best, next) => depthIn(next, line) < depthIn(best, line) ? next : best);
        break;
      }
    }
    this.apply(lines, active, animate);
    this.setHost(foldHost);
    const entries = live.map(({ key, token }) => ({ key, token }));
    const previous = this.snapshot;
    // The snapshot changes identity only when what it says changes, so a line
    // that re-renders every second (the run clock) moves the spine only when
    // its words do.
    if (
      previous.folded === this.folded && previous.foldable === foldable && previous.active === active
      && previous.foldHost === foldHost && sameEntries(previous.entries, entries)
    ) return;
    this.snapshot = { folded: this.folded, foldable, active, entries, foldHost };
    this.notify();
  }

  private setHost(host: HTMLElement | null): void {
    if (this.host && this.host !== host) this.host.removeAttribute(FIRST);
    this.host = host;
    host?.setAttribute(FIRST, "");
  }

  private apply(lines: HTMLElement[], active: boolean, animate: boolean): void {
    const current = new Set(lines);
    // A line that no longer holds a token stands as it is.
    for (const line of this.applied) {
      if (current.has(line)) continue;
      stopMotion(line);
      line.removeAttribute(FOLDED);
      this.applied.delete(line);
      this.intent.delete(line);
    }
    const moving = animate && this.motion();
    // Lines open from the bottom up, the one nearest the composer first.
    lines.forEach((line, index) => {
      this.applied.add(line);
      // What the line is headed for, not what it shows mid-fold: a fold the
      // person reverses halfway must open again, not finish.
      const intended = this.intent.get(line) ?? line.hasAttribute(FOLDED);
      if (intended === active) return;
      this.intent.set(line, active);
      stopMotion(line);
      if (!moving || typeof line.animate !== "function") {
        if (active) line.setAttribute(FOLDED, "true");
        else line.removeAttribute(FOLDED);
        return;
      }
      line.setAttribute(MOVING, "");
      if (active) {
        const from = boxOf(line);
        const motion = line.animate([from, NONE], { duration: DURATION_MS, easing: EASING, id: ANIMATION_ID });
        motion.onfinish = () => {
          line.setAttribute(FOLDED, "true");
          line.removeAttribute(MOVING);
          motion.cancel();
        };
      } else {
        line.removeAttribute(FOLDED);
        const to = boxOf(line);
        const delay = (lines.length - 1 - index) * STAGGER_MS;
        const motion = line.animate([NONE, to], {
          duration: DURATION_MS, delay, easing: EASING, fill: "backwards", id: ANIMATION_ID,
        });
        motion.onfinish = () => { line.removeAttribute(MOVING); };
      }
    });
  }

  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of this.listeners) listener();
    });
  }
}

function sameEntries(a: readonly PendingStackEntry[], b: readonly PendingStackEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.key === other.key && sameToken(entry.token, other.token);
  });
}

function sameToken(a: PendingStackToken, b: PendingStackToken): boolean {
  return a === b || (
    // The icon is a fresh element every render; its kind is the token's id.
    a.id === b.id && a.value === b.value && a.label === b.label && a.attention === b.attention
    && a.accent === b.accent && a.rows === b.rows
    && a.lead?.text === b.lead?.text && a.lead?.rank === b.lead?.rank && a.lead?.hint === b.lead?.hint
  );
}

const PendingStackContext = createContext<PendingStackStore | null>(null);

export function PendingStackProvider({ store, children }: { store: PendingStackStore; children?: ReactNode }) {
  return createElement(PendingStackContext.Provider, { value: store }, children);
}

const EMPTY: PendingStackSnapshot = { folded: false, foldable: false, active: false, entries: [], foldHost: null };
const noop = () => () => {};

/** The stack's fold state for the spine and its controls; null outside a
 *  composer dock that folds. */
export function usePendingStack(): { store: PendingStackStore; state: PendingStackSnapshot } | null {
  const store = useContext(PendingStackContext);
  const state = useSyncExternalStore(
    store?.subscribe ?? noop,
    store ? store.getSnapshot : () => EMPTY,
    store ? store.getSnapshot : () => EMPTY,
  );
  return store ? { store, state } : null;
}

/**
 * Registers one line's token while it renders. Attach the returned ref to any
 * element inside the line; `null` withdraws the token (the line shows nothing
 * worth folding). Outside a folding dock it does nothing.
 */
export function usePendingStackToken(token: PendingStackToken | null): (element: HTMLElement | null) => void {
  const store = useContext(PendingStackContext);
  const key = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const ref = useCallback((element: HTMLElement | null) => {
    anchor.current = element;
    if (store && element) store.set(key, tokenRef.current, element);
  }, [store, key]);
  useLayoutEffect(() => {
    store?.set(key, token, anchor.current);
  });
  useLayoutEffect(() => () => { store?.remove(key); }, [store, key]);
  return ref;
}
