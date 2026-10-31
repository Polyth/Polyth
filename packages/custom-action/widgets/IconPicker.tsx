// Glyph and colour for an action, chosen on one compact surface: a row of
// tints, then the glyph grid grouped by what the action is about.
import { useMemo, useRef, useState, type RefObject } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Icon, ResponsiveOverlay, SearchIcon } from "../../../apps/web/src/components/ui/index.ts";
import type { ActionColor, ActionIconId } from "../src/actionModel.ts";
import { ACTION_COLOR_ORDER, ACTION_GLYPHS, ICON_GROUPS, ICON_KEYWORDS } from "./icons.ts";

const COLOR_LABEL: Record<ActionColor, Parameters<typeof tr>[0]> = {
  accent: "customaction.color.accent",
  blue: "customaction.color.blue",
  green: "customaction.color.green",
  amber: "customaction.color.amber",
  red: "customaction.color.red",
  purple: "customaction.color.purple",
  neutral: "customaction.color.neutral",
};

const GROUP_LABEL: Record<string, Parameters<typeof tr>[0]> = {
  run: "customaction.icons.run",
  systems: "customaction.icons.systems",
  git: "customaction.icons.git",
  files: "customaction.icons.files",
  agents: "customaction.icons.agents",
  things: "customaction.icons.things",
};

export default function IconPicker({
  open,
  anchorRef,
  icon,
  color,
  onIcon,
  onColor,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  icon: ActionIconId;
  color: ActionColor;
  onIcon: (icon: ActionIconId) => void;
  onColor: (color: ActionColor) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ICON_GROUPS;
    const matches = ICON_GROUPS.flatMap((group) => group.icons).filter((id) =>
      id.includes(needle) || (ICON_KEYWORDS[id] ?? "").includes(needle));
    return [{ id: "results", icons: matches }];
  }, [query]);

  return (
    <ResponsiveOverlay
      open={open}
      onClose={() => { setQuery(""); onClose(); }}
      title={tr("customaction.editor.iconTitle")}
      anchorRef={anchorRef}
      phone="popover"
      className="ca-icon-picker-surface"
    >
      <div className="ca-icon-picker" data-color={color}>
        <div className="ca-swatches" role="radiogroup" aria-label={tr("customaction.editor.color")}>
          {ACTION_COLOR_ORDER.map((tint) => (
            <button
              key={tint}
              type="button"
              role="radio"
              aria-checked={tint === color}
              aria-label={tr(COLOR_LABEL[tint])}
              title={tr(COLOR_LABEL[tint])}
              className="ca-swatch"
              data-color={tint}
              onClick={() => onColor(tint)}
            />
          ))}
        </div>
        {/* The shared picker filter well, so this search reads like every other one. */}
        <div className="picker-search ca-icon-search">
          <span className="picker-search-icon" aria-hidden="true"><Icon icon={SearchIcon} size="sm" /></span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={tr("customaction.editor.iconSearch")}
            aria-label={tr("customaction.editor.iconSearch")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="ca-icon-groups ui-scroll">
          {groups.map((group) => (
            <section key={group.id} className="ca-icon-group" aria-label={group.id === "results" ? tr("customaction.editor.iconResults") : tr(GROUP_LABEL[group.id]!)}>
              {group.id !== "results" && <h3 className="ca-icon-group-title">{tr(GROUP_LABEL[group.id]!)}</h3>}
              <div className="ca-icon-grid" role="radiogroup" aria-label={tr("customaction.editor.icon")}>
                {group.icons.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={id === icon}
                    aria-label={id.replace(/-/g, " ")}
                    title={id.replace(/-/g, " ")}
                    className="ca-icon-choice"
                    onClick={() => onIcon(id)}
                  >
                    <Icon icon={ACTION_GLYPHS[id]} size="md" />
                  </button>
                ))}
              </div>
            </section>
          ))}
          {groups[0]?.icons.length === 0 && <p className="ca-icon-empty">{tr("customaction.editor.iconNone")}</p>}
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
