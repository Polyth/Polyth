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
  click(target: BrowserTarget): Promise<void>;
  type(target: BrowserTarget, text: string, submit?: boolean): Promise<void>;
  press(key: string): Promise<void>;
  scroll(x: number, y: number, target?: BrowserTarget): Promise<void>;
  select(target: BrowserTarget, value: string): Promise<void>;
  wait(condition: "network-idle" | "selector", value?: string, timeoutMs?: number): Promise<void>;
  resize(viewport: { width: number; height: number }): Promise<void>;
  emulateColorScheme(colorScheme: BrowserColorScheme): Promise<void>;
  inspect(selector: string): Promise<JsonObject>;
  screenshot(): Promise<{ data: Uint8Array; mime: string }>;
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
}
