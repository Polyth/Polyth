// Manual-only profile driver for chat-workspace: persistent Chromium contexts
// with many pages per profile. Deliberately lacks agent observation/extraction.
import type { BrowserColorScheme, ContentAccessPolicy } from "@polyth/contracts";

export const MANUAL_ONLY_POLICY: ContentAccessPolicy = {
  contentAccess: "manual-only",
  agentControl: false,
  observation: false,
  contextCapture: false,
  inspect: false,
};

export interface ProfileNav {
  url: string;
  title: string;
  loading: boolean;
}

export type ProfileMouseKind = "move" | "down" | "up" | "click" | "dblclick";
export type ProfileKeyKind = "down" | "up" | "press";

export interface ProfilePageEvent {
  kind:
    | "navigation"
    | "loading"
    | "crash"
    | "popup-opened"
    | "popup-closed"
    | "download-blocked"
    | "file-chooser-opened"
    | "clipboard-written"
    | "approval-required";
  url?: string;
  origin?: string;
  reason?: string;
  popupId?: string;
  text?: string;
  message?: string;
}

export interface ScreencastFrame {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface ProfilePage {
  readonly tabId: string;
  readonly contentAccess: ContentAccessPolicy;
  goto(url: string): Promise<ProfileNav>;
  back(): Promise<ProfileNav>;
  forward(): Promise<ProfileNav>;
  reload(): Promise<ProfileNav>;
  stop(): Promise<void>;
  current(): ProfileNav;
  mouse(input: {
    kind: ProfileMouseKind;
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void>;
  wheel(dx: number, dy: number, x: number, y: number): Promise<void>;
  key(input: {
    kind: ProfileKeyKind;
    key: string;
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void>;
  insertText(text: string): Promise<void>;
  resize(viewport: { width: number; height: number }): Promise<void>;
  copySelection(): Promise<string>;
  startScreencast(opts: { quality: number; maxWidth: number; maxHeight: number }): Promise<void>;
  stopScreencast(): Promise<void>;
  onFrame(cb: (frame: ScreencastFrame) => void): () => void;
  onEvent(cb: (ev: ProfilePageEvent) => void): () => void;
  hibernate(): Promise<{ url: string; title: string }>;
  restore(url: string): Promise<ProfileNav>;
  close(): Promise<void>;
  touchActivity(): void;
  setStreamVisible(visible: boolean): void;
  popupInput?(popupId: string, input: Record<string, unknown>): Promise<void>;
  closePopup?(popupId: string): Promise<void>;
  onPopupFrame?: (popupId: string, frame: ScreencastFrame) => void;
}

export interface ProfileContext {
  readonly profileId: string;
  readonly userDataDir: string;
  newPage(tabId: string): Promise<ProfilePage>;
  pages(): ProfilePage[];
  onEvent(cb: (ev: { profileId: string; kind: string; message?: string }) => void): () => void;
  close(): Promise<void>;
}

export type NavigationKind = "top-level" | "nested" | "subresource";

export interface ProfileDriverOpenOptions {
  profileId: string;
  userDataDir: string;
  executablePath?: string;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  colorScheme: BrowserColorScheme;
  guardNavigation: (url: string, kind?: NavigationKind) => Promise<void>;
  onClipboardWrite?: (text: string) => void;
  /** Extra Chromium flags (tests: host-resolver-rules for virtual public names). */
  chromiumArgs?: string[];
  /** Origins the profile already listed. Used to passthrough same-origin
   *  WebSockets so Playwright does not wrap an allowed Chromium socket. */
  listedOrigins?: ReadonlyArray<string>;
}

export interface ProfileDriver {
  engine: "chromium" | "fake";
  openProfile(opts: ProfileDriverOpenOptions): Promise<ProfileContext>;
}
