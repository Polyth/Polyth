// The catalog: search first, sources you can read at a glance and filter with in
// place, and a list that is already there instead of behind a click.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  CapabilityInstallationScope,
  SkillCatalogDto,
  SkillCatalogSkillDto,
  SkillCatalogSourceDto,
} from "@polyth/contracts/capability-installations";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, ErrorState, HighlightedText, ItemList, ItemRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  AddIcon,
  Button,
  CheckIcon,
  ExternalLinkIcon,
  FavoriteIcon,
  Icon,
  IconButton,
  RefreshIcon,
  SearchIcon,
  CloseIcon,
  Select,
  Skeleton,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { SkillMark, updatedLabel, skillCountLabel } from "./SkillParts.tsx";
import { catalogView, defaultInstallScope, formatStars } from "./skillModel.ts";
import { SkillSourceDialog } from "./SkillSourceDialog.tsx";
import { skillsApi } from "./skillsApi.ts";

const PAGE = 60;
const MAX_CHIPS = 7;

/** A narrow repository's few shelves read as chips; dozens read better as a list. */
function CollectionFilter({ collections, value, onChange }: {
  collections: readonly string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  if (collections.length < 2) return null;
  const label = tr("settings.skills.catalog.collection");
  if (collections.length > MAX_CHIPS) {
    return (
      <Select
        className="skills-collection-select"
        label={label}
        value={value ?? ""}
        options={[
          { value: "", label: tr("settings.skills.catalog.allCollections") },
          ...collections.map((collection) => ({ value: collection, label: collection })),
        ]}
        onChange={(next) => onChange(next || null)}
      />
    );
  }
  return (
    <div className="skills-chips" role="group" aria-label={label}>
      {[null, ...collections].map((collection) => (
        <button
          key={collection ?? ""}
          type="button"
          className="skills-chip"
          aria-pressed={value === collection}
          onClick={() => onChange(collection)}
        >{collection ?? tr("settings.skills.catalog.allCollections")}</button>
      ))}
    </div>
  );
}

function SourceTile({ source, selected, matches, searching, onToggle }: {
  source: SkillCatalogSourceDto;
  selected: boolean;
  matches: number;
  searching: boolean;
  onToggle: () => void;
}) {
  const firstRead = source.skillCount === 0;
  let meta;
  if (firstRead && source.sync === "syncing") meta = <Skeleton width="72%" />;
  else if (firstRead && source.sync === "error") meta = <span>{tr("settings.skills.catalog.readFailed")}</span>;
  else if (searching) {
    meta = <span>{matches === 0
      ? tr("settings.skills.catalog.noMatchesHere")
      : matches === 1 ? tr("settings.skills.catalog.matches.one") : tr("settings.skills.catalog.matches", { count: matches })}</span>;
  } else {
    meta = (
      <>
        <span>{skillCountLabel(source.skillCount)}</span>
        {source.stars !== undefined && (
          <span className="skills-stars"><Icon icon={FavoriteIcon} size="sm" />{formatStars(source.stars)}</span>
        )}
      </>
    );
  }
  return (
    <button
      type="button"
      className={`skills-source${selected ? " is-selected" : ""}${searching && matches === 0 ? " is-empty" : ""}`}
      aria-pressed={selected}
      onClick={onToggle}
    >
      <span className="skills-source-mark"><SkillMark avatar={source.avatar} /></span>
      <span className="skills-source-text">
        <strong>{source.label}</strong>
        <small className="skills-source-meta">{meta}</small>
      </span>
    </button>
  );
}

function SourceMasthead({ source, canRefresh, canRemove, onRefresh, onRemove, onClear }: {
  source: SkillCatalogSourceDto;
  canRefresh: boolean;
  canRemove: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  return (
    <section className="skills-masthead" aria-label={source.label}>
      <div className="skills-masthead-text">
        <a className="skills-masthead-repo" href={source.url} target="_blank" rel="noreferrer">
          {source.repository}<Icon icon={ExternalLinkIcon} size="sm" />
        </a>
        {source.description && <p className="skills-masthead-desc">{source.description}</p>}
        <p className="skills-masthead-facts">
          {source.stars !== undefined && <span className="skills-stars"><Icon icon={FavoriteIcon} size="sm" />{formatStars(source.stars)}</span>}
          {source.license && <span>{source.license}</span>}
          {source.updatedAt !== undefined && <span>{updatedLabel(source.updatedAt)}</span>}
          <span>{source.sync === "syncing" ? tr("settings.skills.catalog.reading") : skillCountLabel(source.skillCount)}</span>
        </p>
        {source.sync === "error" && source.error && (
          <p className="skills-masthead-error" role="alert">{tr("settings.skills.catalog.sourceError", { error: source.error })}</p>
        )}
      </div>
      <div className="skills-masthead-actions">
        {canRefresh && (
          <IconButton
            icon={RefreshIcon}
            size="sm"
            label={tr("settings.skills.catalog.refresh")}
            disabled={source.sync === "syncing"}
            onClick={onRefresh}
          />
        )}
        {canRemove && <Button size="sm" variant="ghost" className="commands-delete" onClick={onRemove}>{tr("settings.skills.catalog.removeSource")}</Button>}
        <IconButton icon={CloseIcon} size="sm" label={tr("settings.skills.catalog.clearSource")} onClick={onClear} />
      </div>
    </section>
  );
}

function ShelfCard({ skill, source, onOpen }: {
  skill: SkillCatalogSkillDto;
  source: SkillCatalogSourceDto | undefined;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="skills-card" onClick={onOpen}>
      <span className="skills-card-head">
        <span className="skills-card-mark"><SkillMark avatar={source?.avatar} /></span>
        <span className="skills-card-titles">
          <strong>{skill.title}</strong>
          <small>{source?.label}</small>
        </span>
        {skill.installed?.length ? <Icon icon={CheckIcon} size="sm" className="skills-card-check" /> : null}
      </span>
      <span className="skills-card-desc">{skill.description}</span>
    </button>
  );
}

function RowAction({ skill, scope, busy, onInstall, onOpen }: {
  skill: SkillCatalogSkillDto;
  scope: CapabilityInstallationScope | undefined;
  busy: boolean;
  onInstall: () => void;
  onOpen: () => void;
}) {
  const installed = skill.installed?.[0];
  if (installed?.state === "outdated") return <Button size="sm" onClick={onOpen}>{tr("settings.skills.library.update")}</Button>;
  if (installed) {
    return <span className="skills-installed"><Icon icon={CheckIcon} size="sm" />{tr("settings.skills.catalog.installed")}</span>;
  }
  if (skill.tooLarge) return <span className="skills-row-note">{tr("settings.skills.catalog.tooLarge")}</span>;
  if (!scope) return null;
  // Anything a person must weigh first goes through the review page.
  const needsReview = skill.hiddenText || skill.nameTakenIn?.includes(scope);
  return (
    <Button size="sm" busy={busy} onClick={needsReview ? onOpen : onInstall}>
      {tr("settings.skills.catalog.install")}
    </Button>
  );
}

function CatalogSkeleton() {
  return (
    <div className="skills-skeleton" aria-busy="true" role="status" aria-label={tr("settings.skills.catalog.loadingTitle")}>
      {Array.from({ length: 6 }, (_, index) => (
        <div className="skills-skeleton-row" key={index}>
          <Skeleton shape="block" width={36} height={36} />
          <div>
            <Skeleton width={`${28 + (index * 13) % 24}%`} />
            <Skeleton width={`${62 + (index * 17) % 30}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkillCatalogView({ active, catalog, error, projectId, installing, onReload, onOpen, onInstall }: {
  /** This tab is the one showing. Coming back from a skill does not change it,
   *  so Back keeps the row it returned focus to. */
  active: boolean;
  catalog: SkillCatalogDto | undefined;
  error: unknown;
  projectId: string | null;
  installing: string | null;
  onReload: () => Promise<void>;
  onOpen: (skill: SkillCatalogSkillDto) => void;
  onInstall: (skill: SkillCatalogSkillDto, scope: CapabilityInstallationScope) => void;
}) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setLimit(PAGE); }, [query, sourceId, collection]);

  // The catalog's first question is what you need, so typing starts at once. Not
  // on touch, where this would raise the keyboard over the page. `/` stays with
  // Settings' own search, which claims it before any page can.
  const loaded = Boolean(catalog);
  useEffect(() => {
    if (!active || !loaded || !window.matchMedia?.("(hover: hover)").matches) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [active, loaded]);

  const view = useMemo(
    () => (catalog ? catalogView(catalog, { query, sourceId, collection }) : undefined),
    [catalog, query, sourceId, collection],
  );
  const sources = useMemo(() => new Map(catalog?.sources.map((source) => [source.id, source])), [catalog]);
  const source = sourceId ? sources.get(sourceId) : undefined;
  const scope = catalog ? defaultInstallScope(catalog.access, projectId) : undefined;
  const searching = Boolean(query.trim());
  const reading = catalog?.sources.some((row) => row.sync === "syncing") ?? false;

  const focusRow = (from: Element | null, step: number) => {
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>(".settings-list-hit") ?? [])];
    const index = from ? rows.indexOf(from as HTMLElement) : -1;
    const next = rows[index + step];
    if (next) next.focus();
    else if (step < 0) searchRef.current?.focus();
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    const inSearch = target === searchRef.current;
    if (!inSearch && !target.classList.contains("settings-list-hit")) return;
    event.preventDefault();
    focusRow(inSearch ? null : target, event.key === "ArrowDown" ? 1 : -1);
  };

  const removeSource = async (row: SkillCatalogSourceDto) => {
    if (!await confirmAlert(tr("settings.skills.catalog.removeSourceConfirm", { name: row.label }), {
      title: tr("settings.skills.catalog.removeSource"),
      confirmLabel: tr("settings.skillspage.remove"),
      destructive: true,
    })) return;
    try {
      await skillsApi.removeSource(row.id);
      setSourceId(null);
      await onReload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const refresh = async (id?: string) => {
    try {
      await skillsApi.refresh(id);
      await onReload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!catalog) {
    return error
      ? <ErrorState compact title={tr("settings.skills.catalog.loadError")} error={error} onRetry={() => void onReload()} />
      : <CatalogSkeleton />;
  }

  const nothingYet = catalog.skills.length === 0;
  const rows = view!.rows.slice(0, limit);

  return (
    <div className="skills-catalog" ref={rootRef} onKeyDown={onListKey}>
      <div className="skills-search-bar" role="search">
        <div className="skills-search">
          <Icon icon={SearchIcon} size="md" />
          <TextInput
            ref={searchRef}
            type="search"
            aria-label={tr("settings.skills.catalog.searchLabel")}
            placeholder={nothingYet
              ? tr("settings.skills.catalog.searchLabel")
              : tr("settings.skills.catalog.search", { count: catalog.skills.length })}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // In capture: the Settings dialog's own Esc listener runs before a
            // field's ordinary key handler would.
            onKeyDownCapture={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && <IconButton icon={CloseIcon} size="sm" label={tr("settings.skills.catalog.clearSearch")} onClick={() => { setQuery(""); searchRef.current?.focus(); }} />}
        </div>
      </div>

      <div className="skills-sources-head">
        <h3 className="settings-section-title">{tr("settings.skills.catalog.sources")}</h3>
        <div className="skills-sources-actions">
          {/* A chosen source has its own, in its masthead. */}
          {catalog.access.project && !source && (
            <IconButton
              icon={RefreshIcon}
              size="sm"
              label={tr("settings.skills.catalog.refresh")}
              disabled={reading}
              onClick={() => void refresh()}
            />
          )}
          {catalog.access.sources && (
            <Button size="sm" variant="ghost" iconStart={AddIcon} onClick={() => setAdding(true)}>
              {tr("settings.skills.catalog.addSource")}
            </Button>
          )}
        </div>
      </div>
      <div className="skills-sources">
        {catalog.sources.map((row) => (
          <SourceTile
            key={row.id}
            source={row}
            selected={sourceId === row.id}
            searching={searching}
            matches={view!.matchesBySource.get(row.id) ?? 0}
            onToggle={() => {
              setCollection(null);
              setSourceId(sourceId === row.id ? null : row.id);
            }}
          />
        ))}
      </div>

      {notice && <div className="form-error" role="alert">{notice}</div>}

      {source && (
        <SourceMasthead
          source={source}
          canRefresh={catalog.access.project}
          canRemove={catalog.access.sources && !source.builtin}
          onRefresh={() => void refresh(source.id)}
          onRemove={() => void removeSource(source)}
          onClear={() => { setSourceId(null); setCollection(null); }}
        />
      )}

      {view!.shelf.length > 0 && (
        <Section title={tr("settings.skills.catalog.startHere")} hint={tr("settings.skills.catalog.startHereHint")}>
          <div className="skills-shelf">
            {view!.shelf.map((skill) => (
              <ShelfCard key={skill.id} skill={skill} source={sources.get(skill.sourceId)} onOpen={() => onOpen(skill)} />
            ))}
          </div>
        </Section>
      )}

      {nothingYet && reading
        ? <CatalogSkeleton />
        : view!.rows.length === 0 && !nothingYet
          ? (
            <EmptyState
              compact
              icon="search"
              title={tr("settings.skills.catalog.noMatchTitle", { query: query.trim() })}
              body={tr("settings.skills.catalog.noMatchBody")}
              {...(catalog.access.sources ? { action: { label: tr("settings.skills.catalog.addSource"), onClick: () => setAdding(true) } } : {})}
            />
          )
          : nothingYet
            ? (
              <EmptyState
                compact
                icon="assist"
                title={tr("settings.skills.catalog.emptyTitle")}
                body={tr("settings.skills.catalog.emptyBody")}
                action={{ label: tr("settings.skills.catalog.tryAgain"), onClick: () => void refresh() }}
              />
            )
            : (
              <Section
                title={searching ? tr("settings.skills.catalog.results") : tr("settings.skills.catalog.all")}
                action={<CollectionFilter collections={view!.collections} value={collection} onChange={setCollection} />}
              >
                <ItemList label={tr("settings.skills.catalog.all")}>
                  {rows.map((skill) => (
                    <ItemRow
                      key={skill.id}
                      icon={<SkillMark avatar={sources.get(skill.sourceId)?.avatar} />}
                      title={skill.title}
                      meta={(
                        <span>
                          <HighlightedText
                            text={[sources.get(skill.sourceId)?.label, skill.collection].filter(Boolean).join(" · ")}
                            query={query}
                          />
                        </span>
                      )}
                      description={skill.description}
                      highlight={query}
                      openLabel={tr("settings.skills.catalog.openSkill", { name: skill.title })}
                      onOpen={() => onOpen(skill)}
                      trailing={(
                        <RowAction
                          skill={skill}
                          scope={scope}
                          busy={installing === skill.id}
                          onOpen={() => onOpen(skill)}
                          onInstall={() => { if (scope) onInstall(skill, scope); }}
                        />
                      )}
                    />
                  ))}
                </ItemList>
                {view!.rows.length > limit && (
                  <div className="skills-more">
                    <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE * 2)}>
                      {tr("settings.skills.catalog.showMore", { count: view!.rows.length - limit })}
                    </Button>
                  </div>
                )}
              </Section>
            )}

      <p className="skills-agent-hint">{tr("settings.skills.catalog.agentHint")}</p>

      {adding && (
        <SkillSourceDialog
          onClose={() => setAdding(false)}
          onAdded={async (added) => {
            setAdding(false);
            await onReload();
            setQuery("");
            setCollection(null);
            setSourceId(added.id);
          }}
        />
      )}
    </div>
  );
}
