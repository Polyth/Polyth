import { serverServiceKey } from "./serverPackage.ts";

/**
 * Native web views: real Chromium pages the Polyth Desktop app hosts in its own
 * process, beside the in-process server. Only a Desktop host provides this
 * service; every other host leaves it unset, and a consumer falls back to its
 * own engine.
 *
 * The host owns each view's whole lifecycle (it always lives in a window, a
 * hidden parking window while nobody shows it) and its hardening: sandboxed,
 * no preload, no Node, http(s) only, permissions, downloads and new windows
 * refused. A consumer owns everything about the page itself and drives it only
 * through the view's Chrome DevTools Protocol session.
 */
export interface NativeWebViewCdp {
  /** One CDP command on this page's own target. Rejects once the view is gone. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Every CDP event of the page's target. Returns the unsubscribe. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
}

export type NativeWebViewGoneReason = "crashed" | "closed" | "debugger-detached";

export interface NativeWebView {
  /** Opaque, unguessable. The local Desktop window places the view by it;
   * it grants nothing anywhere else. */
  readonly id: string;
  readonly cdp: NativeWebViewCdp;
  /** A page asked for a new window (`window.open`, `target=_blank`). The host
   * refused it; the consumer decides what to do with the URL. */
  onWindowOpen(listener: (url: string) => void): () => void;
  /** Fired once, when the page can no longer be driven. */
  onGone(listener: (reason: NativeWebViewGoneReason) => void): () => void;
  /** The host cancelled a download the page started. */
  onDownloadBlocked(listener: (url: string) => void): () => void;
  /** Size of the page while no window shows it (CSS px). A shown view takes
   * the size of the place the window gives it. */
  setParkedSize(width: number, height: number): void;
  /**
   * A JPEG of what the page shows now, at its CSS pixel size, or of `clip`
   * (CSS px of the viewport). Taken by the host, which works for a parked page
   * too; rejects (never hangs) while the page has not painted yet.
   */
  capture(clip?: { x: number; y: number; width: number; height: number }): Promise<{ data: Uint8Array; mime: string }>;
  /** Whether a window currently shows the view (so the person sees the live page). */
  shown(): boolean;
  onShownChange(listener: (shown: boolean) => void): () => void;
  close(): Promise<void>;
}

export interface NativeWebViewCreateOptions {
  width: number;
  height: number;
  /**
   * Absolute directory for the page's persistent storage (cookies, local
   * storage, cache). Must lie inside the server's data directory. Views that
   * name the same directory share one storage, like tabs of one browser
   * profile. Absent: an in-memory storage that dies with the view.
   */
  profileDir?: string;
  /**
   * Asked before every http(s)/ws(s) request the page makes, redirect hops
   * included; resolve `false` to refuse it. `navigation` is a top-level
   * document load, `subresource` everything else (frames, fetches, sockets).
   * Without it every such request is refused. Other schemes are the host's:
   * `about:`, `data:` and `blob:` load for subresources only, the rest never.
   */
  guardRequest?: (request: NativeWebViewRequest) => Promise<boolean>;
}

export interface NativeWebViewRequest {
  url: string;
  kind: "navigation" | "subresource";
}

export interface NativeWebViewHost {
  create(opts: NativeWebViewCreateOptions): Promise<NativeWebView>;
}

export const SERVER_NATIVE_WEB_VIEWS = serverServiceKey<NativeWebViewHost>("host.native-web-views");
