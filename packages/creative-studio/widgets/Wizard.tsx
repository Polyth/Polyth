import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { WebInputProps, WebPackageHost, WebUiComponent } from "@polyth/web-sdk";
import {
  applyPreset,
  buildBrief,
  defaultSpec,
  MOOD_IDS,
  USER_LEVELS,
  type MediaRules,
  type MediaSpec,
  type MoodId,
  type UserLevel,
} from "../src/brief.ts";
import {
  ASPECT_IDS,
  DELIVERY_FPS,
  DELIVERY_HEIGHTS,
  EFFORT_IDS,
  estimateCost,
  fmtTime,
  frameSize,
  MEDIA_KINDS,
  studioModelLabel,
  studioPaths,
  VISUAL_DIMENSIONS,
  type MediaKind,
  type StudioModels,
} from "../src/index.ts";
import { BackGlyph, CheckGlyph, ClapperGlyph, CloseGlyph, MusicGlyph, PauseGlyph, PlayGlyph, SparkGlyph } from "./glyphs.tsx";
import ModelSettings from "./ModelSettings.tsx";
import { compact, fill } from "./strings.ts";
import { clockTime } from "./studioModel.ts";
import { IDEA_SEEDS, isAudioFile, isLyricsFile, readLevel, stepBlocker, stepsFor, writeLevel, type WizardStep } from "./wizardModel.ts";
import { wizardStrings, wl, type WizardStrings } from "./wizardStrings.ts";
import { studioStrings } from "./strings.ts";

export interface WizardResult {
  spec: MediaSpec;
  song: File | null;
  lyricsFile: File | null;
  lyricsText: string;
  /** Expert-edited brief, sent as written. Null = generate after upload. */
  brief: string | null;
}

interface Props {
  host: WebPackageHost;
  sessionId: string | null;
  busy: boolean;
  error: string;
  onStart(result: WizardResult): void;
}

/** Review summary line for the model step: session route and any per-part overrides. */
function modelsSummary(models: StudioModels, level: UserLevel): string {
  const session = models.default ? studioModelLabel(models.default) : "Auto";
  if (level !== "expert") return session;
  const overrides = Object.values(models.roles ?? {}).filter(Boolean).length;
  return overrides ? `${session} · ${overrides} per-part` : session;
}

/** Mirror of the upload route's file-name sanitizer, for the brief preview. */
export const uploadName = (name: string) => name.split(/[\\/]/).pop()!.replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80);

const RULE_KEYS = Object.keys(defaultSpec().rules) as Array<keyof MediaRules>;
const AUDIO_ACCEPT = "audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus";
const clampLength = (seconds: number) => Math.max(5, Math.min(600, Math.round(seconds)));

type FieldInput = WebUiComponent<WebInputProps & { id?: string; invalid?: boolean; spellCheck?: boolean }>;

/** The new-video flow: one question per screen on a phone, a live poster
 * beside it on a wide window, one primary action at the bottom. */
export default function Wizard({ host, sessionId, busy, error, onStart }: Props) {
  const { Button, Checkbox, IconButton, Textarea } = host.ui.components;
  const TextInput = host.ui.components.TextInput as FieldInput;
  const t = wizardStrings(host.ui.locale.get());
  const id = useId();
  const [level, setLevelState] = useState<UserLevel>(() => readLevel());
  const [spec, setSpec] = useState<MediaSpec>(() => defaultSpec());
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [song, setSong] = useState<File | null>(null);
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  const [lyricsText, setLyricsText] = useState("");
  const [briefOverride, setBriefOverride] = useState<string | null>(null);
  const [models, setModels] = useState<StudioModels>({});
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const songInput = useRef<HTMLInputElement>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const preview = useSongPreview(song);

  const steps = stepsFor(level);
  const step: WizardStep = steps[Math.min(stepIndex, steps.length - 1)]!;
  const last = stepIndex >= steps.length - 1;
  const blocker = stepBlocker(step, spec);
  const set = (patch: Partial<MediaSpec>) => setSpec((current) => ({ ...current, ...patch }));
  const setLevel = (next: UserLevel, goTo?: WizardStep) => {
    setLevelState(next);
    writeLevel(next);
    const nextSteps = stepsFor(next);
    setDirection("forward");
    setStepIndex(goTo ? Math.max(0, nextSteps.indexOf(goTo)) : 0);
  };

  // "Whole song": estimate with the real length once the browser reads it.
  useEffect(() => {
    if (preview.duration > 0 && spec.durationMode === "song") set({ durationSec: clampLength(preview.duration) });
  }, [preview.duration, spec.durationMode]);
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [stepIndex, level]);

  const previewSpec = useMemo<MediaSpec>(() => ({
    ...spec,
    ...(song && sessionId ? { audioPath: `${studioPaths(sessionId).audioDir}/${uploadName(song.name)}` } : {}),
    ...(sessionId && (lyricsFile || lyricsText.trim())
      ? { lyricsPath: `${studioPaths(sessionId).audioDir}/${lyricsFile ? uploadName(lyricsFile.name) : "lyrics.txt"}` }
      : {}),
  }), [spec, song, lyricsFile, lyricsText, sessionId]);
  const generated = useMemo(() => buildBrief(previewSpec, sessionId
    ? { studioId: sessionId }
    : { uploading: { song: Boolean(song), lyrics: Boolean(lyricsFile || lyricsText.trim()) } }), [previewSpec, sessionId, song, lyricsFile, lyricsText]);
  const estimate = estimateCost({ effort: spec.effort, durationSec: spec.durationSec });

  const next = () => {
    setTouched(true);
    if (blocker) return;
    setTouched(false);
    if (!last) { setDirection("forward"); setStepIndex(stepIndex + 1); return; }
    onStart({ spec: { ...spec, models }, song, lyricsFile, lyricsText, brief: level === "expert" ? briefOverride : null });
  };
  const back = () => { setDirection("back"); setStepIndex(Math.max(0, stepIndex - 1)); };
  const goTo = (target: WizardStep) => {
    const index = steps.indexOf(target);
    if (index < 0 || index === stepIndex) return;
    // Forward jumps only past complete steps.
    for (let i = stepIndex; i < index; i++) if (stepBlocker(steps[i]!, spec)) return;
    setDirection(index > stepIndex ? "forward" : "back");
    setStepIndex(index);
  };
  const chooseSong = (file: File | undefined) => {
    if (file && isAudioFile(file)) setSong(file);
  };

  // ------------------------------------------------------------ sections

  const kindPicker = (
    <fieldset className="cs-field">
      {/* The step heading already asks the question. */}
      <legend className="cs-sr-only">{t.kindHeading}</legend>
      <div className="cs-kinds" role="radiogroup" aria-label={t.kindHeading} data-level={level}>
        {MEDIA_KINDS.map((kind) => (
          <label key={kind} className="cs-kind" data-selected={spec.kind === kind || undefined}>
            <input type="radio" name={`${id}-kind`} checked={spec.kind === kind} onChange={() => setSpec((current) => applyPreset(current, kind))} />
            <KindArt kind={kind} />
            <span className="cs-kind-text">
              <strong>{wl(t, `kind_${kind}`)}</strong>
              <span>{wl(t, `kind_${kind}_hint`)}</span>
            </span>
            <span className="cs-kind-check" aria-hidden="true"><CheckGlyph /></span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  const ideaField = (
    <div className="cs-field">
      <label className="cs-field-label" htmlFor={`${id}-idea`}>{t.ideaLabel}</label>
      <Textarea
        id={`${id}-idea`}
        dir="auto"
        className="cs-hero-input"
        autoGrow
        minRows={3}
        maxRows={8}
        value={spec.idea}
        placeholder={t.ideaPlaceholder}
        invalid={touched && blocker === "idea"}
        aria-describedby={`${id}-idea-hint`}
        onChange={(event: { target: { value: string } }) => set({ idea: event.target.value })}
      />
      <p id={`${id}-idea-hint`} className={touched && blocker === "idea" ? "cs-field-error" : "cs-field-hint"}>
        {touched && blocker === "idea" ? t.ideaTooShort : t.ideaHint}
      </p>
      <div className="cs-seeds">
        <span className="cs-seeds-label"><SparkGlyph className="cs-inline-glyph" />{t.inspire}</span>
        <div className="cs-seed-row">
          {IDEA_SEEDS[spec.kind].map((key) => (
            <button key={key} type="button" className="cs-seed" onClick={() => set({ idea: wl(t, key) })}>{wl(t, key)}</button>
          ))}
        </div>
      </div>
    </div>
  );

  const songCard = (
    <div className="cs-field">
      {/* Guided and Expert show the song on its own step under the same heading. */}
      <span className={level === "quick" ? "cs-field-label" : "cs-sr-only"} id={`${id}-song`}>{t.songHeading}</span>
      <div
        className="cs-songcard"
        data-filled={song ? true : undefined}
        data-dragging={dragging || undefined}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); chooseSong([...event.dataTransfer.files].find(isAudioFile)); }}
      >
        {song ? (
          <>
            <IconButton
              className="cs-songcard-play"
              icon={preview.playing ? PauseGlyph : PlayGlyph}
              label={preview.playing ? t.songPause : t.songPlay}
              variant="quiet"
              size="lg"
              disabled={!preview.url}
              onClick={preview.toggle}
            />
            <span className="cs-songcard-text">
              <strong>{song.name}</strong>
              <span>{[preview.duration ? clockTime(preview.duration) : null, `${(song.size / 1024 / 1024).toFixed(1)} MB`].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="cs-songcard-actions">
              <Button size="sm" variant="ghost" onClick={() => songInput.current?.click()}>{t.songReplace}</Button>
              <IconButton icon={CloseGlyph} label={t.songRemove} size="sm" variant="ghost" onClick={() => setSong(null)} />
            </span>
          </>
        ) : (
          <button type="button" className="cs-songcard-pick" aria-describedby={`${id}-song-hint`} onClick={() => songInput.current?.click()}>
            <span className="cs-songcard-art" aria-hidden="true"><MusicGlyph /></span>
            <span className="cs-songcard-text">
              <strong>{t.songDrop}</strong>
              <span>{t.songDropHint}</span>
            </span>
          </button>
        )}
        <input ref={songInput} hidden type="file" accept={AUDIO_ACCEPT} onChange={(event) => { chooseSong(event.target.files?.[0]); event.target.value = ""; }} />
        {preview.url && <audio ref={preview.audio} src={preview.url} preload="metadata" onLoadedMetadata={preview.onMetadata} onPlay={() => preview.setPlaying(true)} onPause={() => preview.setPlaying(false)} onEnded={() => preview.setPlaying(false)} />}
      </div>
      <p id={`${id}-song-hint`} className="cs-field-hint">{song ? t.songHint : t.songLater}</p>
    </div>
  );

  const lyricsField = (
    <div className="cs-field">
      <label className="cs-field-label" htmlFor={`${id}-lyrics`}>{t.lyricsLabel} <span className="cs-optional">{t.lyricsOptional}</span></label>
      <Textarea
        id={`${id}-lyrics`}
        dir="auto"
        autoGrow
        minRows={3}
        maxRows={10}
        value={lyricsText}
        aria-describedby={`${id}-lyrics-hint`}
        onChange={(event: { target: { value: string } }) => setLyricsText(event.target.value)}
      />
      <div className="cs-row cs-row--split">
        <p id={`${id}-lyrics-hint`} className="cs-field-hint">{lyricsFile ? lyricsFile.name : t.lyricsHint}</p>
        <Button size="sm" variant="ghost" onClick={() => lyricsInput.current?.click()}>{t.lyricsPick}</Button>
        <input ref={lyricsInput} hidden type="file" accept=".lrc,.txt,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file && isLyricsFile(file)) setLyricsFile(file); event.target.value = ""; }} />
      </div>
      <Checkbox checked={spec.lyricsOverlay} onChange={(value: boolean) => set({ lyricsOverlay: value })} label={t.lyricsOverlay} />
    </div>
  );

  const songStep = (
    <>
      {songCard}
      {lyricsField}
      {level === "expert" && (
        <div className="cs-grid2">
          <PathField TextInput={TextInput} label={t.notesLabel} hint={t.notesHint} value={spec.songNotesPath ?? ""} placeholder="song/README.md" onChange={(value) => set({ songNotesPath: value.trim() || undefined })} />
          <PathField TextInput={TextInput} label={t.toolsLabel} hint={t.toolsHint} value={spec.toolsNotesPath ?? ""} placeholder="tools/README.md" onChange={(value) => set({ toolsNotesPath: value.trim() || undefined })} />
        </div>
      )}
    </>
  );

  const styleStep = (
    <>
      <Segmented label={t.dimensionLabel} value={spec.dimension} options={VISUAL_DIMENSIONS.map((value) => ({ value, label: wl(t, `dimension_${value}`) }))} onChange={(dimension) => set({ dimension })} />
      <fieldset className="cs-field">
        <legend className="cs-field-label">{t.moodsLabel} <span className="cs-optional">{t.moodsHint}</span></legend>
        <div className="cs-chips">
          {MOOD_IDS.map((mood) => {
            const on = spec.moods.includes(mood);
            return (
              <button
                key={mood}
                type="button"
                className="cs-chip-toggle"
                aria-pressed={on}
                onClick={() => set({ moods: on ? spec.moods.filter((item) => item !== mood) : [...spec.moods, mood].slice(-3) as MoodId[] })}
              >
                {on && <CheckGlyph className="cs-inline-glyph" />}{wl(t, `mood_${mood}`)}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="cs-field">
        <label className="cs-field-label" htmlFor={`${id}-style`}>{t.styleNotesLabel}</label>
        <Textarea id={`${id}-style`} dir="auto" autoGrow minRows={3} maxRows={8} value={spec.styleNotes} placeholder={t.styleNotesPlaceholder} onChange={(event: { target: { value: string } }) => set({ styleNotes: event.target.value })} />
      </div>
    </>
  );

  const formatStep = (
    <>
      <fieldset className="cs-field">
        <legend className="cs-field-label">{t.aspectLabel}</legend>
        <div className="cs-aspects" role="radiogroup" aria-label={t.aspectLabel}>
          {ASPECT_IDS.map((aspect) => (
            <label key={aspect} className="cs-aspect" data-selected={spec.aspect === aspect || undefined}>
              <input type="radio" name={`${id}-aspect`} checked={spec.aspect === aspect} onChange={() => set({ aspect })} />
              <span className="cs-ratio" data-aspect={aspect} aria-hidden="true" />
              <strong>{wl(t, `aspect_${aspect.replace(":", "_")}`)}</strong>
              <span>{aspect}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="cs-field">
        <legend className="cs-field-label">{t.durationLabel}</legend>
        <div className="cs-chips">
          <button type="button" className="cs-chip-toggle" aria-pressed={spec.durationMode === "song"} onClick={() => set({ durationMode: "song", ...(preview.duration ? { durationSec: clampLength(preview.duration) } : {}) })}>{t.durationSong}</button>
          {[15, 30, 60].map((seconds) => (
            <button key={seconds} type="button" className="cs-chip-toggle" aria-pressed={spec.durationMode === "custom" && spec.durationSec === seconds} onClick={() => set({ durationMode: "custom", durationSec: seconds })}>
              {clockTime(seconds)}
            </button>
          ))}
          <label className="cs-number">
            <input
              type="number"
              min={5}
              max={600}
              inputMode="numeric"
              value={spec.durationMode === "custom" ? spec.durationSec : ""}
              placeholder={t.durationCustom}
              aria-label={`${t.durationCustom}, ${t.seconds}`}
              aria-invalid={blocker === "duration" ? true : undefined}
              onChange={(event) => set({ durationMode: "custom", durationSec: Number(event.target.value) })}
            />
            <span>{t.seconds}</span>
          </label>
        </div>
        {blocker === "duration" && <p className="cs-field-error">{t.durationInvalid}</p>}
      </fieldset>
      <ChoiceCards
        label={t.effortLabel}
        name={`${id}-effort`}
        value={spec.effort}
        options={EFFORT_IDS.map((value) => {
          const cost = estimateCost({ effort: value, durationSec: spec.durationSec });
          return { value, title: wl(t, `effort_${value}`), hint: wl(t, `effort_${value}_hint`), meta: fill(t.estimateShort, { scenes: cost.scenes, minutes: `${cost.minutes[0]}–${cost.minutes[1]}` }) };
        })}
        onChange={(effort) => set({ effort })}
      />
      <ChoiceCards
        label={t.autonomyLabel}
        name={`${id}-autonomy`}
        value={spec.autonomy}
        options={(["checkpoints", "autonomous"] as const).map((value) => ({ value, title: wl(t, `autonomy_${value}`), hint: wl(t, `autonomy_${value}_hint`) }))}
        onChange={(autonomy) => set({ autonomy })}
      />
      <ModelSettings projectId={sessionId} expert={false} value={models} onChange={setModels} strings={studioStrings(host.ui.locale.get())} />
    </>
  );

  const modelsStep = (
    <ModelSettings
      projectId={sessionId}
      expert
      value={models}
      onChange={setModels}
      strings={studioStrings(host.ui.locale.get())}
      expertIntro={<div className="cs-field"><span className="cs-field-label">{t.modelsExpertHeading}</span><p className="cs-field-hint">{t.modelsExpertSub}</p></div>}
    />
  );

  const deliveryStep = (
    <>
      <div className="cs-grid2">
        <Segmented label={t.resolutionLabel} value={String(spec.height)} options={DELIVERY_HEIGHTS.map((value) => ({ value: String(value), label: value === 2160 ? "4K" : `${value}p` }))} onChange={(value) => set({ height: Number(value) })} />
        <Segmented label={t.fpsLabel} value={String(spec.fps)} options={DELIVERY_FPS.map((value) => ({ value: String(value), label: `${value}` }))} onChange={(value) => set({ fps: Number(value) })} />
      </div>
      <div className="cs-grid2">
        <PathField TextInput={TextInput} label={t.outputLabel} value={spec.outputPath} invalid={blocker === "path" && !/\.mp4$/i.test(spec.outputPath)} onChange={(value) => set({ outputPath: value })} />
        <div className="cs-field">
          <Checkbox checked={spec.report} onChange={(value: boolean) => set({ report: value })} label={t.reportLabel} />
          {spec.report && <PathField TextInput={TextInput} label={t.reportPathLabel} value={spec.reportPath} onChange={(value) => set({ reportPath: value })} />}
        </div>
      </div>
      {blocker === "path" && <p className="cs-field-error">{t.pathInvalid}</p>}
      <fieldset className="cs-field">
        <legend className="cs-field-label">{t.rulesLabel}</legend>
        <div className="cs-rules">
          {RULE_KEYS.map((key) => (
            <Checkbox key={key} checked={spec.rules[key]} label={wl(t, `rule_${key}`)} onChange={(value: boolean) => set({ rules: { ...spec.rules, [key]: value } })} />
          ))}
        </div>
      </fieldset>
      <div className="cs-field">
        <label className="cs-field-label" htmlFor={`${id}-extra`}>{t.extraLabel}</label>
        <Textarea id={`${id}-extra`} dir="auto" autoGrow minRows={3} maxRows={10} value={spec.extraInstructions} placeholder={t.extraPlaceholder} onChange={(event: { target: { value: string } }) => set({ extraInstructions: event.target.value })} />
      </div>
    </>
  );

  const size = frameSize(spec.aspect, spec.height);
  const summaryRows: Array<{ step: WizardStep; label: string; value: ReactNode }> = [
    { step: "kind", label: t.summaryKind, value: <>{wl(t, `kind_${spec.kind}`)}<small>{spec.idea.trim() || "—"}</small></> },
    { step: "song", label: t.summarySong, value: song ? song.name : t.noSong },
    { step: "style", label: t.summaryStyle, value: [wl(t, `dimension_${spec.dimension}`), ...spec.moods.map((mood) => wl(t, `mood_${mood}`))].join(" · ") },
    { step: "format", label: t.summaryFormat, value: [spec.aspect, spec.durationMode === "song" ? t.wholeSong : fmtTime(spec.durationSec), wl(t, `effort_${spec.effort}`), spec.autonomy === "autonomous" ? t.autonomous : t.approval].join(" · ") },
    { step: "models", label: t.summaryModels, value: modelsSummary(models, level) },
    { step: "delivery", label: t.summaryDelivery, value: <code>{`${spec.outputPath} · ${size.width}×${size.height} · ${spec.fps} fps`}</code> },
  ];

  const poster = (
    <Poster t={t} spec={spec} level={level} size={size} estimate={estimate} />
  );

  const reviewStep = (
    <>
      <div className="cs-review-poster">{poster}</div>
      <dl className="cs-summary">
        {summaryRows.filter((row) => steps.includes(row.step)).map((row) => (
          <div key={row.step}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
            <Button size="sm" variant="ghost" onClick={() => goTo(row.step)}>{t.edit}</Button>
          </div>
        ))}
      </dl>
      {level === "expert" ? (
        <div className="cs-field">
          <div className="cs-row cs-row--split">
            <label className="cs-field-label" htmlFor={`${id}-brief`}>{t.briefLabel}</label>
            {briefOverride !== null && <span className="cs-badge" data-tone="warn">{t.briefEdited}</span>}
            {briefOverride !== null && <Button size="sm" variant="ghost" onClick={() => setBriefOverride(null)}>{t.briefReset}</Button>}
          </div>
          <Textarea id={`${id}-brief`} className="cs-brief" rows={16} value={briefOverride ?? generated} onChange={(event: { target: { value: string } }) => setBriefOverride(event.target.value)} spellCheck={false} />
          <p className="cs-field-hint">{t.briefHint}</p>
        </div>
      ) : (
        <details className="cs-details">
          <summary>{t.briefShow}</summary>
          <pre className="cs-brief">{generated}</pre>
        </details>
      )}
    </>
  );

  const quickDefaults = (
    <div className="cs-defaults">
      <span className="cs-field-hint">{t.defaultsLabel}</span>
      {([
        ["format", `${spec.aspect} · ${spec.durationMode === "song" ? t.wholeSong : fmtTime(spec.durationSec)}`],
        ["style", wl(t, `dimension_${spec.dimension}`)],
        ["format", wl(t, `effort_${spec.effort}`)],
        ["format", spec.autonomy === "autonomous" ? t.autonomous : t.approval],
      ] as Array<[WizardStep, string]>).map(([target, text], index) => (
        <button key={index} type="button" className="cs-chip-toggle cs-chip-toggle--quiet" onClick={() => setLevel("guided", target)}>{text}</button>
      ))}
    </div>
  );

  const content: Record<WizardStep, ReactNode> = {
    kind: level === "quick" ? <>{kindPicker}{ideaField}{songCard}{quickDefaults}</> : <>{kindPicker}{ideaField}</>,
    song: songStep,
    style: styleStep,
    format: formatStep,
    models: modelsStep,
    delivery: deliveryStep,
    review: reviewStep,
  };
  const heading: Record<WizardStep, [string, string]> = {
    kind: [t.kindHeading, t.kindSub],
    song: [t.songHeading, t.songSub],
    style: [t.styleHeading, t.styleSub],
    format: [t.formatHeading, t.formatSub],
    models: [t.modelsHeading, t.modelsSub],
    delivery: [t.deliveryHeading, t.deliverySub],
    review: [t.reviewHeading, t.reviewSub],
  };

  return (
    <form className="cs-create" onSubmit={(event) => { event.preventDefault(); if (!busy) next(); }} noValidate>
      <div className="cs-create-scroll" ref={scroller}>
        <header className="cs-create-top">
          <span className="cs-eyebrow"><ClapperGlyph className="cs-inline-glyph" />{t.eyebrow}</span>
          <div className="cs-levels" role="radiogroup" aria-label={t.levelLabel}>
            {USER_LEVELS.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={level === value} className="cs-level" title={wl(t, `level_${value}_hint`)} onClick={() => setLevel(value)}>
                {wl(t, `level_${value}`)}
              </button>
            ))}
          </div>
        </header>
        {steps.length > 1 && (
          <ol className="cs-steps" aria-label={t.stepsLabel}>
            {steps.map((item, index) => (
              <li key={item} data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : "next"}>
                <button type="button" onClick={() => goTo(item)} aria-current={index === stepIndex ? "step" : undefined}>
                  <span className="cs-step-bar" aria-hidden="true" />
                  <span className="cs-step-label">{wl(t, `step_${item}`)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="cs-create-layout">
          <section key={`${level}-${step}`} className="cs-create-step" data-dir={direction} aria-labelledby={`${id}-heading`}>
            <div className="cs-create-heading">
              <h2 id={`${id}-heading`}>{level === "quick" ? t.kindHeading : heading[step][0]}</h2>
              <p>{level === "quick" ? wl(t, "level_quick_hint") : heading[step][1]}</p>
            </div>
            {content[step]}
          </section>
          {step !== "review" && <aside className="cs-create-aside" aria-label={t.summaryKind}>{poster}</aside>}
        </div>
      </div>
      <footer className="cs-create-foot">
        {error && <p className="cs-field-error cs-create-error" role="alert">{error}</p>}
        <div className="cs-create-actions">
          {stepIndex > 0 ? <Button variant="ghost" iconStart={BackGlyph} onClick={back}>{t.back}</Button> : <span className="cs-create-estimate">{fill(t.estimateShort, { scenes: estimate.scenes, minutes: `${estimate.minutes[0]}–${estimate.minutes[1]}` })}</span>}
          {steps.length > 1 && <span className="cs-create-count">{fill(t.stepOf, { n: stepIndex + 1, total: steps.length })}</span>}
          <Button type="submit" variant="primary" size="lg" busy={busy} disabled={busy || (touched && Boolean(blocker))} iconStart={last ? ClapperGlyph : undefined}>
            {last ? (busy ? t.starting : t.start) : t.next}
          </Button>
        </div>
      </footer>
    </form>
  );
}

// ------------------------------------------------------------- primitives

function useSongPreview(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    setDuration(0);
    setPlaying(false);
    let objectUrl: string | null = null;
    try { objectUrl = file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null; } catch { objectUrl = null; }
    setUrl(objectUrl);
    if (!objectUrl) return;
    return () => {
      audio.current?.pause();
      URL.revokeObjectURL(objectUrl!);
    };
  }, [file]);
  return {
    url,
    duration,
    playing,
    audio,
    setPlaying,
    onMetadata: () => { const value = audio.current?.duration ?? 0; if (Number.isFinite(value) && value > 0) setDuration(value); },
    toggle: () => {
      const element = audio.current;
      if (!element) return;
      if (element.paused) void element.play().catch(() => setPlaying(false));
      else element.pause();
    },
  };
}

function Poster({ t, spec, level, size, estimate }: { t: WizardStrings; spec: MediaSpec; level: UserLevel; size: { width: number; height: number }; estimate: ReturnType<typeof estimateCost> }) {
  return (
    <div className="cs-poster" data-kind={spec.kind} data-aspect={spec.aspect}>
      <div className="cs-poster-art"><KindArt kind={spec.kind} /></div>
      <div className="cs-poster-body">
        <span className="cs-poster-kind">{wl(t, `kind_${spec.kind}`)}</span>
        <strong className="cs-poster-title" dir="auto">{spec.idea.trim() || t.posterUntitled}</strong>
        <ul className="cs-tags">
          <li>{spec.aspect}</li>
          <li>{spec.durationMode === "song" ? t.wholeSong : fmtTime(spec.durationSec)}</li>
          <li>{level === "expert" ? `${size.height}p · ${spec.fps}` : wl(t, `dimension_${spec.dimension}`)}</li>
          <li>{wl(t, `effort_${spec.effort}`)}</li>
        </ul>
        <div className="cs-poster-estimate">
          <span>{t.estimate}</span>
          <strong>{fill(t.estimateLine, { scenes: estimate.scenes, tokens: `${compact(estimate.tokens[0])}–${compact(estimate.tokens[1])}`, minutes: `${estimate.minutes[0]}–${estimate.minutes[1]}` })}</strong>
          <small>{spec.durationMode === "song" ? fill(t.estimateSong, { length: fmtTime(spec.durationSec) }) : t.estimateNote}</small>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void }) {
  return (
    <fieldset className="cs-field">
      <legend className="cs-field-label">{label}</legend>
      <div className="cs-seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </div>
    </fieldset>
  );
}

function ChoiceCards<T extends string>({ label, name, value, options, onChange }: { label: string; name: string; value: T; options: Array<{ value: T; title: string; hint: string; meta?: string }>; onChange(value: T): void }) {
  return (
    <fieldset className="cs-field">
      <legend className="cs-field-label">{label}</legend>
      <div className="cs-choices" data-count={options.length}>
        {options.map((option) => (
          <label key={option.value} className="cs-choice" data-selected={value === option.value || undefined}>
            <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
            <strong>{option.title}</strong>
            <span>{option.hint}</span>
            {option.meta && <small>{option.meta}</small>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PathField({ TextInput, label, hint, value, placeholder, invalid, onChange }: { TextInput: FieldInput; label: string; hint?: string; value: string; placeholder?: string; invalid?: boolean; onChange(value: string): void }) {  const id = useId();
  return (
    <div className="cs-field">
      <label className="cs-field-label" htmlFor={id}>{label}</label>
      <TextInput id={id} className="cs-mono" value={value} placeholder={placeholder} invalid={invalid} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="cs-field-hint">{hint}</p>}
    </div>
  );
}

/** Abstract illustration per media kind; colours come from tokens via CSS. */
export function KindArt({ kind }: { kind: MediaKind }) {
  return (
    <svg className="cs-art" data-kind={kind} viewBox="0 0 120 72" aria-hidden="true">
      <rect className="cs-art-bg" width="120" height="72" rx="10" />
      {kind === "story" && (
        <>
          <circle className="cs-art-b" cx="88" cy="20" r="9" />
          <path className="cs-art-a" d="M0 56 L18 40 L30 48 L46 30 L64 50 L80 38 L120 58 L120 72 L0 72 Z" />
          <rect className="cs-art-c" x="30" y="44" width="3" height="16" rx="1.5" />
          <circle className="cs-art-c" cx="31.5" cy="41" r="3" />
        </>
      )}
      {kind === "dance" && (
        <>
          {[24, 48, 72, 96].map((x, index) => (
            <g key={x} transform={`translate(${x} ${index % 2 ? 30 : 36})`}>
              <circle className="cs-art-b" cx="0" cy="0" r="4" />
              <path className="cs-art-line" d={index % 2 ? "M0 4 L0 18 M0 8 L-7 2 M0 8 L7 14 M0 18 L-5 28 M0 18 L6 26" : "M0 4 L0 18 M0 8 L-7 14 M0 8 L7 2 M0 18 L-6 26 M0 18 L5 28"} />
            </g>
          ))}
          <path className="cs-art-arc" d="M10 64 Q60 40 110 64" />
        </>
      )}
      {kind === "lyric" && (
        <>
          <rect className="cs-art-a" x="16" y="20" width="62" height="9" rx="4.5" />
          <rect className="cs-art-b" x="16" y="34" width="88" height="11" rx="5.5" />
          <rect className="cs-art-c" x="16" y="50" width="40" height="7" rx="3.5" />
        </>
      )}
      {kind === "visualizer" && (
        <>
          <circle className="cs-art-ring" cx="60" cy="36" r="26" />
          <circle className="cs-art-ring" cx="60" cy="36" r="17" />
          {Array.from({ length: 16 }, (_, index) => {
            const angle = (index / 16) * Math.PI * 2;
            const length = 6 + ((index * 7) % 9);
            return <line key={index} className="cs-art-line" x1={60 + Math.cos(angle) * 28} y1={36 + Math.sin(angle) * 28} x2={60 + Math.cos(angle) * (28 + length)} y2={36 + Math.sin(angle) * (28 + length)} />;
          })}
          <circle className="cs-art-b" cx="60" cy="36" r="8" />
        </>
      )}
      {kind === "teaser" && (
        <>
          <rect className="cs-art-frame" x="44" y="6" width="32" height="60" rx="6" />
          <path className="cs-art-b" d="M60 20 L64 32 L76 34 L66 41 L69 53 L60 46 L51 53 L54 41 L44 34 L56 32 Z" />
          <rect className="cs-art-c" x="50" y="58" width="20" height="3" rx="1.5" />
        </>
      )}
    </svg>
  );
}
