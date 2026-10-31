import { useRef, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { AudioAnalysis } from "../src/audio/analysis.ts";
import {
  EFFORT_PROFILES,
  effectiveDuration,
  estimateCost,
  renderIsCurrent,
  STAGE_IDS,
  stageCriteria,
  studioPaths,
  type QaFinding,
  type RenderJob,
  type StageId,
  type StudioScene,
  type StudioState,
} from "../src/index.ts";
import { CheckGlyph, ExportGlyph, MusicGlyph, OpenGlyph, PlayGlyph, SparkGlyph, UploadGlyph } from "./glyphs.tsx";
import { compact, fill, label, type StudioStrings } from "./strings.ts";
import { clockTime, latestDone, openFindings, runningRender, stageProgress, type AgentNote } from "./studioModel.ts";
import { curvePath } from "./Timeline.tsx";

const STALE_MS = 30_000;
const relative = (at: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
};

// ----------------------------------------------------------------- scenes

export function ScenesView({ host, t, state, scenes, stillUrl, selected, onSelect, onPlayFrom, onChange }: {
  host: WebPackageHost; t: StudioStrings; state: StudioState; scenes: readonly StudioScene[];
  stillUrl(scene: StudioScene): string | null; selected: string | null;
  onSelect(scene: StudioScene): void; onPlayFrom(scene: StudioScene): void; onChange(scene: StudioScene): void;
}) {
  const { Button } = host.ui.components;
  const guide = state.styleGuide;
  return (
    <div className="cs-view cs-scenes">
      {guide && (
        <div className="cs-guide">
          <ul className="cs-palette" aria-label={t.palette}>
            {guide.palette.map((color) => <li key={color} style={{ background: color }} title={color} />)}
          </ul>
          {(guide.typography || guide.motifs?.length) && (
            <p className="cs-guide-notes" dir="auto">{[guide.typography, ...(guide.motifs ?? [])].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      )}
      {state.approvals.concept && <p className="cs-approved"><CheckGlyph className="cs-inline-glyph" />{t.approved}</p>}
      {scenes.length === 0 ? <p className="cs-empty-note">{t.storyboardEmpty}</p> : (
        <ol className="cs-scene-list">
          {scenes.map((scene, index) => {
            const still = stillUrl(scene);
            const isSelected = selected === scene.id;
            return (
              <li key={scene.id} className="cs-scene" data-status={scene.status} data-selected={isSelected || undefined}>
                <button type="button" className="cs-scene-main" aria-expanded={isSelected} onClick={() => onSelect(scene)}>
                  <span className="cs-scene-thumb" data-aspect={state.format.aspect}>
                    {still ? <img src={still} alt="" loading="lazy" decoding="async" /> : <span className="cs-scene-ph" aria-hidden="true">{index + 1}</span>}
                    {scene.stillRevision !== undefined && scene.stillRevision !== scene.revision && <span className="cs-scene-stale" title={t.outdated} />}
                  </span>
                  <span className="cs-scene-text">
                    <span className="cs-scene-title"><span className="cs-scene-n">{index + 1}</span><strong dir="auto">{scene.title}</strong></span>
                    <span className="cs-scene-meta">
                      <span className="cs-dot" data-tone={scene.status} aria-hidden="true" />
                      {label(t, `scene_${scene.status}`)} · {clockTime(scene.start)}–{clockTime(scene.end)} · {label(t, `renderer_${scene.renderer}`)}
                      {scene.transition && index > 0 ? ` · ${label(t, `transition_${scene.transition.kind}`)}` : ""}
                    </span>
                    <span className="cs-scene-desc" dir="auto">{scene.description}</span>
                  </span>
                </button>
                {isSelected && (
                  <div className="cs-scene-more">
                    {scene.lastError && <p className="cs-error"><code>{scene.lastError}</code></p>}
                    <div className="cs-row">
                      <Button size="sm" variant="quiet" iconStart={PlayGlyph} onClick={() => onPlayFrom(scene)}>{t.playFrom}</Button>
                      <Button size="sm" variant="quiet" iconStart={SparkGlyph} onClick={() => onChange(scene)}>{t.change}</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ sound

const AUDIO_ACCEPT = "audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus";
const LYRICS_ACCEPT = ".lrc,.txt,text/plain";

export function SoundView({ host, t, state, analysis, busy, onUpload, onAnalyze, onSeek }: {
  host: WebPackageHost; t: StudioStrings; state: StudioState; analysis: AudioAnalysis | null; busy: boolean;
  onUpload(file: File): void; onAnalyze(): void; onSeek(time: number): void;
}) {
  const { Button } = host.ui.components;
  const songInput = useRef<HTMLInputElement>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);
  const pickers = (
    <>
      <input ref={songInput} hidden type="file" accept={AUDIO_ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />
      <input ref={lyricsInput} hidden type="file" accept={LYRICS_ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />
    </>
  );
  if (!state.audio) {
    return (
      <div className="cs-view cs-sound">
        <div className="cs-drop">
          <span className="cs-drop-art" aria-hidden="true"><MusicGlyph /></span>
          <strong>{t.noAudio}</strong>
          <p>{t.addSong}</p>
          <Button variant="primary" iconStart={UploadGlyph} busy={busy} onClick={() => songInput.current?.click()}>{t.songPick}</Button>
        </div>
        {pickers}
      </div>
    );
  }
  const duration = analysis?.durationSec ?? state.audio.durationSec ?? effectiveDuration(state);
  return (
    <div className="cs-view cs-sound">
      <div className="cs-song">
        <span className="cs-song-art" aria-hidden="true"><MusicGlyph /></span>
        <span className="cs-song-text">
          <strong dir="auto">{state.audio.name ?? state.audio.path.split("/").pop()}</strong>
          <span>{[duration ? clockTime(duration) : null, analysis ? `${Math.round(analysis.bpm)} BPM` : null, analysis ? `${analysis.key.tonic} ${analysis.key.mode === "major" ? "maj" : "min"}` : null].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
      <div className="cs-row">
        <Button size="sm" variant="quiet" onClick={() => songInput.current?.click()}>{t.songReplace}</Button>
        <Button size="sm" variant="quiet" onClick={() => lyricsInput.current?.click()}>{t.lyricsPick}</Button>
        <Button size="sm" variant={analysis ? "ghost" : "primary"} busy={busy} onClick={onAnalyze}>{busy ? t.analyzing : analysis ? t.reanalyze : t.analyze}</Button>
      </div>
      {pickers}
      {analysis && (
        <>
          <dl className="cs-stats">
            <Stat term={t.bpm} value={Math.round(analysis.bpm)} />
            <Stat term={t.key} value={`${analysis.key.tonic} ${analysis.key.mode === "major" ? "maj" : "min"}`} />
            <Stat term={t.bars} value={analysis.downbeats.length} />
            <Stat term={t.sections} value={analysis.sections.length} />
          </dl>
          <figure className="cs-energy">
            <figcaption className="cs-label">{t.energy}</figcaption>
            <div className="cs-energy-plot">
              <div className="cs-energy-sections" aria-hidden="true">
                {analysis.sections.map((section) => (
                  <span key={section.start} data-kind={section.kind} style={{ insetInlineStart: `${(section.start / analysis.durationSec) * 100}%`, inlineSize: `${((section.end - section.start) / analysis.durationSec) * 100}%` }} />
                ))}
              </div>
              <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
                <path d={curvePath(analysis.curve.rms, analysis.curve.rate, analysis.durationSec)} />
              </svg>
            </div>
          </figure>
          <section className="cs-block">
            <h3 className="cs-label">{t.sections}</h3>
            <ol className="cs-sections">
              {analysis.sections.map((section) => (
                <li key={section.start} data-kind={section.kind}>
                  <button type="button" onClick={() => onSeek(section.start)}>
                    <span className="cs-swatch" aria-hidden="true" />
                    <strong>{label(t, `section_${section.kind}`)} {section.group}</strong>
                    <span className="cs-meter" aria-hidden="true"><span style={{ inlineSize: `${Math.round(section.energy * 100)}%` }} /></span>
                    <span className="cs-time">{clockTime(section.start)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <section className="cs-block">
            <h3 className="cs-label">{t.instruments}</h3>
            <div className="cs-lanes">
              {analysis.instruments.map((lane) => (
                <div key={lane.id} className="cs-lane">
                  <span className="cs-lane-name">{label(t, `lane_${lane.id}`)}</span>
                  <svg viewBox={`0 0 ${Math.max(1, lane.activity.length)} 1`} preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
                    {lane.activity.map((value, index) => value > 0.08 ? <rect key={index} x={index} y={0} width={1.02} height={1} opacity={Math.min(1, value)} /> : null)}
                  </svg>
                  <span className="cs-time">{Math.round(lane.coverage * 100)}%</span>
                </div>
              ))}
            </div>
            <p className="cs-hint">{t.instrumentsHint}</p>
          </section>
          <section className="cs-block">
            <h3 className="cs-label">{t.lyrics}</h3>
            {analysis.lyrics?.lines.length ? (
              <>
                {analysis.lyrics.source !== "lrc" && <p className="cs-hint">{t.lyricsEstimated}</p>}
                <ol className="cs-lyrics">
                  {analysis.lyrics.lines.slice(0, 200).map((line, index) => (
                    <li key={index}><button type="button" onClick={() => onSeek(line.start)}><span className="cs-time">{clockTime(line.start)}</span><span dir="auto">{line.text}</span></button></li>
                  ))}
                </ol>
              </>
            ) : <p className="cs-hint">{t.lyricsNone}</p>}
          </section>
          {analysis.warnings.length > 0 && (
            <section className="cs-block">
              <h3 className="cs-label">{t.warnings}</h3>
              <ul className="cs-notes">{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ term, value }: { term: string; value: ReactNode }) {
  return <div><dt>{term}</dt><dd>{value}</dd></div>;
}

// ----------------------------------------------------------------- export

export function ExportView({ host, t, state, now, busy, mediaUrl, onRender, onCancel, onOpen, onWatch }: {
  host: WebPackageHost; t: StudioStrings; state: StudioState; now: number; busy: boolean;
  mediaUrl(path: string, version?: string | number): string;
  onRender(kind: "stills" | "preview" | "final"): void; onCancel(): void; onOpen(path: string): void; onWatch(job: RenderJob): void;
}) {
  const { Button } = host.ui.components;
  const running = runningRender(state);
  const final = latestDone(state, "final");
  const hasScenes = state.scenes.length > 0;
  const finalCurrent = final ? renderIsCurrent(state, final) : false;
  const verification = final?.verification;
  return (
    <div className="cs-view cs-export">
      <article className="cs-final" data-ready={final ? true : undefined}>
        <span className="cs-final-art" aria-hidden="true"><ExportGlyph /></span>
        <div className="cs-final-text">
          <strong>{final ? label(t, "render_final") : t.finalNone}</strong>
          {final ? (
            <span>{[`${final.width}×${final.height}`, `${final.fps} fps`, verification ? clockTime(verification.durationSec) : null].filter(Boolean).join(" · ")}{!finalCurrent ? ` · ${t.outdated}` : ""}</span>
          ) : <span>{t.finalNoneHint}</span>}
          {verification && (
            <span className="cs-verify" data-ok={verification.ok || undefined}>
              {verification.ok ? <CheckGlyph className="cs-inline-glyph" /> : null}
              {verification.ok ? t.verified : `${t.verifyFailed}: ${verification.problems.slice(0, 2).join("; ")}`}
            </span>
          )}
        </div>
        {final?.output && (
          <div className="cs-row cs-final-actions">
            <Button size="sm" variant="primary" iconStart={PlayGlyph} onClick={() => onWatch(final)}>{t.watch}</Button>
            <Button size="sm" variant="quiet" iconStart={OpenGlyph} onClick={() => onOpen(final.delivered ?? final.output!)}>{t.openFile}</Button>
            <Button size="sm" variant="ghost" iconStart={ExportGlyph} onClick={() => saveFile(mediaUrl(final.output!, final.finishedAt), final.delivered ?? final.output!)}>{t.download}</Button>
          </div>
        )}
      </article>

      {running && (
        <article className="cs-job-live">
          <img src={mediaUrl(studioPaths(state.id).liveFrame, Math.floor(running.heartbeatAt / 1500))} alt={t.liveFrame} data-aspect={state.format.aspect} />
          <div className="cs-job-live-text">
            <strong>{label(t, `render_${running.kind}`)} · {Math.round(running.progress * 100)}%</strong>
            <span>{fill(t.frames, { done: running.framesDone, total: running.framesTotal })}{now - running.heartbeatAt > STALE_MS ? ` · ${t.stalled}` : ""}</span>
            <span className="cs-progress" aria-hidden="true"><span style={{ inlineSize: `${Math.round(running.progress * 100)}%` }} /></span>
          </div>
          <Button size="sm" variant="danger" onClick={onCancel}>{t.stopRender}</Button>
        </article>
      )}

      <div className="cs-render-actions">
        <Button size="sm" variant="quiet" disabled={!hasScenes || busy} onClick={() => onRender("stills")}>{t.renderStills}</Button>
        <Button size="sm" variant="quiet" disabled={!hasScenes || Boolean(running) || busy} onClick={() => onRender("preview")}>{t.renderPreview}</Button>
        <Button size="sm" variant={final && finalCurrent ? "quiet" : "primary"} disabled={!hasScenes || Boolean(running) || busy} onClick={() => onRender("final")}>{t.renderFinal}</Button>
      </div>
      <p className="cs-hint">{t.exportIntro}</p>

      <section className="cs-block">
        <h3 className="cs-label">{t.renders}</h3>
        {state.renders.length === 0 ? <p className="cs-hint">{t.rendersEmpty}</p> : (
          <ol className="cs-jobs">
            {state.renders.slice(-8).toReversed().map((job) => (
              <li key={job.id} className="cs-job" data-status={job.status}>
                <span className="cs-dot" data-tone={job.status} aria-hidden="true" />
                <span className="cs-job-text">
                  <strong>{label(t, `render_${job.kind}`)}</strong>
                  <span>{label(t, `renderStatus_${job.status}`)} · {job.width}×{job.height} · {relative(job.finishedAt ?? job.startedAt, now)}{job.status === "done" && job.kind !== "stills" && !renderIsCurrent(state, job) ? ` · ${t.outdated}` : ""}</span>
                  {job.error && <span className="cs-error">{job.error}</span>}
                </span>
                {job.status === "done" && job.output && job.kind !== "stills" && (
                  <Button size="sm" variant="ghost" onClick={() => onWatch(job)}>{t.watch}</Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Same-origin download of a studio media file under its own name. */
function saveFile(url: string, path: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop() ?? "video.mp4";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// ----------------------------------------------------------------- review

export function ReviewView({ host, t, state, mediaUrl, onDismiss, onAskFix, onSeek }: {
  host: WebPackageHost; t: StudioStrings; state: StudioState;
  mediaUrl(path: string, version?: string | number): string;
  onDismiss(finding: QaFinding): void; onAskFix(finding: QaFinding): void; onSeek(time: number): void;
}) {
  const { Button } = host.ui.components;
  const open = openFindings(state);
  const sheetVersion = Math.max(0, ...state.scenes.map((scene) => scene.stillRevision ?? 0), state.updatedAt % 100000);
  const hasSheet = state.scenes.some((scene) => scene.stillRevision);
  const rounds = EFFORT_PROFILES[state.effort].qaRounds;
  return (
    <div className="cs-view cs-review">
      {rounds > 0 && <p className="cs-hint">{fill(t.qaRounds, { done: Math.min(state.qaRounds, rounds), total: rounds })}</p>}
      <section className="cs-block">
        <h3 className="cs-label">{t.findings}</h3>
        {open.length === 0 ? <p className="cs-empty-note">{t.findingsEmpty}</p> : (
          <ul className="cs-findings">
            {open.map((finding) => {
              const scene = state.scenes.find((candidate) => candidate.id === finding.sceneId);
              const at = finding.time ?? scene?.start;
              return (
                <li key={finding.id} data-severity={finding.severity}>
                  <span className="cs-dot" data-tone={finding.severity} aria-hidden="true" />
                  <div className="cs-finding-text">
                    <p dir="auto">{finding.message}</p>
                    {(scene || at !== undefined) && (
                      <button type="button" className="cs-finding-where" onClick={() => at !== undefined && onSeek(at)}>
                        {[scene?.title, at !== undefined ? clockTime(at) : null].filter(Boolean).join(" · ")}
                      </button>
                    )}
                  </div>
                  <div className="cs-row cs-finding-actions">
                    <Button size="sm" variant="quiet" onClick={() => onAskFix(finding)}>{t.askFix}</Button>
                    <Button size="sm" variant="ghost" onClick={() => onDismiss(finding)}>{t.dismiss}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {hasSheet && (
        <figure className="cs-sheet">
          <img src={mediaUrl(studioPaths(state.id).contactSheet, sheetVersion)} alt={t.contactSheet} loading="lazy" decoding="async" />
          <figcaption className="cs-hint">{t.contactSheet}</figcaption>
        </figure>
      )}
    </div>
  );
}

// --------------------------------------------------------------- progress

export function ProgressView({ t, state, now, notes, tokens, cost, focus }: {
  t: StudioStrings; state: StudioState; now: number; notes: readonly AgentNote[];
  tokens?: number; cost?: number; focus: StageId;
}) {
  const estimate = estimateCost({ effort: state.effort, durationSec: effectiveDuration(state), ...(state.scenes.length ? { scenes: state.scenes.length } : {}) });
  const entries = state.activity.slice(-40).toReversed();
  return (
    <div className="cs-view cs-progress-view">
      <ol className="cs-stages">
        {STAGE_IDS.map((stage) => {
          const status = state.stages[stage];
          const open = stage === focus;
          const progress = stageProgress(state, stage);
          return (
            <li key={stage} data-status={status.status} data-focus={open || undefined}>
              <span className="cs-stage-mark" aria-hidden="true">{status.status === "done" ? <CheckGlyph /> : null}</span>
              <div className="cs-stage-text">
                <span className="cs-stage-name"><strong>{label(t, `stage_${stage}`)}</strong><span>{label(t, `status_${status.status}`)}{status.status === "active" && progress.total > 1 ? ` · ${progress.done}/${progress.total}` : ""}</span></span>
                {status.note && <p className="cs-stage-note" dir="auto">{status.note}</p>}
                {open && (
                  <ul className="cs-criteria" aria-label={t.criteria}>
                    {stageCriteria(state, stage).map((criterion) => (
                      <li key={criterion.id} data-met={criterion.met || undefined}>
                        <span aria-hidden="true">{criterion.met ? <CheckGlyph /> : null}</span>
                        <span>{label(t, `criterion_${criterion.id}`)}{criterion.detail ? <small> — {criterion.detail}</small> : null}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {notes.length > 0 && (
        <section className="cs-block">
          <h3 className="cs-label">{t.agentNotes}</h3>
          <ol className="cs-notes-list">
            {notes.map((note) => (
              <li key={note.id}>
                <p dir="auto">{note.text}</p>
                <time className="cs-time" dateTime={new Date(note.time).toISOString()}>{relative(note.time, now)}</time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="cs-block">
        <h3 className="cs-label">{t.activity}</h3>
        {entries.length === 0 ? <p className="cs-hint">{t.activityEmpty}</p> : (
          <ol className="cs-activity">
            {entries.map((entry, index) => (
              <li key={`${entry.at}-${index}`} data-role={entry.role}>
                <span className="cs-activity-role">{label(t, `role_${entry.role}`)}</span>
                <span className="cs-activity-text" dir="auto">{entry.message}</span>
                <time className="cs-time" dateTime={new Date(entry.at).toISOString()}>{relative(entry.at, now)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="cs-block cs-estimate">
        <h3 className="cs-label">{t.estimate}</h3>
        <p>{fill(t.estimateLine, { scenes: estimate.scenes, tokens: `${compact(estimate.tokens[0])}–${compact(estimate.tokens[1])}`, minutes: `${estimate.minutes[0]}–${estimate.minutes[1]}` })}</p>
        {(tokens !== undefined || (cost !== undefined && cost > 0)) && (
          <p><span className="cs-hint">{t.measured}: </span>{tokens !== undefined ? fill(t.measuredTokens, { count: compact(tokens) }) : ""}{cost !== undefined && cost > 0 ? ` · $${cost.toFixed(2)}` : ""}</p>
        )}
        <p className="cs-hint">{t.estimateNote}</p>
      </section>
    </div>
  );
}
