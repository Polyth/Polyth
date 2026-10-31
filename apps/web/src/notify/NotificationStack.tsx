// The single transient-notification surface (see ./store.ts). Mounted once by
// the shell. On phone it hangs under the session header, newest at the top; on
// desktop it rises from the bottom-trailing corner above the status bar,
// newest at the bottom. More than one card folds into a deck that opens while
// the person is on it (hover, focus, touch) — every countdown pauses then;
// while it is folded only the front card counts down.
//
// Geometry is transform-only: each card sits at the stack's edge and is moved
// by its measured offset, so a card arriving or leaving glides its siblings
// (FLIP by transition). A card enters on a short spring, leaves as an exit
// ghost (exitGhost.ts) and can be swiped away toward the inline end — on phone
// also toward the edge it hangs from.
//
// Cards are not live regions (a ticking body would re-read itself). The stack
// keeps one polite and one assertive visually-hidden region mounted and says
// "title — body" once per new notification or kind/title change.
import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { attachSwipeSurface } from "../swipeSurface.ts";
import { useExitGhost } from "../exitGhost.ts";
import Button from "../components/ui/Button.tsx";
import IconButton from "../components/ui/IconButton.tsx";
import Progress from "../components/ui/Progress.tsx";
import { CloseIcon, type LucideIcon } from "../components/ui/icons.ts";
import NotificationGlyph from "./NotificationGlyph.tsx";
import ConversationCard from "./ConversationCard.tsx";
import {
  MAX_VISIBLE,
  dismissAllNotifications,
  dismissNotification,
  notificationRemaining,
  pauseNotifications,
  resumeNotifications,
  setNotificationDeckOpen,
  useNotifications,
  type NotificationRecord,
} from "./store.ts";
import type { WebNotificationAction } from "@polyth/web-sdk";
import "./notify.css";

/** Space between open cards, and how far each folded card peeks out. */
const GAP = 8;
const PEEK = 10;
/** Each folded card is this much smaller than the one in front of it. */
const FOLD_SCALE = 0.05;

const PAUSE_SOURCES = ["hover", "focus", "touch"] as const;
/** Past this many waiting, the stack offers to clear them all. */
const CLEAR_ALL_AFTER = 3;
/** Measured-height key of the "+N more" bar. */
const MORE_KEY = "\u0000more";

/** A ReactNode's readable text, for the announcement (markup is dropped). */
function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).filter(Boolean).join(" ");
  if (isValidElement(node)) return plainText((node.props as { children?: ReactNode }).children);
  return "";
}

/** What a screen reader hears for a record. */
export function announcementFor(record: Pick<NotificationRecord, "title" | "body">): string {
  const body = plainText(record.body).replace(/\s+/g, " ").trim();
  return body ? `${record.title} — ${body}` : record.title;
}

interface Spoken { seq: number; kind: string; title: string }

/** Says each new notification once — a fresh `notify()` or a kind/title
 *  change — never a body, excerpt or progress patch. */
function useAnnouncements(items: readonly NotificationRecord[]) {
  const spoken = useRef(new Map<string, Spoken>());
  const [polite, setPolite] = useState({ text: "", n: 0 });
  const [assertive, setAssertive] = useState({ text: "", n: 0 });
  useEffect(() => {
    const calm: string[] = [];
    const urgent: string[] = [];
    const live = new Set<string>();
    for (const record of items) {
      live.add(record.id);
      const before = spoken.current.get(record.id);
      spoken.current.set(record.id, { seq: record.seq, kind: record.kind, title: record.title });
      if (before && before.seq === record.seq && before.kind === record.kind && before.title === record.title) continue;
      (record.kind === "error" ? urgent : calm).push(announcementFor(record));
    }
    for (const id of [...spoken.current.keys()]) if (!live.has(id)) spoken.current.delete(id);
    if (calm.length > 0) setPolite((previous) => ({ text: calm.join(". "), n: previous.n + 1 }));
    if (urgent.length > 0) setAssertive((previous) => ({ text: urgent.join(". "), n: previous.n + 1 }));
  }, [items]);
  // The same words again still change the region: a no-break space toggles.
  const say = (value: { text: string; n: number }) => value.text + (value.n % 2 ? "\u00a0" : "");
  return { polite: say(polite), assertive: say(assertive) };
}

export default function NotificationStack() {
  const { items, paused } = useNotifications();
  const phone = useShellMode() === "phone";
  const visible = items.slice(-MAX_VISIBLE).reverse();
  const queued = items.length - visible.length;
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const stackRef = useRef<HTMLDivElement | null>(null);
  const spoken = useAnnouncements(items);

  const measure = useCallback((id: string, height: number) => {
    setHeights((previous) => (previous[id] === height ? previous : { ...previous, [id]: height }));
  }, []);

  // Nothing counts down while the page cannot be seen.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => {
      if (document.visibilityState === "hidden") pauseNotifications("hidden");
      else resumeNotifications("hidden");
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      resumeNotifications("hidden");
    };
  }, []);

  // A touch elsewhere folds the deck again and lets the countdowns resume.
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (stackRef.current?.contains(event.target as Node)) return;
      resumeNotifications("touch");
      if (!stackHasFocus(stackRef.current)) setExpanded(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [expanded]);

  // A card can leave from under the pointer or with focus inside it, and the
  // browser then sends neither pointerleave nor blur: re-check after every
  // change so a pause never outlives the person being on the stack.
  const ids = visible.map((item) => item.id).join("\n");
  useEffect(() => {
    const stack = stackRef.current;
    if (visible.length === 0) {
      for (const source of PAUSE_SOURCES) resumeNotifications(source);
      setExpanded(false);
      return;
    }
    if (!stackHasFocus(stack)) resumeNotifications("focus");
    if (!stackIsHovered(stack)) resumeNotifications("hover");
  }, [ids]);

  useEffect(() => () => { for (const source of PAUSE_SOURCES) resumeNotifications(source); }, []);

  const open = expanded || visible.length <= 1;
  // A folded card cannot be read: only the front one counts down then.
  useEffect(() => { setNotificationDeckOpen(open); }, [open]);
  useEffect(() => () => { setNotificationDeckOpen(true); }, []);

  const sizes = visible.map((item) => heights[item.id] ?? 0);
  const front = sizes[0] ?? 0;
  const offsets: number[] = [];
  let travelled = 0;
  for (let index = 0; index < visible.length; index++) {
    offsets.push(open ? travelled : index * PEEK);
    travelled += (sizes[index] ?? 0) + GAP;
  }
  const cardsHeight = visible.length === 0
    ? 0
    : open ? travelled - GAP : front + (visible.length - 1) * PEEK;
  // The "+N more" bar sits inside the stack, past the cards (its far end).
  const moreHeight = queued > 0 ? (heights[MORE_KEY] ?? 0) + GAP : 0;
  const height = cardsHeight + moreHeight;

  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    pauseNotifications("hover");
    setExpanded(true);
  };
  const onPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    resumeNotifications("hover");
    if (!stackHasFocus(stackRef.current)) setExpanded(false);
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType !== "touch") return;
    pauseNotifications("touch");
    setExpanded(true);
  };

  return (
    <div
      ref={stackRef}
      className="notify-stack"
      data-shell={phone ? "phone" : "desktop"}
      data-open={open || undefined}
      data-paused={paused || undefined}
      data-empty={visible.length === 0 || undefined}
      {...(visible.length > 0 ? { role: "region", "aria-label": tr("notify.region") } : {})}
      style={{ "--notify-stack-h": `${height}px`, "--notify-cards-h": `${cardsHeight}px` } as CSSProperties}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onFocus={() => { pauseNotifications("focus"); setExpanded(true); }}
      onBlur={(event) => {
        if (stackRef.current?.contains(event.relatedTarget as Node | null)) return;
        resumeNotifications("focus");
        if (!stackIsHovered(stackRef.current)) setExpanded(false);
      }}
    >
      <span className="sr-only notify-live" aria-live="polite" aria-atomic="true">{spoken.polite}</span>
      <span className="sr-only notify-live" aria-live="assertive" aria-atomic="true">{spoken.assertive}</span>
      {visible.map((record, index) => (
        <NotificationCard
          key={record.id}
          record={record}
          index={index}
          folded={!open && index > 0}
          frontHeight={front}
          offset={offsets[index] ?? 0}
          edge={phone ? -1 : 1}
          onMeasure={measure}
        />
      ))}
      {queued > 0 && (
        <MoreBar
          queued={queued}
          onOpen={() => setExpanded(true)}
          onMeasure={measure}
        />
      )}
    </div>
  );
}

/** The waiting count, as a real control inside the stack: it opens the deck,
 *  and past a few waiting it offers to clear them all. */
function MoreBar({ queued, onOpen, onMeasure }: { queued: number; onOpen(): void; onMeasure(id: string, height: number): void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    onMeasure(MORE_KEY, bar.offsetHeight);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => onMeasure(MORE_KEY, bar.offsetHeight));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [onMeasure]);
  return (
    <div ref={ref} className="notify-more">
      <Button size="sm" variant="quiet" className="notify-more-open" aria-label={tr("notify.moreLabel", { count: queued })} onClick={onOpen}>
        {tr("notify.more", { count: queued })}
      </Button>
      {queued > CLEAR_ALL_AFTER && (
        <Button size="sm" variant="quiet" className="notify-clear-all" onClick={() => dismissAllNotifications("user")}>
          {tr("notify.clearAll")}
        </Button>
      )}
    </div>
  );
}

function stackHasFocus(stack: HTMLElement | null): boolean {
  return !!stack && typeof document !== "undefined" && stack.contains(document.activeElement);
}

function stackIsHovered(stack: HTMLElement | null): boolean {
  try { return !!stack?.matches(":hover"); } catch { return false; }
}

interface CardProps {
  record: NotificationRecord;
  index: number;
  /** Folded behind the front card of a closed deck. */
  folded: boolean;
  frontHeight: number;
  /** Distance from the stack's edge, px. */
  offset: number;
  /** +1 when the stack's edge is below it (desktop), -1 when above (phone). */
  edge: 1 | -1;
  onMeasure(id: string, height: number): void;
}

function NotificationCard({ record, index, folded, frontHeight, offset, edge, onMeasure }: CardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  /** How the person sent it away, which picks its exit: off its side, toward
   *  its edge, or (null) the ordinary sink. */
  const swiped = useRef<"notification-swipe" | "notification-lift" | null>(null);
  const ghostRef = useExitGhost<HTMLDivElement>(
    () => ({ kind: swiped.current ?? "notification" }),
    cardRef,
  );

  // The natural height of the card: its content plus its border, in layout
  // pixels — not the (possibly folded, scaled) card's box on screen.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const height = () => {
      const card = cardRef.current;
      const border = card ? card.offsetHeight - card.clientHeight : 0;
      return inner.offsetHeight + border;
    };
    onMeasure(record.id, height());
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => onMeasure(record.id, height()));
    observer.observe(inner);
    return () => observer.disconnect();
  }, [record.id, onMeasure]);

  // Swipe toward the inline end to dismiss: the card follows the finger on the
  // independent `translate` property, fading as it goes; a release past the
  // commit point sends it off from where it was let go.
  useEffect(() => {
    if (!record.dismissible) return;
    return attachSwipeSurface({
      surface: () => cardRef.current,
      direction: "toward-end",
      zone: () => "surface",
      enabled: () => cardRef.current !== null,
      motion: "--motion-surface",
      begin: ({ rtl }) => {
        const card = cardRef.current;
        if (!card) return null;
        const sign = rtl ? -1 : 1;
        card.style.willChange = "translate, opacity";
        return {
          paint(travel, progress) {
            card.style.translate = `${sign * travel}px 0`;
            card.style.opacity = String(Math.max(0.35, 1 - progress * 0.65));
          },
          cancel() {
            for (const property of ["translate", "opacity", "will-change"]) card.style.removeProperty(property);
          },
          commit({ travel, settleMs }) {
            card.style.setProperty("--notify-from", `${sign * travel}px`);
            if (settleMs > 0) card.style.setProperty("--notify-settle", `${settleMs}ms`);
            swiped.current = "notification-swipe";
            dismissNotification(record.id, "user");
          },
        };
      },
    });
  }, [record.id, record.dismissible]);

  // Phone: a flick toward the edge the stack hangs from (up, under the header)
  // also sends the card away — the gesture people know from system banners.
  useEffect(() => {
    const card = cardRef.current;
    if (!record.dismissible || edge !== -1 || !card) return;
    return attachEdgeFling(card, edge, (travel) => {
      card.style.setProperty("--notify-from-y", `${travel}px`);
      swiped.current = "notification-lift";
      dismissNotification(record.id, "user");
    });
  }, [record.id, record.dismissible, edge]);

  const close = () => dismissNotification(record.id, "user");
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || !record.dismissible) return;
    event.stopPropagation();
    event.preventDefault();
    close();
  };

  const timed = record.duration !== "sticky";
  const titleId = `notify-${record.id}-title`;
  const data = Object.fromEntries(Object.entries(record.data ?? {}).map(([key, value]) => [`data-${key}`, value]));
  const style = {
    zIndex: MAX_VISIBLE - index,
    transform: `translate3d(0, ${-edge * offset}px, 0) scale(${folded ? 1 - index * FOLD_SCALE : 1})`,
    ...(folded && frontHeight > 0 ? { height: `${frontHeight}px` } : {}),
  } as CSSProperties;
  const hasBody = record.body !== undefined && record.body !== null && record.body !== "";
  const closeButton = record.dismissible && (
    <IconButton
      icon={CloseIcon}
      size="sm"
      variant="ghost"
      className="notify-close"
      label={record.dismissLabel ?? tr("notify.dismiss")}
      onClick={close}
    />
  );

  return (
    <div
      {...data}
      ref={ghostRef}
      className="notify-card"
      data-kind={record.kind}
      data-conversation={record.conversation ? "" : undefined}
      data-index={index}
      data-folded={folded || undefined}
      data-owns-swipe={record.dismissible ? "" : undefined}
      role="group"
      aria-labelledby={titleId}
      aria-hidden={folded || undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div
        ref={innerRef}
        className={record.conversation ? "notify-card-inner notify-conversation" : "notify-card-inner"}
        data-closable={record.dismissible || undefined}
        data-title-only={(!record.conversation && !hasBody) || undefined}
      >
        {record.conversation ? (
          <ConversationCard record={record} notice={record.conversation} titleId={titleId} close={closeButton} onClose={close} />
        ) : (
          <>
            <NotificationGlyph kind={record.kind} busy={record.kind === "progress" && typeof record.progress !== "number"}>
              {record.icon}
            </NotificationGlyph>
            <div className="notify-main">
              <p className="notify-title" id={titleId}>{record.title}</p>
              {hasBody && <div className="notify-body">{record.body}</div>}
            </div>
            {closeButton}
            {record.excerpt && <pre className="notify-excerpt">{record.excerpt}</pre>}
            {typeof record.progress === "number" && (
              <Progress className="notify-progress" value={record.progress} label={record.title} />
            )}
            {record.actions && record.actions.length > 0 && (
              <NotificationActions actions={record.actions} onDone={close} />
            )}
          </>
        )}
      </div>
      {timed && <LifeLine key={record.life} id={record.id} duration={record.duration as number} />}
    </div>
  );
}

/** The lifetime hairline. A card mounting again (back from the queue) resumes
 *  it where its countdown stands, by a negative delay, instead of restarting. */
function LifeLine({ id, duration }: { id: string; duration: number }) {
  const [spent] = useState(() => {
    const remaining = notificationRemaining(id);
    return remaining === null ? 0 : Math.max(0, Math.min(duration, duration - remaining));
  });
  const style = {
    "--notify-life": `${duration}ms`,
    ...(spent > 0 ? { animationDelay: `-${Math.round(spent)}ms` } : {}),
  } as CSSProperties;
  return <span className="notify-life" aria-hidden="true" style={style} />;
}

/** Past this, a flick toward the edge commits (px). */
const FLING_COMMIT = 36;
/** Movement before the gesture picks an axis (px). */
const FLING_SLOP = 8;

/** A vertical flick toward `edge` (-1: up) on a touch screen. The card follows
 *  the finger on `translate`; letting go past the commit point dismisses,
 *  anything less springs back. Horizontal movement is left to the inline
 *  swipe; movement away from the edge is ignored. */
function attachEdgeFling(card: HTMLElement, edge: 1 | -1, commit: (travel: number) => void): () => void {
  let start: { x: number; y: number } | null = null;
  let active = false;
  let travel = 0;
  const reset = () => {
    for (const property of ["translate", "opacity", "will-change", "transition"]) card.style.removeProperty(property);
  };
  const onStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) return;
    // A reply field keeps its own touches (caret, selection).
    if ((event.target as Element | null)?.closest?.("input, textarea")) { start = null; return; }
    start = { x: touch.clientX, y: touch.clientY };
    active = false;
    travel = 0;
  };
  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!active) {
      if (Math.abs(dx) < FLING_SLOP && Math.abs(dy) < FLING_SLOP) return;
      // Another axis, or away from the edge: not this gesture.
      if (Math.abs(dy) <= Math.abs(dx) * 1.2 || Math.sign(dy) !== edge) { start = null; return; }
      active = true;
      card.style.willChange = "translate, opacity";
      card.style.transition = "none";
    }
    if (event.cancelable) event.preventDefault();
    travel = Math.sign(dy) === edge ? dy : 0;
    card.style.translate = `0 ${travel}px`;
    card.style.opacity = String(Math.max(0.35, 1 - (Math.abs(travel) / 120) * 0.65));
  };
  const onEnd = () => {
    const was = active;
    start = null;
    active = false;
    if (!was) return;
    if (Math.abs(travel) >= FLING_COMMIT) commit(travel);
    else reset();
  };
  card.addEventListener("touchstart", onStart, { passive: true });
  card.addEventListener("touchmove", onMove, { passive: false });
  card.addEventListener("touchend", onEnd);
  card.addEventListener("touchcancel", onEnd);
  return () => {
    card.removeEventListener("touchstart", onStart);
    card.removeEventListener("touchmove", onMove);
    card.removeEventListener("touchend", onEnd);
    card.removeEventListener("touchcancel", onEnd);
  };
}

function NotificationActions({ actions, onDone }: { actions: readonly WebNotificationAction[]; onDone(): void }) {
  const labelled = actions.filter((action) => !action.iconOnly);
  const iconic = actions.filter((action) => action.iconOnly && action.icon);
  return (
    <div className="notify-actions">
      {labelled.map((action, at) => <ActionButton key={`l${at}`} action={action} onDone={onDone} />)}
      {iconic.length > 0 && <span className="notify-actions-spacer" />}
      {iconic.map((action, at) => <ActionButton key={`i${at}`} action={action} onDone={onDone} />)}
    </div>
  );
}

function ActionButton({ action, onDone }: { action: WebNotificationAction; onDone(): void }) {
  const [running, setRunning] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const run = () => {
    if (!action.keepOpen) onDone();
    let result: void | Promise<void>;
    try { result = action.run(); } catch { return; }
    if (!action.keepOpen || !result || typeof (result as Promise<void>).then !== "function") return;
    setRunning(true);
    void (result as Promise<void>).catch(() => undefined).finally(() => { if (live.current) setRunning(false); });
  };
  const busy = action.busy || running;
  const icon = action.icon as LucideIcon | undefined;
  if (action.iconOnly && icon) {
    return (
      <IconButton
        icon={icon}
        size="sm"
        variant="ghost"
        className="notify-action"
        label={action.label}
        disabled={action.disabled || busy}
        onClick={run}
      />
    );
  }
  return (
    <Button
      size="sm"
      variant={action.primary ? "primary" : "quiet"}
      className="notify-action"
      iconStart={icon}
      busy={busy}
      disabled={action.disabled || busy}
      onClick={run}
    >
      {action.label}
    </Button>
  );
}
