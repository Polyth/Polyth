// The live preview beside Settings > Chat: a small sample conversation drawn
// from the same preferences the real one reads, so a change shows at once. While
// a row is open everything but the part it changes dims; a click on a part opens
// its row. Every setting is reachable from its row, so the sample itself is a
// pointer shortcut, hidden from assistive technology and not a focus stop.
import type { ReactNode } from "react";
import { tr } from "../../i18n/index.ts";
import type { MessageActionRole } from "../../messageActionLayout.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import { useTouchPointer } from "../MessageActionBar.tsx";
import {
  ArrowUpIcon,
  BookmarkIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  Icon,
  IconButton,
  MarkdownIcon,
  MenuIcon,
  MicIcon,
  MonitorIcon,
  MoreIcon,
  NewChatIcon,
  PlusIcon,
  SmartphoneIcon,
  SuccessIcon,
  TerminalIcon,
  type LucideIcon,
} from "../ui/index.ts";
import type { ChatPreviewPart } from "./chatSettingsModel.ts";
import { useMessageActionRows } from "./MessageActionsEditor.tsx";

export type ChatPreviewDevice = "computer" | "phone";

export interface ChatSettingsPreviewProps {
  /** The parts that stay lit; empty while no row is open. */
  focus: readonly ChatPreviewPart[];
  device: ChatPreviewDevice;
  onDevice: (device: ChatPreviewDevice) => void;
  /** What a setting without a look of its own currently does (the send key…). */
  note?: string | undefined;
  onPick: (part: ChatPreviewPart) => void;
}

function Part({ id, focus, onPick, children }: {
  id: ChatPreviewPart;
  focus: readonly ChatPreviewPart[];
  onPick: (part: ChatPreviewPart) => void;
  children: ReactNode;
}) {
  // The send button lives in the composer, which stays lit around it.
  const lit = focus.includes(id) || (id === "composer" && focus.includes("send"));
  // Stuck above a narrow page only the lit part shows; these give it a place:
  // reply buttons under their answer, rail ticks beside a prompt.
  const context = (id === "answer" && focus.includes("replies")) || (id === "user" && focus.includes("rail"));
  return (
    <div
      className="chat-preview-part"
      data-part={id}
      data-focused={lit ? "true" : undefined}
      data-context={context ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onPick(id);
      }}
    >
      {children}
    </div>
  );
}

function PreviewActions({ role, phone, leading }: { role: MessageActionRole; phone: boolean; leading?: ReactNode }) {
  const { show, info, resolve } = useMessageActionRows(role);
  const resolved = resolve(phone);
  return (
    <div className="chat-preview-actions" data-reveal={resolved.mode}>
      {leading}
      {show && resolved.bar.map((id) => <Icon key={id} icon={info(id).icon} size="sm" />)}
      {show && resolved.menu.length > 0 && <Icon icon={MoreIcon} size="sm" />}
    </div>
  );
}

function StepRow({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="chat-preview-step">
      <Icon icon={icon} size="sm" />
      <span>{children}</span>
    </li>
  );
}

function PreviewSteps() {
  const ui = useUiSettings();
  const thoughtInBlock = ui.thinkingDisplayMode === "activity";
  const steps = (
    <>
      <StepRow icon={MarkdownIcon}>{tr("settings.chatPage.sampleRead")}</StepRow>
      <StepRow icon={EditIcon}>
        {tr("settings.chatPage.sampleEdited")}{" "}
        <span className="chat-preview-add">+18</span>{" "}
        <span className="chat-preview-del">−4</span>
      </StepRow>
      <StepRow icon={TerminalIcon}>{tr("settings.chatPage.sampleRan")}</StepRow>
      {thoughtInBlock && <StepRow icon={BrainIcon}>{tr("settings.chatPage.sampleThought")}</StepRow>}
    </>
  );
  if (ui.actionGrouping === "ungrouped") {
    return <ol className="chat-preview-steps" data-style="ungrouped">{steps}</ol>;
  }
  const summary = (
    <div className="chat-preview-summary">
      <Icon icon={SuccessIcon} size="sm" />
      <span>{tr("settings.chatPage.sampleWorked")}</span>
    </div>
  );
  // A chip is the look that hugs its words, so it is shown folded.
  if (ui.activityBlockStyle === "chip") {
    return <div className="chat-preview-steps" data-style="chip">{summary}</div>;
  }
  return (
    <div className="chat-preview-steps" data-style={ui.activityBlockStyle}>
      {summary}
      <ol>{steps}</ol>
    </div>
  );
}

export function ChatSettingsPreview({ focus, device, onDevice, note, onPick }: ChatSettingsPreviewProps) {
  const ui = useUiSettings();
  const touch = useTouchPointer();
  const phone = device === "phone";
  // Rail ticks need a wide window; the bookmark has its own switch per width.
  const railShown = !phone && ui.promptNavigator !== "off";
  const bookmarkShown = phone ? ui.pinLatestPrompt : ui.promptBookmarkDesktop;
  return (
    <div className="chat-preview-frame">
      <div className="chat-preview" data-device={device} data-focus={focus.length > 0 ? "true" : undefined} data-width={ui.chatWidth}>
        <div className="chat-preview-head">
          <span>{tr("settings.chatPage.previewLabel")}</span>
          <div className="chat-preview-devices" role="group" aria-label={tr("settings.quickActions.previewDevice")}>
            <IconButton icon={MonitorIcon} size="sm" label={tr("settings.quickActions.previewComputer")} pressed={!phone} onClick={() => onDevice("computer")} />
            <IconButton icon={SmartphoneIcon} size="sm" label={tr("settings.quickActions.previewTouch")} pressed={phone} onClick={() => onDevice("phone")} />
          </div>
        </div>
        <div className="chat-preview-stage" aria-hidden="true">
          <Part id="header" focus={focus} onPick={onPick}>
            {phone ? (
              <div className="chat-preview-header" data-title-mode={ui.mobileSessionTitle}>
                <Icon icon={MenuIcon} size="sm" />
                {ui.mobileSessionTitle !== "hidden" && <strong>{tr("settings.chatPage.sampleTitle")}</strong>}
                <span className="chat-preview-header-actions">
                  <Icon icon={NewChatIcon} size="sm" />
                  <Icon icon={MoreIcon} size="sm" />
                </span>
              </div>
            ) : (
              <div className="chat-preview-header">
                <strong>{tr("settings.chatPage.sampleTitle")}</strong>
              </div>
            )}
          </Part>
          <div className="chat-preview-column">
            {(railShown || bookmarkShown) && (
              <Part id="rail" focus={focus} onPick={onPick}>
                {railShown && (
                  <div className="chat-preview-rail" data-side={ui.promptNavigatorSide}><i /><i /><i /><i /></div>
                )}
                {bookmarkShown && (
                  <div className="chat-preview-bookmark"><Icon icon={BookmarkIcon} size="sm" /></div>
                )}
              </Part>
            )}
            <Part id="user" focus={focus} onPick={onPick}>
              <div className="chat-preview-user">
                <div className="chat-preview-bubble">{tr("settings.quickActions.sampleUser")}</div>
                <PreviewActions role="user" phone={phone} leading={<time>12:41</time>} />
              </div>
            </Part>
            <Part id="steps" focus={focus} onPick={onPick}><PreviewSteps /></Part>
            {ui.thinkingDisplayMode !== "activity" && (
              <Part id="thinking" focus={focus} onPick={onPick}>
                <div className="chat-preview-thought" data-open={ui.thinkingDisplayMode === "expanded" ? "true" : undefined}>
                  <span className="chat-preview-thought-toggle">
                    {tr("settings.chatPage.sampleThought")}
                    <Icon icon={ui.thinkingDisplayMode === "expanded" ? ChevronDownIcon : ChevronRightIcon} size="sm" />
                  </span>
                  {ui.thinkingDisplayMode === "expanded" && <p>{tr("settings.chatPage.sampleThinking")}</p>}
                </div>
              </Part>
            )}
            <Part id="answer" focus={focus} onPick={onPick}>
              <p className="chat-preview-answer">{tr("settings.chatPage.sampleAnswer")}</p>
            </Part>
            <Part id="replies" focus={focus} onPick={onPick}>
              <PreviewActions role="assistant" phone={phone} />
            </Part>
          </div>
          <Part id="composer" focus={focus} onPick={onPick}>
            <div className="chat-preview-composer-wrap" data-status-style={ui.composerStatusStyle}>
              <div className="chat-preview-status">
                <i />
                <span>{tr("settings.chatPage.sampleStatus")}</span>
              </div>
              <div className="chat-preview-composer">
                <Icon icon={PlusIcon} size="sm" />
                <span className="chat-preview-placeholder">{tr("composer.askAnything")}</span>
                {note && <kbd className="chat-preview-note">{note}</kbd>}
                {ui.showDictate && <Icon icon={MicIcon} size="sm" />}
                <span
                  className="chat-preview-send"
                  data-part="send"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick("send");
                  }}
                >
                  <Icon icon={ArrowUpIcon} size="sm" />
                </span>
              </div>
            </div>
          </Part>
        </div>
      </div>
      <p className="chat-preview-caption">
        {tr(touch ? "settings.chatPage.previewHintTap" : "settings.chatPage.previewHintClick")}
      </p>
    </div>
  );
}
