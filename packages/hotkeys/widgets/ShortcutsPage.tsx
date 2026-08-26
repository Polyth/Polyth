// Editable plugin-provided keyboard shortcuts (Settings > Shortcuts).
import { useState, type KeyboardEvent } from "react";
import { HOTKEY_ACTIONS, comboFromEvent, findConflicts, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { resetKeymap, setBinding, useKeymap } from "./hotkeys.ts";
import { MOD } from "../../../apps/web/src/format.ts";
import { PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const IS_MAC = MOD === "⌘";

export default function ShortcutsPage() {
  const map = useKeymap();
  const [editing, setEditing] = useState<HotkeyAction | null>(null);
  const conflicts = new Set(findConflicts(map));

  const capture = (e: KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setEditing(null); return; }
    const combo = comboFromEvent(e);
    if (!combo || !editing) return;
    setBinding(editing, combo);
    setEditing(null);
  };

  return (
    <>
      <PageHead title={tr("settings.shortcutspage.shortcuts")} blurb={tr("settings.shortcutspage.pluginsProvideTheseActionsClickABinding")} />
      {HOTKEY_ACTIONS.map(({ id, label, pluginName }) => {
        const conflictLabels = HOTKEY_ACTIONS
          .filter((action) => action.id !== id && map[action.id] === map[id])
          .map((action) => action.label);
        return (
        <div key={id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{label}</div>
            <div className="set-row-hint">{tr("settings.shortcutspage.providedBy")}{" "}{pluginName} {tr("settings.shortcutspage.plugin")}</div>
            {conflicts.has(id) && (
              <div className="set-row-hint set-conflict" role="alert">
                {tr("settings.shortcutspage.conflictsWith")}{" "}{conflictLabels.join(", ")}
              </div>
            )}
          </div>
          <div className="set-row-control">
            {editing === id ? (
              <input
                autoFocus
                data-hotkey-capture="true"
                className="hotkey-capture"
                value=""
                placeholder={tr("settings.shortcutspage.pressKeys")}
                onKeyDown={capture}
                onBlur={() => setEditing(null)}
                readOnly
              />
            ) : (
              <button className="hotkey-kbd" title={tr("settings.shortcutspage.clickToChange")} onClick={() => setEditing(id)}>
                <kbd>{formatCombo(map[id], IS_MAC)}</kbd>
              </button>
            )}
          </div>
        </div>
        );
      })}
      <button className="ghost-link" onClick={resetKeymap}>{tr("settings.shortcutspage.resetAllToDefaults")}</button>
    </>
  );
}
