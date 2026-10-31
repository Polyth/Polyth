// Live preview document for the sandboxed iframe (sandbox="allow-scripts",
// opaque origin, no network). It hosts the same scene runtime the server
// renders with; the parent owns the clock (the song) and posts frame times.
import { STUDIO_RUNTIME_SOURCE } from "../src/render/runtime.ts";

export const PREVIEW_CHANNEL = "polyth-creative-studio-v1";

const BRIDGE = `
(function () {
  var CH = ${JSON.stringify(PREVIEW_CHANNEL)};
  var S = globalThis.__studio, ready = false, busy = false, queued = null, lastErrors = 0, generation = 0;
  function post(message) { message.channel = CH; parent.postMessage(message, "*"); }
  function draw(t) {
    // Frames requested while (re)initialising are kept, newest wins.
    if (!ready) { queued = t; return; }
    if (busy) { queued = t; return; }
    busy = true;
    var mine = generation;
    S.renderFrame(t).then(function () {
      busy = false;
      if (mine !== generation) return;
      if (S.errors.length !== lastErrors) { lastErrors = S.errors.length; post({ kind: "errors", errors: S.errors.slice(0, 20) }); }
      if (queued !== null) { var next = queued; queued = null; draw(next); }
    }, function (error) { busy = false; post({ kind: "failed", message: String(error && error.message || error) }); });
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.channel !== CH) return;
    if (data.kind === "init") {
      generation++; ready = false; queued = null;
      S.init(data.input).then(function () {
        ready = true; lastErrors = S.errors.length;
        post({ kind: "ready", errors: S.errors.slice(0, 20) });
        var first = queued !== null ? queued : typeof data.t === "number" ? data.t : 0;
        queued = null;
        draw(first);
      }, function (error) { post({ kind: "failed", message: String(error && error.message || error) }); });
    } else if (data.kind === "frame" && typeof data.t === "number") {
      draw(data.t);
    }
  });
  post({ kind: "loaded" });
})();`;

export function previewDocument(): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return "<!doctype html><html><head><meta charset=\"utf-8\">"
    + "<meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\">"
    + "<meta name=\"referrer\" content=\"no-referrer\">"
    + "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}"
    + "canvas{display:block;width:100%;height:100%;object-fit:contain}</style></head>"
    + "<body><canvas id=\"studio-out\"></canvas>"
    + "<script>" + STUDIO_RUNTIME_SOURCE + "</script>"
    + "<script>" + BRIDGE + "</script></body></html>";
}

/** Preview frame size: small enough to stay smooth, same aspect as the video. */
export function previewSize(aspect: "16:9" | "9:16" | "1:1"): { width: number; height: number } {
  if (aspect === "9:16") return { width: 360, height: 640 };
  if (aspect === "1:1") return { width: 480, height: 480 };
  return { width: 640, height: 360 };
}
