import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type WidgetDefinition } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { FOCUS_TIMER_CAPABILITY_ID, FOCUS_TIMER_PREFERENCE_ID } from "../src/index.ts";
import { createTimerEffects } from "./alerts.ts";
import { createTimerController } from "./controller.ts";
import { RailMark, TimerChip } from "./Launchers.tsx";
import { setRuntime, timerController } from "./runtime.ts";
import { closeAudio, unlockAudio } from "./sound.ts";
import TimerSettings from "./TimerSettings.tsx";
import TimerLayer from "./TimerWindow.tsx";

const CHIP_SLOTS = [
  "app.statusbar.leading",
  "app.statusbar.trailing",
  "app.header.actions",
  "app.header.center",
  "session.header.actions",
  "composer.leading",
  "composer.trailing",
  "sidebar.toolbar",
] as const;

function chipDefinition(available: () => boolean): WidgetDefinition {
  return {
    id: "focus-timer.chip",
    title: tr("focustimer.widget.title"),
    description: tr("focustimer.widget.description"),
    kind: "mini-widget",
    defaultSlot: "app.statusbar.trailing",
    supportedSlots: CHIP_SLOTS,
    category: tr("focustimer.title"),
    capabilities: [FOCUS_TIMER_CAPABILITY_ID],
    defaultVisible: false,
    audience: "standard",
    scope: "global",
    duplicatable: false,
    resizable: false,
    defaultSize: { w: 2, h: 1 },
    minSize: { w: 1, h: 1 },
    isAvailable: () => available(),
    render: () => createElement(TimerChip),
  };
}

export default defineWebPackage((host) => () => {
  const effects = createTimerEffects(host, () => timerController());
  const active = createTimerController({
    storage: (() => {
      try { return globalThis.localStorage ?? null; } catch { return null; }
    })(),
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    effects,
  });
  setRuntime({ controller: active, host });

  const onStorage = (event: StorageEvent) => active.storageChanged(event.key);
  const onWake = () => active.check();
  const onVisibility = () => { if (!document.hidden) active.check(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onWake);
  window.addEventListener("pageshow", onWake);
  document.addEventListener("visibilitychange", onVisibility);

  const off = [
    // The person's settings follow them to every device.
    host.preferences.register(FOCUS_TIMER_PREFERENCE_ID, {
      read: () => active.readSettings(),
      write: (value) => active.writeSettings(value),
      subscribe: (listener) => active.subscribeSettings(listener),
    }),
    // The floating window and the screen-edge flash, over the whole shell.
    host.slots.register({
      slot: "app.layers",
      id: "focus-timer.window",
      render: () => createElement(TimerLayer),
    }),
    // A press shows or hides the window; it never opens or closes a pane.
    host.capabilities.register({
      id: FOCUS_TIMER_CAPABILITY_ID,
      label: tr("focustimer.title"),
      plainDescription: tr("focustimer.description"),
      keywords: ["timer", "pomodoro", "focus", "break", "countdown", "tomato", "stopwatch", "таймер", "помідор", "фокус", "перерва"],
      kind: "command",
      standardTier: "more",
      standardRank: 30,
      icon: RailMark,
      open: () => {
        unlockAudio();
        active.toggleWindow();
      },
      available: () => true,
    }),

    host.settings.registerPage({
      id: "focus-timer",
      label: tr("focustimer.title"),
      group: "Workspace",
      icon: "clock",
      order: 34,
      component: () => createElement(TimerSettings, { variant: "page" }),
      settingsItems: [{
        id: "focus-timer.settings",
        pageId: "focus-timer",
        label: tr("focustimer.title"),
        description: tr("focustimer.description"),
        keywords: ["timer", "pomodoro", "focus", "break", "sound", "notification", "flash"],
        focusTarget: "focus-timer.settings",
      }],
    }),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "focus-timer.palette",
      render: () => null,
      meta: {
        commands: [
          {
            id: "focus-timer.toggle",
            label: tr("focustimer.palette.toggle"),
            group: tr("focustimer.title"),
            keywords: ["timer", "pomodoro", "focus", "таймер", "помідор"],
            icon: "clock",
            run: () => active.toggleWindow(),
          },
          {
            id: "focus-timer.focus",
            label: tr("focustimer.palette.focus"),
            group: tr("focustimer.title"),
            keywords: ["pomodoro", "focus", "start", "помідор", "фокус"],
            icon: "clock",
            run: () => {
              unlockAudio();
              const { timer } = active.getSnapshot();
              // A focus already under way keeps its time; anything else starts one.
              const inFocus = timer.mode === "pomodoro" && timer.phase === "focus" && timer.status !== "idle";
              if (!inFocus) active.selectPhase("focus");
              if (timer.status !== "running" || !inFocus) active.start();
              active.show();
            },
          },
          {
            id: "focus-timer.pause",
            label: tr("focustimer.palette.pause"),
            group: tr("focustimer.title"),
            keywords: ["timer", "pause", "resume", "таймер", "пауза"],
            icon: "clock",
            run: () => {
              unlockAudio();
              active.toggle();
            },
          },
        ],
      },
    }),
  ];

  // Hosts read widget availability synchronously: re-register the chip when a
  // timer starts or stops, so a placed chip appears and leaves with it.
  const chipActive = () => {
    const { timer } = active.getSnapshot();
    return timer.status !== "idle" || timer.finished !== null;
  };
  let chipShown = chipActive();
  let chip = host.widgets.registerPlugin({ id: "focus-timer", name: tr("focustimer.title"), widgets: [chipDefinition(chipActive)] });
  const offChip = active.subscribe(() => {
    const next = chipActive();
    if (next === chipShown) return;
    chipShown = next;
    chip();
    chip = host.widgets.registerPlugin({ id: "focus-timer", name: tr("focustimer.title"), widgets: [chipDefinition(chipActive)] });
  });

  // Saved settings are in now: let a segment that ended while no tab was open
  // move on with the right lengths.
  active.check();

  return () => {
    offChip();
    chip();
    off.toReversed().forEach((dispose) => dispose());
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onWake);
    window.removeEventListener("pageshow", onWake);
    document.removeEventListener("visibilitychange", onVisibility);
    active.dispose();
    setRuntime(null);
    closeAudio();
  };
});
