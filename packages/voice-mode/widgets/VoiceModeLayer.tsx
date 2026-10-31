// Voice mode presentation. By default every screen gets a compact dock
// directly above the composer, so the conversation stays visible and is the
// transcript. Full screen (a preference, or the dock's expand button) is an
// immersive layer over the chat column with a large orb and thumb-reachable
// controls; the rails and navigator stay visible beside it.
// The orb is always the one obvious action: send now, interrupt, resume or
// retry. What the agent is doing shows beside it, with Stop while it works.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  CaptionsIcon,
  CaptionsOffIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  GlassIsland,
  IconButton,
  MicIcon,
  MicOffIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  StopIcon,
  VoiceModeIcon,
  type LucideIcon,
} from "@polyth/web/ui";
import { announce } from "../../../apps/web/src/components/a11y/live.tsx";
import type { VoiceCommandPhrases } from "../src/commands.ts";
import type { VoiceFeedback } from "../src/prefs.ts";
import { formatVoiceString, type VoiceModeStrings } from "../src/strings.ts";
import type { VoiceModeController, VoiceModeSnapshot, VoicePhase } from "./controller.ts";
import Orb from "./Orb.tsx";
import { setVoiceModePrefs, useVoiceModePrefs } from "./prefsStore.ts";

export function phaseLabel(snapshot: VoiceModeSnapshot, strings: VoiceModeStrings): string {
  switch (snapshot.phase) {
    case "starting": return strings.phaseStarting;
    case "listening": return strings.phaseListening;
    case "hearing": return strings.phaseHearing;
    case "sending": return strings.phaseSending;
    case "speaking": return strings.phaseSpeaking;
    case "paused": return strings.phasePaused;
    case "error": return strings.phaseError;
    default: return strings.title;
  }
}

/** What the agent is doing, beside the microphone state; empty when idle. */
export function agentLabel(snapshot: VoiceModeSnapshot, strings: VoiceModeStrings): string {
  switch (snapshot.agent) {
    case "working":
      if (snapshot.action) return snapshot.action;
      return snapshot.tool ? formatVoiceString(strings.workingOn, { tool: snapshot.tool }) : strings.phaseWorking;
    case "needs-input": return strings.phaseNeedsInput;
    default: return "";
  }
}

const quoted = (phrases: readonly string[] | undefined): string => phrases?.[0] ? `“${phrases[0]}”` : "";

export function phaseHint(snapshot: VoiceModeSnapshot, strings: VoiceModeStrings, manual: boolean, bargeIn: boolean,
  commands: VoiceCommandPhrases | null = null): string {
  switch (snapshot.phase) {
    case "listening":
    case "hearing": {
      if (snapshot.agent === "needs-input") return strings.hintNeedsInput;
      if (snapshot.agent === "idle") return manual ? strings.hintListeningManual : strings.hintListening;
      const stop = quoted(commands?.stop);
      const sendNow = quoted(commands?.sendNow);
      return stop && sendNow ? formatVoiceString(strings.hintQueueCommands, { stop, sendNow }) : strings.hintQueue;
    }
    case "speaking": return bargeIn && !snapshot.muted ? strings.hintSpeaking : strings.hintSpeakingTap;
    case "paused": return strings.hintPaused;
    case "error": return snapshot.error ?? strings.hintError;
    default: return "";
  }
}

/** The orb's accessible name is the action a tap performs right now. */
function primaryLabel(phase: VoicePhase, strings: VoiceModeStrings): string {
  switch (phase) {
    case "listening":
    case "hearing": return strings.sendNow;
    case "speaking": return strings.interrupt;
    case "paused": return strings.resume;
    case "error": return strings.retry;
    default: return strings.title;
  }
}

const editable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA"
    || element.tagName === "SELECT" || element.isContentEditable);
};

function useVoiceSnapshot(controller: VoiceModeController): VoiceModeSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** Keyboard: Space = the orb's action, M = mute, Escape = end. Plain keys
 *  never fire while the user types; Escape defers to anything that used it. */
function useVoiceKeys(controller: VoiceModeController) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (editable(event.target)) return;
        event.preventDefault();
        controller.stop();
        return;
      }
      if (editable(event.target)) return;
      if (event.key === " " && !(event.target as HTMLElement | null)?.closest?.("button, a, [role='button']")) {
        event.preventDefault();
        controller.primary();
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        controller.toggleMute();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [controller]);
}

/** Screen readers hear each turn change once; captions stay visual. */
function usePhaseAnnouncements(snapshot: VoiceModeSnapshot, strings: VoiceModeStrings) {
  const last = useRef("");
  useEffect(() => {
    const text = snapshot.phase === "off" ? "" : [phaseLabel(snapshot, strings), agentLabel(snapshot, strings)].filter(Boolean).join(" · ");
    if (text && text !== last.current) announce(text);
    last.current = text;
  }, [snapshot.phase, snapshot.agent, snapshot.tool, snapshot.action, strings]);
}

const userTurn = (snapshot: VoiceModeSnapshot): boolean =>
  snapshot.phase === "hearing" || snapshot.phase === "sending"
  || (snapshot.phase === "listening" && !!snapshot.userText);

/** The words that belong to the current turn: the user's while they talk,
 *  the agent's while it speaks. */
const captionText = (snapshot: VoiceModeSnapshot): string =>
  userTurn(snapshot) ? snapshot.userText : snapshot.phase === "speaking" ? snapshot.assistantText : "";

/** The agent's state and the Stop that goes with it. */
function AgentStatus({ snapshot, strings }: { snapshot: VoiceModeSnapshot; strings: VoiceModeStrings }) {
  const label = agentLabel(snapshot, strings);
  return label ? <span className="voice-agent" data-agent={snapshot.agent}>{label}</span> : null;
}

function StopAgentButton({ controller, snapshot, strings, size }: {
  controller: VoiceModeController;
  snapshot: VoiceModeSnapshot;
  strings: VoiceModeStrings;
  size: "md" | "lg";
}) {
  if (snapshot.agent === "idle") return null;
  return (
    <IconButton className="voice-control voice-control--stop" icon={StopIcon} size={size} variant="ghost"
      label={strings.stopAgent} onClick={() => controller.stopAgent()} />
  );
}

function Captions({ snapshot, strings }: { snapshot: VoiceModeSnapshot; strings: VoiceModeStrings }) {
  const user = userTurn(snapshot);
  const text = captionText(snapshot);
  return (
    <p className="voice-caption" data-speaker={user ? "user" : "assistant"} aria-hidden="true">
      {text ? <><span className="voice-caption-who">{user ? strings.you : strings.assistant}</span><bdi>{text}</bdi></> : null}
    </p>
  );
}

function MuteButton({ controller, snapshot, strings, size }: {
  controller: VoiceModeController;
  snapshot: VoiceModeSnapshot;
  strings: VoiceModeStrings;
  size: "md" | "lg";
}) {
  return (
    <IconButton
      className="voice-control voice-control--mute"
      icon={snapshot.muted ? MicOffIcon : MicIcon}
      size={size}
      variant="ghost"
      label={snapshot.muted ? strings.unmute : strings.mute}
      pressed={snapshot.muted}
      onClick={() => controller.toggleMute()}
    />
  );
}

/** Replies, spoken or silent, switched mid-conversation. It is an account
 *  preference, so the next conversation (on any device) starts with the
 *  last choice. */
export function RepliesSwitch({ strings, size }: { strings: VoiceModeStrings; size: "md" | "lg" }) {
  const { feedback } = useVoiceModePrefs();
  const options: Array<[VoiceFeedback, LucideIcon, string, string]> = [
    ["voice", SpeakerIcon, strings.feedbackVoice, strings.feedbackVoiceHint],
    ["silent", SpeakerOffIcon, strings.feedbackSilent, strings.feedbackSilentHint],
  ];
  return (
    <div className="voice-replies" role="group" aria-label={strings.feedback} data-size={size} data-value={feedback}>
      <span className="voice-replies-thumb" aria-hidden="true" />
      {options.map(([value, icon, label, hint]) => (
        <Button
          key={value}
          className="voice-replies-option"
          variant="ghost"
          size={size === "lg" ? "md" : "sm"}
          iconStart={icon}
          aria-label={label}
          aria-pressed={feedback === value}
          title={hint}
          onClick={() => { if (feedback !== value) setVoiceModePrefs({ feedback: value }); }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function CompactDock({ controller, snapshot, strings, captions, hint, elsewhere }: {
  controller: VoiceModeController;
  snapshot: VoiceModeSnapshot;
  strings: VoiceModeStrings;
  captions: boolean;
  hint: string;
  /** Title of the conversation voice mode talks to, when another is open. */
  elsewhere: string;
}) {
  return (
    <GlassIsland
      strength="medium"
      className="voice-dock"
      role="region"
      aria-label={strings.title}
      data-phase={snapshot.phase}
    >
      <Orb controller={controller} phase={snapshot.phase} size={44} onActivate={() => controller.primary()}
        label={primaryLabel(snapshot.phase, strings)} />
      <div className="voice-dock-text">
        <span className="voice-dock-status">
          <span className="voice-phase">{phaseLabel(snapshot, strings)}</span>
          <AgentStatus snapshot={snapshot} strings={strings} />
          {elsewhere && <span className="voice-target">{formatVoiceString(strings.talkingTo, { title: elsewhere })}</span>}
        </span>
        {snapshot.notice
          ? <span className="voice-notice" role="status">{snapshot.notice}</span>
          : captions && captionText(snapshot)
            ? <Captions snapshot={snapshot} strings={strings} />
            : hint ? <span className="voice-hint">{hint}</span> : null}
      </div>
      <div className="voice-dock-actions">
        <RepliesSwitch strings={strings} size="md" />
        <StopAgentButton controller={controller} snapshot={snapshot} strings={strings} size="md" />
        <MuteButton controller={controller} snapshot={snapshot} strings={strings} size="md" />
        <IconButton icon={ExpandIcon} size="md" variant="ghost" label={strings.expand} onClick={() => controller.setImmersive(true)} />
        <IconButton className="voice-control--end" icon={CloseIcon} size="md" variant="ghost" label={strings.end} onClick={() => controller.stop()} />
      </div>
    </GlassIsland>
  );
}

function ImmersiveLayer({ controller, snapshot, strings, captions, hint, title, workspace, shell }: {
  controller: VoiceModeController;
  snapshot: VoiceModeSnapshot;
  strings: VoiceModeStrings;
  captions: boolean;
  hint: string;
  title: string;
  /** The chat column the layer covers; null outside the shell (test hosts). */
  workspace: HTMLElement | null;
  /** The shell containing block; the layer falls back to the viewport without it. */
  shell: HTMLElement | null;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const [orbSize, setOrbSize] = useState(240);

  // The orb scales with the layer, not the viewport: a short landscape phone
  // and a tall desktop window both keep the controls in reach.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { width, height } = layer.getBoundingClientRect();
      // Short (landscape) layers put the orb beside the words, so height
      // rather than width bounds it there.
      const size = height < 460 ? Math.min(width * 0.3, height * 0.46) : Math.min(width * 0.62, height * 0.36);
      setOrbSize(Math.round(Math.max(96, Math.min(320, size))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  // The layer covers the chat column, not the whole shell, so the rails and
  // navigator stay visible. Publish the column's frame relative to the shell
  // (the containing block) as insets, mirrored for RTL like ContextRail.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || !shell || !workspace) return;
    const publish = () => {
      const shellRect = shell.getBoundingClientRect();
      const chatRect = workspace.getBoundingClientRect();
      const rtl = getComputedStyle(shell).direction === "rtl";
      const start = rtl ? shellRect.right - chatRect.right : chatRect.left - shellRect.left;
      const end = rtl ? chatRect.left - shellRect.left : shellRect.right - chatRect.right;
      layer.style.setProperty("--voice-layer-block-start", `${Math.max(0, Math.round(chatRect.top - shellRect.top))}px`);
      layer.style.setProperty("--voice-layer-block-end", `${Math.max(0, Math.round(shellRect.bottom - chatRect.bottom))}px`);
      layer.style.setProperty("--voice-layer-inline-start", `${Math.max(0, Math.round(start))}px`);
      layer.style.setProperty("--voice-layer-inline-end", `${Math.max(0, Math.round(end))}px`);
      // On phones the column reaches the physical top under the floating
      // session header, so the layer clears whatever part of the status bar
      // and notch the column itself does not.
      layer.style.setProperty("--voice-layer-viewport-top", `${Math.max(0, Math.round(chatRect.top))}px`);
    };
    publish();
    const disconnects: Array<() => void> = [];
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(publish);
      observer.observe(shell);
      observer.observe(workspace);
      disconnects.push(() => observer.disconnect());
    }
    if (typeof MutationObserver === "function") {
      const directionObserver = new MutationObserver(publish);
      directionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
      disconnects.push(() => directionObserver.disconnect());
    }
    return () => { for (const disconnect of disconnects) disconnect(); };
  }, [shell, workspace]);

  // Focus starts on the orb; closing returns focus to whatever opened it. The
  // layer is not modal: the visible rails and navigator stay reachable.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // No ring for this programmatic focus; keyboard use shows it as usual.
    layerRef.current?.querySelector<HTMLElement>(".voice-orb")
      ?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  return createPortal(
    // The shared Quiet Glass dock material (classes, not the component, so
    // the layer can be measured): translucent where blur is supported and
    // allowed, opaque in low-resource and reduced-motion modes.
    <div
      ref={layerRef}
      className="ui-glass-dock ui-glass-dock--strong voice-mode-immersive"
      role="dialog"
      aria-labelledby={headingId}
      data-phase={snapshot.phase}
      data-anchored={shell ? "shell" : undefined}
    >
      <header className="voice-immersive-head">
        <IconButton icon={CollapseIcon} size="lg" variant="ghost" label={strings.collapse} onClick={() => controller.setImmersive(false)} />
        <div className="voice-immersive-title">
          <h2 id={headingId}>{strings.title}</h2>
          {title && <span>{title}</span>}
        </div>
        <IconButton
          icon={captions ? CaptionsIcon : CaptionsOffIcon}
          size="lg"
          variant="ghost"
          label={captions ? strings.hideCaptions : strings.showCaptions}
          pressed={captions}
          onClick={() => setVoiceModePrefs({ captions: !captions })}
        />
      </header>
      <div className="voice-immersive-stage">
        <Orb controller={controller} phase={snapshot.phase} size={orbSize} onActivate={() => controller.primary()}
          label={primaryLabel(snapshot.phase, strings)} />
        <div className="voice-immersive-text">
          <p className="voice-phase voice-phase--large">{phaseLabel(snapshot, strings)}</p>
          <p className="voice-agent-line"><AgentStatus snapshot={snapshot} strings={strings} /></p>
          {snapshot.notice
            ? <p className="voice-notice" role="status">{snapshot.notice}</p>
            : <p className="voice-hint">{hint}</p>}
          {captions && <Captions snapshot={snapshot} strings={strings} />}
          <RepliesSwitch strings={strings} size="lg" />
        </div>
      </div>
      <footer className="voice-immersive-controls">
        <StopAgentButton controller={controller} snapshot={snapshot} strings={strings} size="lg" />
        <MuteButton controller={controller} snapshot={snapshot} strings={strings} size="lg" />
        <IconButton className="voice-control voice-control--end" icon={CloseIcon} size="lg" variant="ghost" label={strings.end}
          onClick={() => controller.stop()} />
      </footer>
      <p className="voice-keys" aria-hidden="true">{strings.keyboardHint}</p>
    </div>,
    shell ?? document.body,
  );
}

// Several hosts can be mounted at once (split panes, and a fallback inside the
// composer for screens without the area above it, like New chat). The
// highest-priority host draws voice mode — the first of equals — and the
// others stay empty.
let hostClaim = 0;
const claims = new Map<number, number>();
let activeClaim = 0;
const claimListeners = new Set<() => void>();

const elect = () => {
  let best = 0;
  let bestPriority = -Infinity;
  for (const [claim, priority] of claims) {
    if (priority > bestPriority) {
      best = claim;
      bestPriority = priority;
    }
  }
  activeClaim = best;
  for (const listener of [...claimListeners]) listener();
};

function useLayerClaim(priority: number): boolean {
  const [claim] = useState(() => ++hostClaim);
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const update = () => setOwner(activeClaim === claim);
    claimListeners.add(update);
    claims.set(claim, priority);
    elect();
    return () => {
      claimListeners.delete(update);
      claims.delete(claim);
      elect();
    };
  }, [claim, priority]);
  return owner;
}

export function VoiceModeHost({ controller, strings, sessionTitle, activeSessionId, bargeIn, commands, priority = 0 }: {
  controller: VoiceModeController;
  strings: VoiceModeStrings;
  sessionTitle(sessionId: string | null): string;
  activeSessionId(): string | null;
  bargeIn(): boolean;
  /** Resolved command phrases, for the hint; null when commands are off. */
  commands(): VoiceCommandPhrases | null;
  /** Higher draws first when several hosts are mounted. */
  priority?: number;
}) {
  const snapshot = useVoiceSnapshot(controller);
  const prefs = useVoiceModePrefs();
  const owner = useLayerClaim(priority);
  const immersive = snapshot.immersive ?? prefs.presentation === "immersive";
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [workspace, setWorkspace] = useState<HTMLElement | null>(null);
  // The host's own mount point sits inside the chat column, so the immersive
  // layer anchors to that column instead of querying the document.
  useLayoutEffect(() => {
    setWorkspace(anchorRef.current?.closest<HTMLElement>(".workspace") ?? null);
  });
  usePhaseAnnouncements(snapshot, strings);
  useVoiceKeys(controller);

  if (!owner || snapshot.phase === "off") return null;
  const hint = phaseHint(snapshot, strings, prefs.turnTaking === "manual", bargeIn(), commands());
  const shell = workspace?.closest<HTMLElement>(".app-shell") ?? null;
  return (
    <>
      <span ref={anchorRef} className="voice-host-anchor" hidden />
      {immersive
        ? <ImmersiveLayer controller={controller} snapshot={snapshot} strings={strings} captions={prefs.captions}
            hint={hint} title={sessionTitle(snapshot.sessionId)} workspace={workspace} shell={shell} />
        : <CompactDock controller={controller} snapshot={snapshot} strings={strings} captions={prefs.captions} hint={hint}
            elsewhere={snapshot.sessionId && snapshot.sessionId !== activeSessionId() ? sessionTitle(snapshot.sessionId) || strings.anotherChat : ""} />}
    </>
  );
}

/** The launcher: a composer (or header) button that starts and ends voice mode. */
export function VoiceModeButton({ controller, strings }: { controller: VoiceModeController; strings: VoiceModeStrings }) {
  const snapshot = useVoiceSnapshot(controller);
  const active = snapshot.phase !== "off";
  return (
    <span className="voice-mode-launch" data-active={active || undefined}>
      <IconButton
        className="voice-mode-btn"
        icon={VoiceModeIcon}
        size="md"
        variant="ghost"
        label={active ? strings.end : strings.start}
        pressed={active}
        onClick={() => controller.toggle()}
      />
    </span>
  );
}
