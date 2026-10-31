import { useSyncExternalStore, type CSSProperties } from "react";
import {
  backgroundCssImage,
  documentAppearance,
  getBackground,
  subscribeAppearance,
  subscribeBackground,
} from "../../backgrounds.ts";
import { tr, type TranslationKey } from "../../i18n/index.ts";
import { SHELL_LOOKS, setUiSettings, useUiSettings, type ShellLook } from "../../uiPrefs.ts";
import { CheckIcon } from "../ui/index.ts";
import "./ShellLookPicker.css";

const LOOK_COPY: Record<ShellLook, readonly [TranslationKey, TranslationKey]> = {
  standard: ["settings.pages.shellLookStandard", "settings.pages.shellLookStandardHint"],
  paper: ["settings.pages.shellLookPaper", "settings.pages.shellLookPaperHint"],
  line: ["settings.pages.shellLookLine", "settings.pages.shellLookLineHint"],
  air: ["settings.pages.shellLookAir", "settings.pages.shellLookAirHint"],
  monolith: ["settings.pages.shellLookMonolith", "settings.pages.shellLookMonolithHint"],
  "monolith-reverse": ["settings.pages.shellLookMonolithReverse", "settings.pages.shellLookMonolithReverseHint"],
  obsidian: ["settings.pages.shellLookObsidian", "settings.pages.shellLookObsidianHint"],
  editorial: ["settings.pages.shellLookEditorial", "settings.pages.shellLookEditorialHint"],
};

/** A look restyles the shell only: the workspace background stays whatever
 *  the person chose (docs/dev/styles.md, "Interface styles"). */
export function pickShellLook(look: ShellLook): void {
  setUiSettings({ shellLook: look });
}

/** A schematic of the shell drawn in the look's own planes: navigator, the
 *  conversation with one prompt and a composer, and the right rail. It uses
 *  the active theme's tokens, so it previews the look in light or dark. */
function LookPreview({ look }: { look: ShellLook }) {
  return (
    <span className="shell-look-preview" data-look={look} aria-hidden="true">
      <span className="slp-nav"><i /><i /><i /><i /></span>
      <span className="slp-main">
        <span className="slp-msg" />
        <span className="slp-text" />
        <span className="slp-text slp-text--short" />
        <span className="slp-composer" />
      </span>
      <span className="slp-rail"><i /><i /><i /></span>
    </span>
  );
}

export function ShellLookPicker() {
  const ui = useUiSettings();
  const background = useSyncExternalStore(subscribeBackground, getBackground, getBackground);
  const appearance = useSyncExternalStore(subscribeAppearance, documentAppearance, documentAppearance);
  // Every tile stands its window on the background in use, in the current
  // theme's art: picking a look keeps it, so the tile shows what you get.
  const wall = backgroundCssImage(background, appearance);
  return (
    <div className="shell-look-grid" role="group" aria-label={tr("settings.pages.shellLook")}>
      {SHELL_LOOKS.map((look) => {
        const [name, hint] = LOOK_COPY[look];
        const selected = ui.shellLook === look;
        return (
          <button
            type="button"
            key={look}
            className="shell-look-option"
            data-shell-look-option={look}
            aria-pressed={selected}
            onClick={() => pickShellLook(look)}
          >
            <span
              className="shell-look-stage"
              data-wall={wall === "none" ? undefined : ""}
              style={wall === "none" ? undefined : { "--slp-wall": wall } as CSSProperties}
            >
              <LookPreview look={look} />
            </span>
            {selected && <span className="shell-look-check"><CheckIcon aria-hidden="true" /></span>}
            <span className="shell-look-copy">
              <strong>{tr(name)}</strong>
              <small>{tr(hint)}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
