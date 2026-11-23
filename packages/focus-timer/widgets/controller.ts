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
  findCycle,
  insertStep,
  isBuiltinCycle,
  moveStep,
  newCycleId,
  newStep,
  removeStep,
  sameCycle,
  updateStep,
  MAX_CYCLES,
  type CycleEdit,
  type CycleSet,
  type CycleStep,
} from "../src/cycles.ts";
import {
  DEFAULT_SETTINGS,
  normalizeLabel,
  parseSettings,
  sameSettings,
  type FocusTimerSettings,
} from "../src/settings.ts";
import {
  acknowledge,
  addTime,
  applySettings,
  parseState,
  reset,
  selectMode,
  selectStep,
  setCountdown,
  skip,
  start,
  tick,
  toggle,
  type FinishedSegment,
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
  /** Go to step `index` of the running cycle. */
  selectStep(index: number): void;
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
  /** Name the countdown; "" restores the built-in name. */
  setCountdownLabel(label: string): void;
  // cycles
  /** Run cycle `id` from its first step (whatever was running stops). */
  selectCycle(id: string): void;
  /** A new own cycle, a copy of `fromId` when given, chosen at once.
   *  Returns its id, or null at the MAX_CYCLES limit. */
  createCycle(fromId?: string): string | null;
  /** Delete one of the person's own cycles. */
  deleteCycle(id: string): void;
  renameCycle(id: string, name: string): void;
  /** Change one step; `index` is in cycle `id`. A built-in cycle is never
   *  changed: the first edit makes the person's own copy and runs it. */
  updateStep(id: string, index: number, patch: Partial<CycleStep>): void;
  /** Add a step after `after` (at the end without it). */
  addStep(id: string, after?: number): void;
  removeStep(id: string, index: number): void;
  moveStep(id: string, from: number, to: number): void;
  duplicateStep(id: string, index: number): void;
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

  /** Run another cycle (chosen, or the running one was deleted): it starts
   *  at its first step, stopped, and whatever was running stops. */
  function switchCycle(value: FocusTimerSettings): void {
    const next = parseSettings(value);
    deps.effects.silence();
    timer = { ...acknowledge(timer), status: "idle", endsAt: null, segmentId: null, mode: "pomodoro", cycleId: next.cycleId, step: 0 };
    controller.writeSettings(next);
    commit(reset(timer, settings));
  }

  /** Apply `change` to cycle `id`. A built-in cycle becomes the person's own
   *  copy first. When the cycle runs, the timer keeps its step: an index the
   *  edit moved follows it. */
  function edit(id: string, change: (cycle: CycleSet) => CycleEdit): void {
    const builtin = isBuiltinCycle(id);
    const source = builtin ? findCycle([], id) : settings.cycles.find((cycle) => cycle.id === id);
    if (!source || source.id !== id) return;
    const result = change(source);
    if (sameCycle(result.cycle, source)) return;
    if (builtin && settings.cycles.length >= MAX_CYCLES) return;
    const cycle: CycleSet = builtin ? { ...result.cycle, id: newCycleId(settings.cycles), name: "" } : result.cycle;
    const cycles = builtin ? [...settings.cycles, cycle] : settings.cycles.map((item) => item.id === id ? cycle : item);
    const running = settings.cycleId === id;
    if (running) {
      const step = result.map ? result.map(timer.step) : timer.step;
      timer = { ...timer, cycleId: cycle.id, step };
    }
    controller.writeSettings({ ...settings, cycles, cycleId: running ? cycle.id : settings.cycleId });
    if (running) commit(timer);
  }

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
    selectStep: (index) => commit(selectStep(acknowledge(timer), settings, index), { silence: true }),
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
    setCountdownLabel(label) {
      controller.updateSettings({ countdownLabel: normalizeLabel(label) });
    },

    selectCycle(id) {
      if (id === settings.cycleId) return;
      switchCycle({ ...settings, cycleId: id });
    },
    createCycle(fromId) {
      if (settings.cycles.length >= MAX_CYCLES) return null;
      const source = fromId ? findCycle(settings.cycles, fromId) : null;
      const cycle: CycleSet = source
        ? { id: newCycleId(settings.cycles), name: isBuiltinCycle(source.id) ? "" : source.name, steps: source.steps.map((item) => ({ ...item })) }
        : { id: newCycleId(settings.cycles), name: "", steps: [newStep(undefined), newStep(newStep(undefined))] };
      if (source?.preset) cycle.preset = source.preset;
      controller.updateSettings({ cycles: [...settings.cycles, cycle] });
      controller.selectCycle(cycle.id);
      return cycle.id;
    },
    deleteCycle(id) {
      if (isBuiltinCycle(id) || !settings.cycles.some((cycle) => cycle.id === id)) return;
      const cycles = settings.cycles.filter((cycle) => cycle.id !== id);
      if (settings.cycleId === id) switchCycle({ ...settings, cycles, cycleId: DEFAULT_SETTINGS.cycleId });
      else controller.updateSettings({ cycles });
    },
    renameCycle(id, name) {
      edit(id, (cycle) => ({ cycle: { ...cycle, name: normalizeLabel(name) } }));
    },
    updateStep: (id, index, patch) => edit(id, (cycle) => updateStep(cycle, index, patch)),
    addStep: (id, after) => edit(id, (cycle) => {
      const where = after === undefined ? cycle.steps.length - 1 : after;
      return insertStep(cycle, where + 1, newStep(cycle.steps[where]));
    }),
    removeStep: (id, index) => edit(id, (cycle) => removeStep(cycle, index)),
    moveStep: (id, from, to) => edit(id, (cycle) => moveStep(cycle, from, to)),
    duplicateStep: (id, index) => edit(id, (cycle) => cycle.steps[index] ? insertStep(cycle, index + 1, { ...cycle.steps[index] }) : { cycle }),
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
