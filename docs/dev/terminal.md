# Terminal: touch input

`packages/terminal` renders shells with its own emulator
(`widgets/terminal/emulator.ts`) and surface (`widgets/TermPane.tsx`). Phones
and tablets get a Termux-style input layer on top of the same PTY protocol; the
server, the WebSocket frames and the emulator are unchanged by it.

## Pieces

| File | Owns |
| --- | --- |
| `widgets/terminal/extraKeys.ts` | Termux `extra-keys` parser, sticky modifiers, FN layer, key encoding (pure) |
| `widgets/terminal/imeBridge.ts` | Software-keyboard diff bridge (pure) |
| `widgets/terminal/touchPrefs.ts` | Device-local touch preferences |
| `widgets/terminal/touchSelection.ts` | Long-press selection geometry: word extension, handle moves (pure) |
| `widgets/ExtraKeysBar.tsx` | Key rows: tap, swipe-up popup, hold-to-repeat, modifier lock, bar swipe |
| `widgets/TouchTerminalDialogs.tsx` | Extra-keys editor and the Select URL list |
| `widgets/TermPane.tsx` | Wiring: hidden input, gestures, menu, wake lock, bell vibration |

## Extra keys

The layout is Termux's `extra-keys` property, so a `termux.properties` line can
be pasted into **⋯ › Edit extra keys** unchanged: an array of rows of key names
or `{key, popup, display}` / `{macro, display}` objects, in lenient JSON
(single quotes and bare object keys accepted; a flat array is one row). The
default is termux-app's own default, byte for byte. Names: `ESC TAB HOME END
PGUP PGDN INS DEL BKSP ENTER SPACE UP DOWN LEFT RIGHT F1–F12 CTRL ALT SHIFT FN
KEYBOARD DRAWER PASTE`, Termux's aliases (`ESCAPE`, `PAGE_UP`, `BACKSPACE`, …),
and the Polyth addition `TEXT` (text-input row). Any other string is typed
literally, as in Termux. A macro is space-separated keys; a modifier in a
macro applies to the next step only.

- **Release acts.** A key sends on pointer release, so the same press can
  instead swipe up (≥ 22 px) for its popup, or slide sideways (≥ 56 px) to
  toggle the text-input row. Holding a navigation/delete key repeats it
  (420 ms, then every 60 ms); holding a popup key previews the popup.
- **Sticky modifiers.** A tap arms CTRL/ALT/SHIFT/FN for the next key; a double
  tap or a hold locks it until tapped again. They apply to extra keys, to
  software-keyboard text (first character), and to hardware key events.
- **FN** follows Termux's Volume-Up table: `WASD` arrows, `P`/`N` page keys,
  digits F1–F10, `E` Esc, `T` Tab, `B`/`F`/`X` Alt-word keys, `L` `|`,
  `H` `~`, `U` `_`, `.` Ctrl+\\, `Q`/`K` toggle the extra keys. Browsers do not
  deliver the volume keys themselves, so FN is the only route to this table.
- Pointer-down is cancelled on every key, so the hidden input keeps focus and
  the software keyboard stays up. The touch chrome and the hidden input are
  also a host keep-keyboard surface (`data-keep-keyboard`, see
  [mobile-viewport.md](mobile-viewport.md)): a touch on any bottom control
  also has its compatibility `mousedown` cancelled while a keyboard is up.
  A bare `click` (assistive technology, keyboard activation) still activates
  a key; the click that follows a pointer press does not act twice.
- A trailing column always holds **⋯** (session and action menu) and the
  keyboard toggle. With extra keys turned off on a touch device those two
  float over the output's bottom edge. The keyboard toggle (and a configured
  `KEYBOARD` key) is the one control that deliberately takes an open keyboard
  down, and raises a closed one. Switching, opening or closing a session
  replaces the pane, and with it the input that held the keyboard.

## Software keyboard

A tap on the output focuses a visually inert native input (only editable
controls raise a software keyboard). `imeBridge.ts` keeps one sentinel space in
it: Android keyboards send no key event for Backspace in an empty field, so
deleting the sentinel is the Backspace. Every `input`/`compositionend` is
diffed (by code point) against what the PTY already received and sent as DELs
plus the new suffix. Gboard-style word composition therefore echoes letter by
letter, and autocorrect or a suggestion arrives as the edit the keyboard made.
The field resets to the sentinel whenever no composition is pending, and after
a sticky-modified character so a later Backspace cannot erase a character the
shell never received. CJK composition is correct in the end state but echoes
the romanised input first. Selecting output never moves this focus (see
[Touch selection](#touch-selection)).

The **text-input row** (bar swipe, `TEXT`, or the menu) is an ordinary field
with full IME, autocorrect and dictation; Enter or Send writes the line plus
`\r`. Closing it hands the keyboard to the terminal input before the row's
field unmounts, so the keyboard is never left without an input.

## Touch selection

Touch selects through the terminal's own cell selection, as Termux does, not
the browser's. WebKit on iOS refuses a text-selection gesture outside the
focused editable element (`textInteractionGesture:shouldBeginAtPoint:` in
`WKContentViewInteraction.mm`), and while the user types that element is the
hidden input, so native selection could never start there. The output is
therefore `user-select: none` with `-webkit-touch-callout: none`, and a touch
`contextmenu` is cancelled.

- **Long press.** A finger held still for 450 ms (`LONG_PRESS_MS`) selects the
  word under it (the word characters of a double click, so paths and URLs come
  whole), or that one character, with a selection haptic. Moving 10 px first
  makes the touch a scroll or an app drag instead. Blank cells select nothing.
- **Extend.** Keeping that finger down and moving it extends the selection
  from the word either way; the word stays selected.
- **Handles.** On release a handle marks each end (knob above the start, below
  the end, finger-sized hit area). Dragging one moves that end to the nearest
  cell boundary; the handles stop a cell short of each other. Past the
  output's top or bottom edge the output scrolls.
- **Selection bar.** A bar above the selection (else below it, else at the
  top of the visible output) offers Copy, Select all and Paste (running
  sessions only). It steps aside while a finger adjusts the selection or the
  output scrolls. Copy writes the grid text (wrapped rows join, as with a
  mouse selection), shows "Copied" briefly and clears the selection. ⋯ › Copy
  copies the same selection.
- **Tap.** A tap first dismisses a selection; it neither opens the keyboard
  nor reaches a mouse-tracking program as a click. The next tap does.
- **Keyboard.** None of this moves focus: the handles and the bar cancel
  `pointerdown`, and the output cancels every touch compatibility
  `mousedown`, so an open software keyboard stays open throughout.
- A long press also selects in full-screen programs: it wins over drag-scroll
  as long as the finger has not moved.

## Gestures and menu

- **Pinch** previews the font live on `.term-view` and commits a per-device
  size on release (6–40 px); **⋯** has larger/smaller/reset. It overrides
  Appearance › Terminal font size on this device only, and the grid re-measures
  and resizes the PTY like any other resize.
- When the program owns the screen (alternate screen or mouse tracking), a
  one-finger drag is not native scrolling: `touch-action: none` applies and the
  drag becomes wheel reports (mouse tracking) or arrow keys, natural direction,
  one step per row of travel. Normal screens keep native momentum scrolling of
  the scrollback.
- **⋯** lists the pane's sessions (Termux's drawer) plus New, Copy/Copy all,
  Paste, Select URL (wrapped rows joined, newest first), Share transcript (Web
  Share, else copy), Find, text input, extra keys, Keep screen on (Screen Wake
  Lock, re-acquired when the page becomes visible), Vibrate on bell
  (throttled to once a second, touch only), zoom, Edit extra keys, Reset
  (emulator reset, then Ctrl+L so the program redraws) and Close session.
  On a phone the menu is a modal sheet while the keyboard is down. While a
  keyboard is up (the hidden input or the text-input row is focused) it opens
  as an anchored popover instead: a sheet claims focus and would take the
  keyboard down. The presentation is latched when the menu opens, and closing
  the menu returns focus to the input that held the keyboard.
- The **New output** pill (output arrived while the view is scrolled up)
  floats over the output's bottom edge, above the touch chrome rather than over
  the keys. Like the other bottom controls it is a keep-keyboard surface: a tap
  scrolls to the bottom without taking the keyboard down.
- The bar shows for coarse pointers by default (`auto`); the desktop context
  menu can force it on. Bottom clearance (home indicator, keyboard band)
  belongs to the hosting layer; the bar adds none.

## Preferences

`polyth.terminal.touch.v1` in `localStorage`: pinch font size, extra-keys
layout, bar visibility and bell vibration. These are per-device input
choices — a phone and a tablet with a hardware keyboard want different ones,
as Termux keeps them per install — so they are not account settings and never
enter session history. Invalid stored values fall back to defaults.

## Verification

```sh
node --experimental-strip-types --test packages/terminal/test/touchKeys.test.ts \
  packages/terminal/test/terminalTouchSelection.test.ts \
  packages/terminal/test/terminalKeepKeyboard.test.ts
```

`touchKeys.test.ts` covers the parser, modifiers, FN layer, encoding, IME diff,
URL collection, preference validation and the selection geometry.
`terminalTouchSelection.test.ts` mounts the real `TermPane` in happy-dom:
long-press selection with the keyboard input kept focused, hold-to-extend,
handle drags, the selection bar (Copy, Select all, Paste), tap-to-dismiss,
tap-to-type, live composition and sentinel Backspace, sticky modifiers from
the bar, the software keyboard and hardware keys, popups and repeat, the
text-input row, pinch zoom, alt-screen drag-scroll and the session menu. Its
touch events are synthetic; real Chromium touch input (CDP) is a separate
check, and neither is a software keyboard. `terminalKeepKeyboard.test.ts`
mounts the pane in a phone shell with the host keep-keyboard seam running: the
opt-in markup, the cancelled `pointerdown`/`mousedown` on the bottom controls,
the keyboard toggle still closing an open keyboard, the New output pill's
placement and tap, the ⋯ popover-versus-sheet choice with focus staying on (and
returning to) the input, and the text-input row's hand-over order. Gboard/iOS keyboard behaviour (including whether the
keyboard really stays up after a bottom control or a selection), keyboard-open
geometry, how the long press sits beside the platform's own long-press
gestures, and haptics need a device.
