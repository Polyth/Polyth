// Commands & Snippets settings: full CRUD over the markdown files in
// .polyth/ (project) or ~/.config/polyth/ (user). Builtins are read-only.
import { useCallback, useEffect, useState } from "react";
import { api, type SlashCommand, type SnippetDef } from "../../api.ts";
import { useStore } from "../../store.ts";
import { EmptyState, PageHead } from "./parts.tsx";

type Scope = "project" | "user";
const snippetScopeLabel = (scope: Scope): string =>
  scope === "user" ? "General snippet" : "Project snippet";

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

  if (!projectId) return <><PageHead title="Commands & Snippets" /><EmptyState title="No active project" /></>;

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
      <PageHead title="Commands & Snippets" blurb="Slash commands (/name) expand into prompts; snippets (#alias) expand inline. Stored as markdown in the project or your home config." />
      <div className="stat-label">Slash commands</div>
      {commands.map((c) => (
        <div key={`${c.scope}-${c.name}`} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label mono">/{c.name}</div>
            <div className="set-row-hint">{c.description || c.prompt.slice(0, 80)}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">{c.scope}</span>
            {c.scope !== "builtin" && (
              <>
                <button
                  className="small-btn"
                  onClick={() => { setCName(c.name); setCDesc(c.description); setCPrompt(c.prompt); setCScope(c.scope as Scope); }}
                >Edit</button>
                <button
                  className="small-btn danger-btn"
                  onClick={() => void run(() => api.deleteCommand(projectId, c.scope as Scope, c.name))}
                >Delete</button>
              </>
            )}
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <input value={cName} placeholder="name" style={{ maxWidth: 140 }} onChange={(e) => setCName(e.target.value)} />
          <input value={cDesc} placeholder="description (optional)" onChange={(e) => setCDesc(e.target.value)} />
          <select value={cScope} onChange={(e) => setCScope(e.target.value as Scope)}>
            <option value="project">project</option>
            <option value="user">user</option>
          </select>
        </div>
        <textarea value={cPrompt} rows={3} placeholder="Prompt — use $ARGUMENTS for the text after /name" onChange={(e) => setCPrompt(e.target.value)} />
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
          >Save command</button>
        </div>
      </div>

      <div className="stat-label">Snippets</div>
      {snippets.length === 0 && <EmptyState title="No snippets yet" body="Snippets expand #alias into saved text anywhere in a message." />}
      {snippets.map((s) => (
        <div key={`${s.scope}-${s.alias}`} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label mono">#{s.alias}</div>
            <div className="set-row-hint">{s.text.slice(0, 80)}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">{snippetScopeLabel(s.scope as Scope)}</span>
            <button className="small-btn" onClick={() => { setSAlias(s.alias); setSText(s.text); setSScope(s.scope as Scope); }}>Edit</button>
            <button className="small-btn danger-btn" onClick={() => void run(() => api.deleteSnippet(projectId, s.scope as Scope, s.alias))}>Delete</button>
          </div>
        </div>
      ))}
      <div className="set-add-form set-add-col">
        <div className="set-add-form">
          <input value={sAlias} placeholder="alias" style={{ maxWidth: 140 }} onChange={(e) => setSAlias(e.target.value)} />
          <select value={sScope} onChange={(e) => setSScope(e.target.value as Scope)}>
            <option value="project">Project snippet</option>
            <option value="user">General snippet</option>
          </select>
        </div>
        <textarea value={sText} rows={2} placeholder="Snippet text" onChange={(e) => setSText(e.target.value)} />
        <div className="set-add-form">
          <button
            className="small-btn"
            disabled={!sAlias.trim() || !sText.trim()}
            onClick={() => void run(async () => {
              await api.saveSnippet(projectId, sScope, { alias: sAlias.trim(), text: sText });
              setSAlias(""); setSText("");
            })}
          >Save snippet</button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
