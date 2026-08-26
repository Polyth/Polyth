// Multi-step introduction overlay for a package (the "package tour"). Stacks
// above the settings modal, entirely separate from the first-run project
// onboarding overlay (store Overlay "onboarding"). Steps render either a real
// screenshot or a designed SVG pattern so no stock assets are needed.
// Esc dismisses WITHOUT persisting (the tour returns next session); the
// explicit skip buttons persist through packages/onboarding/prefs.ts.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  PackageOnboardingHighlightWhere,
  PackageOnboardingMedia,
} from "../packages/onboarding/types.ts";
import {
  closePackageTour, getPackageTourState, nextPackageTourStep,
  previousPackageTourStep, setPackageTourStep, subscribePackageTour,
} from "../packages/onboarding/controller.ts";
import { tr } from "../i18n/index.ts";
import { useModalScrollLock } from "./a11y/Dialog.tsx";

/** Caption for the highlight card, keyed by where the control actually lives
 * (a settings row, a full workspace view, a docked pane, the strip above the
 * composer, or the header). */
const HIGHLIGHT_WHERE_LABELS: Record<PackageOnboardingHighlightWhere, string> = {
  settings: tr("packagetouroverlay.inTheseSettings"),
  workspace: tr("packagetouroverlay.inTheWorkspace"),
  pane: tr("packagetouroverlay.inTheWorkspacePane"),
  composer: tr("packagetouroverlay.aboveTheComposer"),
  header: tr("packagetouroverlay.inTheWorkspaceHeader"),
};

const WAVE_BARS = [16, 34, 22, 52, 78, 44, 96, 118, 66, 104, 82, 48, 70, 36, 24, 14];
const WAVE_ACCENT = new Set([5, 6, 7, 8, 9]);
const TILE_ACCENT = new Set([3, 9, 14, 20]);

function BranchesArt() {
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <path className="art-line" d="M-10 104 H410" />
      <path className="art-line art-accent" d="M56 104 C 112 104 120 46 176 46 H 410" />
      <circle className="art-node" cx="56" cy="104" r="6" />
      <circle className="art-node" cx="130" cy="104" r="6" />
      <circle className="art-node" cx="216" cy="104" r="6" />
      <circle className="art-node" cx="330" cy="104" r="6" />
      <circle className="art-node art-accent" cx="238" cy="46" r="7" />
      <circle className="art-node art-accent" cx="318" cy="46" r="7" />
    </svg>
  );
}

function WaveformArt() {
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {WAVE_BARS.map((height, index) => (
        <rect
          key={index}
          className={`art-bar${WAVE_ACCENT.has(index) ? " art-accent" : ""}`}
          x={22 + index * 23}
          y={75 - height / 2}
          width={10}
          height={height}
          rx={5}
        />
      ))}
    </svg>
  );
}

function TilesArt() {
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {Array.from({ length: 24 }, (_, index) => {
        const column = index % 8;
        const row = Math.floor(index / 8);
        return (
          <rect
            key={index}
            className={`art-tile${TILE_ACCENT.has(index) ? " art-accent" : ""}`}
            x={26 + column * 44}
            y={9 + row * 44}
            width={32}
            height={32}
            rx={9}
          />
        );
      })}
    </svg>
  );
}

function OrbitArt() {
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <circle className="art-ring" cx="300" cy="155" r="40" />
      <circle className="art-ring art-accent" cx="300" cy="155" r="82" />
      <circle className="art-ring" cx="300" cy="155" r="126" />
      <circle className="art-node" cx="300" cy="115" r="5" />
      <circle className="art-node art-accent" cx="300" cy="73" r="7" />
      <circle className="art-node" cx="191" cy="92" r="5" />
    </svg>
  );
}

function RaysArt() {
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <path className="art-line" d="M0 150 L120 -10" />
      <path className="art-line art-accent" d="M0 150 L235 -10" />
      <path className="art-line" d="M0 150 L360 -10" />
      <path className="art-line" d="M0 150 L410 45" />
      <path className="art-line" d="M0 150 L410 105" />
      <circle className="art-node art-accent" cx="141" cy="54" r="7" />
    </svg>
  );
}

function GlyphArt({ seed }: { seed: string }) {
  const initial = (seed.trim().charAt(0) || "p").toUpperCase();
  return (
    <svg className="package-tour-art" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <text className="art-glyph" x="200" y="128" textAnchor="middle">{initial}</text>
    </svg>
  );
}

function TourMedia({ media, seed }: { media: PackageOnboardingMedia | undefined; seed: string }) {
  if (media?.kind === "image" && media.src) {
    return <img className="package-tour-shot" src={media.src} alt="" />;
  }
  switch (media?.pattern) {
    case "branches": return <BranchesArt />;
    case "waveform": return <WaveformArt />;
    case "tiles": return <TilesArt />;
    case "orbit": return <OrbitArt />;
    case "rays": return <RaysArt />;
    default: return <GlyphArt seed={seed} />;
  }
}

export default function PackageTourOverlay() {
  const state = useSyncExternalStore(subscribePackageTour, getPackageTourState);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = state !== null;
  useModalScrollLock(open);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePackageTour("dismiss");
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        nextPackageTourStep();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        previousPackageTourStep();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Contain Tab here so the settings modal's own trap never steals focus.
      event.stopPropagation();
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // window-level capture fires before SettingsView's document-level capture
    // handler, so Esc closes only the tour while it is stacked on top.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!state) return null;
  const { tour, mode, step } = state;
  const current = tour.steps[step]!;
  const lastStep = step === tour.steps.length - 1;

  return (
    <div
      className="scrim package-tour-scrim"
      onPointerDown={(event) => { if (event.target === event.currentTarget) closePackageTour("dismiss"); }}
    >
      <div
        className="package-tour"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="package-tour-title"
        aria-describedby="package-tour-copy"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="package-tour-media" aria-hidden="true">
          <TourMedia media={current.media} seed={tour.title} />
        </div>
        <div className="package-tour-body" key={current.id}>
          <span className="package-tour-kicker">
            {mode === "preview" ? tr("packagetouroverlay.packageTour") : tr("packagetouroverlay.meetThisPackage")} · {tour.title}
          </span>
          <h2 id="package-tour-title">{current.title}</h2>
          <p className="package-tour-copy" id="package-tour-copy">{current.body}</p>
          {current.highlight && (
            <div className="package-tour-highlight">
              <span className="package-tour-highlight-mark" aria-hidden="true">◎</span>
              <div>
                <span>{HIGHLIGHT_WHERE_LABELS[current.highlightWhere ?? "settings"]}</span>
                <strong>{current.highlight}</strong>
              </div>
            </div>
          )}
        </div>
        <div className="package-tour-foot">
          <div className="package-tour-dots">
            {tour.steps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`package-tour-dot${index === step ? " active" : ""}`}
                aria-label={tr("packagetouroverlay.goToStepValueOfValue", { value: index + 1, length: tour.steps.length })}
                aria-current={index === step ? "step" : undefined}
                onClick={() => setPackageTourStep(index)}
              />
            ))}
            <span className="package-tour-count">{step + 1}/{tour.steps.length}</span>
          </div>
          <div className="package-tour-actions">
            {step > 0 && (
              <button type="button" className="btn-soft" onClick={previousPackageTourStep}>{tr("common.back")}</button>
            )}
            <button type="button" className="btn-accent" onClick={nextPackageTourStep}>
              {lastStep ? tr("common.done") : tr("common.next")}
            </button>
          </div>
        </div>
        <div className="package-tour-skips">
          <button type="button" className="package-tour-skip" onClick={() => closePackageTour("skip")}>
            {tr("packagetouroverlay.skipThisTour")}</button>
          <span aria-hidden="true">·</span>
          <button type="button" className="package-tour-skip" onClick={() => closePackageTour("skip-all")}>
            {tr("packagetouroverlay.skipAllOnboardings")}</button>
        </div>
      </div>
    </div>
  );
}
