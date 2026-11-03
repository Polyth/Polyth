import type { KeyChord, Modifier } from "./keys.ts";

export type ComputerPlatform = "linux-x11" | "macos" | "windows";

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}

export type MouseButton = "left" | "right" | "middle";

/** One input step in the driver's own coordinate space: X11 pixels, Windows
 * physical pixels (the helper is DPI aware) or macOS points. */
export type InputStep =
  | { kind: "move"; to: Point }
  | { kind: "click"; at: Point; button: MouseButton; count: number; modifiers: readonly Modifier[] }
  | { kind: "drag"; path: readonly Point[]; button: MouseButton; modifiers: readonly Modifier[] }
  | { kind: "scroll"; at: Point; dx: number; dy: number; modifiers: readonly Modifier[] }
  | { kind: "type"; text: string }
  | { kind: "key"; chord: KeyChord; repeat: number };

export interface DesktopState {
  /** The primary display in driver coordinates. */
  screen: Size;
  cursor: Point;
}

export interface CaptureRequest {
  /** Screen area to capture, in driver coordinates; the whole primary display when absent. */
  region?: Rect;
  /** The PNG is scaled down (never up) to exactly this size. */
  output: Size;
}

export interface CaptureResult extends DesktopState {
  png: Buffer;
}

export interface DesktopWindow {
  id: string;
  title: string;
  app?: string;
  pid?: number;
  bounds: Rect;
  focused?: boolean;
}

export interface DriverProbe {
  ok: boolean;
  /** What is missing or not allowed, phrased for the person. */
  reason?: string;
}

/** A platform backend. Every method acts on the real desktop of the machine
 * the Polyth server runs on; callers serialize them (one pointer, one
 * keyboard). */
export interface ComputerDriver {
  readonly platform: ComputerPlatform;
  probe(signal?: AbortSignal): Promise<DriverProbe>;
  state(signal?: AbortSignal): Promise<DesktopState>;
  capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult>;
  perform(step: InputStep, signal?: AbortSignal): Promise<DesktopState>;
  windows(signal?: AbortSignal): Promise<DesktopWindow[]>;
  focus(id: string, signal?: AbortSignal): Promise<void>;
}
