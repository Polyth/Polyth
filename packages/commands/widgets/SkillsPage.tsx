import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CapabilityInstallationScope,
  SkillInstallationDto,
  SkillInstallationInput,
} from "@polyth/contracts/capability-installations";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, FormField, PageHead, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const scopeOptions = (): Array<[CapabilityInstallationScope, string]> => [
  ["project", tr("settings.commandspage.thisProject")],
  ["space", tr("settings.skillspage.scopeSpace")],
];

const discoveredLabel = (scope: SkillInstallationDto["scope"]): string => {
  // Discovered folders are read-only: say where the skill was found.
  if (scope === "project-opencode") return tr("settings.skillspage.discoveredOpencode");
  if (scope === "project-claude") return tr("settings.skillspage.discoveredClaude");
  if (scope === "project-agents") return tr("settings.skillspage.discoveredAgents");
  if (scope === "user-opencode") return tr("settings.skillspage.userOpencode");
  if (scope === "user-claude") return tr("settings.skillspage.userClaude");
  if (scope === "user-agents") return tr("settings.skillspage.userAgents");
  return scope === "project" ? tr("settings.commandspage.thisProject") : tr("settings.skillspage.spaceTag");
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: unknown };
    throw new Error(typeof body.message === "string" ? body.message : `HTTP ${response.status}`);
  }
  return await response.json() as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export default function SkillsPage() {
  const projectId = useStore((state) => state.activeProjectId);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const project = projectRegistry.status === "ready"
    ? projectRegistry.projects.find((candidate) => candidate.id === projectId)
    : undefined;
  const [scope, setScope] = useState<CapabilityInstallationScope>("project");
  const [skills, setSkills] = useState<SkillInstallationDto[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [disallowedTools, setDisallowedTools] = useState("");
  const [revision, setRevision] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const selectedProjectId = scope === "project" ? projectId ?? undefined : undefined;
  const selectionKey = `${scope}:${selectedProjectId ?? "space"}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;
  const clearForm = useCallback(() => {
    setName("");
    setDescription("");
    setInstructions("");
    setDisallowedTools("");
    setRevision(undefined);
  }, []);

  useEffect(() => {
    clearForm();
    setOpen(false);
    setError("");
    setBusy(false);
  }, [selectionKey, clearForm]);

  const editorOpen = open || revision !== undefined;
  // Bring a just-opened editor into view and put the caret in its first field.
  useEffect(() => {
    const editor = formRef.current;
    if (!editorOpen || !editor) return;
    editor.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    editor.querySelector<HTMLInputElement>("input:not(:disabled), textarea")?.focus({ preventScroll: true });
  }, [editorOpen, revision]);

  useEffect(() => {
    if (scope === "project" && !projectId) {
      setSkills([]);
      return;
    }
    const controller = new AbortController();
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    setLoading(true);
    setError("");
    void request<SkillInstallationDto[]>(`/api/skills${query}`, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setSkills(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, projectId, selectedProjectId]);

  const reload = useCallback(async (expectedSelection: string) => {
    if (scope === "project" && !selectedProjectId) return;
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    const next = await request<SkillInstallationDto[]>(`/api/skills${query}`);
    if (selectionRef.current === expectedSelection) setSkills(next);
  }, [scope, selectedProjectId]);

  const ownsSelectedScope = useCallback((skill: SkillInstallationDto): boolean =>
    !skill.readOnly
    && skill.scope === scope
    && (scope === "space" ? skill.projectId === undefined : skill.projectId === selectedProjectId),
  [scope, selectedProjectId]);

  const edit = (skill: SkillInstallationDto) => {
    if (!ownsSelectedScope(skill)) return;
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setDisallowedTools(skill.disallowedTools?.join(", ") ?? "");
    setRevision(skill.revision);
    setError("");
  };

  const save = async () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) return;
    if (scope === "project" && !selectedProjectId) return;
    const operationKey = selectionKey;
    setBusy(true);
    setError("");
    try {
      const parsedDisallowedTools = [...new Set(
        disallowedTools.split(",").map((tool) => tool.trim()).filter(Boolean),
      )];
      const input: SkillInstallationInput = {
        name: name.trim(),
        description: description.trim(),
        instructions,
        ...(parsedDisallowedTools.length ? { disallowedTools: parsedDisallowedTools } : {}),
        expectedRevision: revision ?? 0,
      };
      await request<SkillInstallationDto>("/api/skills", json("POST", {
        scope,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...input,
      }));
      if (selectionRef.current !== operationKey) return;
      clearForm();
      setOpen(false);
      await reload(operationKey);
    } catch (reason) {
      if (selectionRef.current === operationKey) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (selectionRef.current === operationKey) setBusy(false);
    }
  };

  const remove = async (skill: SkillInstallationDto) => {
    if (!ownsSelectedScope(skill)) return;
    const operationKey = selectionKey;
    const where = scope === "project"
      ? (project?.name ? tr("settings.skillspage.whereProjectNamed", { name: project.name }) : tr("settings.skillspage.whereThisProject"))
      : tr("settings.skillspage.whereThisSpace");
    if (!await confirmAlert(tr("settings.skillspage.removeConfirm", { name: skill.name, where }), {
      title: tr("settings.skillspage.removeSkillTitle"),
      confirmLabel: tr("settings.skillspage.remove"),
    })) return;
    // Project/scope may have changed while the confirmation dialog was open.
    if (selectionRef.current !== operationKey) return;
    setBusy(true);
    setError("");
    try {
      await request<{ ok: boolean }>("/api/skills", json("DELETE", {
        scope,
        name: skill.name,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...(skill.revision !== undefined ? { expectedRevision: skill.revision } : {}),
      }));
      if (selectionRef.current !== operationKey) return;
      if (revision !== undefined && name === skill.name) { clearForm(); setOpen(false); }
      await reload(operationKey);
    } catch (reason) {
      if (selectionRef.current === operationKey) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (selectionRef.current === operationKey) setBusy(false);
    }
  };

  const editorTitle = revision !== undefined
    ? tr("settings.skillspage.editing", { name })
    : scope === "project"
      ? (project?.name
        ? tr("settings.skillspage.newSkillForProjectNamed", { name: project.name })
        : tr("settings.skillspage.newSkillForProject"))
      : tr("settings.skillspage.newSkillForSpace");
  const closeEditor = () => {
    clearForm();
    setOpen(false);
  };

  return <>
    <PageHead blurb={tr("settings.skillspage.pageBlurb")} />
    <div className="commands-scope-bar" data-settings-item="skills.catalog">
      <span className="settings-field-label">{tr("settings.skillspage.showFor")}</span>
      <Seg
        label={tr("settings.skillspage.showFor")}
        value={scope}
        options={scopeOptions()}
        onChange={(value) => setScope(value)}
      />
    </div>

    <Section
      title={scope === "project" ? tr("settings.skillspage.projectTitle") : tr("settings.skillspage.spaceTitle")}
      hint={scope === "project"
        ? tr("settings.skillspage.projectHint")
        : tr("settings.skillspage.spaceHint")}
      action={!editorOpen && skills.length > 0 && (
        <Button
          size="sm"
          variant="quiet"
          disabled={scope === "project" && !projectId}
          onClick={() => { clearForm(); setOpen(true); }}
        >{tr("settings.skillspage.newSkill")}</Button>
      )}
    >
      {scope === "project" && !projectId
        ? <EmptyState compact icon="assist" title={tr("settings.commandspage.noActiveProject")} body={tr("settings.skillspage.noActiveProjectBody")} />
        : loading && skills.length === 0
          ? <EmptyState compact busy title={tr("settings.skillspage.loading")} />
          : skills.length === 0 && !editorOpen
            ? <EmptyState
              compact
              icon="assist"
              title={tr("settings.skillspage.noSkillsTitle")}
              body={tr("settings.skillspage.noSkillsBody")}
              action={{ label: tr("settings.skillspage.newSkill"), onClick: () => { clearForm(); setOpen(true); } }}
            />
            : null}

      {skills.map((skill) => {
        const editable = ownsSelectedScope(skill);
        const inherited = scope === "project" && !skill.readOnly && skill.scope === "space";
        return <div key={`${skill.scope}-${skill.projectId ?? "space"}-${skill.name}`} className="set-row commands-row">
          <div className="set-row-text">
            <div className="set-row-label mono">{skill.name}</div>
            <div className="set-row-hint commands-row-hint">{skill.description}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">{inherited ? tr("settings.skillspage.fromSpace") : discoveredLabel(skill.scope)}</span>
            {editable && <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(skill)}>{tr("settings.skillspage.edit")}</Button>}
            {editable && <Button size="sm" variant="ghost" className="commands-delete" disabled={busy} onClick={() => void remove(skill)}>{tr("settings.skillspage.remove")}</Button>}
          </div>
        </div>;
      })}

      {editorOpen && (scope === "space" || projectId) && (
        <div className="commands-editor" ref={formRef}>
          <div className="commands-editor-title">
            {editorTitle}
          </div>
          <FormField label={tr("settings.commandspage.nameLabel")} hint={revision !== undefined ? tr("settings.skillspage.nameHintLocked") : tr("settings.skillspage.nameHintNew")}>
            <TextInput
              uiSize="sm"
              className="inp-mono"
              value={name}
              spellCheck={false}
              disabled={revision !== undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
          <FormField label={tr("settings.skillspage.whenToUseLabel")} hint={tr("settings.skillspage.whenToUseHint")}>
            <TextInput
              uiSize="sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
          <FormField label={tr("settings.skillspage.instructionsLabel")} hint={tr("settings.skillspage.instructionsHint")}>
            <Textarea
              rows={7}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </FormField>
          <details className="settings-advanced" open={disallowedTools ? true : undefined}>
            <summary>{tr("settings.skillspage.advanced")}</summary>
            <FormField
              label={tr("settings.skillspage.blockedToolsLabel")}
              optional
              hint={tr("settings.skillspage.blockedToolsHint")}
            >
              <TextInput
                uiSize="sm"
                className="inp-mono"
                value={disallowedTools}
                spellCheck={false}
                onChange={(event) => setDisallowedTools(event.target.value)}
              />
            </FormField>
          </details>
          <div className="commands-editor-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={closeEditor}>{tr("settings.skillspage.cancel")}</Button>
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={
                (scope === "project" && !selectedProjectId)
                || !name.trim()
                || !description.trim()
                || !instructions.trim()
              }
              onClick={() => void save()}
            >{revision !== undefined ? tr("settings.skillspage.saveSkill") : tr("settings.skillspage.createSkill")}</Button>
          </div>
        </div>
      )}
    </Section>
    {error && <div className="form-error" role="alert">{error}</div>}
  </>;
}
