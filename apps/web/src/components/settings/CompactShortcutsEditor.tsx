// Settings → Appearance: the ordered tool set pinned to the tablet header.
// Pinned tools fill whole slots beside the session title; the rest — and
// every unpinned tool — stay in the header's More menu.
import { tr } from "../../i18n/index.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { Icon as AppIcon } from "../../icons.tsx";
import { railIconFor } from "../../railIcons.ts";
import {
  MOBILE_SHORTCUT_IDS, UI_DEFAULTS, setUiSettings, useUiSettings, type MobileShortcutId,
} from "../../uiPrefs.ts";
import { useRailSurfaceModel } from "../ContextRail.tsx";
import { ChevronDownIcon, ChevronUpIcon, IconButton, MinusIcon, PlusIcon } from "../ui/index.ts";
import { ResetLink } from "./parts.tsx";
import "./CompactShortcutsEditor.css";

interface ShortcutRow {
  id: MobileShortcutId;
  label: string;
  icon: () => React.JSX.Element;
}

/** Labels and glyphs for every shortcut the current Space can launch. */
function useShortcutCatalog(): Map<MobileShortcutId, ShortcutRow> {
  const resolved = useResolvedCapabilities();
  const { surfaces } = useRailSurfaceModel();
  const capabilities = new Map(resolved
    .filter((capability) => capability.descriptor.rail !== false && capability.descriptor.available())
    .map((capability) => [capability.descriptor.id, capability]));
  const notifications = surfaces.find((surface) =>
    (surface.capabilityId ?? surface.id).includes("notification-centre"));
  const rows = new Map<MobileShortcutId, ShortcutRow>();
  for (const id of MOBILE_SHORTCUT_IDS) {
    if (id === "settings") {
      rows.set(id, { id, label: tr("common.settings"), icon: AppIcon.gear });
    } else if (id === "notification-centre") {
      if (notifications) rows.set(id, { id, label: notifications.title, icon: notifications.icon ?? railIconFor(id) });
    } else {
      const capability = capabilities.get(id);
      if (capability) rows.set(id, { id, label: capability.descriptor.label, icon: railIconFor(id) });
    }
  }
  return rows;
}

export function CompactShortcutsReset() {
  const ui = useUiSettings();
  const isDefault = ui.mobileShortcuts.join() === UI_DEFAULTS.mobileShortcuts.join();
  return (
    <ResetLink
      disabled={isDefault}
      onClick={() => setUiSettings({ mobileShortcuts: [...UI_DEFAULTS.mobileShortcuts] })}
    />
  );
}

export default function CompactShortcutsEditor() {
  const ui = useUiSettings();
  const catalog = useShortcutCatalog();
  const stored = ui.mobileShortcuts;
  // Ids of disabled packages stay stored (they come back with the package)
  // but are neither listed nor counted.
  const pinned = stored.filter((id) => catalog.has(id));
  const available = [...catalog.keys()].filter((id) => !stored.includes(id));
  const save = (next: MobileShortcutId[]) => setUiSettings({ mobileShortcuts: next });
  const move = (id: MobileShortcutId, step: -1 | 1) => {
    const from = pinned.indexOf(id);
    const neighbour = pinned[from + step];
    if (neighbour === undefined) return;
    const next = [...stored];
    const a = next.indexOf(id);
    const b = next.indexOf(neighbour);
    next[a] = neighbour;
    next[b] = id;
    save(next);
  };

  return (
    <div className="compact-shortcuts">
      <ol className="compact-shortcuts-list" aria-label={tr("settings.pages.compactShortcutsPinned")}>
        {pinned.map((id, index) => {
          const row = catalog.get(id)!;
          return (
            <li key={id} className="compact-shortcuts-item" data-pinned="true">
              <span className="compact-shortcuts-glyph" aria-hidden="true"><row.icon /></span>
              <span className="compact-shortcuts-name">{row.label}</span>
              <span className="compact-shortcuts-actions">
                <IconButton
                  icon={ChevronUpIcon}
                  label={tr("settings.pages.compactShortcutsMoveUp", { name: row.label })}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                />
                <IconButton
                  icon={ChevronDownIcon}
                  label={tr("settings.pages.compactShortcutsMoveDown", { name: row.label })}
                  disabled={index === pinned.length - 1}
                  onClick={() => move(id, 1)}
                />
                <IconButton
                  icon={MinusIcon}
                  label={tr("settings.pages.compactShortcutsUnpin", { name: row.label })}
                  onClick={() => save(stored.filter((item) => item !== id))}
                />
              </span>
            </li>
          );
        })}
        {pinned.length === 0 && <li className="compact-shortcuts-empty">{tr("settings.pages.compactShortcutsEmpty")}</li>}
      </ol>
      {available.length > 0 && (
        <>
          <h4 className="compact-shortcuts-heading">{tr("settings.pages.compactShortcutsAvailable")}</h4>
          <ul className="compact-shortcuts-list" aria-label={tr("settings.pages.compactShortcutsAvailable")}>
            {available.map((id) => {
              const row = catalog.get(id)!;
              return (
                <li key={id} className="compact-shortcuts-item">
                  <span className="compact-shortcuts-glyph" aria-hidden="true"><row.icon /></span>
                  <span className="compact-shortcuts-name">{row.label}</span>
                  <span className="compact-shortcuts-actions">
                    <IconButton
                      icon={PlusIcon}
                      label={tr("settings.pages.compactShortcutsPin", { name: row.label })}
                      onClick={() => save([...stored, id])}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
