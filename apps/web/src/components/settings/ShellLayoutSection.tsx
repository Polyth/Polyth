// Settings → Appearance → Window layout (shellLayout.ts). Three cards draw
// the wide window as it would look, in the current theme's colours; the
// chosen card opens its own options underneath, pointed at by a caret, so a
// layout's settings are never shown for a layout that is not in use. The
// top bar's surface belongs to the layouts that draw a bar slab, and the
// mirror, which applies to every layout, closes the section.
import type { CSSProperties, ReactNode } from "react";
import { commandHint, listCommands } from "../../commands.ts";
import { tr } from "../../i18n/index.ts";
import { useDocumentDirection } from "../../shellDirection.ts";
import {
  SHELL_LAYOUTS,
  UI_DEFAULTS,
  setUiSettings,
  useUiSettings,
  type ShellBarStyle,
  type ShellDockSide,
  type ShellLayout,
  type ShellTitlePlacement,
  type TopRailSurface,
  type UiSettings,
} from "../../uiPrefs.ts";
import { BellIcon, CheckIcon, FolderIcon, GlobeIcon, HeadingIcon, InfoIcon, SearchIcon, TerminalIcon } from "../ui/icons.ts";
import { ResetLink, Row, Section, Seg, Toggle } from "./parts.tsx";

const LAYOUT_COPY: Record<ShellLayout, { name: Parameters<typeof tr>[0]; note: Parameters<typeof tr>[0] }> = {
  classic: { name: "settings.shellLayout.classic", note: "settings.shellLayout.classicNote" },
  columns: { name: "settings.shellLayout.columns", note: "settings.shellLayout.columnsNote" },
  bare: { name: "settings.shellLayout.bare", note: "settings.shellLayout.bareNote" },
};

type LayoutPrefs = Pick<UiSettings,
  "shellLayout" | "shellBarStyle" | "floatingColumns" | "shellToolsDock" | "shellActionsDock" | "shellTitle"
  | "topRailSurface" | "mirrorLayout">;

const LAYOUT_DEFAULTS: LayoutPrefs = {
  shellLayout: UI_DEFAULTS.shellLayout,
  shellBarStyle: UI_DEFAULTS.shellBarStyle,
  floatingColumns: UI_DEFAULTS.floatingColumns,
  shellToolsDock: UI_DEFAULTS.shellToolsDock,
  shellActionsDock: UI_DEFAULTS.shellActionsDock,
  shellTitle: UI_DEFAULTS.shellTitle,
  topRailSurface: UI_DEFAULTS.topRailSurface,
  mirrorLayout: UI_DEFAULTS.mirrorLayout,
};

/** A miniature wide window: the columns, the bar (or none), the chat. Every
 *  part is a token-painted block, so the card follows theme and accent. The
 *  bar's mark is the brand, an accent dot an active tool, a pale dot any other. */
function ShellLayoutSpecimen({ layout, prefs }: { layout: ShellLayout; prefs: LayoutPrefs }) {
  const fullHeight = layout !== "classic";
  const island = layout === "columns" && prefs.shellBarStyle === "island";
  const tools = layout === "bare" ? prefs.shellToolsDock : null;
  const actions = layout === "bare" ? prefs.shellActionsDock : null;
  const dots = (count: number, accentLast = false) => Array.from({ length: count }, (_, index) => (
    <i key={index} className={`shell-spec-dot${accentLast && index === count - 1 ? " is-accent" : ""}`} />
  ));
  return (
    <span
      className="shell-spec"
      data-layout={layout}
      data-floating={fullHeight && prefs.floatingColumns ? "true" : "false"}
      aria-hidden="true"
    >
      {layout === "classic" && (
        <span className="shell-spec-band">
          <i className="shell-spec-mark" />
          <i className="shell-spec-pill is-tools" />
          <i className="shell-spec-pill is-title" />
          <span className="shell-spec-dots">{dots(3, true)}</span>
        </span>
      )}
      <span className="shell-spec-side">
        <span className="shell-spec-rail">
          {tools === "start" && <span className="shell-spec-stack">{dots(3)}</span>}
          <i className="shell-spec-tile is-active" />
          <i className="shell-spec-tile" />
          <span className="shell-spec-fill" />
          {actions === "start" && <span className="shell-spec-stack">{dots(2, true)}</span>}
          {layout === "bare" && actions !== "end" && <i className="shell-spec-avatar" />}
        </span>
        <span className="shell-spec-list">
          <i className="shell-spec-row is-head" />
          <i className="shell-spec-row" />
          <i className="shell-spec-row is-active" />
          <i className="shell-spec-row is-short" />
        </span>
      </span>
      <span className="shell-spec-main">
        {layout === "columns" && !island && (
          <span className="shell-spec-bar">
            <i className="shell-spec-pill is-tools" />
            <i className="shell-spec-pill is-title" />
            <span className="shell-spec-dots">{dots(3, true)}</span>
          </span>
        )}
        {island && (
          <span className="shell-spec-bar is-island">
            <span className="shell-spec-island"><span className="shell-spec-dots">{dots(2)}</span><i className="shell-spec-line is-title" /><span className="shell-spec-dots">{dots(2, true)}</span></span>
          </span>
        )}
        {layout === "bare" && prefs.shellTitle === "chat" && (
          <span className="shell-spec-bar is-title"><i className="shell-spec-line is-title" /></span>
        )}
        <span className="shell-spec-chat">
          <i className="shell-spec-bubble" />
          <i className="shell-spec-line" />
          <i className="shell-spec-line is-mid" />
          <i className="shell-spec-line is-short" />
        </span>
        <i className="shell-spec-composer" />
      </span>
      <span className="shell-spec-strip">
        {tools === "end" && <span className="shell-spec-stack">{dots(3)}</span>}
        <span className="shell-spec-stack">{dots(3)}</span>
        <span className="shell-spec-fill" />
        {actions === "end" && <span className="shell-spec-stack">{dots(2, true)}</span>}
        {actions === "end" && <i className="shell-spec-avatar" />}
      </span>
    </span>
  );
}

function PlaceLabel({ icons, children }: { icons: ReactNode; children: ReactNode }) {
  return (
    <span className="shell-layout-place">
      <span className="shell-layout-place-icons" aria-hidden="true">{icons}</span>
      {children}
    </span>
  );
}

export function ShellLayoutSection() {
  const ui = useUiSettings();
  // The palette's own registered hint, so a custom binding shows through.
  const paletteCommand = listCommands().find((command) => command.id === "cmd.palette");
  const paletteHint = paletteCommand ? commandHint(paletteCommand) : undefined;
  const prefs: LayoutPrefs = {
    shellLayout: ui.shellLayout,
    shellBarStyle: ui.shellBarStyle,
    floatingColumns: ui.floatingColumns,
    shellToolsDock: ui.shellToolsDock,
    shellActionsDock: ui.shellActionsDock,
    shellTitle: ui.shellTitle,
    topRailSurface: ui.topRailSurface,
    mirrorLayout: ui.mirrorLayout,
  };
  const isDefault = (Object.keys(LAYOUT_DEFAULTS) as Array<keyof LayoutPrefs>)
    .every((key) => prefs[key] === LAYOUT_DEFAULTS[key]);
  // "Left" and "right" name the columns where they are on screen: a mirrored
  // shell or a right-to-left language puts the navigator on the right.
  const navigatorOnRight = ui.mirrorLayout !== (useDocumentDirection() === "rtl");
  const startLabel = tr(navigatorOnRight ? "settings.shellLayout.rightColumn" : "settings.shellLayout.leftColumn");
  const endLabel = tr(navigatorOnRight ? "settings.shellLayout.leftColumn" : "settings.shellLayout.rightColumn");
  const sides: Array<[ShellDockSide, string]> = [
    ["start", startLabel],
    ["end", endLabel],
    ["hidden", tr("settings.shellLayout.hide")],
  ];
  const caret = SHELL_LAYOUTS.indexOf(prefs.shellLayout);
  // The island and the bare title draw no slab, so only a spread bar has a
  // surface to choose (Header.tsx forces "floating" for the other two).
  const barSlab = prefs.shellLayout === "classic" || (prefs.shellLayout === "columns" && prefs.shellBarStyle === "spread");
  const floatingRow = (
    <Row
      label={tr("settings.shellLayout.floatingColumns")}
      hint={tr("settings.shellLayout.floatingColumnsHint")}
      itemId="appearance.floatingColumns"
    >
      <Toggle
        on={prefs.floatingColumns}
        onChange={(floatingColumns) => setUiSettings({ floatingColumns })}
        label={tr("settings.shellLayout.floatingColumns")}
      />
    </Row>
  );
  return (
    <Section
      title={tr("settings.shellLayout.title")}
      hint={tr("settings.shellLayout.hint")}
      itemId="appearance.windowLayout"
      action={<ResetLink disabled={isDefault} onClick={() => setUiSettings(LAYOUT_DEFAULTS)} />}
    >
      <div className="shell-layout-picker">
        <div className="theme-style-cards shell-layout-cards" role="group" aria-label={tr("settings.shellLayout.title")}>
          {SHELL_LAYOUTS.map((layout) => (
            <button
              key={layout}
              type="button"
              className="theme-style-card shell-layout-card"
              data-layout={layout}
              aria-pressed={prefs.shellLayout === layout}
              onClick={() => setUiSettings({ shellLayout: layout })}
            >
              <ShellLayoutSpecimen layout={layout} prefs={prefs} />
              <span className="theme-style-copy">
                <strong>{tr(LAYOUT_COPY[layout].name)}</strong>
                <small>{tr(LAYOUT_COPY[layout].note)}</small>
              </span>
              {prefs.shellLayout === layout && <span className="theme-style-check"><CheckIcon aria-hidden="true" /></span>}
            </button>
          ))}
        </div>
        <div className="shell-layout-options" style={{ "--shell-layout-caret": caret } as CSSProperties}>
          {prefs.shellLayout === "columns" && (
            <Row
              label={tr("settings.shellLayout.barStyle")}
              hint={tr("settings.shellLayout.barStyleHint")}
              itemId="appearance.shellBarStyle"
            >
              <Seg<ShellBarStyle>
                value={prefs.shellBarStyle}
                label={tr("settings.shellLayout.barStyle")}
                options={[
                  ["spread", tr("settings.shellLayout.barSpread")],
                  ["island", tr("settings.shellLayout.barIsland")],
                ]}
                onChange={(shellBarStyle) => setUiSettings({ shellBarStyle })}
              />
            </Row>
          )}
          {barSlab && (
            <Row
              label={tr("settings.pages.topRailSurface")}
              hint={tr("settings.pages.topRailSurfaceHint")}
              itemId="appearance.topRailSurface"
            >
              <Seg<TopRailSurface>
                value={prefs.topRailSurface}
                label={tr("settings.pages.topRailSurface")}
                options={[
                  ["shadow", tr("settings.pages.topRailShadow")],
                  ["flat", tr("settings.pages.topRailFlat")],
                  ["floating", tr("settings.pages.topRailFloating")],
                ]}
                onChange={(topRailSurface) => setUiSettings({ topRailSurface })}
              />
            </Row>
          )}
          {prefs.shellLayout === "bare" && (
            <>
              <p className="shell-layout-options-title">{tr("settings.shellLayout.whereButtonsGo")}</p>
              <Row
                label={<PlaceLabel icons={<><FolderIcon /><GlobeIcon /><TerminalIcon /></>}>{tr("settings.shellLayout.tools")}</PlaceLabel>}
                itemId="appearance.shellToolsDock"
              >
                <Seg<ShellDockSide>
                  value={prefs.shellToolsDock}
                  label={tr("settings.shellLayout.tools")}
                  options={sides}
                  onChange={(shellToolsDock) => setUiSettings({ shellToolsDock })}
                />
              </Row>
              <Row
                label={<PlaceLabel icons={<><SearchIcon /><BellIcon /></>}>{tr("settings.shellLayout.actions")}</PlaceLabel>}
                itemId="appearance.shellActionsDock"
              >
                <Seg<ShellDockSide>
                  value={prefs.shellActionsDock}
                  label={tr("settings.shellLayout.actions")}
                  options={sides}
                  onChange={(shellActionsDock) => setUiSettings({ shellActionsDock })}
                />
              </Row>
              <Row
                label={<PlaceLabel icons={<HeadingIcon />}>{tr("settings.shellLayout.chatTitle")}</PlaceLabel>}
                itemId="appearance.shellTitle"
              >
                <Seg<ShellTitlePlacement>
                  value={prefs.shellTitle}
                  label={tr("settings.shellLayout.chatTitle")}
                  options={[
                    ["chat", tr("settings.shellLayout.titleOverChat")],
                    ["hidden", tr("settings.shellLayout.hide")],
                  ]}
                  onChange={(shellTitle) => setUiSettings({ shellTitle })}
                />
              </Row>
            </>
          )}
          {prefs.shellLayout !== "classic" && floatingRow}
          {prefs.shellLayout === "bare" && (
            <p className="shell-layout-note">
              <InfoIcon aria-hidden="true" />
              <span>
                {tr("settings.shellLayout.hiddenNote")}
                {paletteHint && <>{" "}<kbd>{paletteHint}</kbd></>}
              </span>
            </p>
          )}
        </div>
      </div>
      <Row
        label={tr("settings.pages.mirrorLayout")}
        hint={tr("settings.pages.mirrorLayoutHint")}
        itemId="appearance.mirrorLayout"
      >
        <Toggle
          on={prefs.mirrorLayout}
          onChange={(mirrorLayout) => setUiSettings({ mirrorLayout })}
          label={tr("settings.pages.mirrorLayout")}
        />
      </Row>
    </Section>
  );
}
