import { useState } from "react";
import type { Project } from "@polyth/contracts";
import { api, type AgentDraftDto } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import {
  AssistIcon,
  Button,
  Icon,
  LightbulbIcon,
  Notice,
  Textarea,
} from "../../../apps/web/src/components/ui/index.ts";
import { localTimeZone } from "../src/cadenceView.ts";
import type { AgentSeed } from "./agentSeed.ts";
import type { AgentTemplate } from "./agentModel.ts";
import { TemplateGrid } from "./AgentTemplates.tsx";
import PlannerProjectPicker from "./PlannerProjectPicker.tsx";

const EXAMPLES = ["agents.exampleDigest", "agents.exampleTriage", "agents.exampleReview"] as const;

/** Step 0 of a new agent: describe it, let the small model draft the fields,
 *  or start from an empty form. Nothing is saved here. */
export default function AgentStart({
  projects,
  projectId: initialProjectId,
  seed,
  onDrafted,
  onScratch,
  onTemplate,
}: {
  projects: readonly Project[];
  projectId: string;
  seed: AgentSeed | null;
  onDrafted: (draft: AgentDraftDto, projectId: string) => void;
  onScratch: (projectId: string, description: string) => void;
  onTemplate?: (template: AgentTemplate) => void;
}) {
  const [projectId, setProjectId] = useState(seed?.projectId ?? initialProjectId);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const canDraft = !!projectId && (!!description.trim() || !!seed) && !busy;

  const draft = async () => {
    if (!canDraft) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await api.scheduleDraft({
        projectId,
        timeZone: localTimeZone(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(seed ? { sessionId: seed.sessionId } : {}),
      });
      onDrafted(result, projectId);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agents-start">
      <div className="agents-start-body">
        <h2 className="agents-start-title">{tr("agents.startQuestion")}</h2>
        {seed && (
          <p className="agents-start-lead">{tr("agents.fromChatValue", { title: seed.sessionTitle })}</p>
        )}
        <Textarea
          className="agents-start-input"
          aria-label={tr("agents.startQuestion")}
          autoGrow
          minRows={3}
          maxRows={10}
          value={description}
          placeholder={seed ? tr("agents.fromChatPlaceholder") : tr("agents.startPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void draft();
            }
          }}
        />
        {!seed && (
          <div className="agents-examples" role="group" aria-label={tr("agents.examples")}>
            {EXAMPLES.map((key) => (
              <button key={key} type="button" className="agents-example" onClick={() => setDescription(tr(key))}>
                <Icon icon={LightbulbIcon} size="sm" />
                <span>{tr(key)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="agents-start-row">
          <PlannerProjectPicker
            label={tr("scheduleview.project")}
            projects={projects}
            value={projectId || null}
            onChange={(id) => { if (id) setProjectId(id); }}
          />
          <span className="agents-start-actions">
            <Button variant="ghost" disabled={!projectId || busy} onClick={() => onScratch(projectId, description.trim())}>
              {tr("agents.startFromScratch")}
            </Button>
            <Button variant="primary" iconStart={AssistIcon} busy={busy} disabled={!canDraft} onClick={() => void draft()}>
              {busy ? tr("agents.drafting") : tr("agents.draftAgent")}
            </Button>
          </span>
        </div>
        {!projectId && <p className="agents-hint">{tr("agents.blockerProject")}</p>}
        {failure && (
          <Notice
            tone="warning"
            actions={<Button size="sm" onClick={() => onScratch(projectId, description.trim())}>{tr("agents.fillByHand")}</Button>}
          >
            {failure}
          </Notice>
        )}
        <p className="agents-hint">{tr("agents.draftNote")}</p>
        {!seed && onTemplate && (
          <section className="agents-start-templates" aria-labelledby="agents-start-templates">
            <h2 className="agents-section-title" id="agents-start-templates">{tr("agents.startFromTemplate")}</h2>
            <TemplateGrid onTemplate={onTemplate} />
          </section>
        )}
      </div>
    </div>
  );
}
