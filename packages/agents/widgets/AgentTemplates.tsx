import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BotIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_ICONS } from "./AgentGlyph.tsx";
import type { AgentIconId } from "../src/agentPrompt.ts";
import { AGENT_TEMPLATES, type AgentTemplate } from "./agentModel.ts";

/** Ready-made agents to start from: a name, a job and a schedule. */
export function TemplateGrid({ onTemplate }: { onTemplate: (template: AgentTemplate) => void }) {
  return (
    <div className="agents-templates">
      {AGENT_TEMPLATES.map((template) => (
        <button
          type="button"
          key={template.id}
          className="agents-template"
          aria-label={tr("agents.useTemplateValue", { name: template.name() })}
          onClick={() => onTemplate(template)}
        >
          <span className="agents-template-glyph" data-color={template.color ?? "neutral"} aria-hidden="true">
            <Icon icon={AGENT_ICONS[template.icon as AgentIconId] ?? BotIcon} size="md" />
          </span>
          <span className="agents-template-copy">
            <strong>{template.name()}</strong>
            <span>{template.description()}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
