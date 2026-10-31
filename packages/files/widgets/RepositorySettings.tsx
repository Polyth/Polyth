import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Project, ProjectRepository } from "@polyth/contracts";
import { projectRepositories } from "@polyth/contracts/workspace";
import { api } from "@polyth/session/web-api";
import type { ProjectSettingsContribution, WebFolderPickerProps } from "@polyth/web-sdk";
import { applyProjectUpsert, useStore } from "../../../apps/web/src/store.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { desktopBridge } from "../../../apps/web/src/desktopBridge.ts";
import { Button, Checkbox, Menu, Notice, ResponsiveOverlay, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import "./repositories.css";

type Props = Pick<Parameters<NonNullable<ProjectSettingsContribution["render"]>>[0], "projectId" | "project">;
type Candidate = Awaited<ReturnType<typeof api.discoverRepositories>>["repositories"][number];
type Health = { branch?: string; changes?: number; unavailable?: boolean };

export default function RepositorySettings({ projectId, project, folderPicker: FolderPicker }: Props & { folderPicker?: ComponentType<WebFolderPickerProps> }) {
  const allProjects = useStore((state) => state.projectRegistry.projects);
  const [current, setCurrent] = useState(project);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chooser, setChooser] = useState<"add" | ProjectRepository | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [limited, setLimited] = useState(false);
  const [rename, setRename] = useState<ProjectRepository | null>(null);
  const [alias, setAlias] = useState("");
  const [candidateAlias, setCandidateAlias] = useState("");
  const generation = useRef(0);
  useEffect(() => { setCurrent(project); }, [project]);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [projectId]);
  const repositories = projectRepositories(current);
  const primary = current.primaryRepositoryId ?? repositories.find((row) => row.path === current.path)?.id ?? repositories[0]!.id;
  const recent = [...new Map(allProjects.flatMap((item) => projectRepositories(item)).map((row) => [row.path, row])).values()]
    .filter((row) => !repositories.some((registered) => registered.path === row.path)).slice(0, 5);

  useEffect(() => {
    let stopped = false;
    setHealth({});
    if (!current.remote) void (async () => {
      // Serial probes keep opening settings cheap even for a large workspace.
      for (const row of projectRepositories(current)) {
        if (stopped) return;
        let result: Health;
        try {
          const status = await api.gitStatus(projectId, undefined, row.id);
          result = { branch: status.branch ?? undefined, changes: new Set([...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].map((file) => file.path)).size };
        } catch { result = { unavailable: true }; }
        if (!stopped) setHealth((previous) => ({ ...previous, [row.id]: result }));
      }
    })();
    return () => { stopped = true; };
  }, [projectId, current]);

  const apply = async (patch: Parameters<typeof api.patchProject>[1]): Promise<boolean> => {
    const epoch = generation.current;
    setBusy(true); setError("");
    try {
      const updated = await api.patchProject(projectId, patch);
      applyProjectUpsert(updated);
      if (epoch === generation.current) setCurrent(updated);
      return true;
    } catch (cause) {
      if (epoch === generation.current) setError(friendlyError(tr("filesreg.errUpdateRepos"), cause));
      return false;
    } finally { if (epoch === generation.current) setBusy(false); }
  };
  const discover = async (path: string) => {
    const epoch = generation.current;
    const result = await api.discoverRepositories(path);
    if (epoch !== generation.current) return;
    const fresh = result.repositories.filter((row) => !repositories.some((registered) => registered.path === row.path));
    setCandidates(fresh); setSelected(fresh.map((row) => row.path)); setLimited(result.truncated);
    setCandidateAlias(fresh.length === 1 ? fresh[0]!.name : "");
  };
  const addSelected = async () => {
    const epoch = generation.current;
    setBusy(true); setError("");
    try {
      let latest: Project | undefined;
      // Each registration is independently durable. Keep unsuccessful rows
      // selected if a later registration fails; never replay earlier writes.
      for (const row of candidates ?? []) {
        if (!selected.includes(row.path)) continue;
        latest = await api.patchProject(projectId, { repository: { action: "add", path: row.path, alias: candidates?.length === 1 ? candidateAlias.trim() || row.name : row.name } });
        applyProjectUpsert(latest);
        if (epoch !== generation.current) return;
        setCurrent(latest);
        setSelected((ids) => ids.filter((id) => id !== row.path));
      }
      setCandidates(null);
    } catch (cause) {
      if (epoch === generation.current) setError(friendlyError(tr("filesreg.errAddRepo"), cause));
    } finally { if (epoch === generation.current) setBusy(false); }
  };
  const remove = async (row: ProjectRepository) => {
    if (row.id === primary) return;
    const changes = health[row.id]?.changes;
    const message = changes
      ? tr(new Intl.PluralRules(getLocale()).select(changes) === "one" ? "filesreg.removeConfirmDirtyOne" : "filesreg.removeConfirmDirtyOther", { alias: row.alias, count: changes })
      : tr("filesreg.removeConfirm", { alias: row.alias });
    if (await confirmAlert(message, { title: tr("filesreg.removeTitle"), confirmLabel: tr("filesreg.remove"), destructive: true })) {
      await apply({ repository: { action: "remove", repositoryId: row.id } });
    }
  };

  return <section className="files-repositories-settings" data-testid="repository-settings">
    {current.remote ? <Notice tone="info" heading={tr("filesreg.remoteHeading")}>{tr("filesreg.remoteBody")}</Notice> : <>
      <div className="files-repositories-list">
        {repositories.map((row) => <div className="files-repository-row" key={row.id}>
          <div className="files-repository-copy">
            <strong>{row.alias}</strong>
            <span className="files-repository-path" title={row.path}>{row.path}</span>
            <span className="files-repository-id">{[row.id === primary ? tr("filesreg.rowPrimary") : "", health[row.id]?.unavailable ? tr("filesreg.rowUnavailable") : health[row.id]?.branch ?? "", health[row.id]?.changes ? tr("filesreg.rowChanged", { count: health[row.id]!.changes! }) : ""].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="files-repository-actions">
            {desktopBridge() && <Button size="sm" variant="ghost" onClick={() => void desktopBridge()!.revealPath(row.path).catch((cause) => setError(friendlyError(tr("filesreg.errRevealRepo"), cause)))}>{tr("filesreg.reveal")}</Button>}
            {health[row.id]?.unavailable && <Button size="sm" disabled={busy} onClick={() => setChooser(row)}>{tr("filesreg.locate")}</Button>}
            <Menu label={tr("filesreg.actionsFor", { alias: row.alias })} entries={[
              { id: "rename", label: tr("filesreg.renameAlias"), disabled: busy, onSelect: () => { setRename(row); setAlias(row.alias); } },
              { id: "primary", label: tr("filesreg.makePrimary"), disabled: busy || row.id === primary, onSelect: () => void apply({ repository: { action: "make-primary", repositoryId: row.id } }) },
              { id: "path", label: tr("filesreg.changePath"), disabled: busy || !FolderPicker, onSelect: () => setChooser(row) },
              { id: "remove", label: tr("filesreg.removeFromProject"), danger: true, disabled: busy || row.id === primary, onSelect: () => void remove(row) },
            ]}>{(trigger) => <Button {...trigger} size="sm" variant="ghost" aria-label={tr("filesreg.actionsFor", { alias: row.alias })}>…</Button>}</Menu>
          </div>
        </div>)}
      </div>
      <Button size="sm" disabled={busy || !FolderPicker} onClick={() => setChooser("add")}>{tr("filesreg.addRepository")}</Button>
      {recent.length > 0 && <details className="files-repositories-recent"><summary>{tr("filesreg.recentRepositories")}</summary>{recent.map((row) => <Button key={row.path} size="sm" variant="ghost" disabled={busy} title={row.path} onClick={() => void discover(row.path).catch((cause) => setError(friendlyError(tr("filesreg.errInspectFolder"), cause)))}>{row.alias} · {row.path}</Button>)}</details>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discover(current.path).catch((cause) => setError(friendlyError(tr("filesreg.errInspectProject"), cause)))}>{tr("filesreg.findLinked")}</Button>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {chooser && FolderPicker && <FolderPicker title={chooser === "add" ? tr("filesreg.addRepositoryTitle") : tr("filesreg.locateTitle", { alias: chooser.alias })} subtitle={tr("filesreg.chooseSubtitle")} confirmLabel={tr("filesreg.chooseFolder")} initialPath={chooser === "add" ? undefined : chooser.path}
      onClose={() => setChooser(null)} onChoose={async (path) => {
        if (chooser === "add") await discover(path);
        else if (!await apply({ repository: { action: "relocate", repositoryId: chooser.id, path } })) throw new Error(tr("filesreg.errPathNotChanged"));
      }} />}
    <ResponsiveOverlay open={candidates !== null} onClose={() => { if (!busy) setCandidates(null); }} title={candidates?.some((row) => row.linked) ? tr("filesreg.foundLinked") : tr("filesreg.found")} phone="sheet">
      <div className="files-repositories-discovery">
        {candidates?.length === 0 && <p>{tr("filesreg.noneFound")}</p>}
        {candidates?.some((row) => row.linked) && <p>{tr("filesreg.linkedNote")}</p>}
        {candidates?.map((row) => <Checkbox key={row.path} checked={selected.includes(row.path)} disabled={busy} label={row.name} description={row.path} onChange={(checked) => setSelected((ids) => checked ? [...ids, row.path] : ids.filter((id) => id !== row.path))} />)}
        {candidates?.length === 1 && <TextInput aria-label={tr("filesreg.aliasAria")} value={candidateAlias} disabled={busy} maxLength={80} onChange={(event) => setCandidateAlias(event.target.value)} />}
        {limited && <p>{tr("filesreg.scanLimit")}</p>}
        <Button variant="primary" disabled={busy || selected.length === 0} busy={busy} onClick={() => void addSelected()}>{tr("filesreg.addSelected")}</Button>
      </div>
    </ResponsiveOverlay>
    <ResponsiveOverlay open={rename !== null} onClose={() => { if (!busy) setRename(null); }} title={tr("filesreg.renameAliasTitle")} phone="sheet">
      <div className="files-repositories-discovery"><TextInput aria-label={tr("filesreg.aliasAria")} value={alias} maxLength={80} disabled={busy} onChange={(event) => setAlias(event.target.value)} /><Button disabled={busy || !alias.trim()} onClick={() => { if (rename) void apply({ repository: { action: "rename", repositoryId: rename.id, alias: alias.trim() } }).then((ok) => { if (ok) setRename(null); }); }}>{tr("filesreg.save")}</Button></div>
    </ResponsiveOverlay>
  </section>;
}
