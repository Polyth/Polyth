import { ComputerUseError } from "../errors.ts";
import { decodeXwd, encodePng, resample } from "../image.ts";
import { baseCharacter, type KeyChord, type Modifier, type NamedKey } from "../keys.ts";
import { runCommand, type CommandRunner } from "../process.ts";
import type {
  ComputerDriver, DesktopState, DesktopWindow, InputStep, MouseButton, Point,
} from "../types.ts";

const INSTALL_HINT = "Install xdotool and xwd (Debian/Ubuntu: sudo apt install xdotool x11-apps; Fedora: sudo dnf install xdotool xwd).";
const MAX_WINDOWS = 60;
/** A 3840×2160 root dumped by xwd at 32 bits per pixel, with headroom. */
const MAX_XWD_BYTES = 64 * 1024 * 1024;

const BUTTONS: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };
const MODIFIER_KEYS: Record<Modifier, string> = { ctrl: "ctrl", alt: "alt", shift: "shift", meta: "super" };
const NAMED: Record<NamedKey, string> = {
  enter: "Return", escape: "Escape", tab: "Tab", space: "space", backspace: "BackSpace",
  delete: "Delete", insert: "Insert", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  up: "Up", down: "Down", left: "Left", right: "Right",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};
const CHAR_KEYSYMS: Record<string, string> = {
  "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
  ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "period", "/": "slash", "`": "grave",
};

/** xdotool's chord syntax: "ctrl+shift+t". */
export const xdotoolChord = (chord: KeyChord): string => {
  const modifiers = new Set(chord.modifiers);
  let key: string | undefined;
  if (chord.key?.kind === "named") key = NAMED[chord.key.name];
  else if (chord.key?.kind === "char") {
    const base = baseCharacter(chord.key.char);
    if (base.shift) modifiers.add("shift");
    key = CHAR_KEYSYMS[base.char] ?? base.char;
  }
  const names = (["ctrl", "alt", "shift", "meta"] as const).filter((m) => modifiers.has(m)).map((m) => MODIFIER_KEYS[m]);
  if (key) return [...names, key].join("+");
  if (names.length) return names.join("+");
  throw new ComputerUseError("invalid-input", "keys names no key");
};

const coordinates = (point: Point) => [String(Math.round(point.x)), String(Math.round(point.y))];

const withModifiers = (modifiers: readonly Modifier[], args: string[]): string[] => {
  if (!modifiers.length) return args;
  const keys = modifiers.map((m) => MODIFIER_KEYS[m]).join("+");
  return ["keydown", keys, ...args, "keyup", keys];
};

/** Wheel buttons: 4 up, 5 down, 6 left, 7 right. */
const scrollArgs = (dx: number, dy: number): string[] => [
  ...(dy ? ["click", "--repeat", String(Math.abs(dy)), "--delay", "30", dy > 0 ? "5" : "4"] : []),
  ...(dx ? ["click", "--repeat", String(Math.abs(dx)), "--delay", "30", dx > 0 ? "7" : "6"] : []),
];

/** `xdotool type` takes every remaining argument as text, so it cannot be
 * chained; "\n" would also arrive as Linefeed, which many toolkits ignore.
 * Each line is one invocation with a Return key between them. */
export const xdotoolTypeCalls = (text: string): string[][] => text.replace(/\r\n?/g, "\n").split("\n").flatMap((line, index) => [
  ...(index > 0 ? [["key", "--clearmodifiers", "Return"]] : []),
  ...(line ? [["type", "--clearmodifiers", "--delay", "12", "--", line]] : []),
]);

export const xdotoolArgs = (step: Exclude<InputStep, { kind: "type" }>): string[] => {
  switch (step.kind) {
    case "move":
      return ["mousemove", ...coordinates(step.to)];
    case "click":
      return withModifiers(step.modifiers, [
        "mousemove", ...coordinates(step.at),
        "click", "--repeat", String(step.count), "--delay", "80", BUTTONS[step.button],
      ]);
    case "drag": {
      const [first, ...rest] = step.path;
      if (!first || !rest.length) throw new ComputerUseError("invalid-input", "drag needs at least two points");
      return withModifiers(step.modifiers, [
        "mousemove", ...coordinates(first), "mousedown", BUTTONS[step.button],
        ...rest.flatMap((point) => ["sleep", "0.03", "mousemove", ...coordinates(point)]),
        "sleep", "0.05", "mouseup", BUTTONS[step.button],
      ]);
    }
    case "scroll":
      return withModifiers(step.modifiers, ["mousemove", ...coordinates(step.at), ...scrollArgs(step.dx, step.dy)]);
    case "key":
      return ["key", "--clearmodifiers", "--repeat", String(step.repeat), "--delay", "60", xdotoolChord(step.chord)];
  }
};

const parseLocation = (text: string): Point => {
  const x = /x:(-?\d+)/.exec(text)?.[1];
  const y = /y:(-?\d+)/.exec(text)?.[1];
  if (x === undefined || y === undefined) throw new ComputerUseError("driver-failed", "xdotool did not report the pointer");
  return { x: Number(x), y: Number(y) };
};

const parseShell = (text: string): Record<string, string> => Object.fromEntries(
  text.split(/\r?\n/).map((line) => line.split("=")).filter((pair) => pair.length === 2).map(([k, v]) => [k!.trim(), v!.trim()]),
);

export interface LinuxDriverOptions {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  /** Override helper paths, for tests that bring their own binaries. */
  xdotool?: string;
  xwd?: string;
  xprop?: string;
}

/** X11 through xdotool (input, windows) and xwd (pixels). Wayland sessions
 * do not allow synthetic input from ordinary clients and are refused. */
export function createLinuxDriver(options: LinuxDriverOptions = {}): ComputerDriver {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const xdotool = options.xdotool ?? "xdotool";
  const xwd = options.xwd ?? "xwd";
  const xprop = options.xprop ?? "xprop";
  const call = async (args: string[], signal?: AbortSignal, maxStdoutBytes?: number) => {
    try {
      return await run(xdotool, args, { env, ...(signal ? { signal } : {}), ...(maxStdoutBytes ? { maxStdoutBytes } : {}) });
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === "missing-helper") {
        throw new ComputerUseError("missing-helper", `xdotool is not installed. ${INSTALL_HINT}`);
      }
      throw error;
    }
  };
  const state = async (signal?: AbortSignal): Promise<DesktopState> => {
    const [geometry, location] = await Promise.all([
      call(["getdisplaygeometry"], signal),
      call(["getmouselocation"], signal),
    ]);
    const [width, height] = geometry.stdout.toString("utf8").trim().split(/\s+/).map(Number);
    if (!width || !height) throw new ComputerUseError("driver-failed", "xdotool did not report the display size");
    return { screen: { width, height }, cursor: parseLocation(location.stdout.toString("utf8")) };
  };
  const activeWindow = async (signal?: AbortSignal): Promise<string | undefined> => {
    try {
      return (await call(["getactivewindow"], signal)).stdout.toString("utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  /** EWMH top-level windows when a window manager publishes them, else every
   * visible named window (bare X servers have no window manager). */
  const windowIds = async (signal?: AbortSignal): Promise<string[]> => {
    try {
      const listed = (await run(xprop, ["-root", "_NET_CLIENT_LIST"], { env, ...(signal ? { signal } : {}) })).stdout.toString("utf8");
      const ids = [...listed.matchAll(/0x[0-9a-f]+/gi)].map((match) => String(Number.parseInt(match[0], 16)));
      if (ids.length) return ids;
    } catch {
      // No xprop or no window manager: fall back to xdotool's search.
    }
    try {
      return (await call(["search", "--onlyvisible", "--name", "."], signal)).stdout.toString("utf8").split(/\s+/).filter(Boolean);
    } catch (error) {
      // xdotool search exits 1 when nothing matches.
      if (error instanceof ComputerUseError && error.code === "driver-failed") return [];
      throw error;
    }
  };

  return {
    platform: "linux-x11",
    async probe(signal) {
      if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") {
        return { ok: false, reason: "This is a Wayland session; it does not let applications send mouse and keyboard input. Log in to an X11 (Xorg) session to use computer control." };
      }
      if (!env.DISPLAY) return { ok: false, reason: "No desktop: the Polyth server has no X display (DISPLAY is not set)." };
      try {
        await state(signal);
        await run(xwd, ["-version"], { env, ...(signal ? { signal } : {}) }).catch(async (error: unknown) => {
          // Some xwd builds have no -version; any answer other than "missing" will do.
          if (error instanceof ComputerUseError && error.code === "missing-helper") throw error;
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof ComputerUseError && error.code === "missing-helper") return { ok: false, reason: `${error.message.split(".")[0]}. ${INSTALL_HINT}` };
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    state,
    async capture(request, signal) {
      let dump: Buffer;
      try {
        dump = (await run(xwd, ["-root", "-silent"], { env, ...(signal ? { signal } : {}), maxStdoutBytes: MAX_XWD_BYTES, timeoutMs: 15_000 })).stdout;
      } catch (error) {
        if (error instanceof ComputerUseError && error.code === "missing-helper") {
          throw new ComputerUseError("missing-helper", `xwd is not installed. ${INSTALL_HINT}`);
        }
        throw error;
      }
      const image = decodeXwd(dump);
      const region = request.region ?? { x: 0, y: 0, width: image.width, height: image.height };
      const png = encodePng(resample(image, region, request.output));
      const location = await call(["getmouselocation"], signal);
      return { png, screen: { width: image.width, height: image.height }, cursor: parseLocation(location.stdout.toString("utf8")) };
    },
    async perform(step, signal) {
      if (step.kind === "type") {
        for (const args of xdotoolTypeCalls(step.text)) await call(args, signal);
      } else {
        await call(xdotoolArgs(step), signal);
      }
      return state(signal);
    },
    async windows(signal) {
      const [ids, active] = await Promise.all([windowIds(signal), activeWindow(signal)]);
      const result: DesktopWindow[] = [];
      for (const id of ids.slice(0, MAX_WINDOWS)) {
        try {
          const [name, geometry] = await Promise.all([
            call(["getwindowname", id], signal),
            call(["getwindowgeometry", "--shell", id], signal),
          ]);
          const title = name.stdout.toString("utf8").trim();
          const shell = parseShell(geometry.stdout.toString("utf8"));
          const width = Number(shell.WIDTH), height = Number(shell.HEIGHT);
          if (!width || !height) continue;
          const pid = await call(["getwindowpid", id], signal)
            .then((out) => Number(out.stdout.toString("utf8").trim()) || undefined)
            .catch(() => undefined);
          result.push({
            id,
            title,
            bounds: { x: Number(shell.X) || 0, y: Number(shell.Y) || 0, width, height },
            ...(pid ? { pid } : {}),
            ...(id === active ? { focused: true } : {}),
          });
        } catch {
          // The window closed while it was listed.
        }
      }
      return result;
    },
    async focus(id, signal) {
      if (!/^\d+$/.test(id)) throw new ComputerUseError("invalid-input", "window must be an id from action \"windows\"");
      try {
        await call(["windowactivate", "--sync", id], signal);
      } catch {
        // Without an EWMH window manager only input focus can move.
        try {
          await call(["windowraise", id, "windowfocus", "--sync", id], signal);
        } catch {
          throw new ComputerUseError("not-found", `No window ${id}; list them again with action "windows"`);
        }
      }
    },
  };
}
