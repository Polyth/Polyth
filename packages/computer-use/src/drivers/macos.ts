import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseError } from "../errors.ts";
import { baseCharacter, type KeyChord, type Modifier, type NamedKey } from "../keys.ts";
import { runCommand, type CommandRunner } from "../process.ts";
import type { ComputerDriver, DesktopState, DesktopWindow, InputStep } from "../types.ts";

/** ANSI virtual key codes (HIToolbox Events.h). */
const NAMED: Record<NamedKey, number> = {
  enter: 36, escape: 53, tab: 48, space: 49, backspace: 51, delete: 117, insert: 114,
  home: 115, end: 119, pageup: 116, pagedown: 121, up: 126, down: 125, left: 123, right: 124,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const CHARS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, "=": 24, 9: 25, 7: 26, "-": 27, 8: 28,
  0: 29, "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, "`": 50,
};
/** CGEventFlags masks. */
const FLAGS: Record<Modifier, number> = { shift: 1 << 17, ctrl: 1 << 18, alt: 1 << 19, meta: 1 << 20 };
/** Left-hand modifier key codes, for chords that press only modifiers. */
const MODIFIER_CODES: Record<Modifier, number> = { meta: 55, shift: 56, alt: 58, ctrl: 59 };

export interface MacKeyPress { code: number; flags: number; modifierCodes: number[] }

export const macKeyPress = (chord: KeyChord): MacKeyPress => {
  const modifiers = new Set(chord.modifiers);
  let code: number | undefined;
  if (chord.key?.kind === "named") code = NAMED[chord.key.name];
  else if (chord.key?.kind === "char") {
    const base = baseCharacter(chord.key.char);
    if (base.shift) modifiers.add("shift");
    code = CHARS[base.char];
  }
  const flags = [...modifiers].reduce((sum, modifier) => sum | FLAGS[modifier], 0);
  const modifierCodes = [...modifiers].map((modifier) => MODIFIER_CODES[modifier]);
  if (code === undefined) {
    if (!modifierCodes.length) throw new ComputerUseError("invalid-input", "keys names no key");
    return { code: -1, flags, modifierCodes };
  }
  return { code, flags, modifierCodes };
};

/** The JXA half of the driver. One request per osascript run, passed in the
 * environment so no value is ever spliced into script source. */
const SCRIPT = String.raw`
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function fail(code, message) { throw new Error(JSON.stringify({ code: code, message: message })); }
function requireInput() {
  if (!$.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')))) {
    fail('permission-required', 'macOS has not allowed Polyth to control the computer. Turn Polyth on in System Settings → Privacy & Security → Accessibility, then try again.');
  }
}
function requireCapture() {
  if (typeof $.CGPreflightScreenCaptureAccess === 'function' && !$.CGPreflightScreenCaptureAccess()) {
    if (typeof $.CGRequestScreenCaptureAccess === 'function') $.CGRequestScreenCaptureAccess();
    fail('permission-required', 'macOS has not allowed Polyth to record the screen. Turn Polyth on in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Polyth.');
  }
}
function state() {
  var bounds = $.CGDisplayBounds($.CGMainDisplayID());
  var location = $.CGEventGetLocation($.CGEventCreate(null));
  return { screen: { width: bounds.size.width, height: bounds.size.height }, cursor: { x: location.x, y: location.y } };
}
function post(event, flags) {
  if (flags) $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
}
var BUTTON = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] };
function mouse(type, point, button, flags, clicks) {
  var event = $.CGEventCreateMouseEvent(null, type, point, button);
  if (clicks) $.CGEventSetIntegerValueField(event, 1, clicks);
  post(event, flags);
}
function pause(seconds) { delay(seconds); }
function key(code, down, flags) { post($.CGEventCreateKeyboardEvent(null, code, down), flags); }
function press(step) {
  for (var r = 0; r < step.repeat; r++) {
    step.modifierCodes.forEach(function (code) { key(code, true, step.flags); });
    if (step.code >= 0) { key(step.code, true, step.flags); key(step.code, false, step.flags); }
    step.modifierCodes.slice().reverse().forEach(function (code) { key(code, false, 0); });
    if (r + 1 < step.repeat) pause(0.06);
  }
}
function typeText(text) {
  var events = Application('System Events');
  var lines = text.split('\n');
  lines.forEach(function (line, index) {
    if (line) events.keystroke(line);
    if (index + 1 < lines.length) { key(36, true, 0); key(36, false, 0); }
  });
}
function perform(step) {
  requireInput();
  if (step.kind === 'move') {
    mouse(5, step.to, 0, 0);
  } else if (step.kind === 'click') {
    var b = BUTTON[step.button];
    mouse(5, step.at, b[3], step.flags);
    for (var i = 1; i <= step.count; i++) {
      mouse(b[0], step.at, b[3], step.flags, i);
      mouse(b[1], step.at, b[3], step.flags, i);
      if (i < step.count) pause(0.05);
    }
  } else if (step.kind === 'drag') {
    var d = BUTTON[step.button];
    mouse(5, step.path[0], d[3], step.flags);
    mouse(d[0], step.path[0], d[3], step.flags, 1);
    for (var p = 1; p < step.path.length; p++) { pause(0.03); mouse(d[2], step.path[p], d[3], step.flags); }
    pause(0.05);
    mouse(d[1], step.path[step.path.length - 1], d[3], step.flags, 1);
  } else if (step.kind === 'scroll') {
    mouse(5, step.at, 0, 0);
    if (typeof $.CGEventCreateScrollWheelEvent2 !== 'function') fail('unsupported', 'This macOS version does not offer scroll events to scripts');
    post($.CGEventCreateScrollWheelEvent2(null, 0, 2, -step.dy, -step.dx, 0), step.flags);
  } else if (step.kind === 'type') {
    typeText(step.text);
  } else if (step.kind === 'key') {
    press(step);
  }
  pause(0.05);
  return state();
}
function windows() {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var frontPid = front ? front.processIdentifier : -1;
  var seenFront = false;
  return list.filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 1; })
    .slice(0, 60)
    .map(function (w) {
      var focused = !seenFront && w.kCGWindowOwnerPID === frontPid;
      if (focused) seenFront = true;
      return {
        id: String(w.kCGWindowNumber),
        title: w.kCGWindowName || '',
        app: w.kCGWindowOwnerName || '',
        pid: w.kCGWindowOwnerPID,
        bounds: { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height },
        focused: focused,
      };
    });
}
function focus(id) {
  var match = windows().filter(function (w) { return w.id === id; })[0];
  if (!match) fail('not-found', 'No window ' + id + '; list them again with action "windows"');
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(match.pid);
  if (!app || !app.activateWithOptions(2)) fail('driver-failed', 'macOS did not bring that app to the front');
  try {
    var proc = Application('System Events').processes.whose({ unixId: match.pid })[0];
    var target = proc.windows.whose({ name: match.title })[0];
    if (match.title && target) target.actions.byName('AXRaise').perform();
  } catch (error) { /* the app is in front; raising one window is best effort */ }
  return {};
}
function run() {
  var request = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey('POLYTH_COMPUTER_REQUEST').js);
  var result;
  if (request.op === 'state') { if (request.capture) requireCapture(); result = state(); }
  else if (request.op === 'perform') result = perform(request.step);
  else if (request.op === 'windows') result = windows();
  else if (request.op === 'focus') result = focus(request.id);
  else fail('invalid-input', 'unknown request');
  return JSON.stringify(result);
}
`;

/** The step as the JXA script reads it: chords become key codes and flags. */
export const macRequestStep = (step: InputStep): Record<string, unknown> => {
  const flagsOf = (modifiers: readonly Modifier[]) => modifiers.reduce((sum, modifier) => sum | FLAGS[modifier], 0);
  switch (step.kind) {
    case "key":
      return { kind: "key", repeat: step.repeat, ...macKeyPress(step.chord) };
    case "click":
    case "drag":
    case "scroll":
      return { ...step, flags: flagsOf(step.modifiers) };
    default:
      return { ...step };
  }
};

export interface MacDriverOptions {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
}

const PERMISSION_HINT = /not allowed|not permitted|-1743|-25211|assistive/i;

export function createMacDriver(options: MacDriverOptions = {}): ComputerDriver {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const jxa = async <T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    try {
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-"], {
        env: { ...env, POLYTH_COMPUTER_REQUEST: JSON.stringify(request) },
        input: SCRIPT,
        ...(signal ? { signal } : {}),
      });
      return JSON.parse(stdout.toString("utf8").trim()) as T;
    } catch (error) {
      if (!(error instanceof ComputerUseError)) throw error;
      // Script failures carry {code, message} as their error text.
      const raised = /\{"code":"([a-z-]+)","message":"((?:[^"\\]|\\.)*)"\}/.exec(error.message);
      if (raised) throw new ComputerUseError(raised[1] as ComputerUseError["code"], JSON.parse(`"${raised[2]}"`) as string);
      if (PERMISSION_HINT.test(error.message)) {
        throw new ComputerUseError("permission-required", "macOS blocked the action. Allow Polyth in System Settings → Privacy & Security → Accessibility (and Automation for System Events when typing text).");
      }
      throw error;
    }
  };
  const state = (signal?: AbortSignal, capture = false) => jxa<DesktopState>({ op: "state", capture }, signal);
  return {
    platform: "macos",
    async probe(signal) {
      try {
        await state(signal);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    state: (signal) => state(signal),
    async capture(request, signal) {
      const before = await state(signal, true);
      const dir = await mkdtemp(join(tmpdir(), "polyth-computer-"));
      try {
        const raw = join(dir, "raw.png");
        const scaled = join(dir, "scaled.png");
        const region = request.region;
        await run("screencapture", [
          "-x", "-t", "png",
          ...(region ? ["-R", [region.x, region.y, region.width, region.height].map(Math.round).join(",")] : ["-m"]),
          raw,
        ], { env, ...(signal ? { signal } : {}) });
        // Retina captures are in physical pixels; scale to the tool's image size.
        await run("sips", ["-z", String(request.output.height), String(request.output.width), raw, "--out", scaled], { env, ...(signal ? { signal } : {}) });
        return { ...before, png: await readFile(scaled) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    perform: (step, signal) => jxa<DesktopState>({ op: "perform", step: macRequestStep(step) }, signal),
    windows: (signal) => jxa<DesktopWindow[]>({ op: "windows" }, signal),
    async focus(id, signal) {
      if (!/^\d+$/.test(id)) throw new ComputerUseError("invalid-input", "window must be an id from action \"windows\"");
      await jxa({ op: "focus", id }, signal);
    },
  };
}
