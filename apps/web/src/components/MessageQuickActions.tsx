import type { UserMsg } from "../reduce.ts";
import {
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  forkActionName,
  revertActionName,
  sentName,
  timeIso,
  timeShort,
  type ActionAvailability,
} from "../messageActions.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { useStore } from "../store.ts";
import SlotHost from "./slots/SlotHost.ts";
import ChatActionButton from "./ChatActionButton.tsx";
import { CopyIcon, GithubIcon, UndoIcon } from "./ui/index.ts";
import { tr } from "../i18n/index.ts";
import "./ChatChrome.css";

export default function MessageQuickActions({
  message,
  announce,
  onRevert,
  onFork,
  revert,
  fork,
}: {
  message: UserMsg;
  announce: (text: string) => void;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useStore((state) => state.activeSessionId);
  const copyFormat = prefs.messageCopyFormat;
  const copyLabel = tr("timeline.copyAsValue", {
    value: copyFormat === "markdown" ? tr("common.markdown") : tr("common.json"),
  });
  const doCopy = () => {
    void copyText(copyFormat === "markdown" ? copyMarkdown(message) : copyJson(message)).then((ok) => {
      announce(copyAnnouncement(ok ? copyFormat : "failed"));
    });
  };

  return (
    <div className="msg-meta">
      <time className="msg-time" dateTime={timeIso(message.time)} aria-label={sentName(message.time)}>
        {timeShort(message.time)}
      </time>
      {prefs.showMessageActions && (
        <div className="chat-message-actions" role="group" aria-label={tr("timeline.answerActions")}>
          <ChatActionButton
            icon={CopyIcon}
            label={copyActionName("user", copyFormat)}
            aria-description={copyLabel}
            onClick={doCopy}
          />
          {onRevert && (
            <ChatActionButton
              icon={UndoIcon}
              label={revertActionName(message.time)}
              disabled={revert?.enabled === false}
              data-revert-seq={message.eventSeq}
              onClick={() => onRevert(message)}
            />
          )}
          {onFork && (
            <ChatActionButton
              icon={GithubIcon}
              label={forkActionName(message.time)}
              disabled={fork?.enabled === false}
              onClick={() => onFork(message)}
            />
          )}
          <SlotHost
            slot="session.message.actions"
            context={{ sessionId, kind: message.kind, messageId: message.id, eventSeq: message.eventSeq }}
          />
        </div>
      )}
    </div>
  );
}
