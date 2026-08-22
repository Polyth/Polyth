// Editable plugin-provided keyboard shortcuts (Settings > Shortcuts).
import { useState, type KeyboardEvent } from "react";
import { HOTKEY_ACTIONS, comboFromEvent, findConflicts, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { resetKeymap, setBinding, useKeymap } from "../../hotkeys.ts";
import { MOD } from "../../format.ts";
import { PageHead } from "./parts.tsx";

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
      <PageHead title="Shortcuts" blurb="Plugins provide these actions. Click a binding and press a new key combo; conflicts stay visible until you resolve them. Esc cancels." />
      {HOTKEY_ACTIONS.map(({ id, label, pluginName }) => {
        const conflictLabels = HOTKEY_ACTIONS
          .filter((action) => action.id !== id && map[action.id] === map[id])
          .map((action) => action.label);
        return (
        <div key={id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{label}</div>
            <div className="set-row-hint">Provided by {pluginName} plugin</div>
            {conflicts.has(id) && (
              <div className="set-row-hint set-conflict" role="alert">
                Conflicts with {conflictLabels.join(", ")}
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
                placeholder="Press keys…"
                onKeyDown={capture}
                onBlur={() => setEditing(null)}
                readOnly
              />
            ) : (
              <button className="hotkey-kbd" title="Click to change" onClick={() => setEditing(id)}>
                <kbd>{formatCombo(map[id], IS_MAC)}</kbd>
              </button>
            )}
          </div>
        </div>
        );
      })}
      <button className="ghost-link" onClick={resetKeymap}>Reset all to defaults →</button>
    </>
  );
}
