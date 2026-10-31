import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { api } from "@polyth/session/web-api";
import { fmtCost, fmtTokens } from "../format.ts";
import { sendMessage } from "../init.ts";
import {
  assistantTime,
  normalizedDuration,
  timeIso,
  timeShort,
  turnDurationMs,
  type ActionAnnounceAnchor,
} from "../messageActions.ts";
import type { ResponseActionId } from "../messageActionLayout.ts";
import type { AssistantMsg, RenderModel } from "../reduce.ts";
import { applyEventWithPendingSend, endPendingSend, setUiError, useStore } from "../store.ts";
import { useTimelineProjectId, useTimelineSessionId } from "../timelineSession.ts";
import { beginRegenerateMotion, cancelRewindMotion } from "../rewindMotion.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import MessageActionBar, { useActionConfirmation, type MessageActionDef } from "./MessageActionBar.tsx";
import { MESSAGE_ACTION_ICONS, messageActionName } from "./messageActionCatalog.ts";
import { startSessionFromText } from "./chatActionHandoffs.ts";
import { useMessagePin } from "./messagePin.ts";
import { Popover } from "./ui/index.ts";

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
  dormant = false,
  identity = true,
}: {
  m: AssistantMsg;
  announce?: (text: string, anchor?: ActionAnnounceAnchor) => void;
  turn?: RenderModel["turn"];
  segmentStartedAt?: number;
  regeneratePrompt?: { eventSeq: number; text: string; attachments?: AttachmentRef[] };
  /** A later turn is working: keep the footer's box, show nothing. */
  dormant?: boolean;
  /** False on an answer a later row of the same turn follows: only the
   *  quick actions show; the identity panel stays one per turn. */
  identity?: boolean;
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

  const modelRef = turn?.model ?? m.model ?? sessionModel;
  const harnessId = m.harnessId ?? turn?.harnessId ?? sessionHarnessId;
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

  const actionAnchor = { role: "assistant" as const, eventSeq: m.eventSeq };
  const responseActionsId = `chat-response-actions-${m.eventSeq}`;
  const regenerate = (anchor: HTMLElement | null) => {
    if (!session || !regeneratePrompt || regenerateBusy) return;
    setRegenerateBusy(true);
    // Regeneration is a real history replacement, not a hidden
    // follow-up. Rewind to the source prompt first; the replacement
    // send then branches the runtime from that exact prefix. The
    // answer starts leaving now; the prompt itself never moves: its
    // in-flight echo takes over the same pixels until the canonical
    // prompt lands (rewindMotion.ts).
    const sessionId = session;
    beginRegenerateMotion(sessionId, regeneratePrompt.eventSeq, anchor?.closest<HTMLElement>(".timeline") ?? null);
    let echo: string | null = null;
    void api.rewind(sessionId, regeneratePrompt.eventSeq)
      .then((marker) => {
        // The durable marker and its replacement echo publish in one
        // store snapshot: no frame can contain both old rows or
        // neither the cut nor the prompt.
        echo = applyEventWithPendingSend(marker, {
          sessionId,
          text: regeneratePrompt.text,
          attachments: regeneratePrompt.attachments ?? [],
        });
        return sendMessage(regeneratePrompt.text, undefined, undefined, {
          targetSessionId: sessionId,
          ...(regeneratePrompt.attachments?.length ? { attachments: regeneratePrompt.attachments } : {}),
        });
      })
      .then((ok) => {
        // A refused replacement leaves the rewind marker to restore.
        if (!ok) { if (echo) endPendingSend(echo); return; }
        showConfirmation("regenerate");
      })
      .catch((error) => {
        cancelRewindMotion(sessionId, regeneratePrompt.eventSeq);
        if (echo) endPendingSend(echo);
        setUiError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setRegenerateBusy(false));
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
        if (ok) showConfirmation("copy");
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

  // An actions-only footer with its actions turned off would be an empty row.
  if (!identity && !prefs.showAnswerQuickActions) return null;

  return (
    <footer
      className="chat-response-footer"
      data-dormant={dormant || undefined}
      data-actions-only={identity ? undefined : "true"}
    >
      {identity && <div className="chat-response-identity">
        <ProviderLogo
          providerID={descriptor?.providerID ?? modelRef?.providerID}
          providerName={descriptor?.providerName}
          harnessId={descriptor?.harnessId ?? harnessId}
          size="regular"
          className="chat-response-logo"
        />
        <span className="chat-response-model" title={modelName}>{modelName}</span>
        {duration && <span className="chat-response-duration">{duration}</span>}
      </div>}

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
          {harnessId && <><dt>{tr("timeline.metaHarness")}</dt><dd>{harnessId}</dd></>}
          {(m.profileId ?? turn?.profileId) && <><dt>{tr("timeline.metaProfile")}</dt><dd><code>{m.profileId ?? turn?.profileId}</code></dd></>}
          {(m.runtimeLegId ?? turn?.runtimeLegId) && <><dt>{tr("timeline.metaRuntimeLeg")}</dt><dd><code>{m.runtimeLegId ?? turn?.runtimeLegId}</code></dd></>}
          <dt>{tr("timeline.agent")}</dt><dd>{agentName}</dd>
          <dt>{tr("timeline.completed")}</dt><dd><time dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time></dd>
          {hasUsage && <><dt>{tr("timeline.input")}</dt><dd>{fmtTokens(usage.input)}</dd><dt>{tr("timeline.output")}</dt><dd>{fmtTokens(usage.output)}</dd></>}
          {usage?.cacheRead ? <><dt>{tr("timeline.cached")}</dt><dd>{fmtTokens(usage.cacheRead)}</dd></> : null}
          {cost ? <><dt>{tr("timeline.cost")}</dt><dd>{fmtCost(cost)}</dd></> : null}
          {turn?.turnId ? <><dt>{tr("timeline.metaRun")}</dt><dd><code>{turn.turnId}</code></dd></> : null}
        </dl>
      </Popover>
    </footer>
  );
}
