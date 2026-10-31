import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type {
  TaskTrackerBoardDto,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
} from "@polyth/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  Notice,
  Select,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { api } from "./api.ts";
import { PROVIDER_LABELS, ProviderMark, providerNouns } from "./brand.tsx";
import { tt } from "./i18n.ts";
import { SettingRow } from "./management.tsx";
import {
  isProjectVisible,
  setProjectTracker,
  updateProviderScope,
  useProjectTracker,
  useProviderScope,
  type ProviderBoardScope,
} from "./scope.ts";
import { friendly } from "./store.ts";

/**
 * Board scope: which projects/workspaces and boards one person sees in a
 * Polyth project, which open by default, and a way to create a board without
 * leaving Polyth.
 */

/** Jira groups boards by project; Trello by workspace; Linear by team. */
const PROJECT_NOUN_KEYS = {
  jira: { singular: "tasktrackers.brand.noun.project", plural: "tasktrackers.brand.noun.projects", all: "tasktrackers.brand.noun.allProjects" },
  trello: { singular: "tasktrackers.brand.noun.workspace", plural: "tasktrackers.brand.noun.workspaces", all: "tasktrackers.brand.noun.allWorkspaces" },
  linear: { singular: "tasktrackers.brand.noun.team", plural: "tasktrackers.brand.noun.teams", all: "tasktrackers.brand.noun.allTeams" },
} as const;

export function projectNouns(provider: TaskTrackerProvider): { singular: string; plural: string; all: string } {
  const keys = PROJECT_NOUN_KEYS[provider];
  const singular = tt(keys.singular);
  return {
    singular: singular.charAt(0).toLocaleUpperCase() + singular.slice(1),
    plural: tt(keys.plural),
    all: tt(keys.all),
  };
}

const toggle = (list: readonly string[], id: string, hidden: boolean): string[] =>
  hidden ? [...new Set([...list, id])] : list.filter((item) => item !== id);

function DefaultRadio({
  name,
  checked,
  disabled,
  label,
  onChoose,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChoose: () => void;
}) {
  return (
    <label className={`tt-default-radio${checked ? " on" : ""}${disabled ? " disabled" : ""}`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChoose}
      />
      <span aria-hidden="true">{checked ? tt("tasktrackers.boards.default") : tt("tasktrackers.boards.makeDefault")}</span>
    </label>
  );
}

/** Choose what the board shows in this Polyth project and what it opens first. */
export function BoardScopeDialog({
  provider,
  projects,
  projectId,
  onClose,
}: {
  provider: TaskTrackerProvider;
  projects: readonly TaskTrackerProjectDto[];
  /** The Polyth project the choice belongs to; none edits the account-wide one. */
  projectId: string | null;
  onClose: () => void;
}) {
  const scope = useProviderScope(projectId, provider);
  const opensFirst = useProjectTracker(projectId) === provider;
  const nouns = projectNouns(provider);
  const projectRadio = useId();
  const boardRadio = useId();
  const [boards, setBoards] = useState<TaskTrackerBoardDto[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    void api.taskTrackerBoards(provider)
      .then((items) => { if (active) setBoards(items); })
      .catch((cause) => { if (active) setError(friendly(tt("tasktrackers.board.couldNotLoadBoards"), cause)); });
    return () => { active = false; };
  }, [provider, reload]);

  const groups = useMemo(() => {
    const byProject = new Map<string, TaskTrackerBoardDto[]>();
    for (const board of boards ?? []) {
      const key = board.projectId ?? "";
      byProject.set(key, [...byProject.get(key) ?? [], board]);
    }
    const named = projects
      .filter((project) => byProject.has(project.id))
      .map((project) => ({ id: project.id, name: project.name, boards: byProject.get(project.id)! }));
    const known = new Set(projects.map((project) => project.id));
    const other = [...byProject.entries()]
      .filter(([key]) => !known.has(key))
      .flatMap(([, items]) => items);
    return other.length > 0 ? [...named, { id: "", name: tt("tasktrackers.boards.otherBoards"), boards: other }] : named;
  }, [boards, projects]);

  const update = (patch: Partial<ProviderBoardScope>) => updateProviderScope(projectId, provider, patch);
  const customized = scope.hiddenProjects.length > 0 || scope.hiddenBoards.length > 0
    || Boolean(scope.defaultProjectId) || Boolean(scope.defaultBoardId);

  return (
    <Dialog
      title={tt("tasktrackers.boards.dialogTitle")}
      onClose={onClose}
      size="md"
      className="tt-scope-dialog"
      footer={(
        <>
          <Button
            variant="ghost"
            disabled={!customized}
            onClick={() => update({ hiddenProjects: [], hiddenBoards: [], defaultProjectId: "", defaultBoardId: "" })}
          >
            {tt("tasktrackers.boards.showEverything")}
          </Button>
          <Button variant="primary" onClick={onClose}>{tt("tasktrackers.boards.done")}</Button>
        </>
      )}
    >
      <div className="tt-scope">
        <p className="tt-compose-target">
          <ProviderMark provider={provider} size="sm" />
          <span>{PROVIDER_LABELS[provider]} · {projectId
            ? tt("tasktrackers.boards.scopeProject")
            : tt("tasktrackers.boards.scopeAccount")}</span>
        </p>
        {projectId && (
          <div className="tt-setting-list">
            <SettingRow
              title={tt("tasktrackers.boards.openFirstTitle", { provider: PROVIDER_LABELS[provider] })}
              body={tt("tasktrackers.boards.openFirstBody")}
              checked={opensFirst}
              disabled={false}
              onChange={(checked) => setProjectTracker(projectId, checked ? provider : "")}
            />
          </div>
        )}
        {error && (
          <Notice tone="error" actions={<Button size="sm" onClick={() => setReload((value) => value + 1)}>{tt("tasktrackers.boards.tryAgain")}</Button>}>
            {error}
          </Notice>
        )}

        <section className="tt-scope-section" aria-label={nouns.plural}>
          <h4>{nouns.plural}</h4>
          {projects.length === 0 ? (
            <p className="tt-inline-hint">{tt("tasktrackers.boards.noNouns", { noun: nouns.plural.toLocaleLowerCase() })}</p>
          ) : (
            <ul className="tt-scope-list">
              <li className="tt-scope-row">
                <span className="tt-scope-name"><strong>{nouns.all}</strong><small>{tt("tasktrackers.boards.fromEvery", { noun: nouns.singular.toLocaleLowerCase() })}</small></span>
                <DefaultRadio
                  name={projectRadio}
                  checked={!scope.defaultProjectId}
                  label={tt("tasktrackers.boards.openAllDefault", { noun: nouns.all.toLocaleLowerCase() })}
                  onChoose={() => update({ defaultProjectId: "" })}
                />
              </li>
              {projects.map((project) => {
                const visible = isProjectVisible(scope, project.id);
                const defaultBoardInside = boards?.some((board) =>
                  board.id === scope.defaultBoardId && board.projectId === project.id) ?? false;
                return (
                  <li className={`tt-scope-row${visible ? "" : " off"}`} key={project.id}>
                    <Checkbox
                      checked={visible}
                      onChange={(checked) => update({
                        hiddenProjects: toggle(scope.hiddenProjects, project.id, !checked),
                        // A board inside a hidden project cannot stay the default.
                        ...(!checked && defaultBoardInside ? { defaultBoardId: "" } : {}),
                      })}
                      label={<span className="tt-scope-name"><strong>{project.name}</strong>{project.key && project.key !== project.name && <small>{project.key}</small>}</span>}
                    />
                    <DefaultRadio
                      name={projectRadio}
                      checked={scope.defaultProjectId === project.id}
                      disabled={!visible}
                      label={tt("tasktrackers.boards.openDefault", { name: project.name })}
                      onChoose={() => update({ defaultProjectId: project.id })}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="tt-scope-section" aria-label={tt("tasktrackers.boards.sectionBoards")} aria-busy={boards === null}>
          <h4>{tt("tasktrackers.boards.sectionBoards")}</h4>
          {boards === null && !error ? (
            <p className="tt-inline-hint" role="status"><span className="tt-spinner" /> {tt("tasktrackers.boards.loading")}</p>
          ) : groups.length === 0 ? (
            <p className="tt-inline-hint">{tt("tasktrackers.boards.empty")}</p>
          ) : groups.map((group) => {
            const projectHidden = Boolean(group.id) && !isProjectVisible(scope, group.id);
            return (
              <div className="tt-scope-group" key={group.id || "other"}>
                <span className="tt-scope-group-name">{group.name}{projectHidden && <i> · {tt("tasktrackers.boards.hidden")}</i>}</span>
                <ul className="tt-scope-list">
                  {group.boards.map((board) => {
                    const shown = !scope.hiddenBoards.includes(board.id);
                    return (
                      <li className={`tt-scope-row${shown && !projectHidden ? "" : " off"}`} key={board.id}>
                        <Checkbox
                          checked={shown}
                          disabled={projectHidden}
                          onChange={(checked) => update({ hiddenBoards: toggle(scope.hiddenBoards, board.id, !checked) })}
                          label={<span className="tt-scope-name"><strong>{board.name}</strong><small>{board.type}</small></span>}
                        />
                        <DefaultRadio
                          name={boardRadio}
                          checked={scope.defaultBoardId === board.id}
                          disabled={!shown || projectHidden}
                          label={tt("tasktrackers.boards.openDefault", { name: board.name })}
                          onChoose={() => update({ defaultBoardId: board.id })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {scope.defaultBoardId && (
            <Button size="sm" variant="ghost" onClick={() => update({ defaultBoardId: "" })}>
              {tt("tasktrackers.boards.clearDefault")}
            </Button>
          )}
        </section>
      </div>
    </Dialog>
  );
}

/** New tracker board, filed in the chosen project/workspace. In Linear the
 *  board is a new project in the chosen team. */
export function BoardComposer({
  provider,
  projects,
  projectId,
  onClose,
  onCreated,
}: {
  provider: TaskTrackerProvider;
  projects: readonly TaskTrackerProjectDto[];
  /** The current filter; preselected when it names a project. */
  projectId: string;
  onClose: () => void;
  onCreated: (board: TaskTrackerBoardDto) => void;
}) {
  const nouns = projectNouns(provider);
  const [name, setName] = useState("");
  const needsProject = provider !== "trello";
  const [project, setProject] = useState(projectId || (needsProject ? projects[0]?.id ?? "" : ""));
  const [type, setType] = useState<"kanban" | "scrum">("kanban");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noun = providerNouns(provider).board;
  const ready = name.trim().length > 0 && (!needsProject || Boolean(project));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      onCreated(await api.taskTrackerCreateBoard(provider, {
        name: name.trim(),
        ...(project ? { projectId: project } : {}),
        ...(provider === "jira" ? { type } : {}),
      }));
    } catch (cause) {
      setError(friendly(tt("tasktrackers.boards.createError", { noun }), cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tt("tasktrackers.boards.newTitle", { provider: PROVIDER_LABELS[provider], noun })}
      onClose={onClose}
      size="sm"
      className="tt-compose-dialog"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{tt("tasktrackers.boards.cancel")}</Button>
          <Button type="submit" form="tt-board-form" variant="primary" busy={busy} disabled={!ready || busy}>
            {tt("tasktrackers.boards.create", { noun })}
          </Button>
        </>
      )}
    >
      <form id="tt-board-form" className="tt-compose" onSubmit={(event) => void submit(event)} noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <label className="tt-field">
          <span>{tt("tasktrackers.boards.name")}</span>
          <TextInput
            value={name}
            autoFocus
            maxLength={255}
            placeholder={provider === "linear" ? tt("tasktrackers.boards.nameProjectPlaceholder") : tt("tasktrackers.boards.nameBoardPlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="tt-field">
          <span>{nouns.singular}{!needsProject && <small> {tt("tasktrackers.boards.optional")}</small>}</span>
          <Select
            label={nouns.singular}
            value={project}
            disabled={busy}
            onChange={setProject}
            options={[
              ...(needsProject ? [] : [{ value: "", label: tt("tasktrackers.boards.personalBoards") }]),
              ...projects.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
          {needsProject && projects.length === 0 && (
            <small className="tt-inline-hint">{provider === "linear"
              ? tt("tasktrackers.boards.linearNoTeam")
              : tt("tasktrackers.boards.jiraProjectFirst")}</small>
          )}
          {provider === "linear" && projects.length > 0 && (
            <small className="tt-inline-hint">{tt("tasktrackers.boards.linearHint")}</small>
          )}
        </div>
        {provider === "jira" && (
          <div className="tt-field">
            <span>{tt("tasktrackers.boards.boardType")}</span>
            <Select
              label={tt("tasktrackers.boards.boardType")}
              value={type}
              disabled={busy}
              onChange={(value) => setType(value === "scrum" ? "scrum" : "kanban")}
              options={[
                { value: "kanban", label: tt("tasktrackers.boards.kanban") },
                { value: "scrum", label: tt("tasktrackers.boards.scrum") },
              ]}
            />
            <small className="tt-inline-hint">{tt("tasktrackers.boards.filterCreated")}</small>
          </div>
        )}
      </form>
    </Dialog>
  );
}
