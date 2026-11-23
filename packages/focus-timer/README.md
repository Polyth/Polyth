# Focus timer

A floating pomodoro and countdown timer beside the chat. The stopwatch launcher on the
right rail (or the command palette) shows and hides it; the window can be dragged
anywhere in the chat column and folded to a small pill.

- **Cycles:** a cycle is an ordered list of steps; each step has a name, a length
  (1–240 min), a kind (focus or break) and a colour. The steps run in order and start
  again after the last one. Ready-made cycles (classic Pomodoro 4 × 25/5 with a
  15-minute long break, 52/17, 50/10, Deep work 90/20, Sit/stand) are picked from a
  dropdown; changing one saves the person's own copy. Own cycles (up to 24, 16 steps
  each) are created, duplicated, renamed and deleted in Settings and saved with the
  account preference. The dots under the dial are the steps; pressing them picks a
  cycle or jumps to a step. Skipping a focus step moves on without counting it. A quiet
  tally (✓ 3) counts today's finished focus steps; auto-start follows the next step's
  kind.
- **Names:** a press on the step name on the dial opens a quick editor under it: the
  person's own name for that step (up to 40 characters; empty brings back the
  built-in one) and its length; the plain timer's name is edited the same way. The
  name shows on the dial, the status chip and in the time-up notices, and names the
  folded pill for screen readers.
- **Timer:** a plain countdown with quick lengths (1–90 min), any number of minutes,
  and +1 minute while it runs.
- **When time is up**, each one can be turned on or off: a synthesised sound (four
  voices, volume, 1–5 plays), a flash (the window pulses and the screen's edge glows
  once), colour (the window wears the phase colour and fills with it until seen) and a
  system notification while Polyth is in the background. A hidden window sends one
  in-app notification with the next step instead. Reduced motion turns the pulses into
  a steady ring.

## How it is built

- `src/timerModel.ts` is the engine: pure functions over one serialisable state, timed
  by the wall clock (`endsAt`), so a throttled tab, a sleeping laptop or a reload lands
  on the right second. A segment that ran out more than 90 s ago finishes quietly and
  never chains auto-started segments.
- `src/cycles.ts` defines steps, the ready-made cycles and the pure step edits (each
  reports where old step indexes went, so the running timer stays on its step); names
  are one line, no control characters, 40 code points. `src/settings.ts` parses and
  clamps the settings and turns the older shape
  (`focusMin`/`shortMin`/`longMin`/`rounds` and per-phase labels) into an own cycle
  when it differs from the defaults; a version 1 timer state lands on the matching
  step; `widgets/labels.ts` picks the custom or built-in name for every surface;
  `src/placement.ts` keeps the
  window's place as fractions of the chat column, so it stays in its corner when the
  column changes size, and mirrors for right-to-left layouts.
- `widgets/controller.ts` owns state, persistence and cross-tab sync. The running
  timer and the window's place are this device's (`localStorage`,
  `polyth.focus-timer.*`); the settings are the person's account UI preference
  `package.focus-timer`, so they follow them to every device. Only the first tab to
  see a segment end rings (`polyth.focus-timer.alerted.v1`); the others follow the
  shared state.
- `widgets/index.tsx` registers the `app.layers` window, the `focus-timer` command
  launcher (its stopwatch mark fills as a segment runs), an optional status-bar chip
  (`focus-timer.chip`), three palette commands and the Settings page.
- `widgets/sound.ts` synthesises the sounds with Web Audio (no audio files). Browsers
  allow sound only after a gesture, so the audio context opens on the first Start or
  preview press.
- `src/serverEntry.ts` only makes the package discoverable (no routes, no server
  state).

Tests: `npm test` in this folder (engine, settings, placement and the controller with
a fake clock and two tabs sharing storage).
