import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { AudioAnalysis } from "../src/audio/analysis.ts";
import { effectiveDuration, type StudioScene, type StudioState } from "../src/index.ts";
import { useClockValue, type PlayClock } from "./clock.ts";
import { label, type StudioStrings } from "./strings.ts";
import { clockTime, sceneAt } from "./studioModel.ts";

interface Props {
  t: StudioStrings;
  state: StudioState;
  scenes: readonly StudioScene[];
  analysis: AudioAnalysis | null;
  clock: PlayClock;
  selectedScene: string | null;
  stillUrl(scene: StudioScene): string | null;
  onSeek(time: number): void;
  onSelectScene(sceneId: string): void;
}

const pct = (value: number, total: number) => `${Math.max(0, Math.min(100, (value / Math.max(0.001, total)) * 100))}%`;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** SVG path of a 0..1 curve over [0, duration] in a 1000×100 box. */
export function curvePath(values: readonly number[], rate: number, duration: number): string {
  if (!values.length || duration <= 0) return "";
  const count = Math.min(values.length, Math.ceil(duration * rate));
  const step = Math.max(1, Math.floor(count / 500));
  let path = "M0,100";
  for (let i = 0; i < count; i += step) {
    const x = ((i / rate) / duration) * 1000;
    path += ` L${x.toFixed(1)},${(100 - (values[i] ?? 0) * 92).toFixed(1)}`;
  }
  return `${path} L${(((count - 1) / rate) / duration * 1000).toFixed(1)},100 Z`;
}

/** Filmstrip over the whole song: sections, scene stills, the energy curve with
 * beats and lyric spans. Drag anywhere to scrub; a tap selects the scene. */
function Timeline({ t, state, scenes, analysis, clock, selectedScene, stillUrl, onSeek, onSelectScene }: Props) {
  const duration = effectiveDuration(state);
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<{ pointer: number; x: number; moved: boolean; rtl: boolean } | null>(null);
  // The track mounts once there is something to place on it.
  const hasContent = Boolean(analysis) || scenes.length > 0;

  useEffect(() => {
    const element = track.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasContent]);

  // The playhead follows the clock without re-rendering the strip.
  useEffect(() => {
    const paint = () => {
      const time = clock.get();
      if (head.current) head.current.style.insetInlineStart = pct(time, duration);
      const element = track.current;
      if (element) {
        element.setAttribute("aria-valuenow", String(Math.round(time)));
        element.setAttribute("aria-valuetext", clockTime(time));
      }
    };
    paint();
    return clock.subscribe(paint);
  }, [clock, duration, hasContent]);

  const currentScene = useClockValue(clock, useCallback((time: number) => sceneAt(scenes, time)?.id ?? "", [scenes]));
  const energy = useMemo(() => analysis ? curvePath(analysis.curve.rms, analysis.curve.rate, duration) : "", [analysis, duration]);
  const beats = useMemo(() => {
    if (!analysis) return { beats: [] as number[], downbeats: new Set<number>() };
    return { beats: analysis.beats.filter((beat) => beat <= duration), downbeats: new Set(analysis.downbeats) };
  }, [analysis, duration]);

  const timeAt = (clientX: number, rtl: boolean) => {
    const box = track.current!.getBoundingClientRect();
    const ratio = clamp01((clientX - box.left) / Math.max(1, box.width));
    return (rtl ? 1 - ratio : ratio) * duration;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track.current) return;
    const rtl = getComputedStyle(track.current).direction === "rtl";
    drag.current = { pointer: event.pointerId, x: event.clientX, moved: false, rtl };
    track.current.setPointerCapture?.(event.pointerId);
    onSeek(timeAt(event.clientX, rtl));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (Math.abs(event.clientX - current.x) > 4) current.moved = true;
    onSeek(timeAt(event.clientX, current.rtl));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    track.current?.releasePointerCapture?.(event.pointerId);
    if (!current.moved) {
      const scene = sceneAt(scenes, timeAt(event.clientX, current.rtl));
      if (scene) onSelectScene(scene.id);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const time = clock.get();
    const beat = analysis ? 60 / Math.max(30, analysis.bpm) : 1;
    const index = scenes.findIndex((scene) => scene.id === sceneAt(scenes, time)?.id);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = event.shiftKey ? scenes[index + 1]?.start ?? duration : time + beat;
    else if (event.key === "ArrowLeft") next = event.shiftKey ? scenes[Math.max(0, time - (scenes[index]?.start ?? 0) > 0.5 ? index : index - 1)]?.start ?? 0 : time - beat;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = duration;
    if (next === null) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(duration, next)));
  };

  const wide = (start: number, end: number, min: number) => width > 0 && ((Math.min(end, duration) - start) / Math.max(0.001, duration)) * width >= min;

  // Nothing to place on the timeline until the song is analyzed or scenes exist.
  if (!hasContent) {
    return (
      <div className="cs-film">
        <p className="cs-film-empty">{t.timelineEmpty}</p>
      </div>
    );
  }

  return (
    <div className="cs-film" data-owns-swipe="">
      <div
        ref={track}
        className="cs-film-track"
        role="slider"
        tabIndex={0}
        aria-label={t.timeline}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKey}
      >
        {analysis && (
          <div className="cs-film-row cs-film-sections" aria-hidden="true">
            {analysis.sections.filter((section) => section.start < duration).map((section) => (
              <span
                key={section.start}
                className="cs-film-section"
                data-kind={section.kind}
                style={{ insetInlineStart: pct(section.start, duration), inlineSize: pct(Math.min(section.end, duration) - section.start, duration) }}
              >
                {wide(section.start, section.end, 44) && <>{label(t, `section_${section.kind}`)}<b>{section.group}</b></>}
              </span>
            ))}
          </div>
        )}
        <div className="cs-film-row cs-film-scenes">
          {scenes.map((scene, index) => {
            const still = stillUrl(scene);
            return (
              <button
                type="button"
                key={scene.id}
                className="cs-film-scene"
                tabIndex={-1}
                data-status={scene.status}
                data-selected={selectedScene === scene.id || undefined}
                data-current={currentScene === scene.id || undefined}
                data-still={still ? true : undefined}
                style={{
                  insetInlineStart: pct(scene.start, duration),
                  inlineSize: pct(Math.min(scene.end, duration) - scene.start, duration),
                  ...(still ? { backgroundImage: `url("${still}")` } : {}),
                }}
                title={`${index + 1}. ${scene.title} · ${clockTime(scene.start)}–${clockTime(scene.end)} · ${label(t, `scene_${scene.status}`)}`}
                onClick={() => onSelectScene(scene.id)}
              >
                {wide(scene.start, scene.end, 22) && <span className="cs-film-scene-n">{index + 1}</span>}
              </button>
            );
          })}
        </div>
        <div className="cs-film-row cs-film-wave" aria-hidden="true">
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
            {energy && <path className="cs-film-energy" d={energy} />}
            {beats.beats.map((beat) => (
              <line
                key={beat}
                className={beats.downbeats.has(beat) ? "cs-film-downbeat" : "cs-film-beat"}
                x1={(beat / duration) * 1000}
                x2={(beat / duration) * 1000}
                y1={beats.downbeats.has(beat) ? 30 : 72}
                y2={100}
              />
            ))}
          </svg>
        </div>
        {analysis?.lyrics && analysis.lyrics.lines.length > 0 && (
          <div className="cs-film-row cs-film-lyrics" aria-hidden="true">
            {analysis.lyrics.lines.filter((line) => line.start < duration).map((line, index) => (
              <span key={index} style={{ insetInlineStart: pct(line.start, duration), inlineSize: pct(Math.min(line.end, duration) - line.start, duration) }} />
            ))}
          </div>
        )}
        <span ref={head} className="cs-film-head" aria-hidden="true"><span className="cs-film-knob" /></span>
      </div>
      <div className="cs-film-scale" aria-hidden="true">
        <span>0:00</span>
        <span>{clockTime(duration / 2)}</span>
        <span>{clockTime(duration)}</span>
      </div>
    </div>
  );
}

export default memo(Timeline);
