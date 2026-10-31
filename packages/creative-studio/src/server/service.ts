// Creative Studio server service: audio analysis, stills, preview/final video
// renders and automatic visual QA. Tools and package routes are thin
// adapters over this; it holds every live job so disable can stop them.
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  effectiveDuration,
  EFFORT_PROFILES,
  finalSpec,
  frameSize,
  fmtTime,
  pushActivity,
  studioPaths,
  type QaFinding,
  type RenderJob,
  type RenderKind,
  type StudioScene,
  type StudioState,
} from "../index.ts";
import { analyzeAudio, ANALYSIS_SAMPLE_RATE } from "../audio/dsp.ts";
import { decodeAudio, toFloat32 } from "../audio/decode.ts";
import { alignPlainLyrics, isLrc, parseLrc, vocalSpans } from "../audio/lyrics.ts";
import { summarizeAnalysis, type AudioAnalysis, type LyricLine } from "../audio/analysis.ts";
import { needsThree, runtimeInput } from "../render/runtime.ts";
import { loadThreeSource, openRuntime, startEncoder, verifyVideo, type FrameStats, type RendererDeps, type SceneError } from "../render/renderer.ts";
import { StudioStore, type StudioRef } from "./store.ts";

/** Structural view of the dictation package's service (no package import). */
export interface DictationLike {
  capability(): { available: boolean; engine?: string; reason?: string };
  create(input: { sessionId?: string; language?: string }): { id: string };
  push(id: string, seq: number, pcm: Uint8Array): Promise<unknown>;
  finalize(id: string): Promise<{ status: string; transcript: string }>;
  cancel(id: string): void;
}

export interface StudioServiceDeps {
  store: StudioStore;
  renderer: RendererDeps;
  dictation?: () => DictationLike | undefined;
  /** Max concurrent render jobs on this host (CPU-bound software rendering). */
  maxConcurrentRenders?: number;
  now?: () => number;
}

interface LiveJob {
  ref: StudioRef;
  job: RenderJob;
  controller: AbortController;
  done: Promise<RenderJob>;
}

const PROGRESS_INTERVAL_MS = 900;
const LIVE_FRAME_INTERVAL_MS = 1500;
const STALE_HEARTBEAT_MS = 30_000;

const invalid = (message: string, code = "invalid-input") => Object.assign(new Error(message), { code });

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= 16) throw invalid("too many renders are queued on this host; try again shortly", "busy");
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal?.removeEventListener("abort", stop); resolve(); };
        const stop = () => {
          const index = this.waiting.indexOf(go);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(Object.assign(new Error("aborted"), { code: "aborted" }));
        };
        signal?.addEventListener("abort", stop, { once: true });
        this.waiting.push(go);
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

export interface StillsResult {
  scenes: Array<{ sceneId: string; still: string; stats: FrameStats[] }>;
  contactSheet?: string;
  errors: SceneError[];
  findings: Array<Pick<QaFinding, "severity" | "message" | "sceneId" | "time">>;
  elapsedMs: number;
}

export function createStudioService(deps: StudioServiceDeps) {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const gate = new Semaphore(Math.max(1, deps.maxConcurrentRenders ?? 1));
  const jobs = new Map<string, LiveJob>();
  const pending = new Set<AbortController>();
  let disposed = false;

  const assertLive = () => { if (disposed) throw invalid("Creative Studio is disabled", "unavailable"); };

  /** Jobs still marked running without a live owner were interrupted (restart/crash). */
  async function reconcile(ref: StudioRef): Promise<StudioState | null> {
    const state = await store.read(ref);
    if (!state) return null;
    const orphaned = state.renders.filter((job) => job.status === "running" && !jobs.has(job.id));
    if (!orphaned.length) return state;
    return store.update(ref, (current) => {
      for (const job of current.renders) {
        if (job.status === "running" && !jobs.has(job.id)) {
          job.status = "interrupted";
          job.error = "The render stopped when Polyth restarted or the package was disabled.";
          job.finishedAt = now();
        }
      }
      return current;
    });
  }

  // ------------------------------------------------------------- audio

  async function analyze(ref: StudioRef, input: {
    audioPath?: string;
    lyricsPath?: string;
    lyricsText?: string;
    transcribe?: boolean;
    language?: string;
    signal?: AbortSignal;
  }) {
    assertLive();
    const state = await store.require(ref);
    const audioPath = input.audioPath?.trim() || state.audio?.path;
    if (!audioPath) throw invalid("no audio file: pass audioPath (a file in this checkout) or add one in the studio");
    const file = await store.file(ref, audioPath);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw invalid(`audio file not found: ${audioPath}`, "not-found");
    const started = now();
    const pcm = toFloat32(await decodeAudio(file, {
      sampleRate: ANALYSIS_SAMPLE_RATE,
      format: "f32le",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(deps.renderer.ffmpegPath ? { ffmpegPath: deps.renderer.ffmpegPath } : {}),
    }));
    if (pcm.length < ANALYSIS_SAMPLE_RATE) throw invalid("the audio file decodes to less than one second of sound");
    const analysis = analyzeAudio(pcm, ANALYSIS_SAMPLE_RATE, { source: audioPath });

    let lyricsSource: string | undefined;
    const lyricsPath = input.lyricsPath?.trim() || state.audio?.lyricsPath;
    let lyricsText = input.lyricsText;
    if (!lyricsText && lyricsPath) {
      const lyricsFile = await store.file(ref, lyricsPath);
      const lyricsInfo = await stat(lyricsFile).catch(() => null);
      if (!lyricsInfo?.isFile()) throw invalid(`lyrics file not found: ${lyricsPath}`, "not-found");
      if (lyricsInfo.size > 64_000) throw invalid("lyrics file is larger than 64 KB");
      const { readFile } = await import("node:fs/promises");
      lyricsText = await readFile(lyricsFile, "utf8");
      lyricsSource = lyricsPath;
    }
    if (lyricsText?.trim()) {
      const lrc = isLrc(lyricsText);
      const lines = lrc ? parseLrc(lyricsText, analysis.durationSec) : alignPlainLyrics(lyricsText, analysis);
      analysis.lyrics = { source: lrc ? "lrc" : "text", lines };
      if (!lrc) analysis.warnings.push("Lyric timing is estimated from vocal activity; add an .lrc file for exact timing.");
    } else if (input.transcribe) {
      const lines = await transcribe(ref, file, analysis, input.language, input.signal);
      if (lines.length) analysis.lyrics = { source: "transcribed", lines };
    }

    await store.writeAnalysis(ref, analysis);
    const sections = analysis.sections.length;
    await store.update(ref, (current) => {
      current.audio = {
        path: audioPath,
        name: audioPath.split("/").pop() ?? audioPath,
        analyzedAt: now(),
        durationSec: analysis.durationSec,
        bpm: analysis.bpm,
        key: `${analysis.key.tonic} ${analysis.key.mode}`,
        ...(lyricsSource ? { lyricsPath: lyricsSource } : current.audio?.lyricsPath ? { lyricsPath: current.audio.lyricsPath } : {}),
      };
      pushActivity(current, {
        at: now(),
        role: "planner",
        stage: "brief",
        message: `Audio analyzed: ${Math.round(analysis.bpm)} BPM, ${analysis.key.tonic} ${analysis.key.mode}, ${sections} sections, ${fmtTime(analysis.durationSec)}`
          + (analysis.lyrics ? `, ${analysis.lyrics.lines.length} lyric lines` : ""),
        sessionId: ref.studioId,
      });
      return current;
    });
    return { ...summarizeAnalysis(analysis), analysisPath: studioPaths(ref.studioId).analysis, elapsedMs: now() - started };
  }

  async function transcribe(ref: StudioRef, file: string, analysis: AudioAnalysis, language?: string, signal?: AbortSignal): Promise<LyricLine[]> {
    const dictation = deps.dictation?.();
    const capability = dictation?.capability();
    if (!dictation || !capability?.available) {
      analysis.warnings.push(`Lyrics were not transcribed: ${capability?.reason ?? "no dictation engine is configured"}. Provide lyrics text or an .lrc file.`);
      return [];
    }
    // Vocal spans, merged and split into ≤ 100 s windows (the dictation cap).
    const windows: Array<[number, number]> = [];
    for (const [from, to] of vocalSpans(analysis)) {
      for (let start = from; start < to; start += 100) windows.push([start, Math.min(to, start + 100)]);
    }
    const lines: LyricLine[] = [];
    for (const [from, to] of windows.slice(0, 12)) {
      if (signal?.aborted) break;
      const pcm = await decodeAudio(file, {
        sampleRate: 16_000, format: "s16le", offset: from, duration: to - from,
        ...(signal ? { signal } : {}),
        ...(deps.renderer.ffmpegPath ? { ffmpegPath: deps.renderer.ffmpegPath } : {}),
      });
      const session = dictation.create({ sessionId: ref.studioId, ...(language ? { language } : {}) });
      try {
        let seq = 1;
        for (let offset = 0; offset < pcm.length; offset += 32_000) {
          await dictation.push(session.id, seq++, new Uint8Array(pcm.subarray(offset, Math.min(pcm.length, offset + 32_000))));
        }
        const result = await dictation.finalize(session.id);
        const text = result.transcript.trim();
        if (!text) continue;
        const sentences = text.split(/(?<=[.!?…])\s+|\n+/).map((line) => line.trim()).filter(Boolean);
        const span = to - from;
        const total = sentences.reduce((sum, line) => sum + line.length, 0) || 1;
        let cursor = from;
        for (const sentence of sentences) {
          const length = (sentence.length / total) * span;
          lines.push({ start: Math.round(cursor * 1000) / 1000, end: Math.round((cursor + length) * 1000) / 1000, text: sentence.slice(0, 200) });
          cursor += length;
        }
      } catch (error) {
        dictation.cancel(session.id);
        analysis.warnings.push(`Lyric transcription failed for ${fmtTime(from)}–${fmtTime(to)}: ${(error as Error).message}`);
      }
    }
    if (lines.length) analysis.warnings.push("Lyrics were machine-transcribed from the mix; check them before burning them into the video.");
    return lines;
  }

  // ------------------------------------------------------------ helpers

  async function prepare(ref: StudioRef, kind: RenderKind, sceneFilter?: readonly string[]) {
    const state = await store.require(ref);
    if (!state.scenes.length) throw invalid("the storyboard has no scenes yet");
    const scenes = sceneFilter?.length
      ? state.scenes.filter((scene) => sceneFilter.includes(scene.id))
      : state.scenes;
    if (sceneFilter?.length && scenes.length !== new Set(sceneFilter).size) {
      const known = new Set(state.scenes.map((scene) => scene.id));
      throw invalid(`unknown scene ids: ${sceneFilter.filter((id) => !known.has(id)).join(", ")}`);
    }
    const analysis = await store.readAnalysis(ref);
    const codes = await store.readScenes(ref, state.scenes.map((scene) => scene.id));
    const profile = EFFORT_PROFILES[state.effort];
    const final = finalSpec(state);
    const height = kind === "preview" ? profile.previewHeight : Math.min(540, final.height);
    const size = kind === "final" ? { width: final.width, height: final.height } : frameSize(state.format.aspect, height);
    const fps = kind === "final" ? final.fps : profile.previewFps;
    const three = needsThree(state.scenes.filter((scene) => codes[scene.id])) ? await loadThreeSource() : null;
    const input = runtimeInput({ state, analysis, codes, width: size.width, height: size.height, three });
    return { state, scenes, analysis, codes, input, fps, size };
  }

  function qaFindings(samples: Array<{ t: number; sceneId: string; stats: FrameStats }>): StillsResult["findings"] {
    const findings: StillsResult["findings"] = [];
    const byScene = new Map<string, Array<{ t: number; stats: FrameStats }>>();
    for (const sample of samples) byScene.set(sample.sceneId, [...(byScene.get(sample.sceneId) ?? []), sample]);
    for (const [sceneId, list] of byScene) {
      const flat = list.filter((sample) => sample.stats.std < 0.012);
      if (flat.length === list.length) {
        const mean = list[0]!.stats.mean;
        findings.push({ severity: "error", sceneId, time: list[0]!.t, message: `Scene renders as a flat ${mean < 0.08 ? "black" : mean > 0.92 ? "white" : "single-colour"} frame — nothing visible is drawn.` });
      } else if (flat.length) {
        findings.push({ severity: "warn", sceneId, time: flat[0]!.t, message: `Scene goes blank around ${fmtTime(flat[0]!.t)}.` });
      }
      const diffs = list.map((sample) => sample.stats.diff).filter((value): value is number => value !== null);
      if (list.length >= 3 && diffs.length >= 2 && diffs.every((value) => value < 0.0025)) {
        findings.push({ severity: "warn", sceneId, time: list[0]!.t, message: "Scene looks frozen: frames barely change over time; tie motion to f.local, beats or energy." });
      }
      const dark = list.filter((sample) => sample.stats.mean < 0.04 && sample.stats.std >= 0.012).length;
      if (dark === list.length) findings.push({ severity: "info", sceneId, message: "Scene is very dark overall; check it reads on a phone screen." });
    }
    return findings;
  }

  function sceneRevisions(state: StudioState): Record<string, number> {
    return Object.fromEntries(state.scenes.map((scene) => [scene.id, scene.revision]));
  }

  // ------------------------------------------------------------- stills

  async function renderStills(ref: StudioRef, options: { sceneIds?: string[]; signal?: AbortSignal } = {}): Promise<StillsResult> {
    assertLive();
    const started = now();
    const { state, scenes, input } = await prepare(ref, "stills", options.sceneIds);
    const controller = new AbortController();
    pending.add(controller);
    const forward = () => controller.abort();
    options.signal?.addEventListener("abort", forward, { once: true });
    const release = await gate.acquire(controller.signal);
    const paths = studioPaths(ref.studioId);
    let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
    try {
      runtime = await openRuntime(deps.renderer, input, controller.signal);
      const rendered: StillsResult["scenes"] = [];
      const samples: Array<{ t: number; sceneId: string; stats: FrameStats }> = [];
      const sheet: Array<{ jpeg: Buffer; label: string }> = [];
      for (const scene of scenes) {
        if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
        const length = Math.max(0.05, scene.end - scene.start);
        const times = [0.12, 0.5, 0.88].map((k) => scene.start + length * k);
        const stats: FrameStats[] = [];
        let middle: Buffer | undefined;
        for (const [index, t] of times.entries()) {
          const frame = await runtime.renderJpeg(t, 0.86, true);
          if (frame.stats) { stats.push(frame.stats); samples.push({ t, sceneId: scene.id, stats: frame.stats }); }
          if (index === 1) middle = frame.jpeg;
        }
        await store.writeBinary(ref, paths.still(scene.id), middle!);
        sheet.push({ jpeg: middle!, label: `${scene.id} · ${fmtTime(scene.start)}` });
        rendered.push({ sceneId: scene.id, still: paths.still(scene.id), stats });
      }
      const errors = await runtime.errors();
      // A contact sheet of the whole storyboard (all scenes' current stills).
      let contactSheet: string | undefined;
      if (!options.sceneIds?.length || options.sceneIds.length === state.scenes.length) {
        const image = await runtime.contactSheet(sheet, state.scenes.length > 9 ? 4 : 3);
        await store.writeBinary(ref, paths.contactSheet, image);
        contactSheet = paths.contactSheet;
      }
      const findings = [
        ...errors.filter((error) => error.sceneId !== "runtime").map((error) => ({ severity: "error" as const, sceneId: error.sceneId, ...(error.t !== undefined ? { time: error.t } : {}), message: `Runtime error: ${error.message}` })),
        ...errors.filter((error) => error.sceneId === "runtime").map((error) => ({ severity: "error" as const, message: `Renderer: ${error.message}` })),
        ...qaFindings(samples),
      ];
      await store.update(ref, (current) => {
        for (const item of rendered) {
          const scene = current.scenes.find((candidate) => candidate.id === item.sceneId);
          const original = scenes.find((candidate) => candidate.id === item.sceneId);
          if (!scene || !original || scene.revision !== original.revision) continue;
          scene.stillRevision = scene.revision;
          const sceneErrors = errors.filter((error) => error.sceneId === scene.id);
          if (sceneErrors.length) {
            scene.lastError = sceneErrors[0]!.message;
            if (scene.status !== "planned") scene.status = "needs-fix";
          } else delete scene.lastError;
        }
        mergeQaFindings(current, findings, rendered.map((item) => item.sceneId));
        pushActivity(current, {
          at: now(), role: "reviewer", stage: "production",
          message: `Stills rendered for ${rendered.length} scene${rendered.length === 1 ? "" : "s"}`
            + (errors.length ? ` — ${errors.length} runtime error${errors.length === 1 ? "" : "s"}` : "")
            + (findings.length > errors.length ? `, ${findings.length - errors.length} QA note${findings.length - errors.length === 1 ? "" : "s"}` : ""),
        });
        return current;
      });
      return { scenes: rendered, ...(contactSheet ? { contactSheet } : {}), errors, findings, elapsedMs: now() - started };
    } finally {
      await runtime?.close();
      release();
      options.signal?.removeEventListener("abort", forward);
      pending.delete(controller);
    }
  }

  /** Replace automatic QA findings for the scenes that were just checked. */
  function mergeQaFindings(state: StudioState, findings: StillsResult["findings"], sceneIds: readonly string[]): void {
    const checked = new Set(sceneIds);
    for (const finding of state.findings) {
      if (finding.source === "qa" && finding.status === "open" && (!finding.sceneId || checked.has(finding.sceneId))) finding.status = "fixed";
    }
    for (const finding of findings) {
      state.findings.push({
        id: `qa-${randomUUID().slice(0, 8)}`,
        severity: finding.severity,
        message: finding.message,
        ...(finding.sceneId ? { sceneId: finding.sceneId } : {}),
        ...(finding.time !== undefined ? { time: Math.round(finding.time * 1000) / 1000 } : {}),
        source: "qa",
        status: "open",
        at: now(),
      });
    }
    if (state.findings.length > 120) state.findings = state.findings.slice(-120);
  }

  // ------------------------------------------------------------- videos

  async function startRender(ref: StudioRef, kind: "preview" | "final"): Promise<RenderJob> {
    assertLive();
    for (const live of jobs.values()) {
      if (store.key(live.ref) === store.key(ref)) throw invalid(`a ${live.job.kind} render is already running (${live.job.id}); wait for it or cancel it`, "conflict");
    }
    const prepared = await prepare(ref, kind);
    const { state, input, fps, size } = prepared;
    const duration = effectiveDuration(state);
    const framesTotal = Math.max(1, Math.ceil(duration * fps));
    const paths = studioPaths(ref.studioId);
    const job: RenderJob = {
      id: `r-${randomUUID().slice(0, 8)}`,
      kind, status: "running", progress: 0, framesDone: 0, framesTotal,
      width: size.width, height: size.height, fps,
      startedAt: now(), heartbeatAt: now(),
      sceneRevisions: sceneRevisions(state),
    };
    await store.update(ref, (current) => {
      current.renders.push(job);
      if (current.renders.length > 30) current.renders = current.renders.slice(-30);
      pushActivity(current, { at: now(), role: "builder", stage: kind === "final" ? "export" : "assembly", message: `${kind === "final" ? "Final" : "Preview"} render started: ${size.width}×${size.height}, ${fps} fps, ${framesTotal} frames` });
      return current;
    });
    const controller = new AbortController();
    const done = run();
    const live: LiveJob = { ref, job, controller, done };
    jobs.set(job.id, live);
    void done.finally(() => jobs.delete(job.id));
    return job;

    async function run(): Promise<RenderJob> {
      const audioFile = state.audio?.path ? await store.file(ref, state.audio.path).catch(() => undefined) : undefined;
      const output = await store.file(ref, paths.render(kind));
      const temp = `${output}.${job.id}.part.mp4`;
      let release: (() => void) | undefined;
      let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
      let encoder: ReturnType<typeof startEncoder> | undefined;
      const samples: Array<{ t: number; sceneId: string; stats: FrameStats }> = [];
      const finish = async (patch: Partial<RenderJob>, activity: string) => {
        Object.assign(job, patch, { finishedAt: now(), heartbeatAt: now() });
        await store.update(ref, (current) => {
          const stored = current.renders.find((candidate) => candidate.id === job.id);
          if (stored) Object.assign(stored, job);
          pushActivity(current, { at: now(), role: "builder", stage: kind === "final" ? "export" : "assembly", message: activity });
          return current;
        }).catch(() => undefined);
        return job;
      };
      try {
        release = await gate.acquire(controller.signal);
        const { mkdir, rename, rm } = await import("node:fs/promises");
        const path = await import("node:path");
        await mkdir(path.dirname(output), { recursive: true });
        runtime = await openRuntime(deps.renderer, input, controller.signal);
        encoder = startEncoder({
          output: temp, fps, durationSec: duration, quality: kind,
          ...(audioFile ? { audioPath: audioFile } : {}),
          ...(deps.renderer.ffmpegPath ? { ffmpegPath: deps.renderer.ffmpegPath } : {}),
        });
        const statsEvery = Math.max(1, Math.round(fps / 2));
        let lastProgress = 0;
        let lastLive = 0;
        const sceneAt = (t: number): StudioScene | undefined => state.scenes.find((scene) => t >= scene.start && t < scene.end) ?? state.scenes.at(-1);
        for (let frameIndex = 0; frameIndex < framesTotal; frameIndex++) {
          if (controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "aborted" });
          const t = frameIndex / fps;
          const withStats = frameIndex % statsEvery === 0;
          const frame = await runtime.renderJpeg(t, kind === "final" ? 0.92 : 0.8, withStats);
          if (frame.stats) samples.push({ t, sceneId: sceneAt(t)?.id ?? "", stats: frame.stats });
          await encoder.write(frame.jpeg);
          job.framesDone = frameIndex + 1;
          const stamp = now();
          if (stamp - lastLive >= LIVE_FRAME_INTERVAL_MS) {
            lastLive = stamp;
            await store.writeBinary(ref, paths.liveFrame, frame.jpeg).catch(() => undefined);
          }
          if (stamp - lastProgress >= PROGRESS_INTERVAL_MS) {
            lastProgress = stamp;
            job.progress = Math.round((job.framesDone / framesTotal) * 1000) / 1000;
            job.heartbeatAt = stamp;
            await store.update(ref, (current) => {
              const stored = current.renders.find((candidate) => candidate.id === job.id);
              if (stored) Object.assign(stored, { progress: job.progress, framesDone: job.framesDone, heartbeatAt: job.heartbeatAt });
              return current;
            }).catch(() => undefined);
          }
        }
        await encoder.finish();
        encoder = undefined;
        await rm(output, { force: true });
        await rename(temp, output);
        const errors = await runtime.errors();
        const findings = [
          ...errors.map((error) => ({ severity: "error" as const, ...(error.sceneId !== "runtime" ? { sceneId: error.sceneId } : {}), ...(error.t !== undefined ? { time: error.t } : {}), message: `Runtime error: ${error.message}` })),
          ...qaFindings(samples.filter((sample) => sample.sceneId)),
        ];
        await store.update(ref, (current) => {
          mergeQaFindings(current, findings, current.scenes.map((scene) => scene.id));
          return current;
        }).catch(() => undefined);
        await runtime.close();
        runtime = undefined;
        // Final delivery: verify the file, then copy it to the requested path.
        let delivery: Partial<RenderJob> = {};
        if (kind === "final") {
          const songSec = state.delivery?.matchSongLength ? state.audio?.durationSec : undefined;
          const verification = await verifyVideo(output, {
            width: size.width, height: size.height, fps, durationSec: duration,
            ...(songSec ? { songSec } : {}),
            ...(deps.renderer.ffmpegPath ? { ffmpegPath: deps.renderer.ffmpegPath } : {}),
            signal: controller.signal,
          });
          if (!audioFile) verification.problems = verification.problems.filter((problem) => !/audio/.test(problem));
          verification.ok = verification.problems.length === 0;
          delivery = { verification };
          const target = state.delivery?.outputPath;
          if (verification.ok && target) {
            const { copyFile, mkdir: makeDir } = await import("node:fs/promises");
            const destination = await store.file(ref, target);
            await makeDir(path.dirname(destination), { recursive: true });
            await copyFile(output, destination);
            delivery.delivered = target;
          }
        }
        const elapsed = Math.round((now() - job.startedAt) / 1000);
        const verified = delivery.verification
          ? delivery.verification.ok ? `; verified${delivery.delivered ? `, delivered to ${delivery.delivered}` : ""}` : `; verification failed: ${delivery.verification.problems.slice(0, 2).join("; ")}`
          : "";
        return await finish(
          { status: "done", progress: 1, output: paths.render(kind), ...delivery, ...(errors.length ? { sceneErrors: errors.slice(0, 20) } : {}) },
          `${kind === "final" ? "Final" : "Preview"} render finished in ${elapsed}s${findings.length ? ` with ${findings.length} QA note${findings.length === 1 ? "" : "s"}` : ""}${verified}`,
        );
      } catch (error) {
        encoder?.kill();
        const { rm } = await import("node:fs/promises");
        await rm(temp, { force: true }).catch(() => undefined);
        const cancelled = controller.signal.aborted;
        return await finish(
          cancelled ? { status: disposed ? "interrupted" : "cancelled" } : { status: "failed", error: (error as Error).message.slice(0, 500) },
          cancelled ? `${kind} render cancelled` : `${kind} render failed: ${(error as Error).message.slice(0, 160)}`,
        );
      } finally {
        encoder?.kill();
        await runtime?.close();
        release?.();
      }
    }
  }

  async function waitRender(ref: StudioRef, jobId: string | undefined, timeoutMs: number): Promise<RenderJob | undefined> {
    const live = [...jobs.values()].find((candidate) => store.key(candidate.ref) === store.key(ref) && (!jobId || candidate.job.id === jobId));
    if (live) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<RenderJob>((resolve) => { timer = setTimeout(() => resolve(live.job), timeoutMs); });
      try {
        return await Promise.race([live.done, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const state = await reconcile(ref);
    return jobId ? state?.renders.find((job) => job.id === jobId) : state?.renders.at(-1);
  }

  async function cancelRender(ref: StudioRef, jobId?: string): Promise<boolean> {
    const live = [...jobs.values()].find((candidate) => store.key(candidate.ref) === store.key(ref) && (!jobId || candidate.job.id === jobId));
    if (!live) return false;
    live.controller.abort();
    await live.done.catch(() => undefined);
    return true;
  }

  /** Render job heartbeat older than this is shown as stalled by the UI. */
  const isStale = (job: RenderJob) => job.status === "running" && now() - job.heartbeatAt > STALE_HEARTBEAT_MS;

  async function dispose(): Promise<void> {
    disposed = true;
    for (const controller of pending) controller.abort();
    const live = [...jobs.values()];
    for (const job of live) job.controller.abort();
    await Promise.allSettled(live.map((job) => job.done));
  }

  return { store, analyze, renderStills, startRender, waitRender, cancelRender, reconcile, isStale, dispose, activeJobs: () => [...jobs.values()].map((live) => live.job) };
}

export type StudioService = ReturnType<typeof createStudioService>;
