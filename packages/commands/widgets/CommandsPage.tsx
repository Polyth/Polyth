// Commands & Snippets settings: full CRUD over the markdown files in
// .polyth/ (project) or ~/.config/polyth/ (user). Builtins are read-only.
import { useCallback, useEffect, useState } from "react";
import { api, type SlashCommand, type SnippetDef } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { commandDescription } from "../../../apps/web/src/utils.ts";
import { Button, Select, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";

type Scope = "project" | "user";
const snippetScopeLabel = (scope: Scope): string =>
  scope === "user" ? tr("settings.commandspage.generalSnippet") : tr("settings.commandspage.projectSnippet");
const commandScopeLabel = (scope: SlashCommand["scope"]): string => {
  if (scope === "builtin") return tr("settings.commandspage.builtin");
  return scope === "user" ? tr("settings.commandspage.user") : tr("settings.commandspage.project");
};

export default function CommandsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [snippets, setSnippets] = useState<SnippetDef[]>([]);
  const [error, setError] = useState("");

  // command form
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cPrompt, setCPrompt] = useState("");
  const [cScope, setCScope] = useState<Scope>("project");
  // snippet form
  const [sAlias, setSAlias] = useState("");
  const [sText, setSText] = useState("");
  const [sScope, setSScope] = useState<Scope>("project");

  const reload = useCallback(() => {
    if (!projectId) return;
    void api.listCommands(projectId).then((r) => {
      setCommands(r.commands);
      setSnippets(r.snippets);
    });
  }, [projectId]);
  useEffect(reload, [reload]);

  if (!projectId) return <><PageHead title={tr("settings.commandspage.commandsSnippets")} /><EmptyState title={tr("settings.commandspage.noActiveProject")} /></>;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHead title={tr("settings.commandspage.commandsSnippets")} blurb={tr("settings.commandspage.slashCommandsNameExpandIntoPromptsSnippets")} />
      <div className="stat-label">{tr("settings.commandspage.slashCommands")}</div>
      {commands.map((c) => (
        <div key={`${c.scope}-${c.name}`} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label mono">/{c.name}</div>
            <div className="set-row-hint">{commandDescription(c) || c.prompt.slice(0, 80)}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">{commandScopeLabel(c.scope)}</span>
            {c.scope !== "builtin" && (
              <>
                <Button
                  size="sm"
                  onClick={() => { setCName(c.name); setCDesc(c.description); setCPrompt(c.prompt); setCScope(c.scope as Scope); }}
                >{tr("common.edit")}</Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void run(() => api.deleteCommand(projectId, c.scope as Scope, c.name))}
                >{tr("common.delete")}</Button>
              </>
            )}
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <TextInput uiSize="sm" value={cName} placeholder={tr("settings.commandspage.name")} onChange={(e) => setCName(e.target.value)} />
          <TextInput uiSize="sm" value={cDesc} placeholder={tr("settings.commandspage.descriptionOptional")} onChange={(e) => setCDesc(e.target.value)} />
          <Select
            label={cScope === "project" ? tr("settings.commandspage.project") : tr("settings.commandspage.user")}
            value={cScope}
            options={[
              { value: "project", label: tr("settings.commandspage.project") },
              { value: "user", label: tr("settings.commandspage.user") },
            ]}
            onChange={(value) => setCScope(value as Scope)}
          />
        </div>
        <Textarea value={cPrompt} rows={3} placeholder={tr("settings.commandspage.promptUseArgumentsForTheTextAfter")} onChange={(e) => setCPrompt(e.target.value)} />
        <div className="set-add-form">
          <Button
            size="sm"
            disabled={!cName.trim() || !cPrompt.trim()}
            onClick={() => void run(async () => {
              await api.saveCommand(projectId, cScope, {
                name: cName.trim(),
                prompt: cPrompt,
                ...(cDesc.trim() ? { description: cDesc.trim() } : {}),
              });
              setCName(""); setCDesc(""); setCPrompt("");
            })}
          >{tr("settings.commandspage.saveCommand")}</Button>
        </div>
      </div>

      <div className="stat-label">{tr("settings.commandspage.snippets")}</div>
      {snippets.length === 0 && <EmptyState title={tr("settings.commandspage.noSnippetsYet")} body={tr("settings.commandspage.snippetsExpandAliasIntoSavedTextAnywhere")} />}
      {snippets.map((s) => (
        <div key={`${s.scope}-${s.alias}`} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label mono">#{s.alias}</div>
            <div className="set-row-hint">{s.text.slice(0, 80)}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">{snippetScopeLabel(s.scope as Scope)}</span>
            <Button size="sm" onClick={() => { setSAlias(s.alias); setSText(s.text); setSScope(s.scope as Scope); }}>{tr("common.edit")}</Button>
            <Button size="sm" variant="danger" onClick={() => void run(() => api.deleteSnippet(projectId, s.scope as Scope, s.alias))}>{tr("common.delete")}</Button>
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <TextInput uiSize="sm" value={sAlias} placeholder={tr("settings.commandspage.alias")} onChange={(e) => setSAlias(e.target.value)} />
          <Select
            label={snippetScopeLabel(sScope)}
            value={sScope}
            options={[
              { value: "project", label: tr("settings.commandspage.projectSnippet") },
              { value: "user", label: tr("settings.commandspage.generalSnippet") },
            ]}
            onChange={(value) => setSScope(value as Scope)}
          />
        </div>
        <Textarea value={sText} rows={2} placeholder={tr("settings.commandspage.snippetText")} onChange={(e) => setSText(e.target.value)} />
        <div className="set-add-form">
          <Button
            size="sm"
            disabled={!sAlias.trim() || !sText.trim()}
            onClick={() => void run(async () => {
              await api.saveSnippet(projectId, sScope, { alias: sAlias.trim(), text: sText });
              setSAlias(""); setSText("");
            })}
          >{tr("settings.commandspage.saveSnippet")}</Button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
