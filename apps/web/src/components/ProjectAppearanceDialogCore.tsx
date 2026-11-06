import { useState, type CSSProperties } from "react";
import type { Project } from "@polyth/contracts";
import { saveProjectAppearanceOptimistic } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import { persistProjectIcon, storedProjectIconSelection } from "../projectIconPicker.ts";
import { loadProjectIconSvg } from "../projectIconLoader.ts";
import { DEFAULT_PROJECT_COLOR } from "../projectIdentity.ts";
import ProjectColorPresets from "./ProjectColorPresets.tsx";
import ProjectIconPickerField, { IconArt } from "./ProjectIconPickerField.tsx";
import { SaveBar } from "./settings/parts.tsx";
import {
  BackIcon,
  Button,
  CloseIcon,
  Dialog,
  Switch,
  IconButton,
  TextInput,
} from "./ui/index.ts";
import "./ProjectAppearanceDialog.css";

// "" hides the hero greeting, null restores the built-in line.
const greetingPatch = (shown: boolean, text: string): string | null => shown ? (text.trim() || null) : "";

export default function ProjectAppearanceDialog({
  project,
  onBack,
  onClose,
  inline = false,
}: {
  project: Project;
  onBack?: () => void;
  onClose?: () => void;
  inline?: boolean;
}) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(() => storedProjectIconSelection(project.icon));
  const [color, setColor] = useState(project.color ?? DEFAULT_PROJECT_COLOR);
  const [greetingShown, setGreetingShown] = useState(project.greeting !== "");
  const [greeting, setGreeting] = useState(project.greeting ?? "");
  // Inline (Settings) mode tracks what is persisted so Save/Discard only wake
  // up for real edits; the dialog keeps its always-available footer.
  const [baseline, setBaseline] = useState(() => ({
    name: project.name,
    icon: storedProjectIconSelection(project.icon),
    color: project.color ?? DEFAULT_PROJECT_COLOR,
    greetingShown: project.greeting !== "",
    greeting: project.greeting ?? "",
  }));
  const [justSaved, setJustSaved] = useState(false);
  const previewName = name.trim() || project.name;
  const initial = Array.from(previewName)[0]?.toLocaleUpperCase() ?? "P";
  const style = { "--project-color": color } as CSSProperties;

  const dirty = name !== baseline.name || icon !== baseline.icon || color !== baseline.color
    || greetingShown !== baseline.greetingShown || greeting !== baseline.greeting;
  const resetAppearance = () => {
    setName(baseline.name);
    setIcon(baseline.icon);
    setColor(baseline.color);
    setGreetingShown(baseline.greetingShown);
    setGreeting(baseline.greeting);
  };

  // Optimistic: the project shows its new name, colour and greeting at once
  // and the dialog closes; the icon is prepared and the one PATCH sent in the
  // background. A rejection restores the project and, inline, the baseline.
  const save = () => {
    const trimmedName = name.trim();
    const greetingValue = greetingPatch(greetingShown, greeting);
    const previousBaseline = baseline;
    const request = saveProjectAppearanceOptimistic(
      project.id,
      { name: trimmedName, color, greeting: greetingValue ?? undefined },
      async () => ({
        name: trimmedName,
        // The colour is baked into an inlined icon, so it is always prepared.
        icon: await persistProjectIcon(icon.trim(), color, loadProjectIconSvg),
        color,
        greeting: greetingValue,
      }),
    );
    if (!inline) {
      onClose?.();
      void request.catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)));
      return;
    }
    const savedGreeting = greetingShown ? greeting.trim() : greeting;
    setName(trimmedName);
    setGreeting(savedGreeting);
    setBaseline({ name: trimmedName, icon, color, greetingShown, greeting: savedGreeting });
    setJustSaved(true);
    void request.catch((error: unknown) => {
      setBaseline(previousBaseline);
      setJustSaved(false);
      setUiError(friendlyError(tr("common.error"), error));
    });
  };

  const editor = (
    <div className="project-appearance-body" style={style}>
        {onBack && (
          <div className="project-appearance-navigation">
            <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>
              {tr("common.back")}
            </Button>
          </div>
        )}
        <div className="project-appearance-preview" aria-label={tr("projectappearancedialog.livePreview")}>
          <span className="project-glyph">
            <IconArt value={icon} initial={initial} variant="glyph" />
          </span>
          <span className="project-name">{previewName}</span>
        </div>

        <label className="project-appearance-field">
          <span>{tr("projectappearancedialog.projectTitle")}</span>
          <span className="project-title-input-wrap">
            <TextInput value={name} maxLength={120} aria-label={tr("projectappearancedialog.projectTitle")} onChange={(event) => setName(event.target.value)} />
            {name && <IconButton icon={CloseIcon} label={tr("projectappearancedialog.clear")} size="sm" onClick={() => setName("")} />}
          </span>
        </label>

        <section className="project-appearance-field" aria-labelledby="project-greeting-label">
          <span className="project-greeting-heading">
            <span id="project-greeting-label">{tr("projectappearancedialog.greeting")}</span>
            <Switch checked={greetingShown} label={tr("projectappearancedialog.showGreeting")} onChange={setGreetingShown} />
          </span>
          {greetingShown && (
            <>
              <span className="project-title-input-wrap">
                <TextInput
                  value={greeting}
                  maxLength={160}
                  placeholder={`${tr("workspace.builtinsurfaces.whatAreWeWorkingOnIn")} {project}.`}
                  aria-labelledby="project-greeting-label"
                  onChange={(event) => setGreeting(event.target.value)}
                />
                {greeting && <IconButton icon={CloseIcon} label={tr("projectappearancedialog.clear")} size="sm" onClick={() => setGreeting("")} />}
              </span>
              <small className="project-greeting-hint">{tr("projectappearancedialog.greetingHint")}</small>
            </>
          )}
        </section>

        <section className="project-appearance-field" aria-labelledby="project-color-label">
          <span id="project-color-label">{tr("projectappearancedialog.color")}</span>
          <ProjectColorPresets value={color} onChange={setColor} />
        </section>

        <ProjectIconPickerField icon={icon} onChange={setIcon} title={name} initial={initial} />
    </div>
  );

  const actions = (
    <>
      <Button size="sm" onClick={() => onClose?.()}>{tr("common.cancel")}</Button>
      <Button size="sm" variant="primary" disabled={!name.trim()} onClick={save}>
        {tr("common.save")}
      </Button>
    </>
  );

  if (inline) {
    return (
      <div className="project-appearance-inline">
        {editor}
        <SaveBar
          dirty={dirty}
          saving={false}
          status={justSaved && !dirty ? "saved" : "idle"}
          onSave={() => { if (name.trim()) save(); else setUiError(tr("projectappearancedialog.titleRequired")); }}
          onDiscard={resetAppearance}
        />
      </div>
    );
  }

  return (
    <Dialog
      title={tr("projectappearancedialog.projectAppearance")}
      onClose={() => onClose?.()}
      size="sm"
      className="project-appearance-dialog"
      initialFocus="input"
      footer={actions}
    >
      {editor}
    </Dialog>
  );
}
