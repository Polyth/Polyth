// Commands & Snippets settings: full CRUD over the markdown files in
// .polyth/ (project) or ~/.config/polyth/ (user). Builtins are read-only.
import { useCallback, useEffect, useState } from "react";
import { api, type SlashCommand, type SnippetDef } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { commandDescription } from "../../../apps/web/src/utils.ts";

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
                <button
                  className="small-btn"
                  onClick={() => { setCName(c.name); setCDesc(c.description); setCPrompt(c.prompt); setCScope(c.scope as Scope); }}
                >{tr("common.edit")}</button>
                <button
                  className="small-btn danger-btn"
                  onClick={() => void run(() => api.deleteCommand(projectId, c.scope as Scope, c.name))}
                >{tr("common.delete")}</button>
              </>
            )}
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <input value={cName} placeholder={tr("settings.commandspage.name")} style={{ maxWidth: 140 }} onChange={(e) => setCName(e.target.value)} />
          <input value={cDesc} placeholder={tr("settings.commandspage.descriptionOptional")} onChange={(e) => setCDesc(e.target.value)} />
          <select value={cScope} onChange={(e) => setCScope(e.target.value as Scope)}>
            <option value="project">{tr("settings.commandspage.project")}</option>
            <option value="user">{tr("settings.commandspage.user")}</option>
          </select>
        </div>
        <textarea value={cPrompt} rows={3} placeholder={tr("settings.commandspage.promptUseArgumentsForTheTextAfter")} onChange={(e) => setCPrompt(e.target.value)} />
        <div className="set-add-form">
          <button
            className="small-btn"
            disabled={!cName.trim() || !cPrompt.trim()}
            onClick={() => void run(async () => {
              await api.saveCommand(projectId, cScope, {
                name: cName.trim(),
                prompt: cPrompt,
                ...(cDesc.trim() ? { description: cDesc.trim() } : {}),
              });
              setCName(""); setCDesc(""); setCPrompt("");
            })}
          >{tr("settings.commandspage.saveCommand")}</button>
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
            <button className="small-btn" onClick={() => { setSAlias(s.alias); setSText(s.text); setSScope(s.scope as Scope); }}>{tr("common.edit")}</button>
            <button className="small-btn danger-btn" onClick={() => void run(() => api.deleteSnippet(projectId, s.scope as Scope, s.alias))}>{tr("common.delete")}</button>
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <input value={sAlias} placeholder={tr("settings.commandspage.alias")} style={{ maxWidth: 140 }} onChange={(e) => setSAlias(e.target.value)} />
          <select value={sScope} onChange={(e) => setSScope(e.target.value as Scope)}>
            <option value="project">{tr("settings.commandspage.projectSnippet")}</option>
            <option value="user">{tr("settings.commandspage.generalSnippet")}</option>
          </select>
        </div>
        <textarea value={sText} rows={2} placeholder={tr("settings.commandspage.snippetText")} onChange={(e) => setSText(e.target.value)} />
        <div className="set-add-form">
          <button
            className="small-btn"
            disabled={!sAlias.trim() || !sText.trim()}
            onClick={() => void run(async () => {
              await api.saveSnippet(projectId, sScope, { alias: sAlias.trim(), text: sText });
              setSAlias(""); setSText("");
            })}
          >{tr("settings.commandspage.saveSnippet")}</button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
