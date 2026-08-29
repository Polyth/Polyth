import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentSkillDef, type SkillScope } from "@polyth/session/web-api";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Select, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";

const LOCATIONS: Array<{ value: SkillScope; label: string }> = [
  { value: "project-opencode", label: "Project · .opencode/skills" },
  { value: "user-opencode", label: "User · ~/.config/opencode/skills" },
  { value: "project-claude", label: "Project · .claude/skills" },
  { value: "user-claude", label: "User · ~/.claude/skills" },
  { value: "project-agents", label: "Project · .agents/skills" },
  { value: "user-agents", label: "User · ~/.agents/skills" },
];

const locationLabel = (scope: SkillScope): string => LOCATIONS.find((location) => location.value === scope)?.label ?? scope;

export default function SkillsPage() {
  const projectId = useStore((state) => state.activeProjectId);
  const [skills, setSkills] = useState<AgentSkillDef[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState<SkillScope>("project-opencode");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    if (!projectId) return;
    void api.listSkills(projectId).then(setSkills).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [projectId]);
  useEffect(reload, [reload]);

  if (!projectId) return <><PageHead title="Skills" /><EmptyState title="No active project" /></>;

  const edit = (skill: AgentSkillDef) => {
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setScope(skill.scope);
    setError("");
  };
  const save = async () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.saveSkill(projectId, scope, { name: name.trim(), description: description.trim(), instructions });
      setName(""); setDescription(""); setInstructions("");
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (skill: AgentSkillDef) => {
    if (!await confirmAlert(`Remove skill "${skill.name}" from ${locationLabel(skill.scope)}?`, { title: "Remove skill", confirmLabel: "Remove" })) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteSkill(projectId, skill.scope, skill.name);
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <PageHead title="Skills" blurb="Reusable agent instructions discovered by OpenCode from your project and user skill folders." />
    <div className="set-add-form">
      <div className="stat-label">Available skills</div>
      <Button size="sm" onClick={() => { setName(""); setDescription(""); setInstructions(""); formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>New skill</Button>
    </div>
    {skills.length === 0 && <EmptyState title="No skills found" body="Create one below, or add a SKILL.md in any supported location." />}
    {skills.map((skill) => <div key={`${skill.scope}-${skill.name}`} className="set-row">
      <div className="set-row-text">
        <div className="set-row-label mono">{skill.name}</div>
        <div className="set-row-hint">{skill.description}</div>
      </div>
      <div className="set-row-control">
        <span className="tag">{locationLabel(skill.scope)}</span>
        <Button size="sm" disabled={busy} onClick={() => edit(skill)}>Edit</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(skill)}>Remove</Button>
      </div>
    </div>)}
    <div className="stat-label">{name ? "Edit skill" : "New skill"}</div>
    <div className="set-add-form set-add-col" ref={formRef}>
      <div className="set-add-form">
        <TextInput uiSize="sm" value={name} placeholder="skill-name" aria-label="Skill name" onChange={(event) => setName(event.target.value)} />
        <Select label={locationLabel(scope)} value={scope} options={LOCATIONS} onChange={(value) => setScope(value as SkillScope)} />
      </div>
      <TextInput uiSize="sm" value={description} placeholder="When an agent should use this skill" aria-label="Skill description" onChange={(event) => setDescription(event.target.value)} />
      <Textarea rows={7} value={instructions} placeholder="Instructions for the agent" aria-label="Skill instructions" onChange={(event) => setInstructions(event.target.value)} />
      <div className="set-add-form">
        <Button size="sm" busy={busy} disabled={!name.trim() || !description.trim() || !instructions.trim()} onClick={() => void save()}>{name ? "Save skill" : "Create skill"}</Button>
        {name && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setName(""); setDescription(""); setInstructions(""); }}>Cancel</Button>}
      </div>
    </div>
    {error && <div className="form-error">{error}</div>}
  </>;
}
