import type { CSSProperties } from "react";
import { tr } from "../i18n/index.ts";
import { PROJECT_COLORS } from "../projectIdentity.ts";
import "./ProjectAppearanceDialog.css";

/** The project colour row: the palette plus a custom colour. */
export default function ProjectColorPresets({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const current = value.toLocaleLowerCase();
  return (
    <div className="project-color-presets" role="group" aria-label={tr("projectappearancedialog.color")}>
      {PROJECT_COLORS.map((preset) => (
        <button
          key={preset}
          type="button"
          className={current === preset ? "selected" : ""}
          style={{ "--swatch-color": preset } as CSSProperties}
          aria-label={tr("projectappearancedialog.colorValue", { value: preset })}
          aria-pressed={current === preset}
          onClick={() => onChange(preset)}
        />
      ))}
      <label className={`project-color-custom${(PROJECT_COLORS as readonly string[]).includes(current) ? "" : " selected"}`} title={tr("projectappearancedialog.customColor")}>
        <input type="color" value={value} aria-label={tr("projectappearancedialog.color")} onChange={(event) => onChange(event.target.value)} />
        <span aria-hidden="true" />
      </label>
    </div>
  );
}
