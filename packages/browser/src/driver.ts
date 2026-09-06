// Driver seam: the session manager drives a page through this contract.
// chromium.ts implements it with playwright-core; fake.ts implements it
// in-memory for tests and for demo mode without a real engine.
import type { BrowserColorScheme, BrowserTarget, JsonObject } from "@polyth/contracts";

export interface DriverPageEvent {
  kind: "console" | "navigation" | "download-blocked" | "popup-blocked" | "crash" | "network";
  message?: string;
  url?: string;
  level?: string;
}

export interface DriverObservation {
  url: string;
  title: string;
  /** Visible text; password input values must never be included. */
  text: string;
  accessibilityDigest: string;
}

export interface DriverNav {
  url: string;
  title: string;
}

export interface DriverPage {
  goto(url: string): Promise<DriverNav>;
  back(): Promise<DriverNav>;
  forward(): Promise<DriverNav>;
  reload(): Promise<DriverNav>;
  stop(): Promise<void>;
  /** Activate the target and return focused/hit-test metadata when available. */
  click(target: BrowserTarget): Promise<JsonObject | void>;
  /** Describe the element at viewport coordinates without mutating the page. */
  point(point: { x: number; y: number }): Promise<JsonObject>;
  type(target: BrowserTarget, text: string, submit?: boolean): Promise<void>;
  press(key: string): Promise<JsonObject | void>;
  /** Quote and bounds for the DOM range between two viewport points. */
  textRange?(start: { x: number; y: number }, end: { x: number; y: number }): Promise<{
    quote: string;
    rect?: { x: number; y: number; width: number; height: number };
  }>;
  scroll(x: number, y: number, target?: BrowserTarget): Promise<void>;
  select(target: BrowserTarget, value: string): Promise<void>;
  wait(condition: "network-idle" | "selector", value?: string, timeoutMs?: number): Promise<void>;
  resize(viewport: { width: number; height: number }): Promise<void>;
  emulateColorScheme(colorScheme: BrowserColorScheme): Promise<void>;
  inspect(selector: string): Promise<JsonObject>;
  screenshot(): Promise<{ data: Uint8Array; mime: string }>;
  /** Optional clipped screenshot for area context crops. */
  screenshotClip?(clip: { x: number; y: number; width: number; height: number }): Promise<{ data: Uint8Array; mime: string }>;
  /** Elements and visible text intersecting a viewport pixel rectangle. */
  queryRegion?(region: { x: number; y: number; width: number; height: number }): Promise<{
    elements: Array<{
      selector?: string;
      tag?: string;
      role?: string;
      name?: string;
      text?: string;
      attributes?: Record<string, string>;
      bounds?: { x: number; y: number; width: number; height: number };
    }>;
    text: string;
  }>;
  observe(selector?: string): Promise<DriverObservation>;
  current(): DriverNav;
  onEvent(cb: (ev: DriverPageEvent) => void): () => void;
  close(): Promise<void>;
}

export interface DriverOpenOptions {
  width: number;
  height: number;
  deviceScaleFactor: number;
  colorScheme: BrowserColorScheme;
  /** Called for every navigation hop (incl. redirects); throw to block. */
  guardNavigation: (url: string) => Promise<void>;
}

export interface BrowserDriver {
  engine: "chromium" | "fake";
  open(opts: DriverOpenOptions): Promise<DriverPage>;
  /** Release the shared browser process after all page contexts are closed. */
  close(): Promise<void>;
}
