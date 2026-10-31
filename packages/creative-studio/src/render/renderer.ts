// Headless renderer: one Chromium page runs the scene runtime, frames stream
// as JPEG into FFmpeg (H.264 + AAC). Polyth owns both child processes for the
// whole job: they are closed in `finally`, on abort and on package disable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rendererPage, type RuntimeInput } from "./runtime.ts";

export const CHROMIUM_RENDER_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--disable-extensions",
  "--disable-background-networking",
  "--no-default-browser-check",
  "--mute-audio",
];

export interface FrameStats { mean: number; std: number; diff: number | null }
export interface SceneError { sceneId: string; message: string; t?: number }

export interface RuntimeSession {
  renderJpeg(t: number, quality: number, withStats: boolean): Promise<{ jpeg: Buffer; stats?: FrameStats }>;
  contactSheet(items: Array<{ jpeg: Buffer; label: string }>, columns: number): Promise<Buffer>;
  errors(): Promise<SceneError[]>;
  close(): Promise<void>;
}

export interface RendererDeps {
  /** Chromium executable, or null when this host has none. */
  chromiumPath: () => Promise<string | null>;
  ffmpegPath?: string;
}

let threeCache: Promise<{ core: string; module: string } | null> | undefined;

/** three.module.js + three.core.js from the installed `three` dependency. */
export function loadThreeSource(): Promise<{ core: string; module: string } | null> {
  threeCache ??= (async () => {
    try {
      const modulePath = fileURLToPath(import.meta.resolve("three"));
      const dir = path.dirname(modulePath);
      const [module, core] = await Promise.all([
        readFile(modulePath, "utf8"),
        readFile(path.join(dir, "three.core.js"), "utf8"),
      ]);
      return { core, module };
    } catch {
      return null;
    }
  })();
  return threeCache;
}

const decodeDataUrl = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

export async function openRuntime(deps: RendererDeps, input: RuntimeInput, signal?: AbortSignal): Promise<RuntimeSession> {
  const executablePath = await deps.chromiumPath();
  if (!executablePath) {
    throw Object.assign(new Error("No Chromium is installed on this host; set POLYTH_CHROMIUM_PATH to render scenes"), { code: "unavailable" });
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true, args: CHROMIUM_RENDER_ARGS });
  const close = async () => { await browser.close().catch(() => undefined); };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, acceptDownloads: false });
    // Scenes are untrusted agent code: no network at all.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(rendererPage(), { waitUntil: "load" });
    await page.evaluate(async (value) => {
      const runtime = (globalThis as unknown as { __studio: { init(input: unknown): Promise<unknown> } }).__studio;
      await runtime.init(value);
    }, input as unknown as Record<string, unknown>);
    return {
      async renderJpeg(t, quality, withStats) {
        const result = await page.evaluate(async ({ t, quality, withStats }) => {
          const runtime = (globalThis as unknown as {
            __studio: { renderFrame(t: number): Promise<void>; capture(type: string, q: number): string; stats(): unknown };
          }).__studio;
          await runtime.renderFrame(t);
          return { url: runtime.capture("image/jpeg", quality), stats: withStats ? runtime.stats() : undefined };
        }, { t, quality, withStats });
        return { jpeg: decodeDataUrl(result.url), ...(result.stats ? { stats: result.stats as FrameStats } : {}) };
      },
      async contactSheet(items, columns) {
        const url = await page.evaluate(async ({ items, columns }) => {
          const runtime = (globalThis as unknown as { __studio: { contactSheet(items: unknown, columns: number): Promise<string> } }).__studio;
          return runtime.contactSheet(items, columns);
        }, { items: items.map((item) => ({ src: `data:image/jpeg;base64,${item.jpeg.toString("base64")}`, label: item.label })), columns });
        return decodeDataUrl(url);
      },
      async errors() {
        return page.evaluate(() => (globalThis as unknown as { __studio: { errors: SceneError[] } }).__studio.errors.slice());
      },
      async close() {
        signal?.removeEventListener("abort", onAbort);
        await close();
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    await close();
    throw error;
  }
}

export interface EncoderOptions {
  output: string;
  fps: number;
  audioPath?: string;
  durationSec: number;
  quality: "preview" | "final";
  ffmpegPath?: string;
}

export interface Encoder {
  write(jpeg: Buffer): Promise<void>;
  finish(): Promise<void>;
  kill(): void;
}

/** FFmpeg reading MJPEG frames from stdin, muxing the song, writing MP4. */
export function startEncoder(options: EncoderOptions): Encoder {
  const final = options.quality === "final";
  const args = [
    "-y", "-hide_banner", "-nostdin", "-v", "error",
    "-f", "image2pipe", "-framerate", String(options.fps), "-c:v", "mjpeg", "-i", "pipe:0",
    ...(options.audioPath ? ["-i", options.audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", final ? "192k" : "96k"] : []),
    "-c:v", "libx264", "-preset", final ? "medium" : "veryfast", "-crf", final ? "20" : "30",
    ...(final ? ["-maxrate", "8M", "-bufsize", "16M"] : []),
    "-pix_fmt", "yuv420p", "-r", String(options.fps), "-t", String(options.durationSec),
    "-movflags", "+faststart", "-f", "mp4", options.output,
  ];
  const child: ChildProcessWithoutNullStreams = spawn(options.ffmpegPath ?? "ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let failure: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.stdout.resume();
  child.on("error", (error: NodeJS.ErrnoException) => {
    failure = error.code === "ENOENT" ? Object.assign(new Error("ffmpeg is not installed on this host"), { code: "unavailable" }) : error;
  });
  child.stdin.on("error", (error) => { failure ??= error; });
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return {
    async write(jpeg) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`ffmpeg exited early: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
      if (!child.stdin.write(jpeg)) {
        await new Promise<void>((resolve, reject) => {
          const done = () => { child.stdin.off("drain", done); child.off("close", closed); resolve(); };
          const closed = () => { child.stdin.off("drain", done); reject(new Error(`ffmpeg exited: ${stderr.trim().split("\n").slice(-2).join(" ")}`)); };
          child.stdin.once("drain", done);
          child.once("close", closed);
        });
      }
    },
    async finish() {
      child.stdin.end();
      const code = await exited;
      if (failure) throw failure;
      if (code !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`);
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

export interface VerifyExpectation {
  width: number;
  height: number;
  fps: number;
  /** Expected duration; with `songSec` the video must match the song. */
  durationSec: number;
  songSec?: number;
  ffprobePath?: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

/**
 * Inspect a finished file the way a delivery check would: container streams,
 * codecs, size, rate, length against the song, audio/video stream alignment,
 * and a full decode so a truncated or corrupt file cannot pass.
 */
export async function verifyVideo(file: string, expect: VerifyExpectation): Promise<import("../index.ts").RenderVerification> {
  const { runCapture } = await import("../audio/decode.ts");
  const problems: string[] = [];
  const probe = JSON.parse((await runCapture(expect.ffprobePath ?? "ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,duration,start_time:format=duration",
    "-of", "json", file,
  ], { maxBytes: 200_000, timeoutMs: 30_000, ...(expect.signal ? { signal: expect.signal } : {}) })).toString("utf8")) as {
    streams?: Array<Record<string, string | number | undefined>>;
    format?: { duration?: string };
  };
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const durationSec = Number(probe.format?.duration ?? 0);
  const rate = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = rate[1] ? Math.round((rate[0]! / rate[1]) * 100) / 100 : 0;
  if (!video) problems.push("no video stream");
  if (!audio) problems.push("no audio stream");
  if (video && video.codec_name !== "h264") problems.push(`video codec is ${video.codec_name}, expected h264`);
  if (video && video.pix_fmt !== "yuv420p") problems.push(`pixel format is ${video.pix_fmt}, expected yuv420p`);
  if (audio && audio.codec_name !== "aac") problems.push(`audio codec is ${audio.codec_name}, expected aac`);
  if (video && (Number(video.width) !== expect.width || Number(video.height) !== expect.height)) problems.push(`size is ${video.width}×${video.height}, expected ${expect.width}×${expect.height}`);
  if (video && Math.abs(fps - expect.fps) > 0.05) problems.push(`frame rate is ${fps}, expected ${expect.fps}`);
  const tolerance = Math.max(0.1, 1.5 / expect.fps);
  const target = expect.songSec ?? expect.durationSec;
  if (Math.abs(durationSec - target) > tolerance) {
    problems.push(`length is ${durationSec.toFixed(2)} s, expected ${target.toFixed(2)} s${expect.songSec ? " (the song)" : ""}`);
  }
  if (video && audio) {
    const videoSec = Number(video.duration ?? durationSec);
    const audioSec = Number(audio.duration ?? durationSec);
    if (Math.abs(videoSec - audioSec) > tolerance) problems.push(`audio (${audioSec.toFixed(2)} s) and video (${videoSec.toFixed(2)} s) lengths differ`);
    const offset = Math.abs(Number(audio.start_time ?? 0) - Number(video.start_time ?? 0));
    if (offset > 0.05) problems.push(`audio starts ${offset.toFixed(3)} s away from the video`);
  }
  // Full decode: errors or an early end mean the file would not play through.
  try {
    await runCapture(expect.ffmpegPath ?? "ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], {
      maxBytes: 1_000_000, timeoutMs: 600_000, ...(expect.signal ? { signal: expect.signal } : {}),
    });
  } catch (error) {
    problems.push(`decoding failed: ${(error as Error).message.slice(0, 200)}`);
  }
  return {
    ok: problems.length === 0,
    durationSec: Math.round(durationSec * 1000) / 1000,
    ...(expect.songSec ? { songSec: expect.songSec } : {}),
    ...(video?.codec_name ? { videoCodec: String(video.codec_name) } : {}),
    ...(video?.pix_fmt ? { pixelFormat: String(video.pix_fmt) } : {}),
    ...(audio?.codec_name ? { audioCodec: String(audio.codec_name) } : {}),
    ...(video ? { width: Number(video.width), height: Number(video.height), fps } : {}),
    problems,
  };
}
