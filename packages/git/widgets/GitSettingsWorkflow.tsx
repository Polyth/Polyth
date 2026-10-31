// Settings → Source control → Workflow: how Polyth names the worktree branches
// it creates and how it hands merge conflicts to an agent. Account settings
// that sync with the person's other clients; they apply to every project.
import { Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { ResetLink, Row, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { DEFAULT_SETTINGS } from "../../../apps/web/src/settings.ts";
import { updateSettings, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { richText } from "./richText.tsx";

/** Example branch for the template preview. Approximates suggestWorktreeBranch
 *  (apps/web/src/worktreeSessions.ts), which a package may not import. */
export function previewBranch(template: string, now = new Date()): string {
  const slug = tr("gitsettings.branchPreviewTitle").toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "fix-login-bug";
  const date = now.toISOString().slice(0, 10);
  return (template.trim() || DEFAULT_SETTINGS.branchTemplate).replaceAll("{slug}", slug).replaceAll("{date}", date);
}

export default function GitSettingsWorkflow() {
  const settings = useStore((s) => s.settings);
  const promptIsDefault = settings.conflictAgentPrompt === DEFAULT_SETTINGS.conflictAgentPrompt
    && settings.conflictAgentTarget === DEFAULT_SETTINGS.conflictAgentTarget;
  return (
    <>
      <Section
        title={tr("gitsettings.branchesTitle")}
        hint={tr("gitsettings.branchesHint")}
        itemId="git.branchTemplate"
        action={<ResetLink disabled={settings.branchTemplate === DEFAULT_SETTINGS.branchTemplate} onClick={() => updateSettings({ branchTemplate: DEFAULT_SETTINGS.branchTemplate })} />}
      >
        <Row
          label={tr("gitsettings.branchTemplate")}
          hint={<>
            {richText("gitsettings.branchTemplateHint", { slug: <code>{"{slug}"}</code>, date: <code>{"{date}"}</code> })}{" "}
            <span className="git-branch-preview">{richText("gitsettings.branchPreview", { branch: <code>{previewBranch(settings.branchTemplate)}</code> })}</span>
          </>}
        >
          <TextInput
            uiSize="sm"
            className="inp-mono git-branch-template"
            aria-label={tr("gitsettings.branchTemplate")}
            spellCheck={false}
            autoCapitalize="off"
            placeholder={DEFAULT_SETTINGS.branchTemplate}
            value={settings.branchTemplate}
            onChange={(event) => updateSettings({ branchTemplate: event.target.value })}
          />
        </Row>
      </Section>
      <Section
        title={tr("gitsettings.conflictsTitle")}
        hint={tr("gitsettings.conflictsHint")}
        itemId="git.conflictAgentTarget"
        action={<ResetLink disabled={promptIsDefault} onClick={() => updateSettings({ conflictAgentPrompt: DEFAULT_SETTINGS.conflictAgentPrompt, conflictAgentTarget: DEFAULT_SETTINGS.conflictAgentTarget })} />}
      >
        <Row label={tr("gitsettings.conflictTarget")} hint={tr("gitsettings.conflictTargetHint")}>
          <Seg
            label={tr("gitsettings.conflictTarget")}
            value={settings.conflictAgentTarget}
            options={[
              ["new-session", tr("gitsettings.conflictNewSession")],
              ["current-session", tr("gitsettings.conflictCurrentSession")],
            ]}
            onChange={(conflictAgentTarget) => updateSettings({ conflictAgentTarget })}
          />
        </Row>
        <Row
          label={tr("gitsettings.conflictPrompt")}
          hint={tr("gitsettings.conflictPromptHint")}
          itemId="git.conflictAgentPrompt"
          layout="stacked"
        >
          <Textarea
            className="git-conflict-agent-prompt"
            aria-label={tr("gitsettings.conflictPrompt")}
            rows={3}
            value={settings.conflictAgentPrompt}
            onChange={(event) => updateSettings({ conflictAgentPrompt: event.target.value })}
          />
        </Row>
      </Section>
    </>
  );
}
