// The focus timer's controller: owns the running state, the window's place
// and the person's settings, keeps them in sync across tabs and decides when
// a finished segment rings. Browser services come in as dependencies, so the
// tests drive it with a fake clock and storage.
//
// Storage: the running timer and the window's place are this device's
// (localStorage: a phone and a laptop each keep their own timer and screen
// corner); the settings are the person's and travel through the host's
// account preference (`package.focus-timer`, see index.tsx).
import { DEFAULT_ANCHOR, parseAnchor, type Anchor } from "../src/placement.ts";
import {
  DEFAULT_SETTINGS,
  labelKey,
  normalizeLabel,
  parseSettings,
  sameSettings,
  type FocusTimerSettings,
  type LabelTone,
} from "../src/settings.ts";
import {
  acknowledge,
  addTime,
  applySettings,
  parseState,
  reset,
  selectMode,
  selectPhase,
  setCountdown,
  skip,
  start,
  tick,
  toggle,
  type FinishedSegment,
  type FocusPhase,
  type TimerMode,
  type TimerState,
} from "../src/timerModel.ts";

export const STATE_KEY = "polyth.focus-timer.state.v1";
export const WINDOW_KEY = "polyth.focus-timer.window.v1";
export const ALERT_KEY = "polyth.focus-timer.alerted.v1";

/** How long an auto-started next segment keeps the "time is up" banner. */
export const AUTO_ACK_MS = 45_000;

export type TimerView = "timer" | "settings";

export interface WindowPrefs {
  /** The floating window is shown. */
  open: boolean;
  /** Folded to the small pill. */
  compact: boolean;
  anchor: Anchor;
}

export interface TimerSnapshot {
  settings: FocusTimerSettings;
  timer: TimerState;
  window: WindowPrefs;
  view: TimerView;
}

export interface TimerEffects {
  /** A segment ran out in this tab first: sound, system notice, toast. */
  ring(finished: FinishedSegment, snapshot: TimerSnapshot): void;
  /** The person acknowledged it: stop a sound still playing. */
  silence(): void;
}

export interface ControllerDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  effects: TimerEffects;
}

export interface TimerController {
  getSnapshot(): TimerSnapshot;
  subscribe(listener: () => void): () => void;
  // timer
  toggle(): void;
  start(): void;
  reset(): void;
  skip(): void;
  addMinutes(minutes: number): void;
  selectPhase(phase: FocusPhase): void;
  selectMode(mode: TimerMode): void;
  setCountdown(minutes: number, run?: boolean): void;
  acknowledge(): void;
  // window
  show(): void;
  hide(): void;
  toggleWindow(): void;
  setCompact(compact: boolean): void;
  setAnchor(anchor: Anchor): void;
  setView(view: TimerView): void;
  // settings (account preference adapter)
  readSettings(): FocusTimerSettings;
  writeSettings(value: unknown): void;
  updateSettings(patch: Partial<FocusTimerSettings>): void;
  /** Name a phase or the countdown; "" restores the built-in name. */
  setLabel(tone: LabelTone, label: string): void;
  subscribeSettings(listener: () => void): () => void;
  // lifecycle
  /** Re-read the clock now (tab became visible, window regained focus). */
  check(): void;
  /** Another tab wrote `key`. */
  storageChanged(key: string | null): void;
  dispose(): void;
}

const MAX_TIMEOUT = 2_147_000_000;

function readJson(storage: ControllerDeps["storage"], key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    return null;
  }
}

function writeJson(storage: ControllerDeps["storage"], key: string, value: unknown): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* private mode or full: keep it in memory */ }
}

function parseWindow(raw: unknown): WindowPrefs {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    open: value.open === true,
    compact: value.compact === true,
    anchor: value.anchor ? parseAnchor(value.anchor) : { ...DEFAULT_ANCHOR },
  };
}

export function createTimerController(deps: ControllerDeps): TimerController {
  let settings: FocusTimerSettings = { ...DEFAULT_SETTINGS };
  let timer: TimerState = parseState(readJson(deps.storage, STATE_KEY), settings, deps.now());
  let windowPrefs = parseWindow(readJson(deps.storage, WINDOW_KEY));
  let view: TimerView = "timer";
  let snapshot: TimerSnapshot = { settings, timer, window: windowPrefs, view };
  let pending: unknown = null;
  let ackTimer: unknown = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const settingsListeners = new Set<() => void>();

  const publish = () => {
    snapshot = { settings, timer, window: windowPrefs, view };
    for (const listener of [...listeners]) listener();
  };

  const persistTimer = () => writeJson(deps.storage, STATE_KEY, timer);
  const persistWindow = () => writeJson(deps.storage, WINDOW_KEY, windowPrefs);

  /** Only the first tab to see a segment end rings for it. */
  const claim = (segmentId: string): boolean => {
    if (!deps.storage) return true;
    try {
      if (deps.storage.getItem(ALERT_KEY) === segmentId) return false;
      deps.storage.setItem(ALERT_KEY, segmentId);
      return true;
    } catch {
      return true;
    }
  };

  const scheduleAck = () => {
    if (ackTimer !== null) deps.clearTimer(ackTimer);
    ackTimer = null;
    const finished = timer.finished;
    if (!finished || timer.status !== "running") return;
    const wait = finished.at + AUTO_ACK_MS - deps.now();
    if (wait <= 0) {
      timer = acknowledge(timer);
      persistTimer();
      return;
    }
    ackTimer = deps.setTimer(() => {
      ackTimer = null;
      if (timer.finished?.segmentId !== finished.segmentId) return;
      timer = acknowledge(timer);
      persistTimer();
      publish();
    }, wait);
  };

  const schedule = () => {
    if (pending !== null) deps.clearTimer(pending);
    pending = null;
    if (disposed || timer.status !== "running" || timer.endsAt === null) return;
    // A few ms late, so the clock is past the end when the tick reads it.
    const wait = Math.min(MAX_TIMEOUT, Math.max(0, timer.endsAt - deps.now() + 15));
    pending = deps.setTimer(() => {
      pending = null;
      check();
    }, wait);
  };

  const commit = (next: TimerState, options: { silence?: boolean } = {}) => {
    if (options.silence) deps.effects.silence();
    timer = next;
    persistTimer();
    schedule();
    scheduleAck();
    publish();
  };

  function check(): void {
    if (disposed) return;
    const result = tick(timer, settings, deps.now());
    if (result.state === timer) {
      schedule();
      return;
    }
    timer = result.state;
    persistTimer();
    schedule();
    scheduleAck();
    publish();
    const finished = result.finished;
    if (finished && !finished.stale && claim(finished.segmentId)) deps.effects.ring(finished, snapshot);
  }

  const now = () => deps.now();

  const controller: TimerController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    toggle: () => commit(toggle(timer, now()), { silence: true }),
    start: () => commit(start(timer, now()), { silence: true }),
    reset: () => commit(reset(timer, settings), { silence: true }),
    skip: () => commit(skip(timer, settings, now()), { silence: true }),
    addMinutes: (minutes) => commit(addTime(acknowledge(timer), minutes * 60_000, now()), { silence: true }),
    selectPhase: (phase) => commit(selectPhase(timer, settings, phase), { silence: true }),
    selectMode: (mode) => commit(selectMode(acknowledge(timer), settings, mode), { silence: true }),
    setCountdown: (minutes, run = false) => commit(setCountdown(timer, minutes, now(), run), { silence: true }),
    acknowledge: () => {
      if (!timer.finished) {
        deps.effects.silence();
        return;
      }
      commit(acknowledge(timer), { silence: true });
    },

    show() {
      if (windowPrefs.open) return;
      windowPrefs = { ...windowPrefs, open: true };
      persistWindow();
      publish();
    },
    hide() {
      if (!windowPrefs.open && view === "timer") return;
      windowPrefs = { ...windowPrefs, open: false };
      view = "timer";
      persistWindow();
      publish();
    },
    toggleWindow() {
      if (windowPrefs.open) controller.hide();
      else controller.show();
    },
    setCompact(compact) {
      if (windowPrefs.compact === compact) return;
      windowPrefs = { ...windowPrefs, compact };
      if (compact) view = "timer";
      persistWindow();
      publish();
    },
    setAnchor(anchor) {
      windowPrefs = { ...windowPrefs, anchor: parseAnchor(anchor) };
      persistWindow();
      publish();
    },
    setView(next) {
      if (view === next) return;
      view = next;
      if (next === "settings" && windowPrefs.compact) windowPrefs = { ...windowPrefs, compact: false };
      publish();
    },

    readSettings: () => settings,
    writeSettings(value) {
      const next = parseSettings(value);
      if (sameSettings(next, settings)) return;
      settings = next;
      timer = applySettings(timer, settings);
      persistTimer();
      schedule();
      publish();
      for (const listener of [...settingsListeners]) listener();
    },
    updateSettings(patch) {
      controller.writeSettings({ ...settings, ...patch });
    },
    setLabel(tone, label) {
      const patch: Partial<FocusTimerSettings> = {};
      patch[labelKey(tone)] = normalizeLabel(label);
      controller.updateSettings(patch);
    },
    subscribeSettings(listener) {
      settingsListeners.add(listener);
      return () => { settingsListeners.delete(listener); };
    },

    check,
    storageChanged(key) {
      if (key !== null && key !== STATE_KEY && key !== WINDOW_KEY) return;
      if (key === null || key === STATE_KEY) {
        timer = parseState(readJson(deps.storage, STATE_KEY), settings, now());
        schedule();
        scheduleAck();
      }
      if (key === null || key === WINDOW_KEY) windowPrefs = parseWindow(readJson(deps.storage, WINDOW_KEY));
      publish();
    },
    dispose() {
      disposed = true;
      if (pending !== null) deps.clearTimer(pending);
      if (ackTimer !== null) deps.clearTimer(ackTimer);
      pending = null;
      ackTimer = null;
      deps.effects.silence();
      listeners.clear();
      settingsListeners.clear();
    },
  };

  // The caller runs the first `check()` once the saved settings are in, so a
  // segment that ended while no tab was open moves on with the right lengths.
  return controller;
}
