// Reports from a page opened in a browser: the page captures this tab itself
// (desktop Chromium, after the browser's own "share this tab" prompt) or takes
// a pasted or attached image, and its Polyth server adds the build facts,
// keeps the tester password and sends (`/api/bug-report/*`, src/sender.ts).
import { BUG_REPORT_LIMITS, type BugReportScreenshot } from "@polyth/contracts/bug-report";
import type { ApiTransport } from "@polyth/web-sdk";
import { browserClient, canCaptureThisTab, type BrowserClient } from "../src/browserClient.ts";
import type { ReportBridge, ReportCapture, ReportDraft, ReportOutcome, ReportState } from "./bridge.ts";

type Shot = NonNullable<ReportCapture["screenshot"]>;

interface ServerState extends ReportState {
  base: {
    version: string;
    channel: "nightly" | "stable";
    serverPlatform: "darwin" | "win32" | "linux";
    serverArch: string;
    install: string;
  } | null;
}

const JPEG_QUALITIES = [0.8, 0.7, 0.6, 0.5] as const;

const navigatorFacts = () => {
  const nav = typeof navigator === "undefined" ? undefined : navigator as Navigator & {
    userAgentData?: { platform?: string; brands?: Array<{ brand: string }> };
  };
  return {
    userAgent: nav?.userAgent ?? "",
    uaPlatform: nav?.userAgentData?.platform,
    brands: nav?.userAgentData?.brands?.map((entry) => entry.brand),
    maxTouchPoints: nav?.maxTouchPoints,
    language: nav?.language,
    hasDisplayMedia: typeof nav?.mediaDevices?.getDisplayMedia === "function",
  };
};

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

const dataUrlOf = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("read failed"));
  reader.readAsDataURL(blob);
});

/** Downscale to the wire's longest edge and re-encode as JPEG until it fits. */
export async function encodeImage(source: CanvasImageSource, width: number, height: number): Promise<Shot | null> {
  if (width < 1 || height < 1) return null;
  let edge: number = BUG_REPORT_LIMITS.screenshotEdge;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scale = Math.min(1, edge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG has no alpha: a transparent PNG would otherwise turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of JPEG_QUALITIES) {
      const blob = await toBlob(canvas, quality);
      if (blob && blob.size > 0 && blob.size <= BUG_REPORT_LIMITS.screenshotBytes) {
        return { dataUrl: await dataUrlOf(blob), width: canvas.width, height: canvas.height, bytes: blob.size };
      }
    }
    edge = Math.round(edge * 0.75);
  }
  return null;
}

/** One frame of this tab. Must be called straight from the key press or
 *  click (the browser needs that gesture); null when the person declines or
 *  the browser cannot offer this tab alone. */
async function captureThisTab(): Promise<Shot | null> {
  if (!canCaptureThisTab(navigatorFacts())) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
    const track = stream.getVideoTracks()[0];
    // Anything but a browser tab (the person picked a window or a screen
    // anyway) is not what the sheet promises: drop it.
    if (!track || (track.getSettings() as { displaySurface?: string }).displaySurface !== "browser") return null;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first decoded frame can predate the prompt closing; wait for a fresh one.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return await encodeImage(video, video.videoWidth, video.videoHeight);
  } catch {
    return null;
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}

/** An image the person pasted or attached, as it will be sent. */
async function encodeFile(file: Blob): Promise<Shot | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return await encodeImage(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

const wireScreenshot = (shot: Shot): BugReportScreenshot => ({
  type: "image/jpeg",
  width: shot.width,
  height: shot.height,
  data: shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1),
});

const newId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

export function serverReportBridge(api: ApiTransport): ReportBridge {
  let held: { id: string; shot: Shot | null; client: BrowserClient } | null = null;
  const state = () => api.get<ServerState>("/api/bug-report/state");

  return {
    async state() {
      const current = await state();
      return { available: current.available === true, needsPassword: current.needsPassword === true, queued: Number(current.queued) || 0 };
    },

    async capture() {
      // The tab first, inside the gesture, while it still shows what went wrong.
      const shot = await captureThisTab();
      const current = await state();
      if (!current.available || !current.base) throw new Error("bug reports are off on this server");
      const client = browserClient(navigatorFacts());
      held = { id: newId(), shot, client };
      const { install, ...server } = current.base;
      return {
        captureId: held.id,
        screenshot: shot,
        base: {
          app: {
            client: "browser",
            version: server.version,
            channel: server.channel,
            edition: "standard",
            platform: client.platform,
            browser: client.browser,
            serverPlatform: server.serverPlatform,
            serverArch: server.serverArch,
            locale: client.locale,
          },
          install,
          settings: {},
        },
        needsPassword: current.needsPassword === true,
        passwordStorage: "server",
      };
    },

    async attach(captureId: string, file: Blob) {
      if (!held || held.id !== captureId) return null;
      const shot = await encodeFile(file);
      if (shot) held.shot = shot;
      return shot;
    },

    async send(draft: ReportDraft): Promise<ReportOutcome> {
      const shot = held && draft.captureId === held.id ? held.shot : null;
      const { captureId: _captureId, ...rest } = draft;
      const outcome = await api.post<ReportOutcome>("/api/bug-report/send", {
        ...rest,
        client: held?.client ?? browserClient(navigatorFacts()),
        screenshot: shot ? wireScreenshot(shot) : null,
      });
      if (outcome.result === "created" || outcome.result === "added" || outcome.result === "queued") held = null;
      return outcome;
    },
  };
}
