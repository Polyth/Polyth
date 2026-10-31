// "Added packages" on Settings → Packages: the managed library, contributed
// to `settings.packages.content`. It lists under the host page's toolbar
// (one search for the whole page), reports its matches back, and takes the
// page over for one package's detail.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { InstalledPluginDto } from "@polyth/contracts";
import { EmptyState, ErrorState, ItemList, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { AddIcon, RefreshIcon, UploadIcon } from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { LIBRARY_OWNER, readPackagesContext } from "./packagesContext.ts";
import { PluginDetail, type PluginDetailTab } from "./PluginDetail.tsx";
import { PluginInstallDialog, type SourceInstallOptions } from "./PluginInstallDialog.tsx";
import { PluginRow } from "./PluginRow.tsx";
import { matchesQuery, matchesStatus, libraryMatches, sourceCanRefetch } from "./pluginTaxonomy.ts";
import { needsReviewToEnable, usePluginLibrary } from "./usePluginLibrary.ts";

const hasFiles = (event: DragEvent<HTMLElement>) => [...(event.dataTransfer?.types ?? [])].includes("Files");

export function ManagedPluginsSection({ context = {} }: { context?: Readonly<Record<string, unknown>> }) {
  const page = readPackagesContext(context);
  const { packagesQuery: query, packagesStatus: status, packagesCategory: category, reportPackageMatches, setPackageDetailOpen } = page;
  const library = usePluginLibrary();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginDetailTab>("overview");
  const [installOpen, setInstallOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<string | null>(null);

  const selected = library.plugins.find((plugin) => plugin.id === selectedId) ?? null;
  // A package uninstalled (here or elsewhere) closes its detail.
  useEffect(() => {
    if (selectedId && library.loaded && !selected) setSelectedId(null);
  }, [library.loaded, selected, selectedId]);

  const matches = useMemo(
    () => libraryMatches(library.plugins, query, category),
    [library.plugins, query, category],
  );
  useEffect(() => {
    reportPackageMatches(LIBRARY_OWNER, matches);
  }, [matches, reportPackageMatches]);
  useEffect(() => () => reportPackageMatches(LIBRARY_OWNER, { all: 0, enabled: 0, disabled: 0 }), [reportPackageMatches]);

  // Before paint, so the host never shows the detail above its own lists.
  const detailOpen = selected !== null;
  useLayoutEffect(() => {
    setPackageDetailOpen(LIBRARY_OWNER, detailOpen);
  }, [detailOpen, setPackageDetailOpen]);
  useEffect(() => () => setPackageDetailOpen(LIBRARY_OWNER, false), [setPackageDetailOpen]);

  // Back returns focus to the row that opened the detail.
  useLayoutEffect(() => {
    const id = returnFocusTo.current;
    if (detailOpen || !id) return;
    returnFocusTo.current = null;
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-plugin-id]") ?? [])]
      .find((element) => element.dataset.pluginId === id);
    row?.querySelector<HTMLButtonElement>(".settings-list-hit")?.focus({ preventScroll: true });
  }, [detailOpen]);

  const open = (plugin: InstalledPluginDto, next: PluginDetailTab = "overview") => {
    setTab(next);
    setSelectedId(plugin.id);
  };
  const back = () => {
    returnFocusTo.current = selectedId;
    setSelectedId(null);
  };

  const closeInstaller = () => {
    setInstallOpen(false);
    setDroppedFile(null);
  };
  const openInstaller = (file: File | null = null) => {
    setDroppedFile(file);
    setInstallOpen(true);
  };
  /** A new package opens straight onto what it needs next: review, or its overview. */
  const installed = (plugin: InstalledPluginDto) => {
    closeInstaller();
    open(plugin, needsReviewToEnable(plugin) ? "permissions" : "overview");
  };
  const installSource = async (source: string, options: SourceInstallOptions) => installed(await library.installSource(source, options));
  const installArchive = async (archive: string, filename: string) => installed(await library.installArchive(archive, filename));

  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event) || installOpen) return;
      event.preventDefault();
      if (!dragging) setDragging(true);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event) || installOpen) return;
      event.preventDefault();
      setDragging(false);
      openInstaller(event.dataTransfer?.files?.[0] ?? null);
    },
  };

  const filtered = query.trim().length > 0 || status !== "all" || category !== null;
  // Alphabetical, like the page's built-in lists.
  const visible = category !== null
    ? []
    : library.plugins
      .filter((plugin) => matchesQuery(plugin, query) && matchesStatus(plugin, status))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id));
  const enabledCount = library.plugins.filter((plugin) => plugin.enabled).length;
  const refetchable = library.plugins.some((plugin) => plugin.updatable ?? sourceCanRefetch(plugin.source));
  // Under an active search or filter the section only appears when it has
  // matches; the page owns the single "nothing matches" state.
  const hidden = !selected && filtered && library.loaded && visible.length === 0 && !library.error;

  const installer = installOpen && (
    <PluginInstallDialog
      initialFile={droppedFile}
      onClose={closeInstaller}
      onInstallSource={installSource}
      onInstallArchive={installArchive}
    />
  );
  const announcer = <span className="sr-only" role="status" aria-live="polite">{library.announcement}</span>;

  if (selected) {
    return (
      <div className="pkg-plugins" ref={rootRef}>
        <PluginDetail
          plugin={selected}
          library={library}
          tab={tab}
          onTab={setTab}
          onBack={back}
          onUploadNew={() => openInstaller()}
        />
        {installer}
        {announcer}
      </div>
    );
  }

  return (
    <div className={`pkg-plugins${dragging ? " is-dragging" : ""}`} ref={rootRef} {...dropHandlers}>
      {!hidden && (
        <Section
          itemId="plugins.managed"
          title={tr("packages.plugins.packages")}
          {...(library.status ? { hint: library.status } : {})}
          action={(
            <>
              {library.plugins.length > 0 && (
                <span className="plugin-library-meta">
                  {tr("settings.packagespage.optionalOnCount", { on: enabledCount, total: library.plugins.length })}
                </span>
              )}
              {refetchable && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconStart={RefreshIcon}
                  busy={library.checking === "*"}
                  disabled={library.checking !== null}
                  onClick={() => void library.checkAllUpdates()}
                >
                  {tr("packages.plugins.checkForUpdates")}
                </Button>
              )}
              <Button size="sm" variant="quiet" iconStart={AddIcon} onClick={() => openInstaller()}>
                {tr("packages.plugins.addPackage")}
              </Button>
            </>
          )}
        >
          {library.error && <ErrorState compact error={library.error} />}
          {!library.loaded ? (
            <EmptyState compact busy title={tr("packages.plugins.loadingPackages")} />
          ) : library.plugins.length === 0 ? (
            <button type="button" className="plugin-empty" onClick={() => openInstaller()}>
              <span className="plugin-empty-mark" aria-hidden="true"><Icon icon={UploadIcon} size="md" /></span>
              <span className="plugin-empty-copy">
                <strong>{tr("packages.plugins.emptyTitle")}</strong>
                <span>{tr("packages.plugins.emptyBody")}</span>
              </span>
            </button>
          ) : visible.length > 0 ? (
            <ItemList label={tr("packages.plugins.packages")}>
              {visible.map((plugin) => (
                <PluginRow
                  key={plugin.id}
                  plugin={plugin}
                  query={query}
                  busy={library.busy.has(plugin.id)}
                  onOpen={() => open(plugin)}
                  onReview={() => open(plugin, "permissions")}
                  onToggle={(enabled) => void library.setEnabled(plugin, enabled)}
                />
              ))}
            </ItemList>
          ) : null}
        </Section>
      )}
      {installer}
      {announcer}
    </div>
  );
}

export default function PluginsPage({ context }: { context?: Readonly<Record<string, unknown>> }) {
  return <ManagedPluginsSection {...(context ? { context } : {})} />;
}
