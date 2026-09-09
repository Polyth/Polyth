import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CapabilityInstallationScope,
  SkillInstallationDto,
  SkillInstallationInput,
} from "@polyth/contracts/capability-installations";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Select, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";

const SCOPE_OPTIONS: Array<{ value: CapabilityInstallationScope; label: string }> = [
  { value: "project", label: "This project" },
  { value: "space", label: "This Space · all projects" },
];

const discoveredLabel = (scope: SkillInstallationDto["scope"]): string => {
  if (scope === "project-opencode") return "Discovered · .opencode/skills";
  if (scope === "project-claude") return "Discovered · .claude/skills";
  if (scope === "project-agents") return "Discovered · .agents/skills";
  if (scope === "user-opencode") return "Discovered · user OpenCode";
  if (scope === "user-claude") return "Discovered · user Claude";
  if (scope === "user-agents") return "Discovered · user agents";
  return scope === "project" ? "This project" : "This Space";
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
  const [revision, setRevision] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const selectedProjectId = scope === "project" ? projectId ?? undefined : undefined;
  const selectionKey = `${scope}:${selectedProjectId ?? "space"}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;
  const clearForm = useCallback(() => {
    setName("");
    setDescription("");
    setInstructions("");
    setRevision(undefined);
  }, []);

  useEffect(() => {
    clearForm();
    setError("");
  }, [selectionKey, clearForm]);

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

  const reload = useCallback(async () => {
    if (scope === "project" && !selectedProjectId) return;
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    setSkills(await request<SkillInstallationDto[]>(`/api/skills${query}`));
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
    setRevision(skill.revision);
    setError("");
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const save = async () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) return;
    if (scope === "project" && !selectedProjectId) return;
    const operationKey = selectionKey;
    setBusy(true);
    setError("");
    try {
      const input: SkillInstallationInput = {
        name: name.trim(),
        description: description.trim(),
        instructions,
        expectedRevision: revision ?? 0,
      };
      await request<SkillInstallationDto>("/api/skills", json("POST", {
        scope,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...input,
      }));
      if (selectionRef.current !== operationKey) return;
      clearForm();
      await reload();
    } catch (reason) {
      if (selectionRef.current === operationKey) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skill: SkillInstallationDto) => {
    if (!ownsSelectedScope(skill)) return;
    const where = scope === "project" ? `project ${project?.name ?? selectedProjectId}` : "this Space";
    if (!await confirmAlert(`Remove skill "${skill.name}" from ${where}?`, {
      title: "Remove skill",
      confirmLabel: "Remove",
    })) return;
    const operationKey = selectionKey;
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
      if (revision !== undefined && name === skill.name) clearForm();
      await reload();
    } catch (reason) {
      if (selectionRef.current === operationKey) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = useMemo(() =>
    scope === "project"
      ? `This project · ${project?.name ?? projectId ?? "none selected"}`
      : "This Space · shared by all projects",
  [scope, project?.name, projectId]);

  return <>
    <PageHead
      title="Skills"
      blurb="Managed skills are resolved by Polyth for every compatible harness. Project skills override same-named Space skills without changing other projects."
    />
    <div className="set-add-form">
      <Select
        label={scopeLabel}
        value={scope}
        options={SCOPE_OPTIONS}
        onChange={(value) => setScope(value as CapabilityInstallationScope)}
      />
      <Button
        size="sm"
        disabled={scope === "project" && !projectId}
        onClick={() => {
          clearForm();
          formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      >New skill</Button>
    </div>

    {scope === "project" && !projectId
      ? <EmptyState title="No active project" body="Select a project before installing a project-scoped skill, or switch the scope to This Space." />
      : !loading && skills.length === 0
        ? <EmptyState title="No skills found" body="Create a managed skill below. Existing native skill folders are discovered read-only when present." />
        : null}

    {skills.map((skill) => {
      const editable = ownsSelectedScope(skill);
      const inherited = scope === "project" && !skill.readOnly && skill.scope === "space";
      return <div key={`${skill.scope}-${skill.projectId ?? "space"}-${skill.name}`} className="set-row">
        <div className="set-row-text">
          <div className="set-row-label mono">{skill.name}</div>
          <div className="set-row-hint">{skill.description}</div>
        </div>
        <div className="set-row-control">
          <span className="tag">{inherited ? "Inherited · This Space" : discoveredLabel(skill.scope)}</span>
          {editable && <Button size="sm" disabled={busy} onClick={() => edit(skill)}>Edit</Button>}
          {editable && <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(skill)}>Remove</Button>}
        </div>
      </div>;
    })}

    <div className="stat-label">{revision !== undefined ? "Edit managed skill" : "New managed skill"}</div>
    <div className="set-add-form set-add-col" ref={formRef}>
      <div className="set-row-hint">Installing into: {scopeLabel}</div>
      <TextInput
        uiSize="sm"
        value={name}
        placeholder="skill-name"
        aria-label="Skill name"
        disabled={revision !== undefined}
        onChange={(event) => setName(event.target.value)}
      />
      <TextInput
        uiSize="sm"
        value={description}
        placeholder="When an agent should use this skill"
        aria-label="Skill description"
        onChange={(event) => setDescription(event.target.value)}
      />
      <Textarea
        rows={7}
        value={instructions}
        placeholder="Instructions for the agent"
        aria-label="Skill instructions"
        onChange={(event) => setInstructions(event.target.value)}
      />
      <div className="set-add-form">
        <Button
          size="sm"
          busy={busy}
          disabled={
            (scope === "project" && !selectedProjectId)
            || !name.trim()
            || !description.trim()
            || !instructions.trim()
          }
          onClick={() => void save()}
        >{revision !== undefined ? "Save skill" : "Create skill"}</Button>
        {(name || description || instructions) && <Button size="sm" variant="ghost" disabled={busy} onClick={clearForm}>Cancel</Button>}
      </div>
    </div>
    {error && <div className="form-error">{error}</div>}
  </>;
}
