import type { UserMsg } from "../reduce.ts";
import {
  actionsMenuName,
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  forkActionName,
  revertActionName,
  sentName,
  timeIso,
  timeShort,
  type ActionAnnounceAnchor,
  type ActionAvailability,
} from "../messageActions.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { useStore } from "../store.ts";
import SlotHost from "./slots/SlotHost.ts";
import ChatActionButton from "./ChatActionButton.tsx";
import { CopyIcon, ForkIcon, UndoIcon } from "./ui/index.ts";

const actionLabel = (name: string, availability?: ActionAvailability): string =>
  availability?.enabled === false ? `${name}. ${availability.reason}` : name;

export default function MessageQuickActions({
  message,
  announce,
  statusText,
  onRevert,
  onFork,
  revert,
  fork,
}: {
  message: UserMsg;
  announce: (text: string, anchor?: ActionAnnounceAnchor) => void;
  statusText?: string;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useStore((state) => state.activeSessionId);
  const projectId = useStore((state) => state.activeProjectId);
  const copyFormat = prefs.messageCopyFormat;
  const doCopy = () => {
    void copyText(copyFormat === "markdown" ? copyMarkdown(message) : copyJson(message)).then((ok) => {
      announce(copyAnnouncement(ok ? copyFormat : "failed"), { role: "user", eventSeq: message.eventSeq });
    });
  };

  return (
    <div className="msg-meta">
      <time className="msg-time" dateTime={timeIso(message.time)} aria-label={sentName(message.time)}>
        {timeShort(message.time)}
      </time>
      {prefs.showMessageActions && (
        <div
          className="chat-message-actions"
          role="group"
          aria-label={actionsMenuName(message)}
          data-actions-seq={message.eventSeq}
        >
          <ChatActionButton
            icon={CopyIcon}
            label={copyActionName("user", copyFormat)}
            onClick={doCopy}
          />
          {statusText && (
            <span className="chat-action-status" role="status" aria-live="polite">{statusText}</span>
          )}
          {onRevert && (
            <ChatActionButton
              icon={UndoIcon}
              label={actionLabel(revertActionName(message.time), revert)}
              disabled={revert?.enabled === false}
              data-revert-seq={message.eventSeq}
              onClick={() => onRevert(message)}
            />
          )}
          {onFork && (
            <ChatActionButton
              icon={ForkIcon}
              label={actionLabel(forkActionName(message.time), fork)}
              disabled={fork?.enabled === false}
              onClick={() => onFork(message)}
            />
          )}
          <SlotHost
            slot="session.message.actions"
            context={{
              sessionId,
              projectId,
              kind: message.kind,
              messageId: message.id,
              messageRole: "user",
              messageText: message.text,
              eventSeq: message.eventSeq,
            }}
          />
        </div>
      )}
    </div>
  );
}
