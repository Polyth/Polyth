// FFmpeg decoding for the analyzer and lyric transcription. Every child is
// bounded (duration, bytes, wall time) and killed on abort, so an agent call
// can never leave an FFmpeg process behind.
import { spawn } from "node:child_process";

export const MAX_ANALYSIS_SECONDS = 15 * 60;

export interface DecodeOptions {
  sampleRate: number;
  format: "f32le" | "s16le";
  /** Seconds to skip / keep. */
  offset?: number;
  duration?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  ffmpegPath?: string;
}

export async function decodeAudio(file: string, options: DecodeOptions): Promise<Buffer> {
  const seconds = Math.min(MAX_ANALYSIS_SECONDS, options.duration ?? MAX_ANALYSIS_SECONDS);
  const bytesPerSample = options.format === "f32le" ? 4 : 2;
  const maxBytes = Math.ceil(seconds * options.sampleRate * bytesPerSample) + 4096;
  const args = [
    "-hide_banner", "-nostdin", "-v", "error",
    ...(options.offset ? ["-ss", String(options.offset)] : []),
    "-t", String(seconds),
    "-i", file,
    "-vn", "-ac", "1", "-ar", String(options.sampleRate),
    "-f", options.format, "pipe:1",
  ];
  return runCapture(options.ffmpegPath ?? "ffmpeg", args, { maxBytes, signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000 });
}

export function toFloat32(buffer: Buffer): Float32Array {
  const aligned = new ArrayBuffer(buffer.length - (buffer.length % 4));
  new Uint8Array(aligned).set(buffer.subarray(0, aligned.byteLength));
  return new Float32Array(aligned);
}

export interface CaptureOptions { maxBytes: number; signal?: AbortSignal; timeoutMs: number }

/** Run a child, capture bounded stdout, kill it on abort/timeout/overflow. */
export function runCapture(command: string, args: string[], options: CaptureOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { code: "aborted" }));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value!);
    };
    const onAbort = () => finish(Object.assign(new Error("aborted"), { code: "aborted" }));
    const timer = setTimeout(() => finish(Object.assign(new Error(`${command} timed out`), { code: "timeout" })), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        finish(Object.assign(new Error(`${command} output exceeded ${options.maxBytes} bytes`), { code: "too-large" }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT"
        ? Object.assign(new Error(`${command} is not installed on this host`), { code: "unavailable" })
        : error);
    });
    child.on("close", (code) => {
      if (code === 0) finish(undefined, Buffer.concat(chunks));
      else finish(Object.assign(new Error(`${command} failed: ${stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`), { code: "failed" }));
    });
  });
}
