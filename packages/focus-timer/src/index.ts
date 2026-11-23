// Focus timer: a floating pomodoro and countdown timer beside the chat. The
// engine (timerModel.ts), settings and window placement are pure and shared by
// the web entry and the tests; the package keeps no server state.
export const FOCUS_TIMER_PACKAGE_ID = "focus-timer";
/** The rail launcher; a press shows or hides the floating window. */
export const FOCUS_TIMER_CAPABILITY_ID = "focus-timer";
/** Account-wide UI preference holding the person's timer settings. */
export const FOCUS_TIMER_PREFERENCE_ID = "package.focus-timer";

export * from "./settings.ts";
export * from "./timerModel.ts";
export * from "./placement.ts";
export type { FocusTimerMessageKey } from "./i18n/index.ts";
