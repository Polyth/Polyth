// Editable plugin-provided keyboard shortcuts (Settings > Shortcuts).
import { useState, type KeyboardEvent } from "react";
import { DEFAULT_KEYMAP, HOTKEY_ACTIONS, comboFromEvent, findConflicts, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { resetKeymap, setBinding, useKeymap } from "./hotkeys.ts";
import { MOD } from "../../../apps/web/src/format.ts";
import { PageHead, ResetLink, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const actionLabel = (id: HotkeyAction): string => tr(`settings.shortcutspage.action.${id}`);
import { Button, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const IS_MAC = MOD === "⌘";

// Presentation-only grouping; actions missing here fall into the first group so
// a newly added action is never hidden.
const GROUPS: ReadonlyArray<{ key: "general" | "search" | "views"; actions: readonly HotkeyAction[] }> = [
  { key: "general", actions: ["palette", "newSession", "focusComposer", "dictate", "voiceMode", "notificationCentre", "settings"] },
  { key: "search", actions: ["searchFiles", "searchWorkspace", "searchSessions", "findInConversation"] },
  { key: "views", actions: ["viewFiles", "viewGit", "viewTerminal", "splitView"] },
];

const groupTitle = (key: (typeof GROUPS)[number]["key"]): string =>
  key === "search" ? tr("settings.shortcutspage.groupSearch")
    : key === "views" ? tr("settings.shortcutspage.groupViews")
      : tr("settings.shortcutspage.groupGeneral");

const actionsIn = (key: (typeof GROUPS)[number]["key"]) => {
  const grouped = new Set(GROUPS.flatMap((group) => group.actions));
  const own = GROUPS.find((group) => group.key === key)!.actions;
  return HOTKEY_ACTIONS.filter(({ id }) => own.includes(id) || (key === "general" && !grouped.has(id)));
};

export default function ShortcutsPage() {
  const map = useKeymap();
  const [editing, setEditing] = useState<HotkeyAction | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const conflicts = new Set(findConflicts(map));
  const customized = HOTKEY_ACTIONS.some(({ id }) => map[id] !== DEFAULT_KEYMAP[id]);

  const capture = (e: KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setEditing(null); return; }
    const combo = comboFromEvent(e);
    if (!combo || !editing) return;
    setBinding(editing, combo);
    setEditing(null);
  };

  const resetAction = confirmReset ? (
    <div className="hotkeys-reset-confirm" role="group" aria-label={tr("settings.shortcutspage.resetAllConfirm")}>
      <span>{tr("settings.shortcutspage.resetAllConfirm")}</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>{tr("settings.shortcutspage.cancel")}</Button>
      <Button size="sm" variant="danger" onClick={() => { resetKeymap(); setConfirmReset(false); }}>
        {tr("settings.shortcutspage.reset")}
      </Button>
    </div>
  ) : (
    <ResetLink label={tr("settings.shortcutspage.resetAll")} disabled={!customized} onClick={() => setConfirmReset(true)} />
  );

  return (
    <div className="pkg-hotkeys">
      <PageHead blurb={tr("settings.shortcutspage.intro")} />
      <p className="hotkeys-touch-note">{tr("settings.shortcutspage.touchNote")}</p>
      {GROUPS.map(({ key }, index) => (
        <Section key={key} title={groupTitle(key)} {...(index === 0 ? { action: resetAction } : {})}>
          {actionsIn(key).map(({ id }) => {
            const combo = formatCombo(map[id], IS_MAC);
            const conflictLabels = HOTKEY_ACTIONS
              .filter((action) => action.id !== id && map[action.id] === map[id])
              .map((action) => actionLabel(action.id));
            return (
              <div key={id} className="set-row hotkey-row">
                <div className="set-row-text">
                  <div className="set-row-label">{actionLabel(id)}</div>
                  {conflicts.has(id) && (
                    <div className="set-row-hint hotkey-conflict" role="alert">
                      {tr("settings.shortcutspage.conflictsWith")}{" "}{conflictLabels.join(", ")}
                    </div>
                  )}
                </div>
                <div className="set-row-control">
                  {editing === id ? (
                    <TextInput
                      uiSize="sm"
                      autoFocus
                      data-hotkey-capture="true"
                      className="hotkey-capture"
                      value=""
                      placeholder={tr("settings.shortcutspage.pressKeys")}
                      aria-label={tr("settings.shortcutspage.pressKeysFor", { action: actionLabel(id) })}
                      onKeyDown={capture}
                      onBlur={() => setEditing(null)}
                      readOnly
                    />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`hotkey-kbd${conflicts.has(id) ? " is-conflict" : ""}`}
                      aria-label={tr("settings.shortcutspage.changeShortcutFor", { action: actionLabel(id), combo })}
                      onClick={() => setEditing(id)}
                    >
                      <kbd>{combo}</kbd>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </Section>
      ))}
    </div>
  );
}
