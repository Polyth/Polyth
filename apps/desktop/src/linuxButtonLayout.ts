import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopCaptionButton, DesktopSystemControls } from "./types.ts";

/**
 * The caption-button layout the Linux desktop itself uses, so Polyth's own
 * buttons sit on the same side, in the same order and with the same set as
 * every other window: GNOME's default shows only Close on the right, Ubuntu's
 * minimize/maximize/close on the right, elementary close on the left.
 *
 * Every reader is bounded and best-effort: a missing tool, an unknown desktop
 * or an unreadable file is `null`, and the renderer keeps its default.
 */

const CAPTION_BUTTONS = new Set<DesktopCaptionButton>(["minimize", "maximize", "close"]);

const layoutFrom = (left: DesktopCaptionButton[], right: DesktopCaptionButton[]): DesktopSystemControls | null => {
  // The side that holds Close is the caption side; a layout without Close
  // takes the side with more buttons. Polyth keeps one cluster, so a split
  // layout (minimize left, close right) keeps only the caption side's buttons.
  const side = right.includes("close") ? "right"
    : left.includes("close") ? "left"
      : right.length >= left.length ? "right" : "left";
  const buttons = side === "right" ? right : left;
  if (buttons.length === 0) return null;
  return { side, buttons };
};

const named = (names: string[]): DesktopCaptionButton[] => {
  const out: DesktopCaptionButton[] = [];
  for (const name of names) {
    const button = name.trim().toLowerCase() as DesktopCaptionButton;
    if (CAPTION_BUTTONS.has(button) && !out.includes(button)) out.push(button);
  }
  return out;
};

/** GNOME-family `button-layout`: `left:right`, comma-separated names
 *  (`appmenu:minimize,maximize,close`). gsettings prints it quoted. */
export function parseGnomeButtonLayout(value: string): DesktopSystemControls | null {
  const raw = value.trim().replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");
  if (!raw.includes(":")) return null;
  const [left = "", right = ""] = raw.split(":");
  return layoutFrom(named(left.split(",")), named(right.split(",")));
}

const KDE_LETTERS: Record<string, DesktopCaptionButton> = { X: "close", I: "minimize", A: "maximize" };
const kdeButtons = (letters: string): DesktopCaptionButton[] => {
  const out: DesktopCaptionButton[] = [];
  for (const letter of letters) {
    const button = KDE_LETTERS[letter];
    if (button && !out.includes(button)) out.push(button);
  }
  return out;
};

/** KWin's `[org.kde.kdecoration2]` ButtonsOnLeft/ButtonsOnRight letters
 *  (X close, I minimize, A maximize). Absent keys mean KWin's defaults. */
export function parseKwinrc(text: string): DesktopSystemControls | null {
  let section = "";
  let left = "MS";
  let right = "HIAX";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[(.*)\]$/.exec(trimmed);
    if (header) { section = header[1] ?? ""; continue; }
    if (section !== "org.kde.kdecoration2") continue;
    const entry = /^(ButtonsOnLeft|ButtonsOnRight)\s*=\s*(.*)$/.exec(trimmed);
    if (entry?.[1] === "ButtonsOnLeft") left = entry[2] ?? "";
    else if (entry?.[1] === "ButtonsOnRight") right = entry[2] ?? "";
  }
  return layoutFrom(kdeButtons(left), kdeButtons(right));
}

const XFWM_LETTERS: Record<string, DesktopCaptionButton> = { C: "close", H: "minimize", M: "maximize" };
/** xfwm4 `button_layout`: letters with `|` for the title (`O|HMC`). */
export function parseXfwmButtonLayout(value: string): DesktopSystemControls | null {
  const raw = value.trim();
  if (!raw.includes("|")) return null;
  const [left = "", right = ""] = raw.split("|");
  const letters = (part: string): DesktopCaptionButton[] => {
    const out: DesktopCaptionButton[] = [];
    for (const letter of part) {
      const button = XFWM_LETTERS[letter];
      if (button && !out.includes(button)) out.push(button);
    }
    return out;
  };
  return layoutFrom(letters(left), letters(right));
}

const run = (command: string, args: string[]): Promise<string | null> => new Promise((resolve) => {
  try {
    execFile(command, args, { timeout: 1500, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  } catch {
    resolve(null);
  }
});

/** Which desktop this is, from XDG_CURRENT_DESKTOP (`ubuntu:GNOME`, `KDE`). */
const desktopsOf = (env: NodeJS.ProcessEnv): string[] =>
  (env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? "").toLowerCase().split(":").filter(Boolean);

const GSETTINGS_SCHEMAS: Array<[desktop: string, schema: string]> = [
  ["cinnamon", "org.cinnamon.desktop.wm.preferences"],
  ["mate", "org.mate.Marco.general"],
];

export async function readLinuxSystemControls(env: NodeJS.ProcessEnv = process.env): Promise<DesktopSystemControls | null> {
  const desktops = desktopsOf(env);
  if (desktops.includes("kde")) {
    const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    try { return parseKwinrc(await readFile(join(configHome, "kwinrc"), "utf8")); } catch { return parseKwinrc(""); }
  }
  if (desktops.includes("xfce")) {
    const value = await run("xfconf-query", ["-c", "xfwm4", "-p", "/general/button_layout"]);
    return value === null ? parseXfwmButtonLayout("O|HMC") : parseXfwmButtonLayout(value);
  }
  const schema = GSETTINGS_SCHEMAS.find(([desktop]) => desktops.includes(desktop))?.[1]
    ?? "org.gnome.desktop.wm.preferences";
  const value = await run("gsettings", ["get", schema, "button-layout"]);
  return value === null ? null : parseGnomeButtonLayout(value);
}
