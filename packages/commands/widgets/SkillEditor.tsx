// Writing a skill by hand. Catalog and harness copies open here too; an edit keeps
// their files and marks them changed so an update asks before replacing the edit.
import { useEffect, useRef, useState } from "react";
import type { CapabilityInstallationScope, SkillInstallationDto } from "@polyth/contracts/capability-installations";
import { FormField, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { skillsApi } from "./skillsApi.ts";

export interface SkillEditorSeed {
  skill?: Omit<SkillInstallationDto, "instructions"> & { instructions: string };
  /** Where a new skill may go. */
  scopes: readonly CapabilityInstallationScope[];
}

export function SkillEditor({ seed, projectId, projectName, onClose, onSaved }: {
  seed: SkillEditorSeed;
  projectId: string | null;
  projectName: string | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = seed.skill;
  const [scope, setScope] = useState<CapabilityInstallationScope>(
    (existing?.scope as CapabilityInstallationScope | undefined) ?? seed.scopes[0] ?? "space",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [disallowedTools, setDisallowedTools] = useState(existing?.disallowedTools?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const formRef = useRef<HTMLDivElement>(null);

  // Bring the editor into view and put the caret in its first field.
  useEffect(() => {
    const editor = formRef.current;
    editor?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    editor?.querySelector<HTMLInputElement>("input:not(:disabled), textarea")?.focus({ preventScroll: true });
  }, []);

  const save = async () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) return;
    setBusy(true);
    setFailure("");
    try {
      const tools = [...new Set(disallowedTools.split(",").map((tool) => tool.trim()).filter(Boolean))];
      await skillsApi.save(scope, {
        name: name.trim(),
        description: description.trim(),
        instructions,
        ...(tools.length ? { disallowedTools: tools } : {}),
        expectedRevision: existing?.revision ?? 0,
      }, scope === "project" ? (existing?.projectId ?? projectId) : undefined);
      await onSaved();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const title = existing
    ? tr("settings.skillspage.editing", { name: existing.name })
    : scope === "project"
      ? (projectName ? tr("settings.skillspage.newSkillForProjectNamed", { name: projectName }) : tr("settings.skillspage.newSkillForProject"))
      : tr("settings.skillspage.newSkillForSpace");

  return (
    <div className="commands-editor" ref={formRef}>
      <div className="commands-editor-scope">
        <div className="commands-editor-title">{title}</div>
        {!existing && seed.scopes.length > 1 && (
          <Seg
            label={tr("settings.skillspage.showFor")}
            value={scope}
            options={seed.scopes.map((option): [CapabilityInstallationScope, string] => [
              option,
              option === "project" ? tr("settings.commandspage.thisProject") : tr("settings.skillspage.scopeSpace"),
            ])}
            onChange={setScope}
          />
        )}
      </div>
      <FormField label={tr("settings.commandspage.nameLabel")} hint={existing ? tr("settings.skillspage.nameHintLocked") : tr("settings.skillspage.nameHintNew")}>
        <TextInput uiSize="sm" className="inp-mono" value={name} spellCheck={false} disabled={Boolean(existing)} onChange={(event) => setName(event.target.value)} />
      </FormField>
      <FormField label={tr("settings.skillspage.whenToUseLabel")} hint={tr("settings.skillspage.whenToUseHint")}>
        <TextInput uiSize="sm" value={description} onChange={(event) => setDescription(event.target.value)} />
      </FormField>
      <FormField label={tr("settings.skillspage.instructionsLabel")} hint={tr("settings.skillspage.instructionsHint")}>
        <Textarea rows={existing?.origin ? 14 : 7} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </FormField>
      <details className="settings-advanced" open={disallowedTools ? true : undefined}>
        <summary>{tr("settings.skillspage.advanced")}</summary>
        <FormField label={tr("settings.skillspage.blockedToolsLabel")} optional hint={tr("settings.skillspage.blockedToolsHint")}>
          <TextInput uiSize="sm" className="inp-mono" value={disallowedTools} spellCheck={false} onChange={(event) => setDisallowedTools(event.target.value)} />
        </FormField>
      </details>
      {failure && <div className="form-error" role="alert">{failure}</div>}
      <div className="commands-editor-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{tr("settings.skillspage.cancel")}</Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={!name.trim() || !description.trim() || !instructions.trim()}
          onClick={() => void save()}
        >{existing ? tr("settings.skillspage.saveSkill") : tr("settings.skillspage.createSkill")}</Button>
      </div>
    </div>
  );
}
