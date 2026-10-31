import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { AudioAnalysis } from "../src/audio/analysis.ts";
import { effectiveDuration, isCssColor, type StudioScene, type StudioState } from "../src/index.ts";
import { needsThree, runtimeInput, type RuntimeInput } from "../src/render/runtime.ts";
import type { StudioClient } from "./client.ts";
import { useClockValue, type PlayClock } from "./clock.ts";
import { AlertGlyph, PauseGlyph, PlayGlyph, RestartGlyph } from "./glyphs.tsx";
import { PREVIEW_CHANNEL, previewDocument, previewSize } from "./preview.ts";
import { fill, type StudioStrings } from "./strings.ts";
import { clockTime, sceneAt } from "./studioModel.ts";

let threeSource: Promise<RuntimeInput["three"]> | undefined;
const loadThree = (client: StudioClient) => {
  threeSource ??= client.three().catch(() => { threeSource = undefined; return null; });
  return threeSource;
};

export interface StageControl {
  seek(time: number, options?: { play?: boolean }): void;
  toggle(): void;
  pause(): void;
}

/** A rendered file shown on the stage instead of the live runtime. */
export interface StageRender { url: string; label: string }

interface Props {
  host: WebPackageHost;
  t: StudioStrings;
  client: StudioClient;
  state: StudioState;
  scenes: readonly StudioScene[];
  analysis: AudioAnalysis | null;
  codes: Record<string, string | undefined>;
  audioUrl: string | null;
  clock: PlayClock;
  controlRef: { current: StageControl | null };
  stillUrl(scene: StudioScene): string | null;
  active: boolean;
  live: boolean;
  render: StageRender | null;
  onBackToLive(): void;
  onShowErrors(): void;
}

/** How well a palette colour lights the theater: saturated mid tones glow,
 * near-black backgrounds and paper whites do not. Non-hex colours rank middle. */
function glowScore(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return 0.3;
  const value = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join("") : hex[1]!;
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  return saturation * Math.max(0, 1 - Math.abs(light - 0.55) * 1.6);
}

export function glowColors(palette: readonly string[] | undefined): string[] {
  return (palette ?? []).filter(isCssColor)
    .map((color, index) => ({ color, index, score: glowScore(color) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.color);
}

const glowStyle = (palette: readonly string[] | undefined): CSSProperties =>
  Object.fromEntries(glowColors(palette).map((color, index) => [`--cs-glow-${index + 1}`, color])) as CSSProperties;

function Stage({ host, t, client, state, scenes, analysis, codes, audioUrl, clock, controlRef, stillUrl, active, live, render, onBackToLive, onShowErrors }: Props) {
  const { IconButton } = host.ui.components;
  const frame = useRef<HTMLIFrameElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  // Bumped by each frame document's own "loaded" message: an iframe also
  // fires load for its initial about:blank, which must not trigger init.
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const [errors, setErrors] = useState<Array<{ sceneId: string; message: string }>>([]);
  const [failure, setFailure] = useState("");
  const duration = effectiveDuration(state);
  const wall = useRef({ origin: 0, offset: 0 });
  const documentHtml = useMemo(() => previewDocument(), []);
  const size = previewSize(state.format.aspect);

  // Re-initialise when anything the runtime reads changes.
  const inputKey = JSON.stringify([state.scenes.map((scene) => [scene.id, scene.start, scene.end, scene.renderer, scene.revision, scene.title, scene.transition]), state.styleGuide, state.format, analysis?.source, analysis?.lyrics?.lines.length, Object.keys(codes).length]);
  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ channel: PREVIEW_CHANNEL, ...message }, "*");
  }, []);

  // Listen before the frame can load: a srcdoc frame may run its bridge and
  // post "loaded" before passive effects run, and that message would be lost.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { channel?: string; kind?: string; errors?: Array<{ sceneId: string; message: string }>; message?: string } | null;
      if (!data || data.channel !== PREVIEW_CHANNEL) return;
      if (data.kind === "loaded") { setReady(false); setFrameGeneration((value) => value + 1); }
      if (data.kind === "ready" || data.kind === "errors") { setErrors(data.errors ?? []); setFailure(""); setReady(true); }
      if (data.kind === "failed") setFailure(data.message ?? "");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!frameGeneration) return;
    let cancelled = false;
    void (async () => {
      const three = needsThree(state.scenes.filter((scene) => codes[scene.id])) ? await loadThree(client) : null;
      if (cancelled) return;
      post({ kind: "init", input: runtimeInput({ state, analysis, codes, ...size, three }), t: clock.get() });
    })();
    return () => { cancelled = true; };
  }, [frameGeneration, inputKey]); // inputKey summarises state/analysis/codes

  // One clock: the song when there is one, otherwise wall time.
  const now = useCallback(() => {
    if (audio.current && audioUrl) return audio.current.currentTime;
    return wall.current.offset + (performance.now() - wall.current.origin) / 1000;
  }, [audioUrl]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const step = () => {
      const current = now();
      if (current >= duration) {
        audio.current?.pause();
        setPlaying(false);
        clock.set(duration);
        post({ kind: "frame", t: Math.max(0, duration - 0.001) });
        return;
      }
      clock.set(current);
      post({ kind: "frame", t: current });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, now, clock, post]);

  const start = useCallback(async (from: number) => {
    const at = Math.max(0, Math.min(from, duration - 0.05));
    clock.set(at);
    if (audio.current && audioUrl) {
      audio.current.currentTime = at;
      try { await audio.current.play(); } catch { /* autoplay refusal: stay paused */ return; }
    } else {
      wall.current = { origin: performance.now(), offset: at };
    }
    setPlaying(true);
  }, [audioUrl, duration, clock]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    const current = now();
    audio.current?.pause();
    setPlaying(false);
    clock.set(current);
  }, [now, clock]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else void start(clock.get() >= duration - 0.05 ? 0 : clock.get());
  }, [pause, start, clock, duration]);

  // Seeks from the timeline, the storyboard and the keyboard. While paused one
  // frame is drawn per animation frame, newest wins.
  const pendingFrame = useRef(0);
  useEffect(() => {
    controlRef.current = {
      seek(at, options) {
        const time = Math.max(0, Math.min(at, duration));
        clock.set(time);
        if (audio.current && audioUrl) audio.current.currentTime = time;
        if (options?.play) { void start(time); return; }
        if (playingRef.current) { wall.current = { origin: performance.now(), offset: time }; return; }
        cancelAnimationFrame(pendingFrame.current);
        pendingFrame.current = requestAnimationFrame(() => post({ kind: "frame", t: Math.min(clock.get(), Math.max(0, duration - 0.001)) }));
      },
      toggle,
      pause,
    };
    return () => { controlRef.current = null; };
  }, [controlRef, duration, audioUrl, clock, start, toggle, pause, post]);

  useEffect(() => { if (!active || render) pause(); }, [active, render, pause]);
  // A rendered file replaces the frame; the next frame announces itself.
  useEffect(() => { if (render) setReady(false); }, [render]);
  useEffect(() => () => { audio.current?.pause(); cancelAnimationFrame(pendingFrame.current); }, []);

  const currentSceneId = useClockValue(clock, useCallback((time: number) => sceneAt(scenes, time)?.id ?? "", [scenes]));
  const currentScene = scenes.find((scene) => scene.id === currentSceneId) ?? scenes[0];
  const poster = currentScene ? stillUrl(currentScene) : null;
  const empty = scenes.length === 0;
  const errorCount = failure ? Math.max(1, errors.length) : errors.length;

  return (
    <section className="cs-stage" data-aspect={state.format.aspect} data-playing={playing || undefined} aria-label={t.livePreview}>
      <div className="cs-stage-frame" style={glowStyle(state.styleGuide?.palette)}>
        <div className="cs-stage-glow" aria-hidden="true" />
        <div className="cs-stage-screen" data-aspect={state.format.aspect}>
          {poster && !render && <img className="cs-stage-poster" src={poster} alt="" decoding="async" />}
          {!poster && !render && !ready && currentScene && (
            <div className="cs-stage-card" aria-hidden="true">
              <b>{scenes.indexOf(currentScene) + 1}</b>
              <span>{currentScene.title}</span>
            </div>
          )}
          {render ? (
            <video key={render.url} className="cs-stage-video" src={render.url} controls playsInline preload="metadata" />
          ) : (
            <iframe
              ref={frame}
              className="cs-stage-runtime"
              data-ready={ready || undefined}
              title={t.livePreview}
              sandbox="allow-scripts"
              srcDoc={documentHtml}
              tabIndex={-1}
            />
          )}
          {!render && !empty && (
            <button type="button" className="cs-stage-hit" aria-label={playing ? t.pause : t.play} onClick={toggle}>
              <span className="cs-stage-bigplay" aria-hidden="true"><PlayGlyph /></span>
            </button>
          )}
          {!render && empty && (
            <div className="cs-stage-empty">
              <strong>{t.stageEmpty}</strong>
              <span>{t.stageEmptyHint}</span>
            </div>
          )}
          <div className="cs-stage-chips">
            {render ? (
              <>
                <span className="cs-chip cs-chip--glass">{render.label}</span>
                <button type="button" className="cs-chip cs-chip--glass cs-chip--action" onClick={onBackToLive}>{t.backToLive}</button>
              </>
            ) : live ? (
              <span className="cs-chip cs-chip--glass cs-chip--live" title={t.liveHint}><span className="cs-live-dot" aria-hidden="true" />{t.live}</span>
            ) : null}
            {!render && errorCount > 0 && (
              <button type="button" className="cs-chip cs-chip--glass cs-chip--alert" onClick={onShowErrors} title={failure || errors.map((error) => `${error.sceneId}: ${error.message}`).join("\n")}>
                <AlertGlyph className="cs-chip-glyph" />{fill(t.previewError, { count: errorCount })}
              </button>
            )}
          </div>
        </div>
      </div>
      {audioUrl && <audio ref={audio} src={audioUrl} preload="metadata" onEnded={() => setPlaying(false)} />}
      {!render && (
        <div className="cs-transport">
          <IconButton
            className="cs-play"
            icon={playing ? PauseGlyph : PlayGlyph}
            label={playing ? t.pause : t.play}
            size="lg"
            variant="quiet"
            disabled={empty}
            onClick={toggle}
          />
          <ClockText clock={clock} duration={duration} />
          {currentScene && (
            <span className="cs-transport-scene" title={currentScene.title}>
              <b>{scenes.indexOf(currentScene) + 1}</b>
              <span dir="auto">{currentScene.title}</span>
            </span>
          )}
          <IconButton
            className="cs-transport-restart"
            icon={RestartGlyph}
            label={t.restart}
            size="sm"
            variant="ghost"
            disabled={empty}
            onClick={() => controlRef.current?.seek(0)}
          />
        </div>
      )}
    </section>
  );
}

function ClockText({ clock, duration }: { clock: PlayClock; duration: number }) {
  const seconds = useClockValue(clock, useCallback((time: number) => Math.floor(time + 1e-6), []));
  return (
    <span className="cs-clock" aria-live="off">
      <b>{clockTime(seconds)}</b><span aria-hidden="true"> / </span><span>{clockTime(duration)}</span>
    </span>
  );
}

export default memo(Stage);
