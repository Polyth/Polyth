import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { renderMarkdown } from "../markdown.tsx";
import { fmtDuration, fmtMs, fmtTokens } from "../format.ts";
import { groupWork, mergeThinking, promptIndex, toolSummary, copyText, loadDraft, type WorkGroup } from "../utils.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { forkSession, sendMessage } from "../init.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import {
  applyEvent, setActiveView, setUiError, startNewSession, useStore,
} from "../store.ts";
import { api } from "../api.ts";
import {
  JUMP_TO_LATEST_NAME,
  PROMPT_NAV_NAME,
  actionsMenuName,
  assistantArticleName,
  assistantTime,
  completedName,
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  draftStateOf,
  forkActionName,
  forkAvailability,
  guardsFromModel,
  mutationErrorMessage,
  promptJumpName,
  reasoningToggleName,
  normalizedDuration,
  revertActionName,
  revertAvailability,
  rewindSeedKey,
  sentName,
  timeIso,
  timeShort,
  turnDurationMs,
  userArticleName,
  type ActionAvailability,
  type MutationGuards,
} from "../messageActions.ts";
import { applyComposerSeed, discardComposerSeed, loadSeedRecord } from "../drafts.ts";
import { TIMELINE_CHUNK, TIMELINE_WINDOW, grownLimit, limitToInclude, windowStart } from "../timelineWindow.ts";
import {
  RAIL_PANEL_ROWS,
  activePromptIndex,
  cursorTickIndex,
  railWindow,
  tickWidth,
} from "../promptRail.ts";
import { captureTimelineAnchor, loadTimelineAnchor, restoreScrollDelta, saveTimelineAnchor, type TimelineAnchor } from "../timelineAnchor.ts";
import CopyButton from "./CopyButton.tsx";
import AttachmentPills from "./AttachmentPills.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost from "./slots/SlotHost.ts";
import type { RenderModel, RenderMessage, ToolMsg, AssistantMsg, TaskActivityMsg, UserMsg } from "../reduce.ts";
import { Icon } from "../icons.tsx";
import "./messagePinAction.tsx";
import ProviderLogo from "./ProviderLogo.tsx";
import { seedMultiRunPrompt } from "../multirunSeed.ts";
import WorkflowTimelineCard from "./WorkflowTimelineCard.tsx";
import { tr } from "../i18n/index.ts";

/** One announcement per copy/mutation outcome; text is the accessible record,
 *  checkmarks only supplement it. Screen readers ignore repeats, so identical
 *  text gets an invisible nudge (same trick as a11y/live.tsx). */
type Announce = (text: string) => void;

// Merged thinking block (WP4): collapsible with a first-line preview, or a
// plain block when the collapsible pref is off. UX-MSG-ACTIONS: the disclosure
// is a native, keyboard-operable control with a purpose-and-target name and
// truthful expanded state; expanding/collapsing appends no event.
function Thinking({ m }: { m: AssistantMsg }) {
  const prefs = useUiSettings();
  const [open, setOpen] = useState(!m.finalized || prefs.thinkingDefaultExpanded);
  const preview = m.reasoning.split("\n").find((l) => l.trim()) ?? "";
  if (!prefs.collapsibleThinkingBlocks) {
    return <div className="reasoning reasoning-flat"><div className="reasoning-body" dir="auto">{m.reasoning}</div></div>;
  }
  return (
    <details className="reasoning" open={open}>
      <summary
        aria-label={reasoningToggleName(open)}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
        style={{ display: "flex", gap: 8, alignItems: "baseline" }}
      >
        <span>{tr("timeline.thinking")}{m.finalized ? "" : "…"}</span>
        {!open && <span className="muted reasoning-preview">{preview}</span>}
      </summary>
      {open && (
        <div className="reasoning-body" dir="auto">{m.reasoning}</div>
      )}
    </details>
  );
}

interface MessageActionEntry {
  key: string;
  label: string;
  name: string; // accessible purpose-and-target name
  run: () => void;
  disabledReason?: string;
  dataAttr?: Record<string, string | number>;
}

/** The action set for one user message or finalized assistant answer. Shared
 *  by the hover/focus desktop row and the persistent touch menu so pointer,
 *  Enter, and Space always produce the same operation. */
function messageActionEntries(
  m: UserMsg | AssistantMsg,
  opts: {
    announce: Announce;
    onRevert?: (message: UserMsg) => void;
    onFork?: (message: UserMsg) => void;
    revert?: ActionAvailability;
    fork?: ActionAvailability;
    copyFormat: "markdown" | "json";
    onGallery?: () => void;
    onRegenerate?: () => void;
    galleryAvailable?: boolean;
  },
): MessageActionEntry[] {
  const role = m.kind;
  const doCopy = () => {
    void copyText(opts.copyFormat === "markdown" ? copyMarkdown(m) : copyJson(m)).then((ok) => {
      opts.announce(copyAnnouncement(ok ? opts.copyFormat : "failed"));
    });
  };
  const entries: MessageActionEntry[] = [
    {
      key: "copy",
      label: tr("timeline.copyAsValue", {
        value: opts.copyFormat === "markdown" ? tr("common.markdown") : tr("common.json"),
      }),
      name: copyActionName(role, opts.copyFormat),
      run: doCopy,
    },
  ];
  if (m.kind === "assistant") {
    entries.push({
      key: "gallery",
      label: tr("timeline.gallery"),
      name: tr("timeline.openImagesFromThisAssistantAnswer"),
      run: opts.onGallery ?? (() => {}),
      ...(!opts.galleryAvailable ? { disabledReason: tr("timeline.noImagesInThisAnswer") } : {}),
    });
    if (opts.onRegenerate) {
      entries.push({
        key: "regenerate",
        label: tr("timeline.regenerate"),
        name: tr("timeline.regenerateThisAssistantAnswer"),
        run: opts.onRegenerate,
      });
    }
  }
  if (m.kind === "user" && opts.onRevert) {
    entries.push({
      key: "revert",
      label: tr("timeline.revertEdit"),
      name: revertActionName(m.time),
      run: () => opts.onRevert?.(m),
      ...(opts.revert && !opts.revert.enabled ? { disabledReason: opts.revert.reason } : {}),
      dataAttr: { "data-revert-seq": m.eventSeq },
    });
  }
  if (m.kind === "user" && opts.onFork) {
    entries.push({
      key: "fork",
      label: tr("timeline.forkEdit"),
      name: forkActionName(m.time),
      run: () => opts.onFork?.(m),
      ...(opts.fork && !opts.fork.enabled ? { disabledReason: opts.fork.reason } : {}),
    });
  }
  return entries;
}

function ActionButton({ entry, className }: { entry: MessageActionEntry; className: string }) {
  const glyph = entry.key === "copy"
    ? <Icon.copy />
    : entry.key === "gallery"
      ? <Icon.image />
      : entry.key === "regenerate"
        ? <Icon.regenerate />
    : entry.key === "fork"
      ? <Icon.fork />
      : <Icon.rewind />;
  return (
    <button
      className={className}
      aria-label={entry.name}
      title={entry.disabledReason ?? entry.name}
      data-tooltip={entry.disabledReason ?? entry.label}
      disabled={entry.disabledReason !== undefined}
      onClick={entry.run}
      {...(entry.dataAttr ?? {})}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

// Semantic time + actions row under a user message or finalized answer. The
// time stays visible; the desktop action buttons reveal on hover/focus-within
// (hidden ones have no pointer hit area); the touch entry is persistent.
//
// UX-TIMELINE-LAYOUT-01 §2.5: the narrow action menu is bounded NORMAL-FLOW
// content immediately after this footer — it pushes later content instead of
// covering its message body, its block size is capped to the visible
// scrollport (internally scrollable beyond that), and opening it reveals it
// through the existing timeline scroll root. Escape/outside press close it,
// action activation closes it, and focus returns to the opener (predecessor
// UX-MSG-ACTIONS contract, placement only).
function MessageMeta({
  m,
  announce,
  onRevert,
  onFork,
  onGallery,
  onRegenerate,
  galleryAvailable,
  revert,
  fork,
}: {
  m: UserMsg | AssistantMsg;
  announce: Announce;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  onGallery?: () => void;
  onRegenerate?: () => void;
  galleryAvailable?: boolean;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  const t = m.kind === "user" ? m.time : assistantTime(m);
  const name = m.kind === "user" ? sentName(t) : completedName(t);
  const entries = messageActionEntries(m, {
    announce,
    onRevert,
    onFork,
    revert,
    fork,
    copyFormat: prefs.messageCopyFormat,
    onGallery,
    onRegenerate,
    galleryAvailable,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) openerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!prefs.showMessageActions && menuOpen) setMenuOpen(false);
  }, [prefs.showMessageActions, menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeMenu(true); }
    };
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || openerRef.current?.contains(target)) return;
      // Outside press closes AND restores the opener, matching Escape and
      // action activation (UX-MSG-ACTIONS focus contract). One exception: a
      // press on another interactive control must keep that control's own
      // focus — restoring here would steal a deliberate target (and trap the
      // composer). The restore runs after the press's default focus handling,
      // which would otherwise land on the focusable timeline region.
      const interactive = target instanceof Element
        && target.closest("button, a[href], input, textarea, select, summary, [contenteditable]") !== null;
      closeMenu(false);
      if (!interactive) {
        const opener = openerRef.current;
        requestAnimationFrame(() => opener?.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [menuOpen, closeMenu]);
  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    // Cap to the LIVE scrollport so the whole menu always sits inside it
    // (rows beyond the cap scroll internally per §2.5), then reveal it
    // through the existing timeline scroll root. The menu sits BELOW its
    // footer in normal flow, so it can never extend behind the fixed header —
    // even at scrollTop=0 — and never covers the body it belongs to. The
    // reveal region can mount mid-open and shrink the port, so the cap tracks
    // port resizes for as long as the menu stays open.
    const port = menu.closest<HTMLElement>(".timeline");
    const fit = () => {
      if (port) menu.style.maxBlockSize = `${Math.max(44, port.clientHeight - 12)}px`;
      menu.scrollIntoView({ block: "nearest" });
    };
    fit();
    const ro = port && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : undefined;
    if (ro && port) ro.observe(port);
    menu.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => ro?.disconnect();
  }, [menuOpen]);
  return (
    <>
      <div className="msg-meta">
        <time className="msg-time" dateTime={timeIso(t)} aria-label={name}>{timeShort(t)}</time>
        {prefs.showMessageActions && (
          <>
            <div className="msg-actions">
              {entries.filter((entry) => entry.key !== "regenerate").map((entry) => (
                <ActionButton key={entry.key} entry={entry} className="msg-action-btn" />
              ))}
              {m.kind === "assistant" && (
                <SlotHost
                  slot="session.message.actions"
                  context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
                />
              )}
              {entries.filter((entry) => entry.key === "regenerate").map((entry) => (
                <ActionButton key={entry.key} entry={entry} className="msg-action-btn" />
              ))}
              {m.kind === "user" && (
                <SlotHost
                  slot="session.message.actions"
                  context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
                />
              )}
            </div>
            <button
              ref={openerRef}
              className="msg-actions-entry"
              aria-label={actionsMenuName(m)}
              title={actionsMenuName(m)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-actions-seq={m.eventSeq}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Icon.more />
            </button>
          </>
        )}
      </div>
      {prefs.showMessageActions && menuOpen && (
        <div ref={menuRef} className="msg-actions-popup" role="menu" aria-label={actionsMenuName(m)}>
          {entries.map((entry) => (
            <button
              key={entry.key}
              role="menuitem"
              className="msg-actions-item"
              aria-label={entry.name}
              title={entry.disabledReason ?? entry.name}
              disabled={entry.disabledReason !== undefined}
              onClick={() => { entry.run(); closeMenu(true); }}
            >
              <span aria-hidden="true">
                {entry.key === "copy"
                  ? <Icon.copy />
                  : entry.key === "gallery"
                    ? <Icon.image />
                    : entry.key === "regenerate"
                      ? <Icon.regenerate />
                  : entry.key === "fork"
                    ? <Icon.fork />
                    : <Icon.rewind />}
              </span>
              <span className="msg-actions-item-label">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const RESPONSE_ACTION_ICON = {
  copy: Icon.copy,
  image: Icon.image,
  plan: Icon.plan,
  pin: Icon.bookmark,
  session: Icon.newSession,
  multirun: Icon.multirun,
} as const;

const RESPONSE_ACTION_LABEL = {
  copy: tr("timeline.copyAnswer"),
  image: tr("timeline.saveAsImage"),
  plan: tr("timeline.saveAsPlan"),
  pin: tr("timeline.pinIntoContext"),
  session: tr("timeline.startNewSessionFromThisAnswer"),
  multirun: tr("timeline.startNewMultiRunFromThisAnswer"),
} as const;

function downloadAnswerImage(text: string, title: string): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;
  const width = 1200;
  const padding = 72;
  const lineHeight = 34;
  context.font = "24px system-ui, sans-serif";
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > width - padding * 2 && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  canvas.width = width;
  canvas.height = Math.max(260, padding * 2 + 54 + Math.min(lines.length, 120) * lineHeight);
  context.fillStyle = "#111318";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4f6fa";
  context.font = "700 30px system-ui, sans-serif";
  context.fillText(title, padding, padding);
  context.fillStyle = "#d7dce5";
  context.font = "24px system-ui, sans-serif";
  lines.slice(0, 120).forEach((line, index) => context.fillText(line, padding, padding + 54 + index * lineHeight));
  const link = document.createElement("a");
  link.download = `polyth-answer-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  return true;
}

function AssistantAgentHeader({
  m,
  announce,
  turn,
}: {
  m: AssistantMsg;
  announce?: Announce;
  /** Present only for the terminal assistant answer of the current turn. */
  turn?: RenderModel["turn"];
}) {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const projectId = useStore((state) => state.activeProjectId);
  const events = useStore((state) => session ? state.events[session.id] ?? [] : []);
  const models = useStore((state) => state.models);
  const prefs = useUiSettings();
  const [pinBusy, setPinBusy] = useState(false);
  const modelRef = turn?.model ?? m.model ?? session?.model;
  const descriptor = modelRef
    ? models.find((candidate) =>
        candidate.providerID === modelRef.providerID && candidate.modelID === modelRef.modelID)
    : undefined;
  const modelName = descriptor?.name ?? modelRef?.modelID ?? "Polyth";
  const agent = (turn?.agent ?? m.agent ?? session?.agent ?? tr("composer.build")).replace(/[-_]+/g, " ");
  const agentName = agent ? agent[0]!.toUpperCase() + agent.slice(1) : tr("composer.build");
  const wholeTurnDuration = turnDurationMs(turn ?? null);
  const duration = wholeTurnDuration !== null
    ? normalizedDuration(wholeTurnDuration)
    : m.completedAt !== undefined
      ? normalizedDuration(Math.max(0, m.completedAt - m.time))
      : null;
  const usage = turn?.usage?.tokens;
  const hasUsage = usage !== undefined && (usage.input > 0 || usage.output > 0);
  let pinned = false;
  for (const event of events) {
    if (Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq) !== m.eventSeq) continue;
    if (event.type === "context/pinned") pinned = true;
    if (event.type === "context/unpinned") pinned = false;
  }
  const runAction = (id: (typeof prefs.responseActions)[number]) => {
    if (id === "copy") {
      void copyText(m.text).then((ok) => announce?.(ok ? tr("timeline.answerCopied") : tr("timeline.couldnTCopyAnswer")));
      return;
    }
    if (id === "image") {
      announce?.(downloadAnswerImage(m.text, modelName) ? tr("timeline.answerImageSaved") : tr("timeline.couldnTSaveAnswerImage"));
      return;
    }
    if (id === "plan") {
      if (!projectId) return;
      void api.knowledgeCreate({
        projectId,
        kind: "plan",
        title: tr("timeline.valuePlanValue", { modelName: modelName, value: timeShort(assistantTime(m)) }),
        body: m.text,
        ...(session ? { sourceSessionId: session.id } : {}),
      }).then(() => announce?.(tr("timeline.answerSavedAsAPlan")))
        .catch((error) => setUiError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (id === "pin") {
      if (!session || pinBusy) return;
      setPinBusy(true);
      void (pinned ? api.unpinContext(session.id, m.eventSeq) : api.pinContext(session.id, m.eventSeq))
        .then(applyEvent)
        .catch((error) => setUiError(error instanceof Error ? error.message : String(error)))
        .finally(() => setPinBusy(false));
      return;
    }
    if (id === "session") {
      if (projectId) startNewSession(projectId, { draft: m.text });
      return;
    }
    seedMultiRunPrompt(m.text);
    setActiveView("multirun");
  };
  return (
    <header className="agent-reply-header">
      <ProviderLogo
        providerID={descriptor?.providerID ?? modelRef?.providerID}
        providerName={descriptor?.providerName}
        className="agent-reply-mark"
      />
      <span className="agent-reply-item agent-reply-model">{modelName}</span>
      <span className="agent-reply-item agent-reply-mode">{agentName}</span>
      {duration && <span className="agent-reply-item agent-reply-duration">{duration}</span>}
      {hasUsage && (
        <span
          className="agent-reply-item agent-reply-usage"
          aria-label={tr("timeline.valueInputTokensAndValue", { input: usage.input, output: usage.output })}
        >
          {fmtTokens(usage.input)} <span aria-hidden="true">↓</span>{"\u00a0"}{fmtTokens(usage.output)} <span aria-hidden="true">↑</span>
        </span>
      )}
      <time className="agent-reply-item" dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time>
      <span className="agent-reply-actions" aria-label={tr("timeline.answerActions")}>
        {prefs.responseActions.map((id) => {
          const Glyph = RESPONSE_ACTION_ICON[id];
          const label = id === "pin" && pinned ? tr("timeline.unpinFromContext") : RESPONSE_ACTION_LABEL[id];
          return (
            <button
              key={id}
              className={id === "pin" && pinned ? "active" : ""}
              aria-label={label}
              title={label}
              draggable
              onDragStart={(event) => event.dataTransfer.setData("text/polyth-response-action", id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const dragged = event.dataTransfer.getData("text/polyth-response-action") as typeof id;
                if (!prefs.responseActions.includes(dragged) || dragged === id) return;
                const next = prefs.responseActions.filter((candidate) => candidate !== dragged);
                next.splice(next.indexOf(id), 0, dragged);
                setUiSettings({ responseActions: next });
              }}
              disabled={(id === "pin" && pinBusy) || ((id === "plan" || id === "session") && !projectId)}
              onClick={() => runAction(id)}
            ><Glyph /></button>
          );
        })}
      </span>
    </header>
  );
}

function AssistantView({
  m,
  announce,
  plan,
  regeneratePrompt,
  turn,
}: {
  m: AssistantMsg;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: string;
  turn?: RenderModel["turn"];
}) {
  const hasAnswer = m.text !== "" || !m.finalized;
  const galleryAvailable = /!\[[^\]]*]\([^)]+\)/.test(m.text);
  const openGallery = () => {
    const message = Array.from(document.querySelectorAll<HTMLElement>(tr("timeline.msgAssistant")))
      .find((candidate) => candidate.dataset.messageSeq === String(m.eventSeq));
    message?.querySelector<HTMLButtonElement>(".md-img-btn")?.click();
  };
  const articleProps = hasAnswer
    ? ({ role: "article", "aria-label": assistantArticleName(m.finalized, assistantTime(m)) } as const)
    : undefined;
  return (
    <div className="msg assistant" data-message-seq={m.eventSeq} {...(articleProps ?? {})}>
      {m.reasoning !== "" && <Thinking m={m} />}
      {hasAnswer && (
        <div className="bubble" dir="auto">{renderMarkdown(m.text || "", m.id)}{!m.finalized && <span className="caret" />}</div>
      )}
      {plan && plan.items.length > 0 && (
        <section className="message-plan-card" aria-label={tr("timeline.currentTaskPlan")}>
          <div className="message-plan-head">
            <span className="message-plan-icon">✓</span>
            <strong>{tr("timeline.plan2")}</strong>
            <span>{plan.items.filter((item) => item.status === "done").length} {tr("timeline.of")}{" "}{plan.items.length}</span>
          </div>
          <div className="message-plan-progress">
            <i style={{ width: `${Math.round((plan.items.filter((item) => item.status === "done").length / plan.items.length) * 100)}%` }} />
          </div>
          <ul>
            {plan.items.slice(0, 5).map((item) => (
              <li key={item.id} className={item.status}>
                <span>{item.status === "done" ? "✓" : item.status === "active" ? "●" : "○"}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.finalized && m.text !== "" && announce && galleryAvailable && (
        <button className="assistant-gallery-shortcut" onClick={openGallery}><Icon.image /> {tr("timeline.openAnswerImages")}</button>
      )}
      {m.finalized && hasAnswer && <AssistantAgentHeader m={m} announce={announce} turn={turn} />}
    </div>
  );
}

// Long tool output stays clamped until "Show all" (UX-37).
function ShellOutput({ text }: { text: string }) {
  let pidValuePending = false;
  return (
    <>
      {text.split(/(\bstarted\b|\bpid\b|\b\d+\b)/gi).map((part, index) => {
        const normalized = part.toLowerCase();
        let className: string | undefined;
        if (normalized === "started") className = "shell-started";
        else if (normalized === "pid") {
          className = "shell-pid";
          pidValuePending = true;
        } else if (/^\d+$/.test(part)) {
          if (pidValuePending) className = "shell-pid";
          pidValuePending = false;
        } else if (pidValuePending && part.trim() && !/^[\s:=#-]+$/.test(part)) {
          pidValuePending = false;
        }
        return <span key={`${index}:${part}`} className={className}>{part}</span>;
      })}
    </>
  );
}

function ClampedPre({ cls, text, shell = false }: { cls: string; text: string; shell?: boolean }) {
  const [full, setFull] = useState(false);
  const long = text.split("\n").length > 24 || text.length > 2400;
  return (
    <div className="copy-wrap">
      <pre className={`${cls}${shell ? " shell-output" : ""}${full ? " full" : ""}`}>
        {shell ? <ShellOutput text={text} /> : text}
      </pre>
      <CopyButton text={text} />
      {long && (
        <button className="small-btn show-all" onClick={() => setFull((v) => !v)}>
          {full ? tr("timeline.collapse") : tr("timeline.showAll")}
        </button>
      )}
    </div>
  );
}

export function shellCardCopyText(
  input: ToolMsg["input"],
  output?: string,
  error?: string,
): string {
  const command = typeof input.command === "string"
    ? input.command
    : JSON.stringify(input, null, 2);
  return [command, output, error].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
}

function ToolCard({ m }: { m: ToolMsg }) {
  const done = m.status !== "pending";
  const [open, setOpen] = useState(!done);
  const inputJson = JSON.stringify(m.input, null, 2);
  const summary = toolSummary(m.input);
  const shell = /^(bash|shell|shell_command|run_shell)$/i.test(m.tool);
  useEffect(() => setOpen(!done), [done]);
  return (
    <div className={`tool-card${open ? " open" : ""}${shell ? " shell-command-card" : ""}${m.status === "error" ? " error" : ""}`}>
      <div className="tool-head">
        <button
          type="button"
          className="tool-disclosure"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-chevron" aria-hidden="true"><Icon.chevronRight /></span>
          <span className="tool-icon">
            {m.status === "pending" ? (
              <span className="spinner" />
            ) : m.status === "done" ? (
              <span className="ok">✓</span>
            ) : (
              <span className="err">✕</span>
            )}
          </span>
          <span className="tool-name">{shell ? tr("timeline.shellCommand") : m.title || m.tool}</span>
          {summary && <span className="mono muted" style={{ fontSize: "calc(11px * var(--ui-font-scale, 1))", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>}
          <span className="tool-dur">{m.finishTime !== undefined ? fmtMs(m.finishTime - m.time) : tr("timeline.running")}</span>
        </button>
        {shell && (
          <span className="tool-card-copy">
            <CopyButton text={shellCardCopyText(m.input, m.output, m.error)} />
          </span>
        )}
      </div>
      {open && <div className="tool-body">
        <div className="tool-section">
            <div className="tool-label">{shell ? tr("timeline.command") : tr("timeline.valueInput", { tool: m.tool })}</div>
          <ClampedPre cls="json" text={inputJson} />
        </div>
        {m.error !== undefined && (
          <div className="tool-section error">
            <div className="tool-label">{tr("common.error")}</div>
            <ClampedPre cls="json" text={m.error} />
          </div>
        )}
        {m.output !== undefined && (
          <div className="tool-section">
            <div className="tool-label">{tr("timeline.output")}</div>
            <ClampedPre cls="out" text={m.output} shell={shell} />
          </div>
        )}
      </div>}
    </div>
  );
}

function TaskActivityRow({ activity }: { activity: TaskActivityMsg }) {
  const label = activity.action === "created"
    ? tr("timeline.taskCreated")
    : activity.action === "started"
      ? tr("timeline.taskStarted")
      : activity.action === "completed"
        ? tr("timeline.taskCompleted")
        : tr("timeline.taskFailed");
  return (
    <div className={`task-activity ${activity.action}`}>
      <span className="task-activity-mark" aria-hidden="true">
        {activity.action === "completed" ? "✓" : activity.action === "failed" ? "✕" : "•"}
      </span>
      <span>{label}: {activity.text}</span>
    </div>
  );
}

// Consecutive tool calls fold behind one "Worked for 3m 1s · 4 steps" row.
function WorkedGroup({ g }: { g: WorkGroup }) {
  const failed = g.tools.some((t) => t.status === "error") || g.tasks.some((task) => task.action === "failed");
  const running = g.tools.some((t) => t.status === "pending") || g.tasks.some((task) => task.action === "started");
  const [open, setOpen] = useState(running || failed);
  const updates = g.tasks.length > 0
    ? ` · ${tr("timeline.taskUpdatesCount", { count: g.tasks.length })}`
    : "";
  return (
    <div className="msg assistant">
      <button className="goal-toggle muted" style={{ fontSize: "calc(11.5px * var(--ui-font-scale, 1))", marginBottom: 6 }} onClick={() => setOpen((v) => !v)}>
        <span className="goal-chevron">{open ? "▾" : "▸"}</span>
        {running ? tr("timeline.working") : tr("timeline.worked")} {tr("timeline.for")}{" "}{fmtDuration(g.ms)} · {g.tools.length} {tr("timeline.steps")}{updates}
        {failed && <span style={{ color: "var(--red)" }}>· {g.tools.filter((t) => t.status === "error").length} {tr("timeline.failed")}</span>}
      </button>
      {open && g.items.map((item) => (
        item.kind === "tool"
          ? <ToolCard key={item.id} m={item} />
          : <TaskActivityRow key={item.id} activity={item} />
      ))}
    </div>
  );
}

function MessageView({ m, announce, plan, regeneratePrompt, turn, onRevert, onFork, revert, fork }: {
  m: RenderMessage;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: string;
  turn?: RenderModel["turn"];
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  if (m.kind === "user") {
    return (
      <div className="msg user" data-msg-id={m.id} role="article" aria-label={userArticleName(m.time)}>
        <div className="bubble" dir="auto">
          {renderMarkdown(m.text, m.id)}
          {m.attachments && m.attachments.length > 0 && (
            <AttachmentPills attachments={m.attachments} />
          )}
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              {tr("timeline.expandedFrom")}{" "}<code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
        </div>
        {announce && (
          <MessageMeta m={m} announce={announce} onRevert={onRevert} onFork={onFork} revert={revert} fork={fork} />
        )}
      </div>
    );
  }
  if (m.kind === "assistant") {
    return <AssistantView m={m} announce={announce} plan={plan} regeneratePrompt={regeneratePrompt} turn={turn} />;
  }
  if (m.kind === "task") return <TaskActivityRow activity={m} />;
  return <ToolCard m={m} />;
}

// Right-edge prompt rail (WP4, restyled after polyth PromptNavigatorRail):
// a thin vertical tape of ticks in a 28px gutter hugging the right edge of the
// chat viewport, vertically centered. It is a SIBLING of the .timeline scroller
// (absolute within .timeline-viewport), so it never scrolls away and never
// competes with right-aligned user bubbles. Each tick is one real user prompt
// from this session; the active turn is tracked against the timeline scroll
// position, ticks swell in a proximity wave under the cursor, and hover/focus
// reveals a recent-turns panel. Click jumps via the existing
// jump()/scrollIntoView path. Presentation-only — no SessionEvent.
function PromptNavigator({ prompts, onJump, containerRef }: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  onJump: (id: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(-1);
  const [cursor, setCursor] = useState(-1);
  const [open, setOpen] = useState(false);
  const [panelStart, setPanelStart] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll-spy: the active turn is the last prompt at/above the viewport
  // midline; at the very bottom the newest rendered prompt always wins (its
  // top may never cross the midline). rAF-throttled; rows hidden by L13
  // windowing count as "above" (see activePromptIndex).
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const line = box.top + el.clientHeight * 0.5;
      const tops = prompts.map((p) => {
        const node = el.querySelector(`[data-msg-id="${p.id}"]`);
        return node === null ? null : node.getBoundingClientRect().top;
      });
      let index = activePromptIndex(tops, line);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
        for (let i = tops.length - 1; i >= 0; i--) {
          if (tops[i] !== null) { index = i; break; }
        }
      }
      setActive(index);
    };
    const onScroll = () => { if (raf === 0) raf = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [prompts, containerRef]);
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);

  const reveal = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setPanelStart(Math.max(0, prompts.length - RAIL_PANEL_ROWS));
    setOpen(true);
  };
  // 160ms leave grace so the pointer can cross the gap into the panel.
  const scheduleClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); setCursor(-1); }, 160);
  };

  const { start, end } = railWindow(prompts.length, active);
  const visible = prompts.slice(start, end);
  const maxPanelStart = Math.max(0, prompts.length - RAIL_PANEL_ROWS);
  const currentPanelStart = Math.min(panelStart, maxPanelStart);
  const panelPrompts = prompts.slice(currentPanelStart, currentPanelStart + RAIL_PANEL_ROWS);
  const jumpTo = (id: string) => { onJump(id); setOpen(false); setCursor(-1); };

  return (
    <nav
      className="prompt-nav"
      aria-label={PROMPT_NAV_NAME}
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
      onFocus={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) reveal(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleClose(); }}
    >
      <div
        className="prompt-nav-tape"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setCursor(cursorTickIndex(e.clientY - box.top, visible.length));
        }}
        onMouseLeave={() => setCursor(-1)}
        data-clip-above={start > 0 || undefined}
        data-clip-below={end < prompts.length || undefined}
      >
        {visible.map((p, i) => {
          const index = start + i;
          return (
            <button
              key={p.id}
              className="prompt-nav-tick"
              aria-label={promptJumpName(index, prompts.length, p.text)}
              aria-current={index === active ? "true" : undefined}
              onClick={() => jumpTo(p.id)}
            >
              <span
                className="prompt-nav-tick-bar"
                aria-hidden="true"
                style={{ width: `${tickWidth(index, active, cursor >= 0 ? start + cursor : -1)}px` }}
              />
            </button>
          );
        })}
      </div>
      {open && panelPrompts.length > 0 && (
        <div className="prompt-nav-panel">
          {currentPanelStart > 0 && (
            <button
              className="prompt-nav-page"
              aria-label={tr("timeline.showEarlierMessages")}
              title={tr("timeline.showEarlierMessages")}
              onClick={() => setPanelStart((value) => Math.max(0, value - RAIL_PANEL_ROWS))}
            >↑</button>
          )}
          {panelPrompts.map((p, i) => {
            const index = currentPanelStart + i;
            return (
              <button
                key={p.id}
                className={index === active ? "prompt-nav-row current" : "prompt-nav-row"}
                aria-current={index === active ? "true" : undefined}
                onClick={() => jumpTo(p.id)}
              >
                <span className="prompt-nav-row-text">{p.preview || tr("messageActions.emptyPrompt")}</span>
              </button>
            );
          })}
          {currentPanelStart < maxPanelStart && (
            <button
              className="prompt-nav-page"
              aria-label={tr("timeline.showLaterMessages")}
              title={tr("timeline.showLaterMessages")}
              onClick={() => setPanelStart((value) => Math.min(maxPanelStart, value + RAIL_PANEL_ROWS))}
            >↓</button>
          )}
        </div>
      )}
    </nav>
  );
}

// Footer under the last message once the turn ended: exactly one terminal
// turn's own start/stop and usage (UX-MSG-ACTIONS) — see turnFooterLine().

export default function Timeline({
  model,
  latestRevealTarget,
}: {
  model: RenderModel;
  /** An optional dock anchor places the latest-reveal control above the composer. */
  latestRevealTarget?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  // L13 windowing: only the last `limit` rows render (see timelineWindow.ts).
  const [limit, setLimit] = useState(TIMELINE_WINDOW);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const pendingJump = useRef<string | null>(null);
  const pendingJumpFocus = useRef(false);
  // Latest-reveal state (§2.4): true while the reader holds a position away
  // from the tail, mounting the reserved Jump to latest region.
  const [showJump, setShowJump] = useState(false);
  // UX-PANE-MODEL stable anchor: session switches adjust during render so the
  // outgoing anchor is captured from the STILL-CURRENT DOM (before commit) and
  // the incoming one is ready before the first paint of the new session.
  // Pane dock/expand/full-screen transitions never remount this tree, so the
  // live scroll position carries itself; this record covers reload + switch.
  const restoreRef = useRef<TimelineAnchor | null>(null);
  const [anchorSession, setAnchorSession] = useState<string | null | undefined>(undefined);
  if (anchorSession !== sessionId) {
    const el = ref.current;
    if (anchorSession !== undefined && anchorSession !== null && el !== null) {
      saveTimelineAnchor(anchorSession, captureTimelineAnchor(el, atBottom.current));
    }
    setAnchorSession(sessionId);
    setLimit(TIMELINE_WINDOW);
    const stored = sessionId !== null ? loadTimelineAnchor(sessionId) : null;
    restoreRef.current = stored !== null && !stored.atBottom ? stored : null;
    atBottom.current = stored?.atBottom ?? true;
    setShowJump(stored !== null && !stored.atBottom);
  }

  // Tail follow (§2.4): at/near the tail the timeline follows growth; a reader
  // who scrolled up keeps the chosen position and sees the reveal control.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    }
  }, [model.version]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    setShowJump(!near);
    if (sessionId === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const now = ref.current;
      if (now) saveTimelineAnchor(sessionId, captureTimelineAnchor(now, atBottom.current));
    }, 200);
  };

  // Debounce safety: reload and unmount flush the stable anchor immediately.
  useEffect(() => {
    if (sessionId === null) return;
    const flush = () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const el = ref.current;
      if (el) saveTimelineAnchor(sessionId, captureTimelineAnchor(el, atBottom.current));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [sessionId]);

  // One timeline live region: copy results and mutation outcomes are announced
  // as text (visual checkmarks only supplement). Identical repeats get an
  // invisible nudge so assistive tech re-announces them.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string) => {
    liveRef.current = text === liveRef.current ? `${text}\u00a0` : text;
    setLiveText(liveRef.current);
    clearTimeout(liveTimer.current);
    // The visible chip fades after the announcement has been delivered; the
    // region itself stays mounted so the next announcement still fires.
    liveTimer.current = setTimeout(() => setLiveText(""), 4000);
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  // Truthful eligibility (UX-MSG-ACTIONS): guards derive from the live render
  // model plus the authoritative queue; the server re-validates inside the
  // per-session lock, so a raced action returns a typed conflict, not a lie.
  const archived = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status === "archived");
  const pendingQuestion = model.questions.some((question) => question.status === "pending");
  const emptyCopy = archived
    ? tr("timeline.archivedSessionNoMessages")
    : pendingQuestion
      ? tr("timeline.answerPendingQuestion")
      : tr("timeline.noMessagesYet");
  const [queuedCount, setQueuedCount] = useState(0);
  useEffect(() => {
    if (!sessionId) { setQueuedCount(0); return; }
    let cancelled = false;
    void api.queueList(sessionId).then((items) => { if (!cancelled) setQueuedCount(items.length); });
    return () => { cancelled = true; };
  }, [sessionId, model.version]);
  const guards: MutationGuards = guardsFromModel(model, { queuedCount, archived });
  const revertOk = revertAvailability(guards);
  const forkOk = forkAvailability(guards);

  const visibleMessages = useMemo(() => model.messages.filter((message) => !message.undone), [model.version]);
  const undoneMessages = useMemo(() => model.messages.filter((message) => message.undone), [model.version]);
  const rows = useMemo(() => groupWork(mergeThinking(visibleMessages)), [visibleMessages]);
  const undoneRows = useMemo(() => groupWork(mergeThinking(undoneMessages)), [undoneMessages]);
  const prompts = useMemo(() => promptIndex(visibleMessages), [visibleMessages]);
  const showNav = prefs.promptNavigator === "on" || (prefs.promptNavigator === "auto" && prompts.length >= 3);
  // Regenerate resends the user prompt that produced each answer. One forward
  // pass — never a reverse scan per assistant row per streaming render.
  const regenerateSources = useMemo(() => {
    const bySeq = new Map<number, string>();
    let lastUserText: string | undefined;
    for (const message of visibleMessages) {
      if (message.kind === "user") lastUserText = message.text;
      else if (message.kind === "assistant" && lastUserText !== undefined) bySeq.set(message.eventSeq, lastUserText);
    }
    return bySeq;
  }, [visibleMessages]);
  const turn = model.turn;
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  const lastUser = [...model.messages].reverse().find((m) => m.kind === "user");

  // L13 windowing: rows render as a suffix; revealing earlier rows keeps the
  // viewport anchored (scrollTop compensates for the height that appeared
  // above), and a jump to a hidden prompt grows the window first.
  const start = windowStart(rows.length, limit);
  const shownRows = start > 0 ? rows.slice(start) : rows;
  const latestAssistantId = [...shownRows].reverse().find((row) => row.kind === "assistant")?.id;
  // A reveal activated from the keyboard can unmount its own control (the
  // final Show earlier chunk, or Show all): focus must then hand off to the
  // named timeline region — never fall to BODY (a11y criteria 6–7).
  const revealHadFocus = useRef(false);
  const reveal = (next: number) => {
    const el = ref.current;
    if (el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    const active = document.activeElement;
    revealHadFocus.current = active instanceof Element && active.closest(".timeline-earlier") !== null;
    setLimit(next);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
    const target = pendingJump.current;
    pendingJump.current = null;
    if (target) {
      const node = el?.querySelector<HTMLElement>(`[data-msg-id="${target}"]`);
      node?.scrollIntoView({ block: "center" });
      if (pendingJumpFocus.current && node) {
        node.tabIndex = -1;
        node.focus({ preventScroll: true });
      }
    }
    pendingJumpFocus.current = false;
    if (revealHadFocus.current) {
      revealHadFocus.current = false;
      // The bar survives a partial reveal and keeps focus itself; only its
      // unmount hands focus to the region (preserving the anchored position).
      if (el && el.querySelector(".timeline-earlier") === null) {
        el.focus({ preventScroll: true });
      }
    }
  }, [limit]);

  // Reapply the stored stable anchor once its row exists: grow the window to
  // include it if needed, then align the row to the remembered usable-edge
  // offset (timelineAnchor.ts owns the inset invariant). Runs every commit
  // but is a no-op unless a restore is pending.
  useLayoutEffect(() => {
    const a = restoreRef.current;
    const el = ref.current;
    if (a === null || a.id === null || el === null) return;
    const node = el.querySelector(`[data-msg-id="${a.id}"]`);
    if (node === null) {
      const index = rows.findIndex((r) => r.kind !== "work" && r.id === a.id);
      if (index >= 0) {
        const next = limitToInclude(rows.length, limit, index);
        if (next !== limit) {
          setLimit(next);
          return; // retry after the window grows
        }
      }
      if (rows.length > 0) restoreRef.current = null; // anchor row is gone
      return;
    }
    restoreRef.current = null;
    el.scrollTop += restoreScrollDelta(el, node, a);
  });
  const jump = (id: string, opts?: { focus?: boolean }) => {
    const index = rows.findIndex((r) => r.kind !== "work" && r.id === id);
    const next = limitToInclude(rows.length, limit, index);
    if (next !== limit) {
      pendingJump.current = id;
      pendingJumpFocus.current = opts?.focus === true;
      setLimit(next);
      return;
    }
    const node = ref.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    node?.scrollIntoView({ block: "center" });
    if (opts?.focus && node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  };
  // Jump to latest (§2.4): scroll to the true final surface (error/retry and
  // turn footer included — they precede the tail clearance), mark follow mode
  // active, and hand focus to the latest message container since this control
  // unmounts. Appends no event.
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
    const msgs = el.querySelectorAll<HTMLElement>(":scope > .msg");
    const target = msgs[msgs.length - 1] ?? el;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  const latestReveal = showJump && !pendingQuestion ? (
    <div className="timeline-reveal">
      <button className="jump-latest" aria-label={JUMP_TO_LATEST_NAME} title={JUMP_TO_LATEST_NAME} onClick={jumpToLatest}>↓</button>
    </div>
  ) : null;
  // Revert and edit: append the marker, then seed the composer with the exact
  // raw prompt + attachments (marker-owned; replay derives the same draft).
  const revert = (message: UserMsg) => {
    if (!sessionId) return;
    void api.rewind(sessionId, message.eventSeq).then((marker) => {
      applyEvent(marker); // WS re-delivery dedupes by seq
      const draft = {
        text: message.raw ?? message.text,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      };
      applyComposerSeed(sessionId, rewindSeedKey(marker.seq), draft);
      requestComposerReplace(draft.text);
    }).catch((err) => {
      const text = mutationErrorMessage("revert", err);
      announce(text);
      setUiError(text);
    });
  };
  // Fork and edit: navigation happens only after the child is published; a
  // failure keeps the source selected with a bounded explanation (spec).
  const fork = (message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch((err) => {
      const text = mutationErrorMessage("fork", err);
      announce(text);
      setUiError(text);
    });
  };
  // Restore original timeline. An untouched seed is cleared silently; an
  // edited draft asks first (both outcomes named in the dock confirmation).
  // Focus lands on the invoking control when it survives, otherwise on the
  // restored target's Revert action — never on BODY.
  const [confirmRestore, setConfirmRestore] = useState(false);
  const restore = (opts?: { confirmed?: boolean; invoker?: HTMLElement | null }) => {
    if (!sessionId || !model.rewind) return;
    const draftState = draftStateOf(loadSeedRecord(sessionId), loadDraft(sessionId));
    if (draftState === "edited" && !opts?.confirmed) {
      setConfirmRestore(true);
      return;
    }
    const atSeq = model.rewind.atSeq;
    const invoker = opts?.invoker ?? null;
    void api.clearRewind(sessionId).then((cleared) => {
      applyEvent(cleared);
      discardComposerSeed(sessionId);
      requestComposerReplace("");
      setConfirmRestore(false);
      announce(tr("timeline.originalTimelineRestored"));
      requestAnimationFrame(() => {
        if (invoker && document.contains(invoker)) { invoker.focus(); return; }
        const el = ref.current;
        const target = el?.querySelector<HTMLElement>(`[data-revert-seq="${atSeq}"]`)
          ?? el?.querySelector<HTMLElement>(`[data-actions-seq="${atSeq}"]`);
        if (target) { target.focus(); return; }
        if (el) { el.focus(); }
      });
    }).catch((err) => {
      const text = mutationErrorMessage("restore", err);
      announce(text);
      setUiError(text);
    });
  };

  // Bounded, already-reduced summary for the timeline before/after hosts —
  // contributions never receive live events or a mutable model reference.
  const slotSummary = {
    sessionId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
  };

  // One timeline, one scroll root (§2.1): the shell stacks the reserved
  // utility region, the single `.timeline` scrollport, and the reserved
  // latest-reveal region as normal-flow siblings. The only exception is the
  // prompt rail: `.timeline-viewport` is a non-scrolling positioning context
  // wrapping the scrollport, and the rail is an absolute SIBLING of the
  // scroller pinned to the right gutter (never over the reading column).
  return (
    <div className="timeline-shell">
      <div className="timeline-viewport">
      <div
        className="timeline"
        role="region"
        aria-label={tr("timeline.conversationTimeline")}
        tabIndex={-1}
        ref={ref}
        onScroll={onScroll}
      >
        <SlotHost slot="session.timeline.before" context={slotSummary} />
        {model.messages.length === 0 && !model.workflowRun && (
          <div className="empty">
            <div>{emptyCopy}</div>
          </div>
        )}
        {start > 0 && (
          <div className="timeline-earlier">
            <button className="small-btn" onClick={() => reveal(grownLimit(rows.length, limit))}>
              {tr("timeline.show")}{" "}{Math.min(TIMELINE_CHUNK, start)} {tr("timeline.earlier")}</button>
            <button className="small-btn" onClick={() => reveal(rows.length)}>
              {tr("timeline.showAll2")}{start} {tr("timeline.hidden")}</button>
          </div>
        )}
        {shownRows.map((r) => (
          r.kind === "work"
            ? <WorkedGroup key={r.id} g={r} />
            : (
              <MessageView
                key={r.id}
                m={r}
                plan={r.kind === "assistant" && r.id === latestAssistantId && model.tasks ? model.tasks : undefined}
                regeneratePrompt={r.kind === "assistant" ? regenerateSources.get(r.eventSeq) : undefined}
                turn={r.kind === "assistant" && r.id === latestAssistantId && turn?.status !== "working" ? turn : undefined}
                announce={announce}
                onRevert={revert}
                onFork={fork}
                revert={revertOk}
                fork={forkOk}
              />
            )
        ))}
        {model.workflowRun && <WorkflowTimelineCard run={model.workflowRun} />}
        {/* The dock confirmation sits OUTSIDE the collapsible tail: it must be
            visible even while the reverted items stay folded away. */}
        {confirmRestore && model.rewind && undoneRows.length > 0 && (
          <div className="rewound-confirm" role="group" aria-label={tr("timeline.confirmRestore")}>
            <span>{tr("timeline.youEditedTheDraftRestoringTheOriginal")}</span>
            <button
              className="small-btn"
              onClick={(event) => restore({ confirmed: true, invoker: event.currentTarget })}
            >{tr("timeline.restoreAndDiscardTheEditedDraft")}</button>
            <button className="small-btn" onClick={() => setConfirmRestore(false)}>
              {tr("timeline.keepEditingTheDraft")}</button>
          </div>
        )}
        {/* The collapsed tail exists only while the revert is ACTIVE. After a
            replacement the originals stay on disk (and out of model history)
            but no longer occupy the visible timeline. */}
        {model.rewind && undoneRows.length > 0 && (
          <details className="rewound-tail">
            <summary>
              <span>{undoneMessages.length} {tr("timeline.revertedTimeline")}{" "}{undoneMessages.length === 1 ? tr("timeline.item") : tr("timeline.items")}</span>
              {model.rewind && !confirmRestore && (
                <button
                  className="small-btn"
                  onClick={(event) => {
                    event.preventDefault();
                    restore({ invoker: event.currentTarget });
                  }}
                >{tr("timeline.restoreOriginalTimeline")}</button>
              )}
            </summary>
            <div className="rewound-tail-body">
              {undoneRows.map((row) => (
                row.kind === "work"
                  ? <WorkedGroup key={row.id} g={row} />
                  : <MessageView key={row.id} m={row} announce={announce} />
              ))}
            </div>
          </details>
        )}
        {turnBroken && (
          <div className="turn-error" role="alert">
            <span className="turn-error-text">
              {turn.status === "aborted" ? tr("timeline.turnAborted") : tr("timeline.turnFailed")}
              {turn.error ? ` — ${turn.error}` : ""}
            </span>
            {lastUser && (
              <button
                type="button"
                className="turn-error-retry"
                title={tr("timeline.retryTheLastMessage")}
                aria-label={tr("timeline.retryTheLastMessage")}
                onClick={() => void sendMessage(lastUser.text)}
              ><Icon.refresh /></button>
            )}
          </div>
        )}
        <div className="msg-live" role="status" aria-live="polite">{liveText}</div>
        <SlotHost slot="session.timeline.after" context={slotSummary} />
      </div>
      {showNav && (
        <PromptNavigator
          prompts={prompts}
          onJump={jump}
          containerRef={ref}
        />
      )}
      {latestReveal && (latestRevealTarget ? createPortal(latestReveal, latestRevealTarget) : latestReveal)}
      </div>
      <SelectionMenu container={ref} />
    </div>
  );
}
