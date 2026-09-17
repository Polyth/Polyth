import { useRef, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { seedMultiRunPrompt } from "@polyth/multirun/prompt-seed";
import { api } from "@polyth/session/web-api";
import { fmtCost, fmtTokens } from "../format.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import {
  assistantTime,
  normalizedDuration,
  timeIso,
  timeShort,
  turnDurationMs,
  type ActionAnnounceAnchor,
} from "../messageActions.ts";
import type { AssistantMsg, RenderModel } from "../reduce.ts";
import { applyEvent, openWorkspacePane, setUiError, startNewSession, useStore } from "../store.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import ChatActionButton from "./ChatActionButton.tsx";
import SlotHost from "./slots/SlotHost.ts";
import {
  CombineIcon,
  CopyIcon,
  ImageIcon,
  InfoIcon,
  NewChatIcon,
  PinIcon,
  Popover,
  RefreshIcon,
  TasksIcon,
  type LucideIcon,
} from "./ui/index.ts";

const RESPONSE_ACTION_ICON: Record<string, LucideIcon> = {
  copy: CopyIcon,
  image: ImageIcon,
  plan: TasksIcon,
  pin: PinIcon,
  session: NewChatIcon,
  multirun: CombineIcon,
};

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

const pinnedBySource = new WeakMap<readonly SessionEvent[], Map<number, boolean>>();
function pinnedState(events: readonly SessionEvent[] | undefined, seq: number): boolean {
  if (!events) return false;
  let map = pinnedBySource.get(events);
  if (!map) {
    map = new Map();
    for (const event of events) {
      if (event.type !== "context/pinned" && event.type !== "context/unpinned") continue;
      const source = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
      if (Number.isFinite(source)) map.set(source, event.type === "context/pinned");
    }
    pinnedBySource.set(events, map);
  }
  return map.get(seq) === true;
}

export default function ChatResponseFooter({
  m,
  announce,
  statusText,
  turn,
  segmentStartedAt,
  regeneratePrompt,
}: {
  m: AssistantMsg;
  announce?: (text: string, anchor?: ActionAnnounceAnchor) => void;
  statusText?: string;
  turn?: RenderModel["turn"];
  segmentStartedAt?: number;
  regeneratePrompt?: string;
}) {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const projectId = useStore((state) => state.activeProjectId);
  const models = useStore((state) => state.models);
  const pinned = useStore((state) => pinnedState(session ? state.events[session.id] : undefined, m.eventSeq));
  const prefs = useUiSettings();
  const [pinBusy, setPinBusy] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const metadataAnchorRef = useRef<HTMLSpanElement>(null);

  const modelRef = turn?.model ?? m.model ?? session?.model;
  const harnessId = m.harnessId ?? turn?.harnessId ?? session?.resolvedHarnessId;
  const presentation = resolveModelPresentation(modelRef, models, harnessId);
  const descriptor = presentation.descriptor;
  const modelName = presentation.name;
  const agent = (turn?.agent ?? m.agent ?? session?.agent ?? tr("composer.build")).replace(/[-_]+/g, " ");
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
  const actionLabel = (id: (typeof prefs.responseActions)[number]) =>
    id === "pin" && pinned ? tr("timeline.unpinFromContext") : RESPONSE_ACTION_LABEL[id];
  const actionDisabled = (id: (typeof prefs.responseActions)[number]) =>
    (id === "pin" && pinBusy) || ((id === "plan" || id === "session") && !projectId);
  const runAction = (id: (typeof prefs.responseActions)[number]) => {
    if (id === "copy") {
      void copyText(m.text).then((ok) =>
        announce?.(ok ? tr("timeline.answerCopied") : tr("timeline.couldnTCopyAnswer"), actionAnchor));
      return;
    }
    if (id === "image") {
      announce?.(
        downloadAnswerImage(m.text, modelName) ? tr("timeline.answerImageSaved") : tr("timeline.couldnTSaveAnswerImage"),
        actionAnchor,
      );
      return;
    }
    if (id === "plan") {
      if (!projectId) return;
      void api.knowledgeCreate({
        projectId,
        kind: "plan",
        title: tr("timeline.valuePlanValue", { modelName, value: timeShort(assistantTime(m)) }),
        body: m.text,
        ...(session ? { sourceSessionId: session.id } : {}),
      }).then(() => announce?.(tr("timeline.answerSavedAsAPlan"), actionAnchor))
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
    openWorkspacePane("multirun");
  };

  return (
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
        {duration && <span className="chat-response-duration">{duration}</span>}
      </div>

      <div className="chat-response-actions" role="group" aria-label={tr("timeline.answerActions")}>
        <span ref={metadataAnchorRef} className="chat-response-info">
          <ChatActionButton
            icon={InfoIcon}
            label={tr("timeline.showResponseMetadata")}
            pressed={metadataOpen}
            aria-expanded={metadataOpen}
            aria-haspopup="dialog"
            onClick={() => setMetadataOpen((open) => !open)}
          />
        </span>
        {prefs.responseActions.map((id) => (
          <ChatActionButton
            key={id}
            icon={RESPONSE_ACTION_ICON[id]}
            label={actionLabel(id)}
            pressed={id === "pin" ? pinned : undefined}
            busy={id === "pin" && pinBusy}
            disabled={actionDisabled(id)}
            onClick={() => runAction(id)}
          />
        ))}
        {regeneratePrompt && (
          <ChatActionButton
            icon={RefreshIcon}
            label={tr("timeline.regenerateThisAssistantAnswer")}
            onClick={() => requestComposerReplace(regeneratePrompt)}
          />
        )}
        <SlotHost
          slot="session.message.actions"
          context={{
            sessionId: session?.id,
            projectId,
            messageId: String(m.eventSeq),
            messageRole: "assistant",
            messageText: m.text,
            eventSeq: m.eventSeq,
          }}
        />
        {statusText && (
          <span className="chat-action-status" role="status" aria-live="polite">{statusText}</span>
        )}
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
          {harnessId && <><dt>Harness</dt><dd>{harnessId}</dd></>}
          {(m.profileId ?? turn?.profileId) && <><dt>Profile</dt><dd><code>{m.profileId ?? turn?.profileId}</code></dd></>}
          {(m.runtimeLegId ?? turn?.runtimeLegId) && <><dt>Runtime leg</dt><dd><code>{m.runtimeLegId ?? turn?.runtimeLegId}</code></dd></>}
          <dt>{tr("timeline.agent")}</dt><dd>{agentName}</dd>
          <dt>{tr("timeline.completed")}</dt><dd><time dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time></dd>
          {hasUsage && <><dt>{tr("timeline.input")}</dt><dd>{fmtTokens(usage.input)}</dd><dt>{tr("timeline.output")}</dt><dd>{fmtTokens(usage.output)}</dd></>}
          {usage?.cacheRead ? <><dt>{tr("timeline.cached")}</dt><dd>{fmtTokens(usage.cacheRead)}</dd></> : null}
          {cost ? <><dt>{tr("timeline.cost")}</dt><dd>{fmtCost(cost)}</dd></> : null}
          {turn?.turnId ? <><dt>Run</dt><dd><code>{turn.turnId}</code></dd></> : null}
        </dl>
      </Popover>
    </footer>
  );
}
