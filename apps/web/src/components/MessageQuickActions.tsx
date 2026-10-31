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
import type { UserMessageActionId } from "../messageActionLayout.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { copyText } from "../utils.ts";
import { setUiError, useStore } from "../store.ts";
import { useTimelineProjectId, useTimelineSessionId } from "../timelineSession.ts";
import { tr } from "../i18n/index.ts";
import MessageActionBar, { useActionConfirmation, type MessageActionDef } from "./MessageActionBar.tsx";
import { MESSAGE_ACTION_ICONS, messageActionName } from "./messageActionCatalog.ts";
import { startSessionFromText } from "./chatActionHandoffs.ts";
import { useMessagePin } from "./messagePin.ts";

const unavailableReason = (availability?: ActionAvailability): string | undefined =>
  availability?.enabled === false ? availability.reason : undefined;

export default function MessageQuickActions({
  message,
  announce,
  onRevert,
  onFork,
  revert,
  fork,
}: {
  message: UserMsg;
  announce: (text: string, anchor?: ActionAnnounceAnchor) => void;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useTimelineSessionId();
  const projectId = useTimelineProjectId();
  const spaceId = useStore((state) => state.projectRegistry.projects.find((project) => project.id === projectId)?.spaceId);
  const pin = useMessagePin(sessionId, message.eventSeq);
  const copyFormat = prefs.messageCopyFormat;
  const [confirmed, confirm] = useActionConfirmation();
  const anchor = { role: "user" as const, eventSeq: message.eventSeq };

  const actions: Array<MessageActionDef<UserMessageActionId>> = [{
    id: "copy",
    icon: MESSAGE_ACTION_ICONS.copy,
    label: copyActionName("user", copyFormat),
    menuLabel: messageActionName("copy"),
    run: () => {
      void copyText(copyFormat === "markdown" ? copyMarkdown(message) : copyJson(message)).then((ok) => {
        const text = copyAnnouncement(ok ? copyFormat : "failed");
        if (ok) confirm("copy");
        announce(text, anchor);
        if (!ok) setUiError(text);
      });
    },
  }];
  if (onRevert) {
    const reason = unavailableReason(revert);
    actions.push({
      id: "revert",
      icon: MESSAGE_ACTION_ICONS.revert,
      label: revertActionName(message.time),
      menuLabel: messageActionName("revert"),
      ...(reason ? { disabledReason: reason } : {}),
      disabled: reason !== undefined,
      data: { "data-revert-seq": message.eventSeq },
      run: () => onRevert(message),
    });
  }
  if (onFork) {
    const reason = unavailableReason(fork);
    actions.push({
      id: "fork",
      icon: MESSAGE_ACTION_ICONS.fork,
      label: forkActionName(message.time),
      menuLabel: messageActionName("fork"),
      ...(reason ? { disabledReason: reason } : {}),
      disabled: reason !== undefined,
      run: () => onFork(message),
    });
  }
  if (sessionId) {
    actions.push({
      id: "pin",
      icon: MESSAGE_ACTION_ICONS.pin,
      label: pin.pinned
        ? tr("messagepinaction.unpinMessageFromCompactionContext")
        : tr("messagepinaction.pinMessageForCompactionContext"),
      menuLabel: pin.pinned ? tr("messageActions.action.unpin") : messageActionName("pin"),
      pressed: pin.pinned,
      busy: pin.busy,
      run: () => {
        confirm("pin");
        void pin.toggle();
      },
    });
  }
  if (projectId) {
    actions.push({
      id: "session",
      icon: MESSAGE_ACTION_ICONS.session,
      label: tr("messageActions.startSessionFromPrompt"),
      menuLabel: messageActionName("session"),
      run: () => {
        if (startSessionFromText(projectId, message.text)) confirm("session");
      },
    });
  }

  return (
    <div className="msg-meta">
      <time className="msg-time" dateTime={timeIso(message.time)} aria-label={sentName(message.time)}>
        {timeShort(message.time)}
      </time>
      {prefs.showMessageActions && (
        <MessageActionBar
          role="user"
          className="chat-message-actions"
          layout={prefs.userMessageActions}
          actions={actions}
          confirmed={confirmed}
          label={actionsMenuName(message)}
          moreLabel={tr("messageActions.more")}
          data={{ "data-actions-seq": message.eventSeq }}
          context={{
            sessionId,
            projectId,
            spaceId,
            attachments: message.attachments,
            kind: message.kind,
            messageId: message.id,
            messageRole: "user",
            messageText: message.text,
            eventSeq: message.eventSeq,
          }}
        />
      )}
    </div>
  );
}
