// Settings > Chat. It reads as a summary: a live preview, one Level of detail,
// then one-line rows that show their current value and open in place, one at a
// time. The rarely used settings wait under "More options". The level is derived
// from the preferences it writes, so nothing about it is stored (chatSettingsModel).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { clampPromptHistoryLimit } from "@polyth/contracts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { tr, type TranslationKey } from "../../i18n/index.ts";
import { isPromptBookmarkHome, usePromptBookmarkPosition, writePromptBookmarkPosition } from "../../promptBookmarkPosition.ts";
import { updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings, type ActivityBlockStyle } from "../../uiPrefs.ts";
import { useTouchPointer } from "../MessageActionBar.tsx";
import { Button, CheckIcon, ChevronDownIcon, ChevronUpIcon } from "../ui/index.ts";
import { ChatSettingsPreview, type ChatPreviewDevice } from "./ChatSettingsPreview.tsx";
import {
  CHAT_DETAIL_LEVELS,
  CHAT_PREVIEW_ROW,
  chatDetailLevelOf,
  chatDetailPatch,
  chatItemInMore,
  chatPreviewFocus,
  chatRowOfItem,
  type ChatDetailLevel,
  type ChatPreviewPart,
  type ChatRowId,
} from "./chatSettingsModel.ts";
import MessageActionsEditor, { useMessageActionRows } from "./MessageActionsEditor.tsx";
import { DisclosureRow, ItemList, NumberField, ResetLink, Row, Section, Seg, Toggle } from "./parts.tsx";
import "./ShellLookPicker.css";
import "./ChatSettingsPage.css";

const LEVEL_COPY: Record<ChatDetailLevel, readonly [TranslationKey, TranslationKey]> = {
  minimal: ["settings.chatPage.levelMinimal", "settings.chatPage.levelMinimalHint"],
  balanced: ["settings.chatPage.levelBalanced", "settings.chatPage.levelBalancedHint"],
  detailed: ["settings.chatPage.levelDetailed", "settings.chatPage.levelDetailedHint"],
};

const LEVEL_SCHEMATICS: Record<ChatDetailLevel, ReactNode> = {
  minimal: (
    <>
      <i className="chat-sch-user" />
      <span className="chat-sch-chip"><b /><i /></span>
      <i style={{ inlineSize: "88%" }} />
      <i style={{ inlineSize: "64%" }} />
    </>
  ),
  balanced: (
    <>
      <i className="chat-sch-user" />
      <span className="chat-sch-thread"><i className="chat-sch-faint" style={{ inlineSize: "50%" }} /><i className="chat-sch-faint" style={{ inlineSize: "38%" }} /></span>
      <i style={{ inlineSize: "86%" }} />
      <i style={{ inlineSize: "58%" }} />
    </>
  ),
  detailed: (
    <>
      <i className="chat-sch-user" />
      <span className="chat-sch-ledger"><i className="chat-sch-faint" style={{ inlineSize: "70%" }} /><i className="chat-sch-faint" style={{ inlineSize: "62%" }} /><i className="chat-sch-faint" style={{ inlineSize: "66%" }} /></span>
      <i style={{ inlineSize: "84%" }} />
    </>
  ),
};

const STEP_STYLES: ReadonlyArray<readonly [ActivityBlockStyle, TranslationKey, ReactNode]> = [
  ["thread", "settings.pages.activityStyleThread", (
    <>
      <span className="chat-sch-head"><b /><i className="chat-sch-faint" style={{ inlineSize: "46%" }} /></span>
      <span className="chat-sch-thread"><i className="chat-sch-faint" style={{ inlineSize: "70%" }} /><i className="chat-sch-faint" style={{ inlineSize: "52%" }} /><i className="chat-sch-faint" style={{ inlineSize: "60%" }} /></span>
    </>
  )],
  ["ledger", "settings.pages.activityStyleLedger", (
    <span className="chat-sch-ledger"><i className="chat-sch-faint" style={{ inlineSize: "80%" }} /><i className="chat-sch-faint" style={{ inlineSize: "72%" }} /><i className="chat-sch-faint" style={{ inlineSize: "76%" }} /></span>
  )],
  ["chip", "settings.pages.activityStyleChip", (
    <>
      <span className="chat-sch-chip"><b /><i /></span>
      <i style={{ inlineSize: "84%" }} />
      <i style={{ inlineSize: "60%" }} />
    </>
  )],
  ["margin", "settings.pages.activityStyleMargin", (
    <span className="chat-sch-margin"><b /><i className="chat-sch-faint" style={{ inlineSize: "70%" }} /><b /><i className="chat-sch-faint" style={{ inlineSize: "54%" }} /><b /><i className="chat-sch-faint" style={{ inlineSize: "62%" }} /></span>
  )],
];

/** A choice that is easier seen than described, on the Appearance look tile. */
function VisualOption({ name, hint, selected, onClick, children }: {
  name: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="shell-look-option chat-visual-option" aria-pressed={selected} onClick={onClick}>
      {selected && <span className="shell-look-check"><CheckIcon aria-hidden="true" /></span>}
      <span className="chat-sch" aria-hidden="true">{children}</span>
      <span className="shell-look-copy">
        <strong>{name}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

/** Keep a row's head where it is on screen while the rows around it change
 *  height: opening one row can close another above it, and on a narrow page the
 *  preview above folds to the part in play. Scrolling by hand ends the hold. */
function holdOnScreen(head: HTMLElement, durationMs: number): () => void {
  const scroller = head.closest<HTMLElement>(".settings-pane-body");
  if (!scroller || typeof requestAnimationFrame !== "function") return () => undefined;
  const top = head.getBoundingClientRect().top;
  const started = performance.now();
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    scroller.removeEventListener("wheel", stop);
    scroller.removeEventListener("touchstart", stop);
  };
  const tick = (now: number) => {
    const drift = head.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift;
    if (now - started < durationMs) frame = requestAnimationFrame(tick);
    else stop();
  };
  scroller.addEventListener("wheel", stop, { passive: true });
  scroller.addEventListener("touchstart", stop, { passive: true });
  frame = requestAnimationFrame(tick);
  return stop;
}

/** Bring a whole opened row into view without moving it further than needed,
 *  under the preview when the preview is stuck above the page. */
function revealRow(row: HTMLElement, preview: HTMLElement | null): void {
  const scroller = row.closest<HTMLElement>(".settings-pane-body");
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const frame = preview?.getBoundingClientRect();
  const stuckAbove = frame && frame.right > box.left && frame.left < box.right && frame.bottom <= box.top + 1 ? frame.height : 0;
  const gap = 8;
  const topEdge = view.top + stuckAbove + gap;
  const bottomEdge = view.bottom - gap;
  const delta = box.top < topEdge
    ? box.top - topEdge
    : box.bottom > bottomEdge
      ? Math.min(box.bottom - bottomEdge, box.top - topEdge)
      : 0;
  if (Math.abs(delta) < 1) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    || document.documentElement.dataset.reduceAnimations === "true";
  scroller.scrollBy({ top: delta, behavior: still ? "auto" : "smooth" });
}

export function ChatPage({ settingsTarget }: { settingsTarget?: SettingsNavigationTarget } = {}) {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  const touchPointer = useTouchPointer();
  const bookmarkPosition = usePromptBookmarkPosition();
  const target = settingsTarget?.itemId;
  const [openRow, setOpenRow] = useState<ChatRowId | null>(() => chatRowOfItem(target));
  const [moreOpen, setMoreOpen] = useState(() => chatItemInMore(target));
  // A routed target lands on its setting's final position, so its row opens at
  // once; the routed effect in SettingsView scrolls to it on the next frames.
  const [animateRows, setAnimateRows] = useState(!target);
  const [device, setDevice] = useState<ChatPreviewDevice>(touchPointer ? "phone" : "computer");
  const pageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const stopHold = useRef<() => void>(() => undefined);
  const revealWhenOpen = useRef<ChatRowId | null>(null);

  useEffect(() => {
    if (!target) return;
    const row = chatRowOfItem(target);
    if (row) {
      setAnimateRows(false);
      setOpenRow(row);
    }
    if (chatItemInMore(target)) setMoreOpen(true);
  }, [target]);

  useEffect(() => () => stopHold.current(), []);

  const revealOpenRow = (row: ChatRowId) => {
    // The hold ends here: it would read this scroll as drift and undo it.
    stopHold.current();
    const element = pageRef.current?.querySelector<HTMLElement>(`[data-disclosure-row="${row}"]`);
    if (element) revealRow(element, previewRef.current);
  };

  const showRow = (row: ChatRowId) => {
    // Show the device these settings are about: the title is the phone's, and
    // the rail needs a wide window unless a phone bookmark shows.
    if (row === "header") setDevice("phone");
    if (row === "navigation" && !ui.pinLatestPrompt) setDevice("computer");
    if (openRow === row) {
      revealOpenRow(row);
      return;
    }
    revealWhenOpen.current = row;
    setAnimateRows(true);
    setOpenRow(row);
  };

  const toggleRow = (row: ChatRowId) => (head: HTMLElement) => {
    stopHold.current();
    if (openRow === row) {
      stopHold.current = holdOnScreen(head, 240);
      revealWhenOpen.current = null;
      setAnimateRows(true);
      setOpenRow(null);
    } else {
      // Until the row has grown and revealed itself; a slow render takes longer.
      stopHold.current = holdOnScreen(head, 1200);
      showRow(row);
    }
  };

  const onRowOpened = (row: ChatRowId) => () => {
    if (revealWhenOpen.current !== row) return;
    revealWhenOpen.current = null;
    revealOpenRow(row);
  };

  const onPreviewPick = (part: ChatPreviewPart) => {
    if (part !== "answer") {
      showRow(CHAT_PREVIEW_ROW[part]);
      return;
    }
    // The answer's one setting sits on the page: point at it.
    revealWhenOpen.current = null;
    setAnimateRows(true);
    setOpenRow(null);
    const width = pageRef.current?.querySelector<HTMLElement>('[data-settings-item="chat.width"]');
    if (!width) return;
    width.scrollIntoView({ block: "nearest" });
    width.classList.add("flash");
    window.setTimeout(() => width.classList.remove("flash"), 1600);
  };

  const rowProps = (row: ChatRowId) => ({
    rowId: row,
    open: openRow === row,
    animate: animateRows,
    onToggle: toggleRow(row),
    onOpened: onRowOpened(row),
  });

  const level = chatDetailLevelOf(ui);
  const applyLevel = (next: ChatDetailLevel) => setUiSettings(chatDetailPatch(next, ui));
  const levelOptions = CHAT_DETAIL_LEVELS.map((id) => [id, tr(LEVEL_COPY[id][0])] as [ChatDetailLevel | "custom", string]);

  const thinkingOptions: Array<[typeof ui.thinkingDisplayMode, string]> = [
    ["collapsed", tr("settings.pages.collapsibleThinking")],
    ["expanded", tr("settings.pages.expandedThinking")],
    ...(ui.actionGrouping === "grouped"
      ? [["activity", tr("settings.pages.hideThinkingInActivity")] as [typeof ui.thinkingDisplayMode, string]]
      : []),
  ];
  const followUpOptions: Array<[typeof ui.followUpBehavior, string]> = [
    ["steer", tr("settings.pages.steer")],
    ["queue", tr("composer.queue")],
    ["interrupt", tr("settings.pages.interrupt")],
  ];
  const pasteOptions: Array<[typeof ui.largeTextPasteBehavior, string]> = [
    ["ask", tr("settings.pages.largePasteAsk")],
    ["attach", tr("composer.largePasteAttach")],
    ["inline", tr("composer.largePasteInline")],
  ];
  const mobileTitleOptions: Array<[typeof ui.mobileSessionTitle, string]> = [
    ["hidden", tr("settings.pages.mobileSessionTitleHidden")],
    ["title", tr("settings.pages.mobileSessionTitleOnly")],
    ["button", tr("settings.pages.mobileSessionTitleButton")],
  ];
  const mobileSendOptions: Array<[typeof settings.mobileSendShortcut, string]> = [
    ["none", tr("settings.pages.sendButtonOnly")],
    ["enter", "Enter"],
    ["shift-enter", "Shift+Enter"],
  ];

  const optionLabel = <T,>(options: ReadonlyArray<readonly [T, string]>, value: T) =>
    options.find(([id]) => id === value)?.[1] ?? "";
  const desktopKey = settings.desktopSendShortcut === "enter" ? "Enter" : "Shift+Enter";
  const phoneSend = optionLabel(mobileSendOptions, settings.mobileSendShortcut);
  const sendValue = `${desktopKey} · ${settings.mobileSendShortcut === "none"
    ? tr("settings.chatPage.sendPhoneButton")
    : tr("settings.chatPage.sendPhoneKey", { key: phoneSend })}`;
  const userActions = useMessageActionRows("user");
  const replyActions = useMessageActionRows("assistant");
  const actionsValue = (rows: typeof userActions) => {
    if (!rows.show) return tr("settings.quickActions.placeOff");
    const resolved = rows.resolve(touchPointer);
    const count = resolved.bar.length + resolved.menu.length;
    if (count === 0) return tr("settings.chatPage.noButtons");
    const buttons = count === 1 ? tr("settings.chatPage.oneButton") : tr("settings.chatPage.buttonCount", { count });
    const reveal = resolved.mode === "always"
      ? tr("settings.chatPage.revealAlways")
      : resolved.mode === "hover"
        ? tr("settings.chatPage.revealHover")
        : tr("settings.chatPage.revealMenu");
    return `${buttons} · ${reveal}`;
  };
  const composerValue = [
    ui.showDictate ? tr("settings.chatPage.valueDictation") : "",
    ui.showQuickActions ? tr("settings.pages.composerQuickActions") : "",
  ].filter(Boolean).join(" · ") || tr("common.none");
  const bookmarkOn = ui.pinLatestPrompt || ui.promptBookmarkDesktop;
  const navigationValue = [
    ui.promptNavigator === "off"
      ? ""
      : ui.promptNavigatorSide === "left" ? tr("settings.chatPage.railLeft") : tr("settings.chatPage.railRight"),
    bookmarkOn ? tr("settings.chatPage.valueBookmark") : "",
  ].filter(Boolean).join(" · ") || tr("settings.quickActions.placeOff");
  const previewNote = openRow === "send"
    ? device === "phone" ? phoneSend : desktopKey
    : openRow === "followUp"
      ? optionLabel(followUpOptions, ui.followUpBehavior)
      : openRow === "paste"
        ? optionLabel(pasteOptions, ui.largeTextPasteBehavior)
        : undefined;

  return (
    <div ref={pageRef} className="chat-settings">
      <div className="chat-settings-layout">
        <aside
          ref={previewRef}
          className="chat-settings-aside"
          aria-label={tr("settings.chatPage.previewLabel")}
          data-focus={openRow ? "true" : undefined}
        >
          <ChatSettingsPreview
            focus={chatPreviewFocus(openRow, ui)}
            device={device}
            onDevice={setDevice}
            note={previewNote}
            onPick={onPreviewPick}
          />
        </aside>
        <div className="chat-settings-main">
          <Section
            title={tr("settings.chatPage.level")}
            itemId="chat.detailLevel"
            action={(
              <>
                {level === null && <span className="chat-level-custom">{tr("settings.chatPage.levelCustom")}</span>}
                <ResetLink disabled={level === "balanced"} onClick={() => applyLevel("balanced")} />
              </>
            )}
          >
            <div className="shell-look-grid chat-level-tiles" role="group" aria-label={tr("settings.chatPage.level")}>
              {CHAT_DETAIL_LEVELS.map((id) => (
                <VisualOption
                  key={id}
                  name={tr(LEVEL_COPY[id][0])}
                  hint={tr(LEVEL_COPY[id][1])}
                  selected={level === id}
                  onClick={() => applyLevel(id)}
                >
                  {LEVEL_SCHEMATICS[id]}
                </VisualOption>
              ))}
            </div>
            <div className="chat-level-compact">
              <Seg<ChatDetailLevel | "custom">
                label={tr("settings.chatPage.level")}
                value={level ?? "custom"}
                options={levelOptions}
                onChange={(next) => { if (next !== "custom") applyLevel(next); }}
              />
              <p>{level ? tr(LEVEL_COPY[level][1]) : tr("settings.chatPage.levelCustomHint")}</p>
            </div>
          </Section>

          <Section title={tr("settings.chatPage.conversationGroup")}>
            <ItemList>
              <DisclosureRow
                {...rowProps("steps")}
                label={tr("settings.chatPage.agentSteps")}
                value={ui.actionGrouping === "ungrouped"
                  ? tr("settings.chatPage.stepsEach")
                  : tr(STEP_STYLES.find(([id]) => id === ui.activityBlockStyle)?.[1] ?? "settings.pages.activityStyleThread")}
              >
                <Row hint={tr("settings.chatPage.agentStepsHint")} layout="stacked" itemId="chat.activityStyle">
                  {ui.actionGrouping === "grouped" && (
                    <div className="shell-look-grid chat-step-styles" role="group" aria-label={tr("settings.pages.activityBlockStyle")}>
                      {STEP_STYLES.map(([id, name, schematic]) => (
                        <VisualOption
                          key={id}
                          name={tr(name)}
                          selected={ui.activityBlockStyle === id}
                          onClick={() => setUiSettings({ activityBlockStyle: id })}
                        >
                          {schematic}
                        </VisualOption>
                      ))}
                    </div>
                  )}
                </Row>
                <Row label={tr("settings.chatPage.groupSteps")} itemId="chat.actionBlocks">
                  <Toggle
                    on={ui.actionGrouping === "grouped"}
                    onChange={(on) => setUiSettings({ actionGrouping: on ? "grouped" : "ungrouped" })}
                    label={tr("settings.chatPage.groupSteps")}
                  />
                </Row>
              </DisclosureRow>
              <DisclosureRow
                {...rowProps("thinking")}
                label={tr("settings.chatPage.thinking")}
                value={optionLabel(thinkingOptions, ui.thinkingDisplayMode)}
              >
                <Row hint={tr("settings.pages.thinkingBlocksHint")} layout="stacked" itemId="chat.thinking">
                  <Seg
                    label={tr("settings.chatPage.thinking")}
                    value={ui.thinkingDisplayMode}
                    options={thinkingOptions}
                    onChange={(thinkingDisplayMode) => setUiSettings({ thinkingDisplayMode })}
                  />
                </Row>
              </DisclosureRow>
              <DisclosureRow
                label={tr("settings.chatPage.width")}
                itemId="chat.width"
                control={(
                  <Seg
                    label={tr("settings.chatPage.width")}
                    value={ui.chatWidth}
                    options={[
                      ["normal", tr("settings.pages.normal")],
                      ["wide", tr("settings.pages.wide")],
                      ["ultrawide", tr("settings.pages.ultraWide")],
                    ]}
                    onChange={(chatWidth) => setUiSettings({ chatWidth })}
                  />
                )}
              />
            </ItemList>
          </Section>

          <Section title={tr("settings.chatPage.typingGroup")}>
            <ItemList>
              <DisclosureRow {...rowProps("send")} label={tr("settings.chatPage.sendWith")} value={sendValue}>
                <Row label={tr("settings.pages.desktopSendShortcut")} hint={tr("settings.pages.sendShortcutHint")} itemId="chat.sendOnEnter">
                  <Seg
                    label={tr("settings.pages.desktopSendShortcut")}
                    value={settings.desktopSendShortcut}
                    options={[["enter", "Enter"], ["shift-enter", "Shift+Enter"]]}
                    onChange={(desktopSendShortcut) => {
                      setDevice("computer");
                      updateSettings({ desktopSendShortcut, sendOnEnter: desktopSendShortcut === "enter" });
                    }}
                  />
                </Row>
                <Row label={tr("settings.pages.mobileSendShortcut")} hint={tr("settings.pages.mobileSendShortcutHint")} itemId="chat.mobileSendShortcut">
                  <Seg
                    label={tr("settings.pages.mobileSendShortcut")}
                    value={settings.mobileSendShortcut}
                    options={mobileSendOptions}
                    onChange={(mobileSendShortcut) => {
                      setDevice("phone");
                      updateSettings({ mobileSendShortcut });
                    }}
                  />
                </Row>
              </DisclosureRow>
              <DisclosureRow
                {...rowProps("followUp")}
                label={tr("settings.pages.whileTheAgentIsWorking")}
                value={optionLabel(followUpOptions, ui.followUpBehavior)}
              >
                <Row hint={tr("settings.pages.whatEnterDoesDuringAnActiveTurn")} layout="stacked" itemId="chat.followUp">
                  <Seg
                    label={tr("settings.pages.whileTheAgentIsWorking")}
                    value={ui.followUpBehavior}
                    options={followUpOptions}
                    onChange={(followUpBehavior) => setUiSettings({ followUpBehavior })}
                  />
                </Row>
              </DisclosureRow>
              <DisclosureRow
                {...rowProps("paste")}
                label={tr("settings.chatPage.longPastes")}
                value={optionLabel(pasteOptions, ui.largeTextPasteBehavior)}
              >
                <Row hint={tr("settings.pages.largePasteHint")} layout="stacked" itemId="chat.largePaste">
                  <Seg
                    label={tr("settings.chatPage.longPastes")}
                    value={ui.largeTextPasteBehavior}
                    options={pasteOptions}
                    onChange={(largeTextPasteBehavior) => setUiSettings({ largeTextPasteBehavior })}
                  />
                </Row>
              </DisclosureRow>
            </ItemList>
          </Section>

          <Section title={tr("settings.chatPage.buttonsGroup")}>
            <ItemList>
              {/* Both roles use one editor so their quick actions configure identically. */}
              <DisclosureRow {...rowProps("userActions")} label={tr("settings.chatPage.underYourMessages")} value={actionsValue(userActions)}>
                <MessageActionsEditor role="user" itemId="chat.messageActions" onDevice={setDevice} />
              </DisclosureRow>
              <DisclosureRow {...rowProps("replies")} label={tr("settings.chatPage.underAgentReplies")} value={actionsValue(replyActions)}>
                <MessageActionsEditor role="assistant" itemId="chat.responseActions" onDevice={setDevice} />
              </DisclosureRow>
              <DisclosureRow {...rowProps("composer")} label={tr("settings.pages.composerGroup")} value={composerValue}>
                <Row label={tr("settings.pages.dictationButton")} hint={tr("settings.pages.dictationButtonHint")} itemId="chat.showDictate">
                  <Toggle on={ui.showDictate} onChange={(showDictate) => setUiSettings({ showDictate })} label={tr("settings.pages.dictationButton")} />
                </Row>
                <Row label={tr("settings.pages.composerQuickActions")} hint={tr("settings.pages.composerQuickActionsHint")} itemId="chat.showQuickActions">
                  <Toggle on={ui.showQuickActions} onChange={(showQuickActions) => setUiSettings({ showQuickActions })} label={tr("settings.pages.composerQuickActions")} />
                </Row>
              </DisclosureRow>
              <DisclosureRow {...rowProps("navigation")} label={tr("settings.pages.promptNavigatorGroup")} value={navigationValue}>
                <Row label={tr("settings.pages.promptRail")} hint={tr("settings.pages.promptRailHint")} itemId="chat.promptNavigator">
                  <Toggle
                    on={ui.promptNavigator !== "off"}
                    onChange={(on) => {
                      setDevice("computer");
                      setUiSettings({ promptNavigator: on ? "auto" : "off" });
                    }}
                    label={tr("settings.pages.promptRail")}
                  />
                </Row>
                {ui.promptNavigator !== "off" && (
                  <Row label={tr("settings.pages.promptRailSide")} hint={tr("settings.pages.promptRailSideHint")} itemId="chat.promptNavigatorSide">
                    <Seg
                      label={tr("settings.pages.promptRailSide")}
                      value={ui.promptNavigatorSide}
                      options={[
                        ["left", tr("settings.pages.promptNavigatorSideLeft")],
                        ["right", tr("settings.pages.promptNavigatorSideRight")],
                      ]}
                      onChange={(promptNavigatorSide) => {
                        setDevice("computer");
                        setUiSettings({ promptNavigatorSide });
                      }}
                    />
                  </Row>
                )}
                <Row label={tr("settings.pages.promptBookmarkMobile")} hint={tr("settings.pages.promptBookmarkMobileHint")} itemId="chat.pinLatestPrompt">
                  <Toggle
                    on={ui.pinLatestPrompt}
                    onChange={(pinLatestPrompt) => {
                      setDevice("phone");
                      setUiSettings({ pinLatestPrompt });
                    }}
                    label={tr("settings.pages.promptBookmarkMobile")}
                  />
                </Row>
                <Row label={tr("settings.pages.promptBookmarkDesktop")} hint={tr("settings.pages.promptBookmarkDesktopHint")} itemId="chat.promptBookmarkDesktop">
                  <Toggle
                    on={ui.promptBookmarkDesktop}
                    onChange={(promptBookmarkDesktop) => {
                      setDevice("computer");
                      setUiSettings({ promptBookmarkDesktop });
                    }}
                    label={tr("settings.pages.promptBookmarkDesktop")}
                  />
                </Row>
                {bookmarkOn && (
                  <Row label={tr("settings.pages.pinLatestPromptPosition")} hint={tr("settings.pages.bookmarkPositionPlainHint")} itemId="chat.pinLatestPromptPosition">
                    <Button
                      size="sm"
                      disabled={isPromptBookmarkHome(bookmarkPosition)}
                      title={tr("timeline.promptBookmarkMoveHint")}
                      onClick={() => writePromptBookmarkPosition(null)}
                    >{tr("settings.pages.pinLatestPromptPositionReset")}</Button>
                  </Row>
                )}
              </DisclosureRow>
              <DisclosureRow
                {...rowProps("header")}
                label={tr("settings.pages.mobileSessionTitle")}
                value={optionLabel(mobileTitleOptions, ui.mobileSessionTitle)}
              >
                <Row hint={tr("settings.pages.mobileSessionTitleHint")} layout="stacked" itemId="chat.mobileSessionTitle">
                  <Seg
                    label={tr("settings.pages.mobileSessionTitle")}
                    value={ui.mobileSessionTitle}
                    options={mobileTitleOptions}
                    onChange={(mobileSessionTitle) => setUiSettings({ mobileSessionTitle })}
                  />
                </Row>
              </DisclosureRow>
            </ItemList>
          </Section>

          <div className="chat-settings-more">
            <Button
              variant="ghost"
              size="sm"
              className="settings-disclosure-toggle"
              iconEnd={moreOpen ? ChevronUpIcon : ChevronDownIcon}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              {tr("settings.chatPage.moreOptions")}
            </Button>
            {!moreOpen && (
              <small>
                {[tr("settings.pages.copyFormat"), tr("settings.pages.promptHistory"), tr("settings.pages.sessionActivityDetails")].join(" · ")}
              </small>
            )}
          </div>
          {moreOpen && (
            <div className="chat-settings-more-body">
              <Row label={tr("settings.pages.copyFormat")} hint={tr("settings.pages.chooseThePayloadUsedByTheSingle")} itemId="chat.copyFormat">
                <Seg
                  value={ui.messageCopyFormat}
                  options={[["markdown", tr("common.markdown")], ["json", tr("common.json")]]}
                  onChange={(messageCopyFormat) => setUiSettings({ messageCopyFormat })}
                />
              </Row>
              <Row label={tr("settings.pages.promptHistory")} hint={tr("settings.pages.promptHistoryHint")} itemId="chat.promptHistory">
                <Seg
                  value={ui.promptHistoryScope}
                  options={[
                    ["session", tr("settings.pages.promptHistoryScopeSession")],
                    ["space", tr("settings.pages.promptHistoryScopeSpace")],
                  ]}
                  onChange={(promptHistoryScope) => setUiSettings({ promptHistoryScope })}
                />
              </Row>
              <Row label={tr("settings.pages.promptHistoryLimit")} hint={tr("settings.pages.promptHistoryLimitHint")} itemId="chat.promptHistoryLimit">
                <NumberField
                  value={ui.promptHistoryLimit}
                  min={1}
                  max={200}
                  label={tr("settings.pages.promptHistoryLimit")}
                  onCommit={(next) => setUiSettings({ promptHistoryLimit: clampPromptHistoryLimit(next, ui.promptHistoryLimit) })}
                />
              </Row>
              <Row label={tr("settings.pages.sessionActivityDetails")} hint={tr("settings.pages.sessionActivityDetailsHint")} itemId="chat.activityDetails">
                <Seg
                  value={ui.sessionActivityDetails}
                  options={[
                    ["tabs", tr("settings.pages.sessionActivityTabs")],
                    ["all", tr("settings.pages.sessionActivityAll")],
                  ]}
                  onChange={(sessionActivityDetails) => setUiSettings({ sessionActivityDetails })}
                />
              </Row>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
