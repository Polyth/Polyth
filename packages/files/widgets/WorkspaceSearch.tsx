import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWorkspaceContext, type WorkspaceRepository } from "@polyth/contracts/workspace";
import { api, type FileContentSearchHit } from "@polyth/session/web-api";
import type { SurfaceComponentProps, WebResourceLinkProps, WebUiComponent } from "@polyth/web-sdk";
import { openEditorFile, useStore, workspaceProjectId } from "../../../apps/web/src/store.ts";
import EmptyState, { ProjectRequiredEmpty } from "../../../apps/web/src/components/EmptyState.tsx";
import { RepositoryScopePicker, Spinner, TextInput, WorkspaceSurfaceHeader } from "../../../apps/web/src/components/ui/index.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import "./workspace-search.css";

const SEARCH_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 180;
const safeSearchPath = (value: string): boolean => Boolean(value)
  && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/")
  && !/^[A-Za-z]:/.test(value) && !value.split("/").some((segment) => !segment || segment === "..");

export interface WorkspaceSearchGroup {
  repository: WorkspaceRepository;
  hits: FileContentSearchHit[];
  truncated: boolean;
  error?: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keep one result/error row per repository so a partial workspace failure is
 * visible and cannot be mistaken for an empty search. */
export async function fetchWorkspaceSearch(
  projectId: string,
  sessionId: string | null,
  repositories: readonly WorkspaceRepository[],
  query: string,
  include?: string,
  exclude?: string,
): Promise<WorkspaceSearchGroup[]> {
  const settled = await Promise.allSettled(
    repositories.map((repository) => api.filesSearchContent(
      projectId,
      query,
      SEARCH_LIMIT,
      sessionId ?? undefined,
      repository.repositoryId,
      include,
      exclude,
    )),
  );
  return settled.map((result, index) => {
    const repository = repositories[index]!;
    return result.status === "fulfilled"
      ? { repository, hits: result.value.hits, truncated: result.value.truncated }
      : { repository, hits: [], truncated: false, error: errorMessage(result.reason) };
  });
}

function repoDetail(repository: WorkspaceRepository): string {
  return repository.state === "missing" ? tr("wsearch.repoUnavailable", { path: repository.path }) : repository.path;
}

export default function WorkspaceSearch({
  projectId: scopedProjectId,
  sessionId: scopedSessionId,
  resourceLink: ResourceLink,
}: SurfaceComponentProps & { resourceLink?: WebUiComponent<WebResourceLinkProps> }) {
  const storeProjectId = useStore(workspaceProjectId);
  const storeSessionId = useStore((state) => state.activeSessionId);
  const projectId = scopedProjectId === undefined ? storeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? storeSessionId : scopedSessionId;
  const project = useStore((state) => state.projectRegistry.projects.find((candidate) => candidate.id === projectId));
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const [query, setQuery] = useState("");
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [groups, setGroups] = useState<WorkspaceSearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeError, setScopeError] = useState("");
  const [requestError, setRequestError] = useState("");
  const generation = useRef(0);
  const sessionPending = sessionId !== null && sessionId !== undefined && !session;

  const scopeKey = `${projectId ?? "none"}:${sessionId ?? "project"}`;
  const resolved = useMemo(() => {
    if (!project || sessionPending) return { repositories: [] as WorkspaceRepository[], error: "" };
    try {
      const context = resolveWorkspaceContext(project, session ?? null);
      return {
        repositories: context.repositories,
        error: "",
      };
    } catch (error) {
      return { repositories: [] as WorkspaceRepository[], error: errorMessage(error) };
    }
  }, [project, session, sessionPending]);
  const repositories = resolved.repositories;
  const repositoryKey = repositories.map((repository) => `${repository.repositoryId}:${repository.path}`).join("\u0000");
  const selectedRepositories = useMemo(
    () => repositoryId ? repositories.filter((repository) => repository.repositoryId === repositoryId) : repositories,
    [repositories, repositoryId],
  );

  useEffect(() => {
    setRepositoryId(null);
    setGroups([]);
    setRequestError("");
  }, [scopeKey]);

  useEffect(() => {
    if (repositoryId && !repositories.some((repository) => repository.repositoryId === repositoryId)) {
      setRepositoryId(null);
    }
  }, [repositories, repositoryId]);

  useEffect(() => {
    const token = ++generation.current;
    let cancelled = false;
    const hasQuery = query.trim().length > 0;
    setGroups([]);
    setScopeError(resolved.error);
    setRequestError("");
    if (!projectId || !hasQuery || sessionPending || resolved.error || selectedRepositories.length === 0) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void fetchWorkspaceSearch(projectId, sessionId, selectedRepositories, query, include, exclude)
        .then((next) => {
          if (cancelled || generation.current !== token) return;
          setGroups(next);
          setLoading(false);
          if (next.length > 0 && next.every((group) => group.error)) {
            setRequestError(tr("wsearch.failedAll"));
          }
        })
        .catch((error) => {
          if (cancelled || generation.current !== token) return;
          setLoading(false);
          setRequestError(errorMessage(error));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, sessionId, query, include, exclude, repositoryKey, repositoryId, resolved.error, selectedRepositories, sessionPending]);

  const openResult = (repository: WorkspaceRepository, hit: FileContentSearchHit, permanent: boolean) => {
    if (!repositories.some((candidate) => candidate.repositoryId === repository.repositoryId && candidate.path === repository.path)
      || !safeSearchPath(hit.path) || !Number.isSafeInteger(hit.line) || hit.line < 1
      || !Number.isSafeInteger(hit.column) || hit.column < 0) return;
    openEditorFile(hit.path, {
      path: hit.path,
      startLine: hit.line,
      column: hit.column,
    }, { preview: !permanent, repositoryId: repository.repositoryId });
  };

  if (!projectId) return <ProjectRequiredEmpty title={tr("wsearch.selectProject")} description={tr("wsearch.selectProjectBody")} variant="panel" />;
  if (!project) return <EmptyState variant="panel" title={tr("wsearch.loadingProject")} mark={<Spinner />} />;
  if (sessionPending) return <EmptyState variant="panel" title={tr("wsearch.loadingWorkspace")} description={tr("wsearch.waitingSession")} mark={<Spinner />} />;

  const hasResults = groups.some((group) => group.hits.length > 0);
  const hasTruncated = groups.some((group) => group.truncated);
  const hasSuccessfulGroup = groups.some((group) => !group.error);

  return (
    <section className="workspace-search" aria-label={tr("wsearch.label")}>
      <WorkspaceSurfaceHeader
        className="workspace-search-toolbar"
        label={tr("wsearch.label")}
        scope={<RepositoryScopePicker
          mode="all"
          repositories={repositories.map((repository) => ({
            id: repository.repositoryId,
            alias: repository.alias,
            detail: repoDetail(repository),
          }))}
          value={repositoryId}
          onChange={setRepositoryId}
          label={tr("wsearch.repositories")}
          disabled={repositories.length === 0}
        />}
        context={<div className="workspace-search-context">
          <div className="workspace-search-field">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("wsearch.searchContent")}
              aria-label={tr("wsearch.searchContent")}
              autoFocus
            />
          </div>
          <div className="workspace-search-filters" role="group" aria-label={tr("wsearch.filtersAria")}>
            <TextInput value={include} onChange={(event) => setInclude(event.target.value)} placeholder={tr("wsearch.include", { glob: "src/**" })} aria-label={tr("wsearch.includeAria")} />
            <TextInput value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder={tr("wsearch.exclude", { glob: "dist/**" })} aria-label={tr("wsearch.excludeAria")} />
          </div>
        </div>}
      />
      <div className="workspace-search-state" aria-live="polite">
        {loading && <><Spinner /> <span>{tr("wsearch.searching")}</span></>}
        {!loading && requestError && <span className="workspace-search-error" role="alert">{requestError}</span>}
        {!loading && !requestError && scopeError && <span className="workspace-search-error" role="alert">{scopeError}</span>}
        {!loading && !requestError && !scopeError && hasTruncated && (
          <span className="workspace-search-limited" role="status">{tr("wsearch.limited")}</span>
        )}
      </div>
      {!loading && !requestError && !scopeError && query.trim() && !hasResults && !hasTruncated && hasSuccessfulGroup && (
        <EmptyState variant="panel" title={tr("wsearch.noMatch")} description={tr("wsearch.noMatchBody")} />
      )}
      {!query.trim() && <EmptyState variant="panel" title={tr("wsearch.searchContent")} description={tr("wsearch.typeQuery")} />}
      <div className="workspace-search-results">
        {groups.map((group) => (
          <section className="workspace-search-group" key={group.repository.repositoryId}>
            <header className="workspace-search-group-header">
              <strong>{group.repository.alias}</strong>
              <span>{group.error ? tr("wsearch.error") : tr(new Intl.PluralRules(getLocale()).select(group.hits.length) === "one" ? "wsearch.resultsOne" : "wsearch.resultsOther", { count: group.hits.length })}</span>
            </header>
            {group.error && <p className="workspace-search-error" role="alert">{group.error}</p>}
            {group.hits.filter((hit) => safeSearchPath(hit.path)
              && Number.isSafeInteger(hit.line) && hit.line >= 1
              && Number.isSafeInteger(hit.column) && hit.column >= 0).map((hit, index) => (
              ResourceLink ? (
                <div className="workspace-search-result workspace-search-resource-result" key={`${group.repository.repositoryId}:${hit.path}:${hit.line}:${hit.column}:${index}`} data-repository-id={group.repository.repositoryId} data-path={hit.path}>
                  <ResourceLink
                    resource={{ scheme: "file", locator: hit.path, projectId, sessionId: sessionId ?? null, repositoryId: group.repository.repositoryId }}
                    selection={{ startLine: hit.line, endLine: hit.line, column: hit.column }}
                    resolve={false}
                    mode="range"
                  >
                    <span className="workspace-search-result-location">
                      <span className="workspace-search-result-path">{hit.path}</span>
                      <span className="workspace-search-result-line">{hit.line}:{hit.column}</span>
                    </span>
                    <code>{hit.preview}</code>
                  </ResourceLink>
                </div>
              ) : (
                <button
                  className="workspace-search-result"
                  key={`${group.repository.repositoryId}:${hit.path}:${hit.line}:${hit.column}:${index}`}
                  type="button"
                  data-repository-id={group.repository.repositoryId}
                  data-path={hit.path}
                  onClick={(event) => openResult(group.repository, hit, event.metaKey || event.ctrlKey)}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    openResult(group.repository, hit, true);
                  }}
                  title={tr("wsearch.openAt", { path: hit.path, line: hit.line })}
                >
                  <span className="workspace-search-result-location">
                    <span className="workspace-search-result-path">{hit.path}</span>
                    <span className="workspace-search-result-line">{hit.line}:{hit.column}</span>
                  </span>
                  <code>{hit.preview}</code>
                </button>
              )
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}
