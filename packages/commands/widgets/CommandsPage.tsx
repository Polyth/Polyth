// Commands & Snippets settings: full CRUD over the markdown files in
// .polyth/ (project, shared with the Space, admins only) or the signed-in
// person's own storage (user, private to them). Builtins are read-only.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SlashCommand, type SnippetDef } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import {
  EmptyState,
  ErrorState,
  FormField,
  PageHead,
  Section,
  Seg,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { commandDescription } from "../../../apps/web/src/utils.ts";
import { Button, confirmAlert, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";

type Scope = "project" | "user";
// One vocabulary for where a command or snippet lives: "user" entries are the
// person's own and apply to every project they open; "project" entries are
// shared with everyone in the Space and only admins can change them.
const scopeLabel = (scope: SlashCommand["scope"]): string => {
  if (scope === "builtin") return tr("settings.commandspage.builtIn");
  return scope === "user" ? tr("settings.commandspage.allMyProjects") : tr("settings.commandspage.thisProject");
};
const scopeOptions = (canShare: boolean): Array<[Scope, string]> => [
  ...(canShare ? [["project", tr("settings.commandspage.thisProject")] as [Scope, string]] : []),
  ["user", tr("settings.commandspage.allMyProjects")],
];

/** Move the reader to a just-opened editor and put the caret in its first field. */
const focusEditor = (editor: HTMLElement | null) => {
  if (!editor) return;
  editor.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  editor.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
};

export default function CommandsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [snippets, setSnippets] = useState<SnippetDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState("");

  // command editor; `cEditing` is the command being edited, null for a new one
  const [cOpen, setCOpen] = useState(false);
  const [cEditing, setCEditing] = useState<string | null>(null);
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cPrompt, setCPrompt] = useState("");
  const [cScope, setCScope] = useState<Scope>("user");
  const commandEditor = useRef<HTMLDivElement>(null);
  // snippet editor
  const [sOpen, setSOpen] = useState(false);
  const [sEditing, setSEditing] = useState<string | null>(null);
  const [sAlias, setSAlias] = useState("");
  const [sText, setSText] = useState("");
  const [sScope, setSScope] = useState<Scope>("user");
  // Only Space admins may write shared (project) commands; everyone else saves their own.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    let live = true;
    void api.spaces().then((state) => {
      const active = state.spaces.find((space) => space.id === state.activeSpaceId);
      if (live) setCanShare(active?.role === "owner" || active?.role === "admin");
    }).catch(() => { if (live) setCanShare(false); });
    return () => { live = false; };
  }, []);
  const snippetEditor = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    if (!projectId) return;
    void api.listCommands(projectId)
      .then((r) => {
        setCommands(r.commands);
        setSnippets(r.snippets);
        setLoadError(null);
      })
      .catch((cause: unknown) => setLoadError(cause))
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useEffect(() => { if (cOpen) focusEditor(commandEditor.current); }, [cOpen, cEditing]);
  useEffect(() => { if (sOpen) focusEditor(snippetEditor.current); }, [sOpen, sEditing]);

  if (!projectId) {
    return <EmptyState icon="command" title={tr("settings.commandspage.noActiveProject")} body={tr("settings.commandspage.noActiveProjectBody")} />;
  }

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      setError("");
      await fn();
      reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const openCommand = (command?: SlashCommand) => {
    setCEditing(command?.name ?? null);
    setCName(command?.name ?? "");
    setCDesc(command?.description ?? "");
    setCPrompt(command?.prompt ?? "");
    setCScope(command ? command.scope as Scope : "user");
    setCOpen(true);
  };
  const closeCommand = () => {
    setCOpen(false);
    setCEditing(null);
    setCName(""); setCDesc(""); setCPrompt("");
  };
  const openSnippet = (snippet?: SnippetDef) => {
    setSEditing(snippet?.alias ?? null);
    setSAlias(snippet?.alias ?? "");
    setSText(snippet?.text ?? "");
    setSScope(snippet ? snippet.scope as Scope : "user");
    setSOpen(true);
  };
  const closeSnippet = () => {
    setSOpen(false);
    setSEditing(null);
    setSAlias(""); setSText("");
  };

  const deleteCommand = async (command: SlashCommand) => {
    const confirmed = await confirmAlert(tr("settings.commandspage.deleteCommandConfirm", { name: command.name }), {
      title: tr("settings.commandspage.deleteCommandTitle"),
      confirmLabel: tr("common.delete"),
    });
    if (!confirmed) return;
    if (await run(() => api.deleteCommand(projectId, command.scope as Scope, command.name)) && cEditing === command.name) closeCommand();
  };
  const deleteSnippet = async (snippet: SnippetDef) => {
    const confirmed = await confirmAlert(tr("settings.commandspage.deleteSnippetConfirm", { alias: snippet.alias }), {
      title: tr("settings.commandspage.deleteSnippetTitle"),
      confirmLabel: tr("common.delete"),
    });
    if (!confirmed) return;
    if (await run(() => api.deleteSnippet(projectId, snippet.scope as Scope, snippet.alias)) && sEditing === snippet.alias) closeSnippet();
  };

  if (loadError && commands.length === 0 && snippets.length === 0) {
    return <>
      <PageHead blurb={tr("settings.commandspage.pageBlurb")} />
      <ErrorState title={tr("settings.commandspage.loadError")} error={loadError} onRetry={reload} />
    </>;
  }

  return (
    <>
      <PageHead blurb={tr("settings.commandspage.pageBlurb")} />
      {loadError && <ErrorState compact title={tr("settings.commandspage.loadError")} error={loadError} onRetry={reload} />}

      <Section
        title={tr("settings.commandspage.slashCommands")}
        hint={tr("settings.commandspage.commandsHint")}
        itemId="commands.catalog"
        action={!cOpen && commands.length > 0 && <Button size="sm" variant="quiet" onClick={() => openCommand()}>{tr("settings.commandspage.addCommand")}</Button>}
      >
        {loading && commands.length === 0
          ? <EmptyState compact busy title={tr("settings.commandspage.loading")} />
          : commands.length === 0 && !cOpen && (
            <EmptyState
              compact
              icon="command"
              title={tr("settings.commandspage.noCommandsYet")}
              body={tr("settings.commandspage.noCommandsBody")}
              action={{ label: tr("settings.commandspage.addCommand"), onClick: () => openCommand() }}
            />
          )}
        {commands.map((c) => (
          <div key={`${c.scope}-${c.name}`} className="set-row commands-row">
            <div className="set-row-text">
              <div className="set-row-label mono">/{c.name}</div>
              <div className="set-row-hint commands-row-hint">{commandDescription(c) || c.prompt}</div>
            </div>
            <div className="set-row-control">
              <span className="tag">{scopeLabel(c.scope)}</span>
              {c.scope !== "builtin" && (
                <>
                  <Button size="sm" variant="ghost" disabled={c.scope === "project" && !canShare} onClick={() => openCommand(c)}>{tr("common.edit")}</Button>
                  <Button size="sm" variant="ghost" className="commands-delete" disabled={c.scope === "project" && !canShare} onClick={() => void deleteCommand(c)}>{tr("common.delete")}</Button>
                </>
              )}
            </div>
          </div>
        ))}
        {cOpen && (
          <div className="commands-editor" ref={commandEditor}>
            <div className="commands-editor-title">
              {cEditing ? tr("settings.commandspage.editingCommand", { name: cEditing }) : tr("settings.commandspage.newCommand")}
            </div>
            <div className="commands-editor-grid">
              <FormField label={tr("settings.commandspage.nameLabel")} hint={tr("settings.commandspage.nameHint")}>
                <TextInput uiSize="sm" className="inp-mono" value={cName} spellCheck={false} onChange={(e) => setCName(e.target.value)} />
              </FormField>
              <FormField label={tr("settings.commandspage.descriptionLabel")} hint={tr("settings.commandspage.descriptionHint")} optional>
                <TextInput uiSize="sm" value={cDesc} onChange={(e) => setCDesc(e.target.value)} />
              </FormField>
            </div>
            <FormField label={tr("settings.commandspage.promptLabel")} hint={tr("settings.commandspage.promptHint")}>
              <Textarea value={cPrompt} rows={4} onChange={(e) => setCPrompt(e.target.value)} />
            </FormField>
            <div className="commands-editor-scope">
              <span className="settings-field-label">{tr("settings.commandspage.saveTo")}</span>
              <Seg label={tr("settings.commandspage.saveTo")} value={cScope} options={scopeOptions(canShare)} onChange={setCScope} />
            </div>
            <div className="commands-editor-actions">
              <Button size="sm" variant="ghost" onClick={closeCommand}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!cName.trim() || !cPrompt.trim()}
                onClick={() => void run(async () => {
                  await api.saveCommand(projectId, cScope, {
                    name: cName.trim(),
                    prompt: cPrompt,
                    ...(cDesc.trim() ? { description: cDesc.trim() } : {}),
                  });
                  closeCommand();
                })}
              >{tr("settings.commandspage.saveCommand")}</Button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title={tr("settings.commandspage.snippets")}
        hint={tr("settings.commandspage.snippetsHint")}
        itemId="commands.snippets"
        action={!sOpen && snippets.length > 0 && <Button size="sm" variant="quiet" onClick={() => openSnippet()}>{tr("settings.commandspage.addSnippet")}</Button>}
      >
        {loading && snippets.length === 0
          ? <EmptyState compact busy title={tr("settings.commandspage.loading")} />
          : snippets.length === 0 && !sOpen && (
            <EmptyState
              compact
              icon="edit"
              title={tr("settings.commandspage.noSnippetsYet")}
              body={tr("settings.commandspage.noSnippetsBody")}
              action={{ label: tr("settings.commandspage.addSnippet"), onClick: () => openSnippet() }}
            />
          )}
        {snippets.map((s) => (
          <div key={`${s.scope}-${s.alias}`} className="set-row commands-row">
            <div className="set-row-text">
              <div className="set-row-label mono">#{s.alias}</div>
              <div className="set-row-hint commands-row-hint">{s.text}</div>
            </div>
            <div className="set-row-control">
              <span className="tag">{scopeLabel(s.scope as Scope)}</span>
              <Button size="sm" variant="ghost" disabled={s.scope === "project" && !canShare} onClick={() => openSnippet(s)}>{tr("common.edit")}</Button>
              <Button size="sm" variant="ghost" className="commands-delete" disabled={s.scope === "project" && !canShare} onClick={() => void deleteSnippet(s)}>{tr("common.delete")}</Button>
            </div>
          </div>
        ))}
        {sOpen && (
          <div className="commands-editor" ref={snippetEditor}>
            <div className="commands-editor-title">
              {sEditing ? tr("settings.commandspage.editingSnippet", { alias: sEditing }) : tr("settings.commandspage.newSnippet")}
            </div>
            <FormField label={tr("settings.commandspage.aliasLabel")} hint={tr("settings.commandspage.aliasHint")}>
              <TextInput uiSize="sm" className="inp-mono" value={sAlias} spellCheck={false} onChange={(e) => setSAlias(e.target.value)} />
            </FormField>
            <FormField label={tr("settings.commandspage.textLabel")}>
              <Textarea value={sText} rows={3} onChange={(e) => setSText(e.target.value)} />
            </FormField>
            <div className="commands-editor-scope">
              <span className="settings-field-label">{tr("settings.commandspage.saveTo")}</span>
              <Seg label={tr("settings.commandspage.saveTo")} value={sScope} options={scopeOptions(canShare)} onChange={setSScope} />
            </div>
            <div className="commands-editor-actions">
              <Button size="sm" variant="ghost" onClick={closeSnippet}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!sAlias.trim() || !sText.trim()}
                onClick={() => void run(async () => {
                  await api.saveSnippet(projectId, sScope, { alias: sAlias.trim(), text: sText });
                  closeSnippet();
                })}
              >{tr("settings.commandspage.saveSnippet")}</Button>
            </div>
          </div>
        )}
      </Section>
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  );
}
