// The floating timer beside the chat (mounted once in `app.layers`). Two
// shapes: the card (dial, controls, phases) and a small pill. Either can be
// dragged anywhere in the chat column and keeps its corner when the column
// changes size (src/placement.ts). When a segment ends the card can flash and
// fill with the phase colour, and the screen's edge pulses once.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { anchorAt, clampPosition, placeCard, type Insets, type Rect } from "../src/placement.ts";
import { customLabel } from "../src/settings.ts";
import {
  COUNTDOWN_PRESETS,
  formatClock,
  progress as progressOf,
  remainingMs,
  type FocusPhase,
  type TimerState,
} from "../src/timerModel.ts";
import { finishedCopy } from "./alerts.ts";
import type { TimerController, TimerSnapshot } from "./controller.ts";
import { CheckGlyph, CompactGlyph, PauseGlyph, PlayGlyph, ResetGlyph, SkipGlyph, TimerMark } from "./glyphs.tsx";
import { phaseLabel, toneOf, type Tone } from "./labels.ts";
import { unlockAudio } from "./sound.ts";
import { timerController, timerHost, useNow, useTimer } from "./runtime.ts";
import TimerSettings, { LabelField, Stepper } from "./TimerSettings.tsx";

/** The quick editor under the dial: which part was asked for and the label
 *  it edits (kept, so a segment ending mid-edit does not swap the field). */
type Editing = { focus: "label" | "rounds"; tone: Tone };

const GAP = 12;
const INSETS: Insets = { start: GAP, top: GAP, end: GAP, bottom: GAP };

/** How far the launcher strip floats into the chat column at its end edge,
 *  so the timer sits beside it instead of over its icons. */
function stripLane(columnBox: DOMRect, rtl: boolean): number {
  const strip = document.querySelector<HTMLElement>(".plugin-strip");
  const box = strip?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0) return 0;
  if (box.right <= columnBox.left || box.left >= columnBox.right) return 0;
  return Math.max(0, rtl ? box.right - columnBox.left : columnBox.right - box.left);
}

const PHONE_QUERY = "(max-width: 480px), (max-height: 480px) and (pointer: coarse)";
let topProbe: HTMLElement | null = null;

/** On the phone shell the session title and its buttons float over the top
 *  of Chat: keep the timer under them (safe area included). */
function phoneTopClearance(): number {
  if (typeof matchMedia !== "function" || !matchMedia(PHONE_QUERY).matches) return 0;
  if (!topProbe || !topProbe.isConnected) {
    topProbe = document.createElement("div");
    topProbe.setAttribute("aria-hidden", "true");
    topProbe.className = "focus-timer-probe";
    document.body.appendChild(topProbe);
  }
  return topProbe.offsetHeight;
}

function chatFrame(): { rect: Rect; rtl: boolean; insets: Insets } {
  const column = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".app-shell > .workspace") : null;
  const box = column?.getBoundingClientRect();
  if (column && box && box.width > 0 && box.height > 0) {
    const rtl = getComputedStyle(column).direction === "rtl";
    return {
      rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      rtl,
      insets: { ...INSETS, top: Math.max(GAP, phoneTopClearance()), end: GAP + stripLane(box, rtl) },
    };
  }
  return {
    rect: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    rtl: document.documentElement.dir === "rtl",
    insets: INSETS,
  };
}

function clockTime(at: number): string {
  try {
    return new Intl.DateTimeFormat(timerHost()?.ui.locale.get() ?? undefined, { hour: "numeric", minute: "2-digit" }).format(at);
  } catch {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

/** The dial: a track, the elapsed arc and a dot riding its head. */
function Dial({ fraction, size, stroke }: { fraction: number; size: number; stroke: number }) {
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  const cx = size / 2 + r * Math.cos(angle);
  const cy = size / 2 + r * Math.sin(angle);
  return (
    <svg className="focus-timer-dial-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle className="focus-timer-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="focus-timer-arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={c * (1 - fraction)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {fraction > 0.001 && fraction < 0.999 && (
        <circle className="focus-timer-head-dot" cx={cx} cy={cy} r={stroke * 0.85} />
      )}
    </svg>
  );
}

/** The cycle's focus intervals as dots; a press opens the quick editor on
 *  their count. */
function RoundDots({ done, total, running, phase, expanded, onPress }: {
  done: number;
  total: number;
  running: boolean;
  phase: FocusPhase;
  expanded: boolean;
  onPress: () => void;
}) {
  const where = tr("focustimer.round", { current: Math.min(total, done + (phase === "focus" ? 1 : 0)) || 1, total });
  return (
    <button
      type="button"
      className="focus-timer-rounds"
      aria-label={`${where}. ${tr("focustimer.action.editRounds")}`}
      aria-expanded={expanded}
      title={tr("focustimer.action.editRounds")}
      onClick={onPress}
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className="focus-timer-round"
          data-state={index < done ? "done" : index === done && phase === "focus" ? (running ? "live" : "next") : "todo"}
        />
      ))}
    </button>
  );
}

/** Under the dial: the shown phase's label and, for pomodoro, how many focus
 *  intervals make a cycle. Both apply at once; the dots and chip above are
 *  the preview. */
function QuickEditor({ editing, snapshot, controller, onClose }: {
  editing: Editing;
  snapshot: TimerSnapshot;
  controller: TimerController;
  onClose: () => void;
}) {
  const id = useId();
  const { settings, timer } = snapshot;
  return (
    <div className="focus-timer-edit" data-tone={editing.tone} role="group" aria-labelledby={`${id}-caption`}>
      <div className="focus-timer-edit-head">
        <label className="focus-timer-edit-caption" id={`${id}-caption`} htmlFor={`${id}-label`}>
          {tr("focustimer.edit.label")}
        </label>
        <button type="button" className="focus-timer-edit-done" onClick={onClose}>{tr("focustimer.edit.done")}</button>
      </div>
      <LabelField
        id={`${id}-label`}
        tone={editing.tone}
        value={customLabel(settings, editing.tone)}
        autoFocus={editing.focus === "label"}
        onCommit={(label) => controller.setLabel(editing.tone, label)}
        onDone={onClose}
        onCancel={onClose}
      />
      {timer.mode === "pomodoro" && (
        <Stepper
          settingKey="rounds"
          value={settings.rounds}
          label={tr("focustimer.edit.rounds")}
          unit=""
          autoFocus={editing.focus === "rounds"}
          onChange={(rounds) => controller.updateSettings({ rounds })}
        />
      )}
    </div>
  );
}

function useDrag(
  cardRef: RefObject<HTMLElement | null>,
  onDrop: (left: number, top: number) => void,
  setLive: (position: { left: number; top: number } | null) => void,
) {
  const drag = useRef<{ id: number; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Controls keep their press; the pill's face is a button that also drags.
    if (target.closest("button:not([data-drag]), input, select, textarea, a, [role='tab']")) return;
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    drag.current = { id: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top, x: event.clientX, y: event.clientY, moved: false };
    suppressClick.current = false;
  }, [cardRef]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const card = cardRef.current;
    if (!state || state.id !== event.pointerId || !card) return;
    if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
    if (!state.moved) {
      // Capture only once it is a drag, so a plain press still clicks its button.
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    state.moved = true;
    card.dataset.dragging = "true";
    const { rect, rtl, insets } = chatFrame();
    setLive(clampPosition(rect, { width: card.offsetWidth, height: card.offsetHeight }, event.clientX - state.dx, event.clientY - state.dy, insets, rtl));
  }, [cardRef, setLive]);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const card = cardRef.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!card || !state.moved) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    delete card.dataset.dragging;
    suppressClick.current = true;
    onDrop(event.clientX - state.dx, event.clientY - state.dy);
  }, [cardRef, onDrop]);

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
    /** True once, right after a drag ended: the click that follows is not a press. */
    takeSuppressedClick: () => {
      const value = suppressClick.current;
      suppressClick.current = false;
      return value;
    },
  };
}

function TimerCard({ snapshot, controller }: { snapshot: TimerSnapshot; controller: TimerController }) {
  const { timer, settings, window: prefs, view } = snapshot;
  const now = useNow(timer.status === "running" ? timer.endsAt : null);
  const cardRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [live, setLive] = useState<{ left: number; top: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const tone = toneOf(timer);
  const label = phaseLabel(tone, settings);
  const left = remainingMs(timer, now);
  const fraction = progressOf(timer, now);
  const running = timer.status === "running";
  const done = timer.finished ? finishedCopy(timer.finished, snapshot) : null;
  const fresh = Boolean(timer.finished && !timer.finished.stale);
  const compact = prefs.compact && view === "timer";

  // Folding, hiding or opening settings closes the quick editor.
  useEffect(() => {
    if (compact || view !== "timer") setEditing(null);
  }, [compact, view]);

  const toggleEditor = (focus: Editing["focus"]) => {
    setEditing((current) => current?.focus === focus ? null : { focus, tone });
  };

  const closeEditor = () => {
    const card = cardRef.current;
    const hadFocus = Boolean(card?.querySelector(".focus-timer-edit")?.contains(document.activeElement));
    setEditing(null);
    // Focus returns to the label it came from instead of falling to the page.
    if (hadFocus) requestAnimationFrame(() => chipRef.current?.focus({ preventScroll: true }));
  };

  const place = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const { rect, rtl, insets } = chatFrame();
    setPosition(placeCard(rect, { width: card.offsetWidth, height: card.offsetHeight }, prefs.anchor, insets, rtl));
  }, [prefs.anchor]);

  useLayoutEffect(() => {
    place();
  }, [place, compact, view, Boolean(done), Boolean(editing)]);

  useEffect(() => {
    const card = cardRef.current;
    const column = document.querySelector<HTMLElement>(".app-shell > .workspace");
    window.addEventListener("resize", place);
    if (typeof ResizeObserver !== "function") return () => window.removeEventListener("resize", place);
    const observer = new ResizeObserver(() => place());
    if (card) observer.observe(card);
    if (column) observer.observe(column);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  const onDrop = useCallback((dropLeft: number, dropTop: number) => {
    const card = cardRef.current;
    if (!card) return;
    const { rect, rtl, insets } = chatFrame();
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const clamped = clampPosition(rect, size, dropLeft, dropTop, insets, rtl);
    setLive(null);
    controller.setAnchor(anchorAt(rect, size, clamped.left, clamped.top, insets, rtl));
  }, [controller]);

  const { handlers, takeSuppressedClick } = useDrag(cardRef, onDrop, setLive);

  const press = (run: () => void) => () => {
    unlockAudio();
    run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      if (editing) closeEditor();
      else if (view === "settings") controller.setView("timer");
      else if (timer.finished) controller.acknowledge();
      else controller.setCompact(true);
      event.stopPropagation();
      return;
    }
    if (event.key === " " && view === "timer" && !target.closest("button, input, select, textarea, [role='tab']")) {
      event.preventDefault();
      unlockAudio();
      controller.toggle();
    }
  };

  const at = live ?? position;
  const style = at ? { left: `${at.left}px`, top: `${at.top}px` } : { visibility: "hidden" as const };
  const primaryLabel = running
    ? tr("focustimer.action.pause")
    : timer.status === "paused"
      ? tr("focustimer.action.resume")
      : timer.finished && timer.mode === "pomodoro"
        ? tr(timer.phase === "focus" ? "focustimer.action.startFocus" : "focustimer.action.startBreak")
        : tr("focustimer.action.start");
  const status = running
    ? tr("focustimer.endsAt", { time: clockTime(timer.endsAt ?? now) })
    : timer.status === "paused" ? tr("focustimer.paused") : tr("focustimer.ready");
  const todayMinutes = Math.round(timer.today.focusMs / 60_000);

  if (compact) {
    return (
      <section
        ref={cardRef}
        className="focus-timer focus-timer-pill"
        role="region"
        aria-label={tr("focustimer.title")}
        data-tone={tone}
        data-status={timer.status}
        data-done={fresh || undefined}
        data-color={settings.color || undefined}
        data-flash={settings.flash || undefined}
        style={style}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        <button
          type="button"
          className="focus-timer-pill-face"
          data-drag=""
          title={tr("focustimer.action.expand")}
          aria-label={`${label} ${formatClock(left)}. ${tr("focustimer.action.expand")}`}
          onClick={() => {
            if (takeSuppressedClick()) return;
            controller.acknowledge();
            controller.setCompact(false);
          }}
        >
          <span className="focus-timer-pill-dial"><Dial fraction={fraction} size={26} stroke={3} /></span>
          <span className="focus-timer-pill-time">{formatClock(left)}</span>
        </button>
        <button
          type="button"
          className="focus-timer-icon-btn focus-timer-pill-play"
          aria-label={primaryLabel}
          title={primaryLabel}
          onClick={press(() => controller.toggle())}
        >
          {running ? <PauseGlyph size={14} /> : <PlayGlyph size={14} />}
        </button>
      </section>
    );
  }

  const icons = timerHost()?.ui.iconSet;
  const SettingsIcon = icons?.SettingsIcon;
  const CloseIcon = icons?.CloseIcon;
  const BackIcon = icons?.ChevronLeftIcon;
  const EditIcon = icons?.EditIcon;

  return (
    <section
      ref={cardRef}
      className="focus-timer focus-timer-card"
      role="region"
      aria-label={tr("focustimer.title")}
      data-tone={tone}
      data-status={timer.status}
      data-view={view}
      data-done={fresh || undefined}
      data-finished={timer.finished ? true : undefined}
      data-color={settings.color || undefined}
      data-flash={settings.flash || undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      <header className="focus-timer-head" {...handlers}>
        {view === "settings" ? (
          <button type="button" className="focus-timer-back" onClick={() => controller.setView("timer")}>
            {BackIcon ? <BackIcon size={16} aria-hidden /> : null}
            <span>{tr("focustimer.action.back")}</span>
          </button>
        ) : (
          <span className="focus-timer-head-meta">
            {timer.today.count > 0 && (
              <span
                className="focus-timer-today"
                role="img"
                aria-label={tr("focustimer.todayHint", { count: timer.today.count, minutes: todayMinutes })}
                title={tr("focustimer.todayHint", { count: timer.today.count, minutes: todayMinutes })}
              >
                <CheckGlyph size={12} strokeWidth={2.4} />
                {timer.today.count}
              </span>
            )}
          </span>
        )}
        <span className="focus-timer-tools">
          {view === "timer" && (
            <button type="button" className="focus-timer-icon-btn" aria-label={tr("focustimer.action.settings")} title={tr("focustimer.action.settings")} onClick={() => controller.setView("settings")}>
              {SettingsIcon ? <SettingsIcon size={16} aria-hidden /> : <span aria-hidden="true">⚙</span>}
            </button>
          )}
          {view === "timer" && (
            <button type="button" className="focus-timer-icon-btn" aria-label={tr("focustimer.action.compact")} title={tr("focustimer.action.compact")} onClick={() => controller.setCompact(true)}>
              <CompactGlyph size={15} />
            </button>
          )}
          <button type="button" className="focus-timer-icon-btn" aria-label={tr("focustimer.action.hide")} title={tr("focustimer.action.hide")} onClick={() => controller.hide()}>
            {CloseIcon ? <CloseIcon size={16} aria-hidden /> : <span aria-hidden="true">×</span>}
          </button>
        </span>
      </header>

      {view === "settings" ? (
        <div className="focus-timer-settings-scroll">
          <TimerSettings variant="window" />
        </div>
      ) : (
        <div className="focus-timer-body">
          <div className="focus-timer-dial">
            <Dial fraction={fraction} size={176} stroke={6} />
            <div className="focus-timer-face">
              <button
                ref={chipRef}
                type="button"
                className="focus-timer-chip"
                data-tone={tone}
                data-custom={customLabel(settings, tone) ? true : undefined}
                aria-label={`${label}. ${tr("focustimer.action.editLabel")}`}
                aria-expanded={editing?.focus === "label"}
                title={tr("focustimer.action.editLabel")}
                onClick={() => toggleEditor("label")}
              >
                <span className="focus-timer-chip-dot" aria-hidden="true" />
                <span className="focus-timer-chip-label">{label}</span>
                <span className="focus-timer-chip-pencil" aria-hidden="true">
                  {EditIcon ? <EditIcon size={11} aria-hidden /> : "✎"}
                </span>
              </button>
              <span className="focus-timer-time" aria-hidden="true">{formatClock(left)}</span>
              <span className="focus-timer-status">{status}</span>
              {timer.mode === "pomodoro" && (
                <RoundDots
                  done={timer.cycleDone}
                  total={settings.rounds}
                  running={running}
                  phase={timer.phase}
                  expanded={editing?.focus === "rounds"}
                  onPress={() => toggleEditor("rounds")}
                />
              )}
            </div>
          </div>
          <span className="sr-only" role="timer" aria-live="off">{`${label} ${formatClock(left)}`}</span>

          {editing && <QuickEditor editing={editing} snapshot={snapshot} controller={controller} onClose={closeEditor} />}

          {done && (
            <div className="focus-timer-done" role="status">
              <span className="focus-timer-done-text">
                <strong>{done.title}</strong>
                <span>{done.body}</span>
              </span>
              <button
                type="button"
                className="focus-timer-icon-btn focus-timer-done-dismiss"
                aria-label={tr("focustimer.action.dismiss")}
                title={tr("focustimer.action.dismiss")}
                onClick={() => controller.acknowledge()}
              >
                {CloseIcon ? <CloseIcon size={14} aria-hidden /> : <span aria-hidden="true">×</span>}
              </button>
            </div>
          )}

          <div className="focus-timer-controls">
            <button type="button" className="focus-timer-icon-btn focus-timer-side" aria-label={tr("focustimer.action.reset")} title={tr("focustimer.action.reset")} onClick={press(() => controller.reset())} disabled={timer.status === "idle" && left === timer.durationMs && !timer.finished}>
              <ResetGlyph size={18} />
            </button>
            <button
              type="button"
              className="focus-timer-play"
              aria-label={primaryLabel}
              title={primaryLabel}
              onClick={press(() => controller.toggle())}
            >
              {running ? <PauseGlyph size={22} /> : <PlayGlyph size={22} />}
            </button>
            {timer.mode === "pomodoro" ? (
              <button type="button" className="focus-timer-icon-btn focus-timer-side" aria-label={tr("focustimer.action.skip")} title={tr("focustimer.action.skip")} onClick={press(() => controller.skip())}>
                <SkipGlyph size={18} />
              </button>
            ) : (
              <button type="button" className="focus-timer-icon-btn focus-timer-side focus-timer-plus" aria-label={tr("focustimer.action.addMinute")} title={tr("focustimer.action.addMinute")} onClick={press(() => controller.addMinutes(1))}>
                +1
              </button>
            )}
          </div>

          <div className="focus-timer-segments" role="tablist" aria-label={tr("focustimer.phase.label")}>
            {(["focus", "short", "long", "countdown"] as const).map((item) => {
              const selected = item === tone;
              const label = item === "focus" ? tr("focustimer.phase.focusTab")
                : item === "short" ? tr("focustimer.phase.shortTab")
                  : item === "long" ? tr("focustimer.phase.longTab")
                    : tr("focustimer.mode.countdown");
              const full = item === "focus" ? tr("focustimer.phase.focus")
                : item === "short" ? tr("focustimer.phase.short")
                  : item === "long" ? tr("focustimer.phase.long")
                    : tr("focustimer.mode.countdown");
              return (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={item === "countdown" ? full : undefined}
                  className="focus-timer-segment"
                  data-tone={item}
                  title={full}
                  onClick={() => {
                    if (selected) return;
                    if (item === "countdown") controller.selectMode("countdown");
                    else controller.selectPhase(item);
                  }}
                >
                  {item === "countdown" ? <TimerMark size={16} /> : label}
                </button>
              );
            })}
          </div>

          {timer.mode === "countdown" && <CountdownPresets timer={timer} controller={controller} />}
        </div>
      )}
    </section>
  );
}

function CountdownPresets({ timer, controller }: { timer: TimerState; controller: TimerController }) {
  const [custom, setCustom] = useState("");
  const submit = () => {
    const minutes = Number(custom.replace(",", "."));
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    unlockAudio();
    controller.setCountdown(minutes, true);
    setCustom("");
  };
  return (
    <div className="focus-timer-presets" role="group" aria-label={tr("focustimer.presets")}>
      {COUNTDOWN_PRESETS.map((minutes) => (
        <button
          key={minutes}
          type="button"
          className="focus-timer-preset"
          aria-pressed={timer.countdownMin === minutes}
          onClick={() => {
            unlockAudio();
            controller.setCountdown(minutes, true);
          }}
        >
          {tr("focustimer.minutes", { count: minutes })}
        </button>
      ))}
      <form
        className="focus-timer-custom"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="focus-timer-custom-input"
          type="number"
          inputMode="decimal"
          min={1}
          max={720}
          step={1}
          value={custom}
          placeholder={tr("focustimer.customMinutes")}
          aria-label={tr("focustimer.customMinutes")}
          onChange={(event) => setCustom(event.target.value)}
        />
        <button type="submit" className="focus-timer-preset" disabled={!custom.trim()}>
          {tr("focustimer.customSet")}
        </button>
      </form>
    </div>
  );
}

/** The screen's edge, pulsing once in the phase colour as a segment ends.
 *  It never takes a pointer. */
function EdgeFlash({ snapshot }: { snapshot: TimerSnapshot }) {
  const finished = snapshot.timer.finished;
  const [visible, setVisible] = useState<string | null>(null);
  useEffect(() => {
    if (!finished || finished.stale || !snapshot.settings.flash) {
      setVisible(null);
      return;
    }
    if (Date.now() - finished.at > 6000) return;
    setVisible(finished.segmentId);
    const handle = setTimeout(() => setVisible(null), 4200);
    return () => clearTimeout(handle);
  }, [finished?.segmentId, finished?.stale, snapshot.settings.flash]);
  if (!finished || visible !== finished.segmentId) return null;
  // The colour of what comes next: a green edge says "break time".
  return <div className="focus-timer-edge" data-tone={toneOf(snapshot.timer)} aria-hidden="true" />;
}

export default function TimerLayer() {
  const snapshot = useTimer();
  const controller = timerController();
  if (!snapshot || !controller) return null;
  return (
    <>
      <EdgeFlash snapshot={snapshot} />
      {snapshot.window.open && <TimerCard snapshot={snapshot} controller={controller} />}
    </>
  );
}
