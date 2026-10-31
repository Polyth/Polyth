// The person's composer on an agent's page: Chat's composer material with the
// controls a conversation with an agent needs — files, where the message goes
// (on in the current conversation or a new one), queueing behind a run that
// works, Stop, a kept draft and recall of the last message.
import {
  useEffect, useRef, useState,
  type ClipboardEvent, type KeyboardEvent,
} from "react";
import type { AttachmentRef } from "@polyth/contracts";
import type { AgentContinuationDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { isImeComposing } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { useStore, setUiError } from "../../../apps/web/src/store.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { matchesSendShortcut } from "../../../apps/web/src/settings.ts";
import { getUiSettings } from "../../../apps/web/src/uiPrefs.ts";
import { isLargeTextPaste, MAX_PENDING_ATTACHMENTS, PASTED_TEXT_NAME, uploadInboxFile } from "../../../apps/web/src/attachments.ts";
import AttachmentPills from "../../../apps/web/src/components/AttachmentPills.tsx";
import {
  AttachmentIcon, ChevronDownIcon, Icon, IconButton, Menu, NewChatIcon, QueueSendIcon, ReplyIcon, SendIcon,
  Spinner, StopIcon, Textarea, type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
// The box takes no more than the agent keeps, so what was sent is what the
// run shows.
import { AGENT_INPUT_LIMIT } from "../src/agentThread.ts";
import { continuesInto } from "./agentThreads.ts";

// ---- the kept draft ----------------------------------------------------------
// Presentation only: the unsent words for each agent, on this device.

const DRAFTS_KEY = "polyth.agents.drafts.v1";

function readDrafts(): Record<string, string> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DRAFTS_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function readAgentDraft(agentId: string): string {
  const text = readDrafts()[agentId];
  return typeof text === "string" ? text : "";
}

export function writeAgentDraft(agentId: string, text: string): void {
  const drafts = readDrafts();
  if (text.trim()) drafts[agentId] = text.slice(0, AGENT_INPUT_LIMIT);
  else delete drafts[agentId];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* private mode keeps the field only */ }
}

// ---- where the message goes ------------------------------------------------------

/** "13:40" today, "Yesterday 13:40", else "Mon 13:40". */
export function exchangeLabel(at: number, now = Date.now()): string {
  const locale = getLocale();
  const time = new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) return time;
  const days = Math.ceil((today.getTime() - at) / (24 * 60 * 60_000));
  if (days <= 1) {
    const yesterday = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return `${yesterday} ${time}`;
  }
  return `${new Date(at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export interface ThreadChoice {
  /** Where the message lands as things stand. */
  target: "continue" | "new";
  /** The person may choose the other way. */
  canContinue: boolean;
  /** When the conversation it continues last moved. */
  at?: number;
  reason?: string;
}

/** What the composer says about where a message goes, from the agent's
 *  `followUp` and the person's choice. */
export function threadChoice(
  agent: Pick<ScheduleTaskDto, "followUp" | "target">,
  continuation: AgentContinuationDto,
  now = Date.now(),
): ThreadChoice {
  const followUp = agent.followUp;
  const into = continuesInto(followUp, now);
  // A conversation that only went quiet may still be continued on request.
  const lapsed = !into && !!followUp?.sessionId;
  const canContinue = !!into || lapsed || followUp?.reason === "idle";
  const at = followUp?.at;
  if (continuation === "new") return { target: "new", canContinue, ...(at ? { at } : {}) };
  if (into || (continuation === "continue" && canContinue)) return { target: "continue", canContinue, ...(at ? { at } : {}) };
  return {
    target: "new",
    canContinue,
    ...(at ? { at } : {}),
    reason: lapsed ? "idle" : followUp?.reason ?? "none",
  };
}

const REASON_KEYS: Partial<Record<string, Parameters<typeof tr>[0]>> = {
  idle: "agents.freshIdle",
  "instructions-changed": "agents.freshInstructions",
  "context-full": "agents.freshContextFull",
  compacted: "agents.freshCompacted",
  unavailable: "agents.freshUnavailable",
  asked: "agents.freshAsked",
};

/** The quiet chip under the editor: where the message goes, and the menu to
 *  send it the other way. */
function ThreadChip({ agent, continuation, onChange }: {
  agent: ScheduleTaskDto;
  continuation: AgentContinuationDto;
  onChange: (next: AgentContinuationDto) => void;
}) {
  // The chip changes by itself only when the follow-up window lapses.
  const until = agent.followUp?.until;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (typeof until !== "number") return;
    const wait = until - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [until, agent.followUp?.sessionId]);
  const choice = threadChoice(agent, continuation, now);
  const rolling = agent.target?.mode === "dedicated-session";
  const when = choice.at ? exchangeLabel(choice.at, now) : "";
  const label = choice.target === "continue"
    ? (rolling || !when ? tr("agents.threadContinues") : tr("agents.threadContinuesValue", { time: when }))
    : tr("agents.threadNew");
  const why = choice.target === "new" && choice.reason && REASON_KEYS[choice.reason] ? tr(REASON_KEYS[choice.reason]!) : "";
  const entries: MenuEntry[] = [
    {
      id: "continue",
      kind: "radio",
      checked: choice.target === "continue",
      disabled: !choice.canContinue,
      icon: ReplyIcon,
      label: rolling || !when ? tr("agents.threadContinueAction") : tr("agents.threadContinueActionValue", { time: when }),
      detail: choice.canContinue ? tr("agents.threadContinueDetail") : why || tr("agents.threadNothingToContinue"),
      onSelect: () => onChange("continue"),
    },
    {
      id: "new",
      kind: "radio",
      checked: choice.target === "new",
      icon: NewChatIcon,
      label: tr("agents.threadNewAction"),
      detail: tr("agents.threadNewDetail"),
      onSelect: () => onChange("new"),
    },
  ];
  return (
    <Menu label={tr("agents.threadMenu")} title={tr("agents.threadMenu")} align="start" entries={entries}>
      {(trigger) => (
        <button
          {...trigger}
          type="button"
          className="config-chip agent-thread-chip"
          data-target={choice.target}
          title={why ? `${label} · ${why}` : label}
        >
          <span className="config-chip-icon" aria-hidden="true">
            <Icon icon={choice.target === "continue" ? ReplyIcon : NewChatIcon} size="sm" />
          </span>
          <span className="config-chip-text">{label}</span>
          <span className="config-chip-caret" aria-hidden="true"><Icon icon={ChevronDownIcon} size="sm" /></span>
        </button>
      )}
    </Menu>
  );
}

// ---- the composer --------------------------------------------------------------

export interface AgentMessage {
  text: string;
  attachments: AttachmentRef[];
  continuation: AgentContinuationDto;
}

/** Files dropped on the conversation, for the agent they were dropped on. */
export interface DroppedFiles { batch: number; agentId: string; files: File[] }

/** One agent's composer. The page keys it by agent, so nothing typed,
 *  attached or in flight carries over to another agent. */
export default function AgentComposer({ agent, name, placeholder, disabled, running, onSend, onStop, files }: {
  agent: ScheduleTaskDto;
  name: string;
  placeholder: string;
  /** The agent cannot take messages (its version waits for review). */
  disabled: boolean;
  /** A run works now: a message waits for it; Stop ends it. */
  running: boolean;
  onSend: (message: AgentMessage) => Promise<boolean>;
  onStop: () => Promise<void>;
  /** Files dropped on the conversation, handed in by the page. */
  files?: DroppedFiles | null;
}) {
  const phone = useShellMode() === "phone";
  const settings = useStore((state) => state.settings);
  const [text, setText] = useState(() => readAgentDraft(agent.id));
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [continuation, setContinuation] = useState<AgentContinuationDto>("auto");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { writeAgentDraft(agent.id, text); }, [agent.id, text]);

  const attach = (picked: readonly File[]): void => {
    const room = MAX_PENDING_ATTACHMENTS - attachments.length - uploading;
    const batch = picked.slice(0, Math.max(0, room));
    if (picked.length > batch.length) {
      setUiError(tr("agents.tooManyFilesValue", { count: MAX_PENDING_ATTACHMENTS }), null, undefined, "info");
    }
    for (const file of batch) {
      setUploading((count) => count + 1);
      void uploadInboxFile(agent.projectId, null, file).then((result) => {
        if (!result.ok) {
          setUiError(tr("agents.couldNotAttachValue", { name: file.name || "file", reason: result.reason }));
          return;
        }
        // An upload that finishes after the person left this agent is dropped.
        if (mounted.current) setAttachments((current) => [...current, result.ref].slice(0, MAX_PENDING_ATTACHMENTS));
      }).finally(() => { if (mounted.current) setUploading((count) => Math.max(0, count - 1)); });
    }
  };
  // A batch dropped before this composer existed (on another agent) is not
  // taken: only a new drop on this agent is.
  const handedIn = useRef<number | null>(files?.batch ?? null);
  useEffect(() => {
    if (!files || handedIn.current === files.batch) return;
    handedIn.current = files.batch;
    if (files.agentId === agent.id) attach(files.files);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const empty = !text.trim() && attachments.length === 0;
  const submit = async (): Promise<void> => {
    if (empty || sending || disabled || uploading > 0) return;
    const message: AgentMessage = { text: text.trim().slice(0, AGENT_INPUT_LIMIT).trimEnd(), attachments, continuation };
    const target = agent.id;
    // The feed shows the words from this moment while the server admits the
    // run, so the box empties now. A refused message comes back ahead of
    // anything typed since, to the agent it was written to: into the box, or
    // into that agent's kept draft when the person has moved on.
    setText("");
    setAttachments([]);
    setContinuation("auto");
    setSending(true);
    const ahead = (current: string) => current.trim() ? `${message.text}\n\n${current}` : message.text;
    try {
      if (await onSend(message)) return;
      if (mounted.current) {
        setText(ahead);
        setAttachments((current) => [...message.attachments, ...current].slice(0, MAX_PENDING_ATTACHMENTS));
        setContinuation(message.continuation);
      } else if (message.text) {
        writeAgentDraft(target, ahead(readAgentDraft(target)));
      }
    } finally {
      if (mounted.current) {
        setSending(false);
        keepFocus();
      }
    }
  };
  const stop = async (): Promise<void> => {
    setStopping(true);
    try { await onStop(); } finally {
      if (mounted.current) {
        setStopping(false);
        keepFocus();
      }
    }
  };
  /** A busy Send or a Stop that goes away drops keyboard focus to the page;
   *  it comes back to the box (not on a phone, where it would raise the
   *  keyboard unasked). */
  const keepFocus = (): void => {
    if (phone) return;
    const active = document.activeElement;
    const form = field.current?.form;
    if (!active || active === document.body || (form && form.contains(active))) {
      requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    }
  };

  /** The last thing the person said to this agent, for ↑ in an empty box. */
  const lastSaid = (): string | undefined =>
    [...(agent.history ?? [])].sort((a, b) => b.startedAt - a.startedAt).find((run) => run.input?.trim())?.input;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that commits an IME candidate (Safari: keyCode 229) never sends.
    if (isImeComposing(event)) return;
    if (event.key === "ArrowUp" && !text && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const last = lastSaid();
      if (last) {
        event.preventDefault();
        setText(last);
      }
      return;
    }
    if (event.key !== "Enter") return;
    const shortcut = phone ? settings.mobileSendShortcut : settings.desktopSendShortcut;
    if (event.metaKey || event.ctrlKey || matchesSendShortcut(shortcut, event.shiftKey)) {
      event.preventDefault();
      void submit();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (pasted.length) {
      event.preventDefault();
      attach(pasted);
      return;
    }
    // A long log or document goes as a file, as in Chat (unless the person
    // keeps long pastes inline); the box itself holds what the agent keeps.
    const words = event.clipboardData?.getData("text/plain") ?? "";
    if (isLargeTextPaste(words) && getUiSettings().largeTextPasteBehavior !== "inline") {
      event.preventDefault();
      attach([new File([words], PASTED_TEXT_NAME, { type: "text/plain" })]);
    }
  };

  const sendLabel = running ? tr("agents.sendAfterRun") : tr("agents.talkSend");
  return (
    <form
      className="agent-composer ui-field-frame"
      data-running={running || undefined}
      aria-label={tr("agents.composerLabelValue", { name })}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      {(attachments.length > 0 || uploading > 0) && (
        <div className="agent-composer-files">
          {attachments.length > 0 && (
            <AttachmentPills
              attachments={attachments}
              onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
            />
          )}
          {uploading > 0 && (
            <span className="agent-composer-uploading" role="status">
              <Spinner size="sm" />
              {tr("agents.uploadingValue", { count: uploading })}
            </span>
          )}
        </div>
      )}
      <Textarea
        ref={field}
        className="agent-composer-input"
        autoGrow
        minRows={1}
        maxRows={10}
        value={text}
        maxLength={AGENT_INPUT_LIMIT}
        disabled={disabled}
        aria-label={tr("agents.talkPlaceholderValue", { name })}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="agent-composer-bar">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            if (picked.length) attach(picked);
          }}
        />
        <IconButton
          icon={AttachmentIcon}
          size={phone ? "lg" : "sm"}
          className="agent-composer-attach"
          label={tr("agents.attachFiles")}
          disabled={disabled || attachments.length + uploading >= MAX_PENDING_ATTACHMENTS}
          onClick={() => fileInput.current?.click()}
        />
        {/* An agent that works in one chosen chat has nowhere else to go. */}
        {agent.target?.mode !== "existing-session" && (
          <ThreadChip agent={agent} continuation={continuation} onChange={setContinuation} />
        )}
        <span className="agent-composer-actions">
          {running && (
            <IconButton
              icon={StopIcon}
              size={phone ? "lg" : "sm"}
              className="agent-composer-stop"
              label={tr("agents.stop")}
              busy={stopping}
              disabled={stopping}
              onClick={() => void stop()}
            />
          )}
          <IconButton
            icon={running ? QueueSendIcon : SendIcon}
            type="submit"
            className="agent-composer-send"
            label={sendLabel}
            title={sendLabel}
            busy={sending}
            disabled={disabled || sending || empty || uploading > 0}
          />
        </span>
      </div>
    </form>
  );
}
