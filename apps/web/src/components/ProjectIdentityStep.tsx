// The new-project window: name, colour and icon, with defaults that are already
// fine, so one press is enough. Colour and icon stay visible (they are what make
// a project recognisable), and the rest of the icon library waits behind "All
// icons". Files go to the Polyth folder unless the person chose a folder.
//
// Contract: a phone opens with no keyboard, so the colours and icons stay in
// view until the person asks to type; a desktop opens with the name selected,
// so typing replaces the default.
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { ProjectDirection } from "@polyth/contracts/project-composition";
import { tr } from "../i18n/index.ts";
import { projectIconLabel } from "../projectIconPicker.ts";
import { projectIconStarters, type ProjectIdentityDraft } from "../projectIdentity.ts";
import Dialog from "./a11y/Dialog.tsx";
import { isImeComposing } from "./input/editorCore.ts";
import ProjectColorPresets from "./ProjectColorPresets.tsx";
import ProjectIconPickerField, { IconArt } from "./ProjectIconPickerField.tsx";
import { Button, FolderIcon, Icon, TextInput, type LucideIcon } from "./ui/index.ts";
import "./ProjectSetupFlowDialog.css";

const NAME_INPUT = ".project-identity-name input";
const HEADING = ".project-identity-heading";

const starterLabel = (value: string): string =>
  projectIconLabel(value.slice(value.lastIndexOf("/") + 1).replace(/\.svg$/, ""));

export default function ProjectIdentityStep({
  draft,
  onDraftChange,
  directions,
  stepLabel,
  hint,
  folderPath,
  folderRootLabel,
  onChooseFolder,
  error,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  secondaryIcon,
  onSecondary,
  onClose,
}: {
  draft: ProjectIdentityDraft;
  onDraftChange: (draft: ProjectIdentityDraft) => void;
  directions: readonly ProjectDirection[];
  stepLabel?: string;
  hint: string;
  /** The folder the project already has. Absent: the Polyth folder. */
  folderPath?: string;
  /** Where the Polyth folder is, when the person can reach it directly. */
  folderRootLabel?: string;
  /** Offered only where a folder can be chosen instead of the Polyth folder. */
  onChooseFolder?: () => void;
  error?: string;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel: string;
  secondaryIcon?: LucideIcon;
  onSecondary: () => void;
  onClose: () => void;
}) {
  const [allIcons, setAllIcons] = useState(false);
  // Fixed on open: a pointer change must not move focus or summon a keyboard.
  const [initialFocus] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? HEADING : NAME_INPUT);
  const name = draft.name;
  const canSubmit = name.trim().length > 0;
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "P";
  const style = { "--project-color": draft.color } as CSSProperties;

  // An icon chosen from the full library stays visible after collapsing it.
  const starters = useMemo(() => {
    const list = projectIconStarters(directions);
    return draft.icon && !list.includes(draft.icon) ? [draft.icon, ...list.slice(0, -1)] : list;
  }, [directions, draft.icon]);

  const setIcon = (icon: string) => onDraftChange({ ...draft, icon, iconEdited: true });
  const submitFromName = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isImeComposing(event)) return;
    event.preventDefault();
    if (canSubmit) onPrimary();
  };

  return (
    <Dialog
      title={tr("projectcomposition.identityTitle")}
      onClose={onClose}
      size="md"
      initialFocus={initialFocus}
      className="project-setup-flow-dialog project-setup-flow-dialog-compact project-identity-dialog"
    >
      <div className="project-setup-intro">
        {stepLabel && <span className="project-setup-step">{stepLabel}</span>}
        <h2 className="project-identity-heading" tabIndex={-1}>{tr("projectcomposition.identityHeading")}</h2>
        <p>{hint}</p>
      </div>
      <div className="project-setup-scroll">
        <div className="project-appearance-body project-identity-body" style={style}>
          <div className="project-identity-name">
            <span className="project-glyph project-identity-glyph">
              <IconArt value={draft.icon} initial={initial} variant="glyph" />
            </span>
            <TextInput
              value={name}
              maxLength={120}
              aria-label={tr("projectappearancedialog.projectTitle")}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value, nameEdited: true })}
              onFocus={(event) => { if (!draft.nameEdited) event.target.select(); }}
              onKeyDown={submitFromName}
            />
          </div>

          <section className="project-identity-section" aria-labelledby="project-identity-color-label">
            <span id="project-identity-color-label" className="project-appearance-field">{tr("projectappearancedialog.color")}</span>
            <ProjectColorPresets value={draft.color} onChange={(color) => onDraftChange({ ...draft, color, colorEdited: true })} />
          </section>

          <section className="project-identity-section" aria-labelledby="project-identity-icon-label">
            <span className="project-identity-section-head">
              <span id="project-identity-icon-label" className="project-appearance-field">{tr("projectappearancedialog.projectIcon")}</span>
              <Button size="sm" variant="ghost" aria-expanded={allIcons} onClick={() => setAllIcons((open) => !open)}>
                {tr(allIcons ? "projectcomposition.identityFewerIcons" : "projectcomposition.identityAllIcons")}
              </Button>
            </span>
            {allIcons ? (
              <ProjectIconPickerField icon={draft.icon} onChange={setIcon} title={name} initial={initial} showHeading={false} />
            ) : (
              <div className="project-icon-options project-identity-starters" role="radiogroup" aria-labelledby="project-identity-icon-label">
                {starters.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    title={starterLabel(value)}
                    aria-label={starterLabel(value)}
                    aria-checked={draft.icon === value}
                    className={draft.icon === value ? "selected" : ""}
                    onClick={() => setIcon(value)}
                  >
                    <IconArt value={value} initial={initial} className="project-icon-art" />
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="project-identity-folder">
            <Icon icon={FolderIcon} size="sm" />
            {folderPath
              ? <span title={folderPath}><bdi>{folderPath}</bdi></span>
              : <span {...(folderRootLabel ? { title: folderRootLabel } : {})}>{tr("projectcomposition.identityFilesInPolythFolder")}</span>}
            {!folderPath && onChooseFolder && (
              <Button size="sm" variant="ghost" onClick={onChooseFolder}>{tr("projectcomposition.identityChooseFolder")}</Button>
            )}
          </div>

          {error && <div className="project-setup-error project-identity-error" role="alert">{error}</div>}
        </div>

        <div className="project-setup-actions project-identity-actions">
          <Button variant="ghost" {...(secondaryIcon ? { iconStart: secondaryIcon } : {})} onClick={onSecondary}>{secondaryLabel}</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={onPrimary}>{primaryLabel}</Button>
        </div>
      </div>
    </Dialog>
  );
}
