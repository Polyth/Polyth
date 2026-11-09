// Every skill this Polyth can reach, across Polyth and all your harnesses.
import { useMemo, useState } from "react";
import type { CapabilityInstallationScope, SkillLibraryDto, SkillLibraryEntryDto } from "@polyth/contracts/capability-installations";
import { EmptyState, ErrorState, ItemList, ItemRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { AddIcon, Badge, Button, CloseIcon, Icon, IconButton, SearchIcon, Skeleton, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { harnessStyle, SkillMark } from "./SkillParts.tsx";
import { availabilityOf, defaultInstallScope, harnessCounts, libraryGroups, usableCount } from "./skillModel.ts";

const discoveredLabel = (scope: NonNullable<SkillLibraryEntryDto["discoveredIn"]>): string => {
  if (scope === "project-opencode") return tr("settings.skillspage.discoveredOpencode");
  if (scope === "project-claude") return tr("settings.skillspage.discoveredClaude");
  if (scope === "project-agents") return tr("settings.skillspage.discoveredAgents");
  if (scope === "user-opencode") return tr("settings.skillspage.userOpencode");
  if (scope === "user-claude") return tr("settings.skillspage.userClaude");
  if (scope === "user-agents") return tr("settings.skillspage.userAgents");
  return tr("settings.skills.library.folderUnclaimed");
};

const namesOf = (entry: SkillLibraryEntryDto, library: SkillLibraryDto): string => {
  const names = entry.natives.map((native) => library.harnesses.find((row) => row.id === native.harnessId)?.name ?? native.harnessId);
  const unique = [...new Set(names)];
  return unique.length > 3 ? `${unique.slice(0, 3).join(", ")} +${unique.length - 3}` : unique.join(", ");
};

function Rows({ entries, library, query, projectId, busy, onOpen, onUpdate, onAdopt }: {
  entries: readonly SkillLibraryEntryDto[];
  library: SkillLibraryDto;
  query: string;
  projectId: string | null;
  busy: string | null;
  onOpen: (entry: SkillLibraryEntryDto) => void;
  onUpdate: (entry: SkillLibraryEntryDto) => void;
  onAdopt: (entry: SkillLibraryEntryDto, scope: CapabilityInstallationScope) => void;
}) {
  const adoptScope = defaultInstallScope(library.access, projectId);
  return (
    <ItemList>
      {entries.map((entry) => {
        const managed = entry.managed;
        const origin = managed?.origin;
        const rows = availabilityOf(entry, library.harnesses);
        const usable = usableCount(rows);
        const canWrite = managed ? (managed.scope === "space" ? library.access.space : library.access.project) : false;
        const adoptable = !managed && adoptScope && entry.natives.some((native) => native.importable);
        const meta = managed
          ? [
            origin?.kind === "catalog" ? origin.sourceLabel : origin?.kind === "harness" ? tr("settings.skills.library.fromHarness", { name: origin.harnessName }) : undefined,
            managed.scope === "space" ? tr("settings.skills.library.scopeSpace") : tr("settings.skills.library.scopeProject"),
          ].filter(Boolean).join(" · ")
          : entry.natives.length ? namesOf(entry, library) : entry.discoveredIn ? discoveredLabel(entry.discoveredIn) : "";
        return (
          <ItemRow
            key={entry.name}
            icon={<SkillMark avatar={entry.avatar} />}
            title={entry.title}
            meta={(
              <>
                <span>{meta}</span>
                {managed?.modified && <Badge>{tr("settings.skills.library.customized")}</Badge>}
              </>
            )}
            {...(entry.description ? { description: entry.description } : {})}
            highlight={query}
            openLabel={tr("settings.skills.catalog.openSkill", { name: entry.title })}
            onOpen={() => onOpen(entry)}
            trailing={(
              <>
                {managed && library.harnesses.length > 0 && usable < library.harnesses.length && (
                  <span className="skills-row-note">{tr("settings.skills.library.reach", { count: usable, total: library.harnesses.length })}</span>
                )}
                {entry.updateAvailable && canWrite && (
                  <Button size="sm" busy={busy === entry.name} onClick={() => onUpdate(entry)}>{tr("settings.skills.library.update")}</Button>
                )}
                {adoptable && (
                  // Offered on the row a person is looking at: on every row at
                  // once it would be the loudest thing on the page.
                  <Button size="sm" className="skills-row-reveal" busy={busy === entry.name} onClick={() => onAdopt(entry, adoptScope)}>{tr("settings.skills.library.useEverywhere")}</Button>
                )}
              </>
            )}
          />
        );
      })}
    </ItemList>
  );
}

function LibrarySkeleton() {
  return (
    <div className="skills-skeleton" aria-busy="true" role="status" aria-label={tr("settings.skillspage.loading")}>
      {Array.from({ length: 4 }, (_, index) => (
        <div className="skills-skeleton-row" key={index}>
          <Skeleton shape="block" width={36} height={36} />
          <div>
            <Skeleton width={`${24 + (index * 11) % 20}%`} />
            <Skeleton width={`${58 + (index * 19) % 30}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkillLibraryView({ library, error, projectId, busy, notice, onReload, onOpen, onUpdate, onAdopt, onNew, onBrowse }: {
  library: SkillLibraryDto | undefined;
  error: unknown;
  projectId: string | null;
  busy: string | null;
  notice: string;
  onReload: () => Promise<void>;
  onOpen: (entry: SkillLibraryEntryDto) => void;
  onUpdate: (entry: SkillLibraryEntryDto) => void;
  onAdopt: (entry: SkillLibraryEntryDto, scope: CapabilityInstallationScope) => void;
  onNew: () => void;
  onBrowse: () => void;
}) {
  const [query, setQuery] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const groups = useMemo(
    () => (library ? libraryGroups(library, query, harnessId || null) : undefined),
    [library, query, harnessId],
  );
  const counts = useMemo(() => (library ? harnessCounts(library, query) : undefined), [library, query]);

  if (!library || !groups) {
    return error
      ? <ErrorState compact title={tr("settings.skills.library.loadError")} error={error} onRetry={() => void onReload()} />
      : <LibrarySkeleton />;
  }

  const canCreate = library.access.project || library.access.space;
  const rowProps = { library, query, projectId, busy, onOpen, onUpdate, onAdopt };
  const total = groups.managed.length + groups.own.length + groups.builtIn.length;
  const filtering = Boolean(query.trim() || harnessId);

  return (
    <div className="skills-library">
      <div className="skills-library-bar">
        <div className="skills-search is-compact" role="search">
          <Icon icon={SearchIcon} size="sm" />
          <TextInput
            uiSize="sm"
            type="search"
            aria-label={tr("settings.skills.library.search")}
            placeholder={tr("settings.skills.library.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <IconButton icon={CloseIcon} size="sm" label={tr("settings.skills.catalog.clearSearch")} onClick={() => setQuery("")} />}
        </div>
        {canCreate && <Button size="sm" iconStart={AddIcon} onClick={onNew}>{tr("settings.skillspage.newSkill")}</Button>}
      </div>

      {library.harnesses.length > 1 && (
        <div className="skills-harness-chips" role="group" aria-label={tr("settings.skills.library.filterHarness")}>
          <button type="button" className="skills-harness-chip" aria-pressed={!harnessId} onClick={() => setHarnessId("")}>
            {tr("settings.skills.library.allSkills")}
          </button>
          {library.harnesses.map((harness) => (
            <button
              key={harness.id}
              type="button"
              className="skills-harness-chip"
              aria-pressed={harnessId === harness.id}
              onClick={() => setHarnessId(harnessId === harness.id ? "" : harness.id)}
            >
              {harness.color && <span className="skills-harness-dot" style={harnessStyle(harness)} aria-hidden="true" />}
              {harness.name}
              <em className="skills-harness-count">{counts?.get(harness.id) ?? 0}</em>
            </button>
          ))}
        </div>
      )}

      {notice && <div className="form-error" role="alert">{notice}</div>}

      {total === 0 && (
        filtering
          ? (
            <EmptyState
              compact
              icon="search"
              title={tr("settings.skills.library.noMatch", { query: query.trim() || library.harnesses.find((row) => row.id === harnessId)?.name || "" })}
              body={tr("settings.skills.library.noMatchBody")}
              action={{ label: tr("settings.skills.library.browse"), onClick: onBrowse }}
            />
          )
          : (
            <EmptyState
              icon="assist"
              title={tr("settings.skills.library.emptyTitle")}
              body={tr("settings.skills.library.emptyBody")}
              action={{ label: tr("settings.skills.library.browse"), onClick: onBrowse }}
            />
          )
      )}

      {groups.managed.length > 0
        ? (
          <Section title={tr("settings.skills.library.managedTitle")} hint={tr("settings.skills.library.managedHint")}>
            <Rows entries={groups.managed} {...rowProps} />
          </Section>
        )
        : total > 0 && !filtering && (
          <EmptyState
            compact
            icon="assist"
            title={tr("settings.skills.library.managedEmptyTitle")}
            body={tr("settings.skills.library.managedEmptyBody")}
            action={{ label: tr("settings.skills.library.browse"), onClick: onBrowse }}
          />
        )}
      {groups.own.length > 0 && (
        <Section title={tr("settings.skills.library.ownTitle")} hint={tr("settings.skills.library.ownHint")}>
          <Rows entries={groups.own} {...rowProps} />
        </Section>
      )}
      {groups.builtIn.length > 0 && (
        <Section
          title={tr("settings.skills.library.builtInTitle")}
          hint={tr("settings.skills.library.builtInHint", { count: groups.builtIn.length })}
          action={(
            <Button size="sm" variant="ghost" aria-expanded={showBuiltIn || Boolean(query.trim())} onClick={() => setShowBuiltIn(!showBuiltIn)}>
              {showBuiltIn ? tr("settings.skills.library.hide") : tr("settings.skills.library.show")}
            </Button>
          )}
        >
          {(showBuiltIn || query.trim()) && <Rows entries={groups.builtIn} {...rowProps} />}
        </Section>
      )}
    </div>
  );
}
