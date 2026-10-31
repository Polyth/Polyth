import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PackageDescriptorDto } from "@polyth/contracts";
import type { PackagesPageMatches, PackagesPageSlotContext } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import { bootPackages, subscribePackages } from "../../packages/registry.ts";
import { deletePackageSessions, findPackageSessions, hidePackageSessions, refreshLoadedProjectSessions, type PackageSessionOwner } from "../../packages/packageSessions.ts";
import SlotHost, { useSlotVersion } from "../slots/SlotHost.ts";
import { listSlots } from "../../slots.ts";
import { openSettingsPage } from "../../store.ts";
import { guardedSettingsPageVisible, useGuardrails } from "../../guardrails.ts";
import { maybeAutoShowPackageTour, openPackageTour } from "../../packages/onboarding/controller.ts";
import { canonicalTourPackageId, packageToSettingsPageId } from "../../packages/onboarding/pageMap.ts";
import { getPackageOnboarding, subscribePackageOnboardings } from "../../packages/onboarding/registry.ts";
import { EmptyState, ErrorState, ItemList, ItemRow, PageHead, Section, Seg, settingsErrorText } from "./parts.tsx";
import { PackageGlyph } from "./packageIcons.tsx";
import PackageResidueSection from "./PackageResidueSection.tsx";
import {
  filterPackages,
  isFiltered,
  packageEntry,
  packageFacets,
  sumMatches,
  type PackageEntry,
  type PackageFilter,
  type PackageStatusFilter,
} from "./packageManagement.ts";
import { tr, type TranslationKey } from "../../i18n/index.ts";
import { Badge, Button, Checkbox, Dialog, Icon, IconButton, Notice, Select, Spinner, Switch, TextInput, VisuallyHidden } from "../ui/index.ts";
import { CloseIcon, HelpIcon, LockIcon, SearchIcon } from "../ui/icons.ts";
import { isImeComposing } from "../input/editorCore.ts";

const PACKAGE_NAME_KEYS: Readonly<Record<string, TranslationKey>> = {
  git: "packages.git.git",
  terminal: "capabilities.terminal",
  preview: "capabilities.preview",
  browser: "packages.onboarding.tours.builtin.browser",
  goals: "statusbar.goals",
  multirun: "packages.onboarding.tours.builtin.multirun",
  workflow: "statusbar.workflows",
  fusion: "statusbar.fusion",
  walkthrough: "statusbar.walkthrough",
  schedule: "statusbar.schedule",
  usage: "packages.usage.usage",
  knowledge: "capabilities.knowledge",
  dictation: "settings.packagespage.voiceAndDictation",
  ssh: "packages.ssh.sshRemotes",
  mcp: "packages.mcp.mcp",
  commands: "packages.commands.commands",
  plugins: "packages.plugins.plugins",
  integrations: "packages.integrations.integrations",
  recap: "settings.packagespage.sessionAssist",
};

const PACKAGE_DESCRIPTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  git: "settings.packagespage.gitDescription",
  terminal: "settings.packagespage.terminalDescription",
  preview: "settings.packagespage.previewDescription",
  browser: "settings.packagespage.browserDescription",
  goals: "settings.packagespage.goalsDescription",
  multirun: "settings.packagespage.multirunDescription",
  workflow: "settings.packagespage.workflowDescription",
  fusion: "settings.packagespage.fusionDescription",
  walkthrough: "settings.packagespage.walkthroughDescription",
  recap: "settings.packagespage.recapDescription",
  schedule: "settings.packagespage.scheduleDescription",
  usage: "settings.packagespage.usageDescription",
  github: "settings.packagespage.githubDescription",
  knowledge: "settings.packagespage.knowledgeDescription",
  dictation: "settings.packagespage.dictationDescription",
  ssh: "settings.packagespage.sshDescription",
  mcp: "packages.mcp.modelContextProtocolServerConfiguration",
  commands: "settings.packagespage.commandsDescription",
  plugins: "settings.packagespage.pluginsDescription",
  integrations: "settings.packagespage.integrationsDescription",
};

const CATEGORY_KEYS: Readonly<Record<string, TranslationKey>> = {
  workspace: "projectcomposition.workspace",
  engineering: "projectcomposition.direction.engineering",
  research: "projectcomposition.direction.research",
  operations: "projectcomposition.direction.operations",
  finance: "projectcomposition.direction.finance",
  wellbeing: "projectcomposition.direction.wellbeing",
  home: "projectcomposition.direction.home",
  system: "settingsview.system",
  other: "settings.packagespage.categoryOther",
};

const packageName = (descriptor: PackageDescriptorDto): string => {
  const key = PACKAGE_NAME_KEYS[descriptor.id];
  return key ? tr(key) : descriptor.name;
};

const packageDescription = (descriptor: PackageDescriptorDto): string => {
  const key = PACKAGE_DESCRIPTION_KEYS[descriptor.id];
  return key ? tr(key) : descriptor.description;
};

const categoryLabel = (id: string): string => {
  const key = CATEGORY_KEYS[id];
  return key ? tr(key) : id.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
};

const STATUS_LABELS: Readonly<Record<PackageStatusFilter, TranslationKey>> = {
  all: "settings.packagespage.filterAll",
  enabled: "settings.packagespage.filterOn",
  disabled: "settings.packagespage.filterOff",
};

/** Preview packages (off by default) are labelled; while one is on, its row
 *  says plainly that it is not well tested yet. */
const MATURITY_KEYS: Readonly<Partial<Record<string, { badge: TranslationKey; notice: TranslationKey }>>> = {
  "in-progress": { badge: "settings.packagespage.inProgress", notice: "settings.packagespage.inProgressNotice" },
  beta: { badge: "settings.packagespage.beta", notice: "settings.packagespage.betaNotice" },
};

const EMPTY_FILTER: PackageFilter = { query: "", status: "all", category: null };
const ALL_CATEGORIES = "";

function Count({ value }: { value: number }) {
  return <em className="seg-count">{value}</em>;
}

const sameMatches = (left: PackagesPageMatches | undefined, right: PackagesPageMatches): boolean =>
  !!left && left.all === right.all && left.enabled === right.enabled && left.disabled === right.disabled;

/** One built-in package: identity and description, then its tour, the on/off
 *  switch (core packages show a lock note instead) and — when the package has
 *  its own settings page — a chevron: the row opens that page. */
function PackageRow({
  entry, query, pending, error, selecting, selected, settingsPageId, onToggle, onSelect,
}: {
  entry: PackageEntry;
  query: string;
  /** Target state of an in-flight change, if any. */
  pending: boolean | undefined;
  error: string | undefined;
  selecting: boolean;
  selected: boolean;
  settingsPageId: string | null;
  onToggle: (enabled: boolean) => void;
  onSelect: (selected: boolean) => void;
}) {
  const { descriptor, name } = entry;
  const tourId = canonicalTourPackageId(descriptor.id);
  const hasTour = !!getPackageOnboarding(tourId);
  const shownEnabled = pending ?? descriptor.enabled;
  const selectable = selecting && !descriptor.core;
  const maturity = descriptor.maturity ? MATURITY_KEYS[descriptor.maturity] : undefined;
  return (
    <ItemRow
      className="package-row"
      data-package-id={descriptor.id}
      aria-busy={pending !== undefined || undefined}
      icon={<PackageGlyph icon={descriptor.icon} size={18} strokeWidth={1.75} />}
      title={name}
      meta={maturity
        ? <Badge tone="warning" className="package-maturity">{tr(maturity.badge)}</Badge>
        : undefined}
      description={entry.description}
      highlight={query}
      inactive={!descriptor.core && !shownEnabled}
      {...(error ? { error } : {})}
      {...(maturity && shownEnabled ? { notice: tr(maturity.notice) } : {})}
      {...(selectable
        ? { selection: { checked: selected, onChange: onSelect, label: tr("settings.packagespage.selectValue", { name }) } }
        : {})}
      {...(settingsPageId && !selecting
        ? { onOpen: () => openSettingsPage(settingsPageId), openLabel: tr("settings.packagespage.openValueSettings", { name }) }
        : {})}
      trailing={(
        <>
          {hasTour && !selecting && (
            <IconButton
              size="sm"
              icon={HelpIcon}
              className="package-tour-btn"
              label={tr("settings.packagespage.previewTheValueTour", { name })}
              onClick={() => openPackageTour(tourId, "preview")}
            />
          )}
          {descriptor.core ? (
            <span className="package-locked">
              <Icon icon={LockIcon} size="sm" />
              {tr("settings.packagespage.alwaysOn")}
            </span>
          ) : (
            <>
              {pending !== undefined && <Spinner size="sm" label={tr("settings.packagespage.applying")} />}
              <Switch
                checked={shownEnabled}
                label={descriptor.enabled
                  ? tr("settings.packagespage.disableValue", { value: name })
                  : tr("settings.packagespage.enableValue", { value: name })}
                disabled={pending !== undefined}
                onChange={onToggle}
              />
            </>
          )}
        </>
      )}
    />
  );
}

export default function PackagesPage() {
  const [packages, setPackages] = useState<PackageDescriptorDto[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<PackageFilter>(EMPTY_FILTER);
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  // What `settings.packages.content` contributions list under the toolbar,
  // and which of them currently shows a detail view in place of the page.
  const [contributed, setContributed] = useState<ReadonlyMap<string, PackagesPageMatches>>(() => new Map());
  const [detailOwners, setDetailOwners] = useState<ReadonlySet<string>>(() => new Set());
  const [stuck, setStuck] = useState(false);
  // A package about to be turned off that still owns chats: the row stays on
  // until the person chooses clean up, hide, or cancel.
  const [ownedSessions, setOwnedSessions] = useState<{ descriptor: PackageDescriptorDto; owner: PackageSessionOwner } | null>(null);
  // The whole batch a prompt interrupted, so a bulk disable continues after.
  const [ownerBatch, setOwnerBatch] = useState<readonly PackageDescriptorDto[]>([]);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listScroll = useRef<number | null>(null);
  const inFlight = useRef(new Set<string>());
  // Bumped when a change starts and settles, so a list read that raced a
  // change cannot paint the pre-change state over the confirmed one.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const at = generation.current;
    try {
      const response = await api.packagesList();
      if (at !== generation.current) return;
      setPackages(response.packages);
      setLoadError(null);
    } catch (cause) {
      if (at === generation.current) setLoadError(cause);
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribePackages(() => { void load(); });
  }, [load]);

  // Re-render rows when tours or settings pages register/unregister.
  const [, setToursAt] = useState(0);
  useEffect(() => subscribePackageOnboardings(() => setToursAt((value) => value + 1)), []);
  const slotsAt = useSlotVersion();
  const guardrails = useGuardrails();
  const settingsPages = useMemo(() => listSlots("settings.pages"), [slotsAt]);
  const settingsPageFor = (descriptor: PackageDescriptorDto): string | null => {
    if (!descriptor.enabled || !descriptor.hasSettings) return null;
    const pageId = packageToSettingsPageId(descriptor.id, settingsPages);
    return pageId && guardedSettingsPageVisible(guardrails, pageId) ? pageId : null;
  };

  const pane = (): HTMLElement | null => rootRef.current?.closest<HTMLElement>(".settings-pane-body") ?? null;

  const reportPackageMatches = useCallback((owner: string, matches: PackagesPageMatches) => {
    setContributed((current) => {
      if (sameMatches(current.get(owner), matches)) return current;
      const next = new Map(current);
      next.set(owner, { ...matches });
      return next;
    });
  }, []);

  const setPackageDetailOpen = useCallback((owner: string, open: boolean) => {
    // Remember where the list was before the detail replaces it, so Back
    // returns the reader to the same rows.
    if (open && listScroll.current === null) listScroll.current = pane()?.scrollTop ?? null;
    setDetailOwners((current) => {
      if (current.has(owner) === open) return current;
      const next = new Set(current);
      if (open) next.add(owner); else next.delete(owner);
      return next;
    });
  }, []);

  const detailOpen = detailOwners.size > 0;
  useLayoutEffect(() => {
    const scroller = pane();
    if (!scroller) return;
    if (detailOpen) scroller.scrollTop = 0;
    else if (listScroll.current !== null) {
      scroller.scrollTop = listScroll.current;
      listScroll.current = null;
    }
  }, [detailOpen]);

  const slotContext = useMemo<PackagesPageSlotContext>(() => ({
    packagesQuery: filter.query,
    packagesStatus: filter.status,
    packagesCategory: filter.category,
    reportPackageMatches,
    setPackageDetailOpen,
  }), [filter, reportPackageMatches, setPackageDetailOpen]);

  // The toolbar sticks to the top of the pane; once content scrolls under it
  // the bar lifts off the page with a soft edge.
  const toolbarShown = packages !== null && !detailOpen;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = pane();
    if (!toolbarShown || !sentinel || !scroller || typeof IntersectionObserver === "undefined") {
      setStuck(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting), { root: scroller });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [toolbarShown]);

  const entries = useMemo(() => (packages ?? []).map((descriptor) => {
    const category = descriptor.category ?? "other";
    return packageEntry(descriptor, {
      name: packageName(descriptor),
      description: packageDescription(descriptor),
      category: categoryLabel(category),
    });
  }), [packages]);
  const visible = useMemo(() => filterPackages(entries, filter), [entries, filter]);
  const facets = useMemo(() => packageFacets(entries, filter), [entries, filter]);
  const counts = sumMatches(facets.status, contributed.values());
  const optional = visible.filter((entry) => !entry.descriptor.core);
  const core = visible.filter((entry) => entry.descriptor.core);
  const optionalOn = entries.filter((entry) => !entry.descriptor.core && entry.descriptor.enabled).length;
  const optionalTotal = entries.filter((entry) => !entry.descriptor.core).length;
  const filtered = isFiltered(filter);

  const patchFilter = (patch: Partial<PackageFilter>) => setFilter((current) => ({ ...current, ...patch }));
  const clearFilters = () => {
    setFilter(EMPTY_FILTER);
    searchRef.current?.focus();
  };

  const setMap = <V,>(update: (next: Map<string, V>) => void) => (current: ReadonlyMap<string, V>) => {
    const next = new Map(current);
    update(next);
    return next;
  };

  /** Apply one target state to one or more packages, one request at a time.
   * Rows show the target immediately; a failure restores the row and keeps
   * its reason beside it. The list is re-read once everything settles. */
  const setEnabled = async (descriptors: readonly PackageDescriptorDto[], enabled: boolean) => {
    const targets = descriptors.filter((item) => !item.core && item.enabled !== enabled && !inFlight.current.has(item.id));
    if (targets.length === 0) return;
    // Turning a package off leaves the chats of its own lane behind. Its
    // purpose is package-owned for the session's life, so ask once: clean them
    // up, hide them, or cancel. Nothing is touched until the person chooses.
    if (!enabled) {
      const owner = await firstOwnerWithSessions(targets);
      if (owner) {
        setSessionError("");
        setOwnerBatch(targets);
        setOwnedSessions({ descriptor: owner.descriptor, owner: owner.sessions });
        return;
      }
    }
    await applyEnabled(targets, enabled);
  };

  /** First target that still owns lane chats, in the batch's order. */
  const firstOwnerWithSessions = async (
    targets: readonly PackageDescriptorDto[],
  ): Promise<{ descriptor: PackageDescriptorDto; sessions: PackageSessionOwner } | null> => {
    for (const item of targets) {
      try {
        const sessions = await findPackageSessions(item.id);
        if (sessions) return { descriptor: item, sessions };
      } catch {
        // Enumeration is best-effort: a package whose chats cannot be read
        // still disables, it just is not offered the cleanup prompt.
      }
    }
    return null;
  };

  /** Turn off (or on) the package, then act on the chats it owns. */
  const resolveOwnedSessions = async (action: "cleanup" | "hide" | "cancel") => {
    const pendingOwner = ownedSessions;
    if (!pendingOwner || sessionBusy) return;
    if (action === "cancel") {
      setOwnedSessions(null);
      setOwnerBatch([]);
      return;
    }
    setSessionBusy(true);
    setSessionError("");
    try {
      if (action === "hide") await hidePackageSessions(pendingOwner.owner);
      else await deletePackageSessions(pendingOwner.owner);
      setOwnedSessions(null);
      // Continue the original batch: this package is now clear to disable, and
      // the rest of the selection is applied in the same pass.
      const remaining = ownerBatch.length > 0 ? ownerBatch : [pendingOwner.descriptor];
      setOwnerBatch([]);
      const fresh = remaining.map((item) => packages?.find((entry) => entry.id === item.id) ?? item);
      await applyEnabled(fresh, false);
    } catch (cause) {
      setSessionError(settingsErrorText(cause).message);
    } finally {
      setSessionBusy(false);
    }
  };

  const applyEnabled = async (targets: readonly PackageDescriptorDto[], enabled: boolean) => {
    for (const item of targets) inFlight.current.add(item.id);
    generation.current += 1;
    setError("");
    setPending(setMap((next) => { for (const item of targets) next.set(item.id, enabled); }));
    setRowErrors(setMap((next) => { for (const item of targets) next.delete(item.id); }));
    const applied: PackageDescriptorDto[] = [];
    for (const item of targets) {
      try {
        const updated = await api.packagesSetEnabled(item.id, enabled);
        applied.push(updated);
        setPackages((current) => current?.map((entry) => entry.id === updated.id ? updated : entry) ?? null);
      } catch (cause) {
        const name = packageName(item);
        const reason = settingsErrorText(cause).message;
        setRowErrors(setMap((next) => {
          next.set(item.id, tr(enabled ? "settings.packagespage.couldNotEnable" : "settings.packagespage.couldNotDisable", { name, reason }));
        }));
      } finally {
        inFlight.current.delete(item.id);
        setPending(setMap((next) => { next.delete(item.id); }));
      }
    }
    if (applied.length > 0) {
      try {
        await bootPackages();
      } catch (cause) {
        setError(settingsErrorText(cause).message);
      }
    }
    generation.current += 1;
    void load();
    // Hiding chats archives rows the sidebar may not hold (a package lane can
    // span projects), so reconcile the loaded projects from the server.
    if (!enabled && applied.length > 0) void refreshLoadedProjectSessions();
    if (applied.length === 1) {
      const name = packageName(applied[0]!);
      setAnnouncement(tr(enabled ? "settings.packagespage.valueEnabled" : "settings.packagespage.valueDisabled", { name }));
      // A freshly enabled package introduces itself once (unless skipped).
      if (enabled && targets.length === 1) maybeAutoShowPackageTour(canonicalTourPackageId(applied[0]!.id));
    } else if (applied.length > 1) {
      setAnnouncement(tr(enabled ? "settings.packagespage.countEnabled" : "settings.packagespage.countDisabled", { count: applied.length }));
    }
  };

  const selectableVisible = optional.map((entry) => entry.descriptor);
  const selectedDescriptors = (packages ?? []).filter((item) => !item.core && selected.has(item.id));
  const toEnable = selectedDescriptors.filter((item) => !item.enabled);
  const toDisable = selectedDescriptors.filter((item) => item.enabled);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((item) => selected.has(item.id));
  const toggleSelect = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const selectAllVisible = (on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const item of selectableVisible) {
      if (on) next.add(item.id); else next.delete(item.id);
    }
    return next;
  });
  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const runBulk = async (items: readonly PackageDescriptorDto[], enabled: boolean) => {
    await setEnabled(items, enabled);
    setSelected(new Set());
  };

  const renderRows = (list: readonly PackageEntry[], label: string): ReactNode => (
    <ItemList label={label}>
      {list.map((entry) => (
        <PackageRow
          key={entry.descriptor.id}
          entry={entry}
          query={filter.query}
          pending={pending.get(entry.descriptor.id)}
          error={rowErrors.get(entry.descriptor.id)}
          selecting={selecting}
          selected={selected.has(entry.descriptor.id)}
          settingsPageId={settingsPageFor(entry.descriptor)}
          onToggle={(enabled) => { void setEnabled([entry.descriptor], enabled); }}
          onSelect={(on) => toggleSelect(entry.descriptor.id, on)}
        />
      ))}
    </ItemList>
  );

  const categoryOptions = [
    { value: ALL_CATEGORIES, label: tr("settings.packagespage.allCategories") },
    ...facets.categories.map((facet) => ({ value: facet.id, label: categoryLabel(facet.id), detail: String(facet.count) })),
  ];

  return (
    <div className={`packages-page${detailOpen ? " is-detail" : ""}`} ref={rootRef}>
      {!detailOpen && <PageHead title={tr("settings.packagespage.packages")} blurb={tr("settings.packagespage.enableOrDisableOptionalWorkspaceFeatures")} />}
      {!packages && !loadError && !detailOpen && <EmptyState compact title={tr("settings.packagespage.loadingInstalledPolythPackages")} busy />}
      {!packages && !!loadError && !detailOpen && <ErrorState title={tr("settings.packagespage.packagesUnavailable")} error={loadError} onRetry={() => void load()} />}
      {toolbarShown && (
        <>
          <div className="packages-toolbar-sentinel" ref={sentinelRef} aria-hidden="true" />
          <div className={`packages-toolbar${stuck ? " is-stuck" : ""}`} role="search">
            <div className="packages-search">
              <Icon icon={SearchIcon} size="sm" />
              <TextInput
                ref={searchRef}
                uiSize="sm"
                type="search"
                value={filter.query}
                onChange={(event) => patchFilter({ query: event.target.value })}
                onKeyDown={(event) => {
                  if (isImeComposing(event)) return;
                  if (event.key === "Escape" && filter.query) {
                    event.preventDefault();
                    event.stopPropagation();
                    patchFilter({ query: "" });
                  }
                }}
                aria-label={tr("settings.packagespage.searchPackages")}
                placeholder={tr("settings.packagespage.searchPackagesPlaceholder")}
              />
              {filter.query && (
                <IconButton size="sm" variant="ghost" icon={CloseIcon} label={tr("settings.packagespage.clearSearch")} onClick={() => { patchFilter({ query: "" }); searchRef.current?.focus(); }} />
              )}
            </div>
            <div className="packages-filters">
              <Seg
                value={filter.status}
                label={tr("settings.packagespage.statusFilter")}
                onChange={(status) => patchFilter({ status })}
                options={(["all", "enabled", "disabled"] as const).map((status) => [
                  status,
                  <>{tr(STATUS_LABELS[status])}<Count value={counts[status]} /></>,
                ])}
              />
              {facets.categories.length > 1 && (
                <Select
                  className="packages-category"
                  searchable={false}
                  align="end"
                  label={tr("settings.packagespage.categoryFilter")}
                  value={filter.category ?? ALL_CATEGORIES}
                  options={categoryOptions}
                  onChange={(value) => patchFilter({ category: value === ALL_CATEGORIES ? null : value })}
                />
              )}
            </div>
          </div>
        </>
      )}
      <SlotHost slot="settings.packages.content" context={slotContext as unknown as Record<string, unknown>} />
      {packages && !detailOpen && (
        <div className="packages-list">
          {error && <ErrorState compact error={error} />}
          {filtered && counts[filter.status] === 0 && (
            <EmptyState
              compact
              icon="search"
              title={tr("settings.packagespage.noPackagesMatch")}
              body={tr("settings.packagespage.noPackagesMatchHint")}
              action={{ label: tr("settings.packagespage.clearFilters"), onClick: clearFilters }}
            />
          )}
          {optional.length > 0 && (
            <Section
              title={tr("settings.packagespage.optionalPackages")}
              hint={tr("settings.packagespage.optionalPackagesHint")}
              action={(
                <>
                  <span className="packages-section-meta">{tr("settings.packagespage.optionalOnCount", { on: optionalOn, total: optionalTotal })}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="packages-select-toggle"
                    aria-pressed={selecting}
                    onClick={() => selecting ? endSelection() : setSelecting(true)}
                  >
                    {selecting ? tr("settings.packagespage.done") : tr("settings.packagespage.select")}
                  </Button>
                </>
              )}
            >
              {renderRows(optional, tr("settings.packagespage.optionalPackages"))}
            </Section>
          )}
          {core.length > 0 && (
            <Section title={tr("settings.packagespage.corePackages")} hint={tr("settings.packagespage.corePackagesHint")}>
              {renderRows(core, tr("settings.packagespage.corePackages"))}
            </Section>
          )}
          <PackageResidueSection refreshKey={packages} />
          {selecting && (
            <div className="packages-bulkbar" role="toolbar" aria-label={tr("settings.packagespage.bulkActions")}>
              <Checkbox
                className="packages-bulk-all"
                checked={allVisibleSelected}
                disabled={selectableVisible.length === 0}
                onChange={selectAllVisible}
                label={tr("settings.packagespage.selectAllShown", { count: selectableVisible.length })}
              />
              <span className="packages-bulk-count">{tr("settings.packagespage.selectedCount", { count: selectedDescriptors.length })}</span>
              <div className="packages-bulk-actions">
                <Button size="sm" variant="quiet" disabled={toEnable.length === 0} onClick={() => { void runBulk(toEnable, true); }}>
                  {toEnable.length > 0 ? tr("settings.packagespage.enableCount", { count: toEnable.length }) : tr("settings.pages.enable")}
                </Button>
                <Button size="sm" variant="quiet" disabled={toDisable.length === 0} onClick={() => { void runBulk(toDisable, false); }}>
                  {toDisable.length > 0 ? tr("settings.packagespage.disableCount", { count: toDisable.length }) : tr("settings.pages.disable")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <VisuallyHidden><span role="status" aria-live="polite">{announcement}</span></VisuallyHidden>
      {ownedSessions && (
        <Dialog
          title={tr("settings.packagespage.ownedSessionsTitle", { name: packageName(ownedSessions.descriptor) })}
          onClose={() => { if (!sessionBusy) { setOwnedSessions(null); setOwnerBatch([]); } }}
          size="sm"
          className="package-sessions-dialog"
          footer={(
            <>
              <Button size="sm" disabled={sessionBusy} onClick={() => { void resolveOwnedSessions("cancel"); }}>
                {tr("common.cancel")}
              </Button>
              <Button size="sm" disabled={sessionBusy} onClick={() => { void resolveOwnedSessions("hide"); }}>
                {tr("settings.packagespage.ownedSessionsHide")}
              </Button>
              <Button size="sm" variant="danger" disabled={sessionBusy} onClick={() => { void resolveOwnedSessions("cleanup"); }}>
                {tr("settings.packagespage.ownedSessionsCleanup")}
              </Button>
            </>
          )}
        >
          <Notice tone="warning" role="alert">
            {tr("settings.packagespage.ownedSessionsBody", {
              name: packageName(ownedSessions.descriptor),
              count: ownedSessions.owner.sessions.length,
            })}
          </Notice>
          <p className="package-sessions-hint">
            {ownedSessions.owner.archivedCount > 0
              ? tr("settings.packagespage.ownedSessionsHintArchived", { count: ownedSessions.owner.archivedCount })
              : tr("settings.packagespage.ownedSessionsHint")}
            {ownedSessions.owner.truncated && <> {tr("settings.packagespage.ownedSessionsHintPartial")}</>}
          </p>
          {sessionBusy && <Spinner size="sm" label={tr("settings.packagespage.applying")} />}
          {sessionError !== "" && <ErrorState compact error={sessionError} />}
        </Dialog>
      )}
    </div>
  );
}
