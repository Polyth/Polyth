import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentRef, RewindFilesPreview } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { api } from "@polyth/session/web-api";
import { fmtCost, fmtTokens } from "../format.ts";
import { sendMessage } from "../init.ts";
import { selectionFeedback } from "../haptics.ts";
import { thinkingVariantLabel } from "@polyth/models/model-presentation";
import {
  assistantTime,
  dateTimeMedium,
  latencyLabel,
  normalizedDuration,
  responseTiming,
  timeIso,
  turnDurationMs,
  type ActionAnnounceAnchor,
} from "../messageActions.ts";
import type { ResponseActionId } from "../messageActionLayout.ts";
import { answerModelRef, type AssistantMsg, type RenderModel } from "../reduce.ts";
import { applyEventWithPendingSend, endPendingSend, setUiError, useStore } from "../store.ts";
import { useTimelineProjectId, useTimelineSessionId } from "../timelineSession.ts";
import { beginRegenerateMotion, cancelRewindMotion } from "../rewindMotion.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { getLocale, tr } from "../i18n/index.ts";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import MessageActionBar, { useActionConfirmation, type MessageActionDef } from "./MessageActionBar.tsx";
import { MESSAGE_ACTION_ICONS, messageActionName } from "./messageActionCatalog.ts";
import { startSessionFromText } from "./chatActionHandoffs.ts";
import { useMessagePin } from "./messagePin.ts";
import { Popover } from "./ui/index.ts";
import RewindFilesDialog, { type RewindFilesPhase } from "./RewindFilesDialog.tsx";

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
      } else line = candidate;
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

export default function ChatResponseFooter({
  m,
  announce,
  turn,
  segmentStartedAt,
  regeneratePrompt,
  inFlight = false,
}: {
  /** The answer belongs to the working turn: the live selection may label it. */
  inFlight?: boolean;
  m: AssistantMsg;
  announce?: (text: string, anchor?: ActionAnnounceAnchor) => void;
  turn?: RenderModel["turn"];
  segmentStartedAt?: number;
  regeneratePrompt?: { eventSeq: number; text: string; attachments?: AttachmentRef[] };
}) {
  // Only the fields the footer reads: every footer of the transcript would
  // otherwise re-render on each session update of a live turn (status,
  // updatedAt), which made them the costliest rows of a working chat.
  const sessionId = useTimelineSessionId();
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.id ?? null);
  // A projection arrives with a new model object even when nothing changed:
  // subscribe to its fields and rebuild one stable reference.
  const sessionProvider = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.model?.providerID);
  const sessionModelId = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.model?.modelID);
  const sessionVariant = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.model?.variant);
  const sessionModel = useMemo(() => sessionProvider !== undefined && sessionModelId !== undefined
    ? { providerID: sessionProvider, modelID: sessionModelId, ...(sessionVariant !== undefined ? { variant: sessionVariant } : {}) }
    : undefined, [sessionProvider, sessionModelId, sessionVariant]);
  const sessionHarnessId = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.resolvedHarnessId);
  const sessionAgent = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.agent);
  const projectId = useTimelineProjectId();
  const spaceId = useStore((state) => state.projectRegistry.projects.find((project) => project.id === projectId)?.spaceId);
  const models = useStore((state) => state.models);
  const pin = useMessagePin(session ?? undefined, m.eventSeq);
  const prefs = useUiSettings();
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [regenerateBusy, setRegenerateBusy] = useState(false);
  const [confirmedAction, showConfirmation] = useActionConfirmation();
  // Response details anchor to the control that opened them: the Info button
  // on the bar, or the bar itself when Info lives in the "More" menu.
  const metadataAnchorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!prefs.showAnswerQuickActions) setMetadataOpen(false);
  }, [prefs.showAnswerQuickActions]);

  // A finalized answer keeps the model recorded for it (its message, then its
  // turn). The session's current selection only labels an answer still in
  // flight; otherwise a later model switch would re-label every older answer.
  const modelRef = answerModelRef(m, turn, sessionModel, inFlight);
  const harnessId = m.harnessId ?? turn?.harnessId ?? sessionHarnessId;
  // A Relay chat's turn records the member account that ran it ("via Iryna").
  const viaAccount = m.viaAccount ?? turn?.viaAccount;
  const presentation = resolveModelPresentation(modelRef, models, harnessId);
  const descriptor = presentation.descriptor;
  const modelName = presentation.name;
  const agent = (turn?.agent ?? m.agent ?? sessionAgent ?? tr("composer.build")).replace(/[-_]+/g, " ");
  const agentName = agent ? agent[0]!.toUpperCase() + agent.slice(1) : tr("composer.build");
  const wholeTurnDuration = turnDurationMs(turn ?? null);
  const fallbackStart = segmentStartedAt && segmentStartedAt > 0 ? segmentStartedAt : m.time;
  const duration = wholeTurnDuration !== null
    ? normalizedDuration(wholeTurnDuration)
    : m.completedAt !== undefined
      ? normalizedDuration(Math.max(0, m.completedAt - fallbackStart))
      : null;
  const usage = turn?.usage?.tokens ?? m.tokens;
  const cost = turn?.usage?.cost ?? m.cost;
  const hasUsage = usage !== undefined && (usage.input > 0 || usage.output > 0);
  const effort = modelRef?.variant ? thinkingVariantLabel(modelRef.variant) : null;
  const completedAt = assistantTime(m);
  // Turn usage spans the whole turn, so its speed does too; an answer's own
  // tokens are measured over that answer's own stream.
  const timing = responseTiming({
    startedAt: m.turnStartedAt ?? turn?.startedAt,
    firstOutputAt: m.turnFirstOutputAt ?? turn?.firstOutputAt,
    endedAt: turn?.usage ? turn.stoppedAt : m.completedAt,
    outputTokens: usage?.output,
  });
  const ownSpeed = !turn?.usage && m.tokens && m.completedAt !== undefined
    ? responseTiming({ firstOutputAt: m.time, endedAt: m.completedAt, outputTokens: m.tokens.output }).tokensPerSecond
    : null;
  const tokensPerSecond = turn?.usage ? timing.tokensPerSecond : ownSpeed;
  const speed = tokensPerSecond !== null
    ? tr("timeline.metaSpeedValue", {
        value: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: tokensPerSecond < 10 ? 1 : 0 }).format(tokensPerSecond),
      })
    : null;

  const actionAnchor = { role: "assistant" as const, eventSeq: m.eventSeq };
  const responseActionsId = `chat-response-actions-${m.eventSeq}`;
  type RegenerateSource = NonNullable<typeof regeneratePrompt>;
  // Regeneration is a real history replacement, not a hidden follow-up.
  // Rewind to the source prompt first; the replacement send then branches
  // the runtime from that exact prefix. The answer starts leaving now; the
  // prompt itself never moves: its in-flight echo takes over the same
  // pixels until the canonical prompt lands (rewindMotion.ts). Rejects only
  // when the rewind itself was refused (nothing changed); a refused send
  // leaves the rewind marker to restore.
  const replaceAnswer = (
    sessionId: string,
    source: RegenerateSource,
    timeline: HTMLElement | null,
    files?: "restore",
    motion = true,
  ): Promise<void> => {
    if (motion) beginRegenerateMotion(sessionId, source.eventSeq, timeline);
    let echo: string | null = null;
    return api.rewind(sessionId, source.eventSeq, files ? { files } : undefined)
      .catch((error: unknown) => {
        if (motion) cancelRewindMotion(sessionId, source.eventSeq);
        throw error;
      })
      .then((marker) => {
        // The durable marker and its replacement echo publish in one
        // store snapshot: no frame can contain both old rows or neither
        // the cut nor the prompt.
        echo = applyEventWithPendingSend(marker, {
          sessionId,
          text: source.text,
          attachments: source.attachments ?? [],
        });
        return sendMessage(source.text, undefined, undefined, {
          targetSessionId: sessionId,
          ...(source.attachments?.length ? { attachments: source.attachments } : {}),
        }).then((ok) => {
          if (!ok) { if (echo) endPendingSend(echo); return; }
          showConfirmation("regenerate");
        }, (error: unknown) => {
          if (motion) cancelRewindMotion(sessionId, source.eventSeq);
          if (echo) endPendingSend(echo);
          setUiError(error instanceof Error ? error.message : String(error));
        });
      });
  };
  // Regenerating discards the files the replaced answer changed. When any
  // file would change, ask first and list them (RewindFilesDialog's
  // regenerate purpose); otherwise it stays the instant action it was.
  const [filesConfirm, setFilesConfirm] = useState<{
    sessionId: string;
    source: RegenerateSource;
    preview: RewindFilesPreview;
    phase: RewindFilesPhase;
    error: string | null;
  } | null>(null);
  // Mounted from the first confirmation on, so its exit can play; a footer
  // that never asked renders no dialog at all.
  const [filesConfirmMounted, setFilesConfirmMounted] = useState(false);
  const regenerateInvokerRef = useRef<HTMLElement | null>(null);
  const regenerateTimelineRef = useRef<HTMLElement | null>(null);
  const regenerate = (anchor: HTMLElement | null) => {
    if (!session || !regeneratePrompt || regenerateBusy || filesConfirm) return;
    setRegenerateBusy(true);
    const sessionId = session;
    const source = regeneratePrompt;
    const timeline = anchor?.closest<HTMLElement>(".timeline") ?? null;
    regenerateInvokerRef.current = anchor;
    regenerateTimelineRef.current = timeline;
    // An older server (or a failed preview) keeps the files-untouched
    // regeneration it always had.
    const previewing: Promise<RewindFilesPreview | null> = typeof api.previewRewindFiles === "function"
      ? api.previewRewindFiles(sessionId, source.eventSeq).catch(() => null)
      : Promise.resolve(null);
    void previewing.then((preview) => {
      if (preview?.available && preview.restore.length > 0) {
        setFilesConfirmMounted(true);
        setFilesConfirm({ sessionId, source, preview, phase: "idle", error: null });
        return;
      }
      // Nothing on disk would change. A regeneration that leaves changed
      // files behind still records why on its marker.
      const recordWhy = preview !== null && !preview.turnRunning
        && (preview.keep.length > 0 || preview.reason === "branch-changed");
      return replaceAnswer(sessionId, source, timeline, recordWhy ? "restore" : undefined)
        .catch((error: unknown) => setUiError(error instanceof Error ? error.message : String(error)));
    }).finally(() => setRegenerateBusy(false));
  };
  const runConfirmedRegenerate = (dialog: NonNullable<typeof filesConfirm>, attempts: number) => {
    // While a stopped turn settles, the dialog keeps saying so; the retried
    // rewinds play no exit motion, so a refused attempt cannot flicker.
    const running = dialog.preview.turnRunning;
    setFilesConfirm({ ...dialog, phase: running && attempts > 0 ? "stopping" : "applying", error: null });
    void replaceAnswer(dialog.sessionId, dialog.source, regenerateTimelineRef.current, "restore", !running)
      .then(() => setFilesConfirm(null))
      .catch((error: unknown) => {
        // The stop the person asked for may still be settling on the server.
        if (attempts > 0 && (error as { code?: unknown } | null)?.code === "conflict" && running) {
          window.setTimeout(() => runConfirmedRegenerate(dialog, attempts - 1), 500);
          return;
        }
        setFilesConfirm((current) => current && { ...current, phase: "idle", error: tr("timeline.regenerateFiles.error") });
      });
  };
  const confirmRegenerate = () => {
    const dialog = filesConfirm;
    if (!dialog || dialog.phase !== "idle") return;
    if (!dialog.preview.turnRunning) { runConfirmedRegenerate(dialog, 0); return; }
    // Files are written only after the turn has really stopped: stop it,
    // then retry the rewind while the server still reports it running.
    setFilesConfirm({ ...dialog, phase: "stopping", error: null });
    void api.abort(dialog.sessionId, "timeline").catch(() => undefined)
      .then(() => runConfirmedRegenerate(dialog, 60));
  };

  const action = (
    id: ResponseActionId,
    label: string,
    run: MessageActionDef<ResponseActionId>["run"],
    extra: Partial<MessageActionDef<ResponseActionId>> = {},
  ): MessageActionDef<ResponseActionId> => ({
    id,
    icon: MESSAGE_ACTION_ICONS[id],
    label,
    menuLabel: messageActionName(id),
    run,
    ...extra,
  });
  const actions: Array<MessageActionDef<ResponseActionId>> = [
    action("copy", tr("timeline.copyAnswer"), () => {
      void copyText(m.text).then((ok) => {
        const text = ok ? tr("timeline.answerCopied") : tr("timeline.couldnTCopyAnswer");
        if (ok) { selectionFeedback(); showConfirmation("copy"); }
        announce?.(text, actionAnchor);
        if (!ok) setUiError(text);
      });
    }),
    action("info", tr("timeline.showResponseMetadata"), (anchor) => {
      metadataAnchorRef.current = anchor;
      setMetadataOpen((open) => !open);
    }, { pressed: metadataOpen, expanded: metadataOpen }),
    action("image", tr("timeline.saveAsImage"), () => {
      const ok = downloadAnswerImage(m.text, modelName);
      if (ok) showConfirmation("image");
      announce?.(
        ok ? tr("timeline.answerImageSaved") : tr("timeline.couldnTSaveAnswerImage"),
        actionAnchor,
      );
    }),
  ];
  if (regeneratePrompt) {
    actions.push(action("regenerate", tr("timeline.regenerateThisAssistantAnswer"), regenerate, { busy: regenerateBusy }));
  }
  if (session) {
    actions.push(action(
      "pin",
      pin.pinned ? tr("timeline.unpinFromContext") : tr("timeline.pinIntoContext"),
      () => {
        showConfirmation("pin");
        void pin.toggle();
      },
      { pressed: pin.pinned, busy: pin.busy, menuLabel: pin.pinned ? tr("messageActions.action.unpin") : messageActionName("pin") },
    ));
  }
  if (projectId) {
    actions.push(action("session", tr("timeline.startNewSessionFromThisAnswer"), () => {
      if (startSessionFromText(projectId, m.text)) showConfirmation("session");
    }));
  }

  return (
    <>
    <footer className="chat-response-footer">
      <div className="chat-response-identity">
        <ProviderLogo
          providerID={descriptor?.providerID ?? modelRef?.providerID}
          providerName={descriptor?.providerName}
          harnessId={descriptor?.harnessId ?? harnessId}
          size="regular"
          className="chat-response-logo"
        />
        <span className="chat-response-model" title={modelName}>{modelName}</span>
        {viaAccount && (
          <span className="chat-response-account" title={tr("timeline.viaAccount", { name: viaAccount })}>
            ({viaAccount})
          </span>
        )}
        {duration && <span className="chat-response-duration">{duration}</span>}
      </div>

      <div className="chat-response-action-area">
        <MessageActionBar
          role="assistant"
          id={responseActionsId}
          className="chat-response-actions"
          layout={prefs.assistantMessageActions}
          actions={actions}
          confirmed={confirmedAction}
          label={tr("timeline.answerActions")}
          moreLabel={tr("timeline.moreResponseActions")}
          hidden={!prefs.showAnswerQuickActions}
          context={{
            sessionId: session ?? undefined,
            projectId,
            spaceId,
            kind: "assistant",
            messageId: String(m.eventSeq),
            messageRole: "assistant",
            messageText: m.text,
            eventSeq: m.eventSeq,
          }}
        />
      </div>

      <Popover
        open={metadataOpen}
        onClose={() => setMetadataOpen(false)}
        anchorRef={metadataAnchorRef}
        align="end"
        side="up"
        className="chat-response-metadata"
        ariaLabel={tr("timeline.responseMetadata")}
        restoreFocus={false}
      >
        <dl>
          <dt>{tr("timeline.metaModel")}</dt><dd>{modelName}</dd>
          {effort && <><dt>{tr("timeline.metaEffort")}</dt><dd>{effort}</dd></>}
          {harnessId && <><dt>{tr("timeline.metaHarness")}</dt><dd>{harnessId}</dd></>}
          {(m.profileId ?? turn?.profileId) && <><dt>{tr("timeline.metaProfile")}</dt><dd><code>{m.profileId ?? turn?.profileId}</code></dd></>}
          <dt>{tr("timeline.agent")}</dt><dd>{agentName}</dd>
          <dt>{tr("timeline.completed")}</dt><dd><time dateTime={timeIso(completedAt)}>{dateTimeMedium(completedAt)}</time></dd>
          {timing.ttftMs !== null && <><dt><abbr title={tr("timeline.metaTtftFull")}>{tr("timeline.metaTtft")}</abbr></dt><dd>{latencyLabel(timing.ttftMs)}</dd></>}
          {speed && <><dt>{tr("timeline.metaSpeed")}</dt><dd>{speed}</dd></>}
          {hasUsage && <><dt>{tr("timeline.input")}</dt><dd>{fmtTokens(usage.input)}</dd><dt>{tr("timeline.output")}</dt><dd>{fmtTokens(usage.output)}</dd></>}
          {usage?.cacheRead ? <><dt>{tr("timeline.cached")}</dt><dd>{fmtTokens(usage.cacheRead)}</dd></> : null}
          {cost ? <><dt>{tr("timeline.cost")}</dt><dd>{fmtCost(cost)}</dd></> : null}
        </dl>
      </Popover>
    </footer>
    {filesConfirmMounted && (
      <RewindFilesDialog
        purpose="regenerate"
        preview={filesConfirm?.preview ?? null}
        phase={filesConfirm?.phase ?? "idle"}
        error={filesConfirm?.error ?? null}
        onRestore={confirmRegenerate}
        onClose={() => setFilesConfirm(null)}
        restoreFocusRef={regenerateInvokerRef}
      />
    )}
    </>
  );
}
