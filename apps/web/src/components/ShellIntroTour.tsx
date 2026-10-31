// The first-open interface tour (model in shellIntro.ts).
// A spotlight cut out of the scrim frames the real control, a hand-drawn arrow
// runs from the card to it, and the card explains the step. The shell stays
// mounted and visible underneath but inert while the tour is open; the tour
// owns the store overlay ("onboarding") so no other modal stacks with it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  closeShellIntro,
  getShellIntroState,
  introArrowPath,
  placeIntroCard,
  resolveIntroAnchor,
  setShellIntroStep,
  shellIntroResumeIndex,
  shellIntroSteps,
  subscribeShellIntro,
  suspendShellIntro,
  type IntroArrow,
  type IntroCardPlacement,
  type IntroRect,
  type ShellIntroArt,
} from "../shellIntro.ts";
import { getState, openSettingsPage, setOverlay, useStore } from "../store.ts";
import { guardedProjectAddAllowed, limitedProjectAddAllowed, useAccountLimits, useGuardrails } from "../guardrails.ts";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useShellLayout } from "../shellLayout.ts";
import { Button } from "./ui/index.ts";
import LanguagePicker from "./LanguagePicker.tsx";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { markAutoPickerOffered } from "../projectOnboarding.ts";
import { useExitGhost } from "../exitGhost.ts";
import "./ShellIntroTour.css";

/** Breathing room between the target and the spotlight's edge. */
const SPOTLIGHT_PAD = 6;
/** Anchors can move (a drawer settling, the registry painting rails), so the
 *  layout is re-measured while the tour is open. Cheap: one query + rects. */
const REMEASURE_MS = 300;

interface IntroLayout {
  target: IntroRect | null;
  card: IntroCardPlacement;
  arrow: IntroArrow | null;
}

const sameRect = (a: IntroRect | null, b: IntroRect | null): boolean =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

const sameLayout = (a: IntroLayout | null, b: IntroLayout): boolean =>
  !!a && sameRect(a.target, b.target) && a.card.side === b.card.side
  && a.card.left === b.card.left && a.card.top === b.card.top
  && a.arrow?.line === b.arrow?.line;

function roundRect(rect: DOMRect): IntroRect {
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** A schematic of the shell with the three rails in accent. */
function ShellArt() {
  return (
    <svg className="shell-intro-art" viewBox="0 0 320 132" aria-hidden="true" focusable="false">
      <rect className="art-frame" x="8" y="8" width="304" height="116" rx="12" />
      <rect className="art-rail art-accent" x="16" y="16" width="20" height="100" rx="6" />
      <circle className="art-dot" cx="26" cy="30" r="5" />
      <circle className="art-dot" cx="26" cy="46" r="5" />
      <circle className="art-dot" cx="26" cy="62" r="5" />
      <rect className="art-plus" x="20" y="98" width="12" height="12" rx="4" />
      <rect className="art-rail art-accent" x="112" y="16" width="96" height="16" rx="8" />
      <rect className="art-rail art-accent" x="284" y="40" width="20" height="76" rx="6" />
      <rect className="art-bubble" x="60" y="48" width="132" height="14" rx="7" />
      <rect className="art-bubble art-bubble-own" x="132" y="70" width="128" height="14" rx="7" />
      <rect className="art-bubble" x="60" y="92" width="96" height="14" rx="7" />
    </svg>
  );
}

/** One tile travels from the top rail into the right rail, once. */
function DragArt() {
  return (
    <svg className="shell-intro-art shell-intro-art--drag" viewBox="0 0 320 132" aria-hidden="true" focusable="false">
      <rect className="art-rail" x="40" y="18" width="176" height="28" rx="14" />
      <rect className="art-tile" x="52" y="24" width="16" height="16" rx="5" />
      <rect className="art-tile" x="80" y="24" width="16" height="16" rx="5" />
      <rect className="art-tile art-slot" x="108" y="24" width="16" height="16" rx="5" />
      <rect className="art-tile" x="136" y="24" width="16" height="16" rx="5" />
      <rect className="art-rail" x="262" y="18" width="28" height="104" rx="14" />
      <rect className="art-tile" x="268" y="30" width="16" height="16" rx="5" />
      <rect className="art-tile" x="268" y="58" width="16" height="16" rx="5" />
      <path className="art-trail" d="M 116 40 C 140 96, 220 104, 270 92" />
      <g className="art-moving">
        <rect className="art-tile art-accent" x="108" y="24" width="16" height="16" rx="5" />
        <path className="art-cursor" d="M 120 34 l 0 15 l 4 -4 l 3 7 l 3 -1.4 l -3 -6.6 l 5.5 0 z" />
      </g>
    </svg>
  );
}

function IntroArt({ art }: { art: ShellIntroArt }) {
  return (
    <div className="shell-intro-media" aria-hidden="true">
      {art === "shell" ? <ShellArt /> : <DragArt />}
    </div>
  );
}

export default function ShellIntroTour() {
  const state = useSyncExternalStore(subscribeShellIntro, getShellIntroState);
  const overlay = useStore((s) => s.overlay);
  const accountLimits = useAccountLimits();
  const canAddProject = guardedProjectAddAllowed(useGuardrails()) && limitedProjectAddAllowed(accountLimits);
  const phone = useShellMode() === "phone";
  const barless = useShellLayout().tools !== "bar";
  const hasProject = useStore((s) => s.projectRegistry.projects.length > 0);
  const projectAdded = state?.projectAdded === true;
  const steps = useMemo(
    () => shellIntroSteps({ canAddProject, phone, barless, hasProject, projectAdded }),
    [canAddProject, phone, barless, hasProject, projectAdded],
  );
  const open = state !== null;
  const stepIndex = !state ? 0
    : state.resumeAfter ? shellIntroResumeIndex(steps, state.resumeAfter)
    : Math.min(state.step, steps.length - 1);
  const step = steps[stepIndex]!;
  const lastStep = stepIndex === steps.length - 1;

  const rootRef = useRef<HTMLDivElement>(null);
  // Finishing or skipping the tour unmounts it at once; it still fades away.
  const rootGhostRef = useExitGhost<HTMLDivElement>(() => ({ kind: "tour" }), rootRef);
  const cardRef = useRef<HTMLDivElement>(null);
  const claimedOverlay = useRef(false);
  const [layout, setLayout] = useState<IntroLayout | null>(null);

  const close = useCallback(() => {
    closeShellIntro();
  }, []);

  // The tour is the one open overlay. Another overlay taking over (a global
  // shortcut opening Settings) ends the tour instead of stacking with it.
  useEffect(() => {
    if (!open) {
      if (claimedOverlay.current && getState().overlay === "onboarding") setOverlay(null);
      claimedOverlay.current = false;
      return;
    }
    if (!claimedOverlay.current) {
      claimedOverlay.current = true;
      if (overlay !== "onboarding") setOverlay("onboarding");
      return;
    }
    if (overlay !== "onboarding") {
      claimedOverlay.current = false;
      closeShellIntro();
    }
  }, [open, overlay]);

  useModalSurface({
    open,
    onClose: close,
    containerRef: cardRef,
    isolationRootRef: rootRef,
    initialFocus: ".shell-intro-primary",
  });

  const goTo = useCallback((index: number) => setShellIntroStep(index, steps.length), [steps.length]);
  const next = useCallback(() => {
    if (lastStep) close();
    else goTo(stepIndex + 1);
  }, [close, goTo, lastStep, stepIndex]);
  const back = useCallback(() => goTo(stepIndex - 1), [goTo, stepIndex]);

  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card || typeof window === "undefined") return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = resolveIntroAnchor(step.anchors, document, viewport);
    const target = anchor ? roundRect(anchor.getBoundingClientRect()) : null;
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const placement = placeIntroCard(target, size, viewport, step.prefer);
    const cardRect = { left: placement.left, top: placement.top, ...size };
    const arrow = target ? introArrowPath(cardRect, target) : null;
    const nextLayout: IntroLayout = { target, card: placement, arrow };
    setLayout((current) => sameLayout(current, nextLayout) ? current : nextLayout);
  }, [step]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }
    measure();
    window.addEventListener("resize", measure);
    const timer = window.setInterval(measure, REMEASURE_MS);
    const observer = typeof ResizeObserver === "function" && cardRef.current
      ? new ResizeObserver(() => measure())
      : null;
    if (observer && cardRef.current) observer.observe(cardRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [open, measure]);

  if (!state) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The language menu is portaled, but its keys still bubble through React.
    if (event.target instanceof HTMLElement && event.target.closest(".shell-intro-dots, [role=\"menu\"]")) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const forward = (event.key === "ArrowRight") !== (document.documentElement.dir === "rtl");
      event.preventDefault();
      if (forward) {
        if (!lastStep) goTo(stepIndex + 1);
      } else back();
    }
  };

  const target = layout?.target ?? null;
  const placement = layout?.card;
  const welcome = step.id === "welcome";

  return (
    <div
      ref={rootGhostRef}
      className="shell-intro"
      data-step={step.id}
      data-placement={placement?.side ?? "center"}
      data-measured={layout ? "true" : undefined}
    >
      {target ? (
        <div
          className="shell-intro-spotlight"
          aria-hidden="true"
          style={{
            left: target.left - SPOTLIGHT_PAD,
            top: target.top - SPOTLIGHT_PAD,
            width: target.width + SPOTLIGHT_PAD * 2,
            height: target.height + SPOTLIGHT_PAD * 2,
          }}
        >
          <span key={step.id} className="shell-intro-ping" />
        </div>
      ) : <div className="shell-intro-scrim" aria-hidden="true" />}
      {layout?.arrow && (
        <svg className="shell-intro-arrow" aria-hidden="true" focusable="false">
          <g key={`${step.id}:${layout.card.side}`}>
            <path className="shell-intro-arrow-line" d={layout.arrow.line} pathLength={1} />
            <path className="shell-intro-arrow-head" d={layout.arrow.head} />
          </g>
        </svg>
      )}
      <div
        ref={cardRef}
        className="shell-intro-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shell-intro-title"
        aria-describedby="shell-intro-copy"
        tabIndex={-1}
        style={placement ? { left: placement.left, top: placement.top } : undefined}
        onKeyDown={onKeyDown}
      >
        {/* Offered from the first step. Bootstrap remounts the shell on a
            locale change; the tour state lives outside React, so it stays. */}
        <LanguagePicker className="shell-intro-language" />
        {step.art && <IntroArt key={`art:${step.id}`} art={step.art} />}
        <div className="shell-intro-body" key={step.id}>
          <span className="shell-intro-kicker">
            {tr("shellintro.kicker")}
            {!welcome && <>{" · "}<span className="shell-intro-count">{tr("shellintro.stepCount", { step: stepIndex + 1, total: steps.length })}</span></>}
          </span>
          <h2 id="shell-intro-title">{tr(step.title)}</h2>
          <p className="shell-intro-copy" id="shell-intro-copy">{tr(step.body)}</p>
          {step.id === "add-project" && (
            <>
              <Button
                size="sm"
                className="shell-intro-cta"
                onClick={() => {
                  // The tour waits while the project dialog is open and picks
                  // up again when it closes (App resumes it).
                  suspendShellIntro(step.id, getState().projectRegistry.projects.map((project) => project.id));
                  // This is the first-run picker offer; it must not reopen by
                  // itself if the user cancels it.
                  markAutoPickerOffered();
                  setOverlay("project-picker");
                }}
              >
                {tr("shellintro.addProjectNow")}
              </Button>
              <p className="shell-intro-note">{tr("shellintro.addProjectResumeNote")}</p>
            </>
          )}
          {step.id === "appearance" && (
            <Button
              size="sm"
              className="shell-intro-cta"
              onClick={() => { close(); openSettingsPage("appearance"); }}
            >
              {tr("shellintro.openAppearance")}
            </Button>
          )}
        </div>
        <div className="shell-intro-foot">
          <div className="shell-intro-dots" role="group" aria-label={tr("shellintro.steps")}>
            {steps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`shell-intro-dot${index === stepIndex ? " active" : ""}`}
                aria-label={tr("shellintro.goToStep", { step: index + 1, total: steps.length })}
                aria-current={index === stepIndex ? "step" : undefined}
                onClick={() => goTo(index)}
              />
            ))}
          </div>
          <div className="shell-intro-actions">
            {welcome ? (
              <Button size="sm" variant="ghost" className="shell-intro-skip" onClick={close}>{tr("shellintro.skip")}</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={back}>{tr("common.back")}</Button>
            )}
            <Button size="sm" variant="primary" className="shell-intro-primary" onClick={next}>
              {welcome ? tr("shellintro.start") : lastStep ? tr("shellintro.finish") : tr("common.next")}
            </Button>
          </div>
        </div>
        {!welcome && !lastStep && (
          <button type="button" className="shell-intro-skip-link" onClick={close}>{tr("shellintro.skip")}</button>
        )}
      </div>
    </div>
  );
}
