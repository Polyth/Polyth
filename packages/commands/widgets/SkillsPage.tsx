// Settings → Skills: the library of what your harnesses can use, and the catalog
// of what they could. Both stay mounted behind an open skill, so its Back returns
// to the same search, filter and scroll position.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CapabilityInstallationScope,
  SkillCatalogDto,
  SkillCatalogSkillDto,
  SkillLibraryDetailDto,
  SkillLibraryDto,
  SkillLibraryEntryDto,
} from "@polyth/contracts/capability-installations";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { PageHead, SettingsTabs } from "../../../apps/web/src/components/settings/parts.tsx";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { SkillCatalogView } from "./SkillCatalogView.tsx";
import { SkillDetailView, type SkillDetailTarget } from "./SkillDetailView.tsx";
import { SkillEditor, type SkillEditorSeed } from "./SkillEditor.tsx";
import { SkillLibraryView } from "./SkillLibraryView.tsx";
import { skillsApi } from "./skillsApi.ts";

type SkillsTab = "library" | "catalog";
const POLL_MS = 1_200;

const tabFor = (target: SettingsNavigationTarget | undefined): SkillsTab | undefined =>
  target?.itemId === "skills.browse" ? "catalog" : target?.itemId === "skills.catalog" ? "library" : undefined;
const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export default function SkillsPage({ settingsTarget }: { settingsTarget?: SettingsNavigationTarget }) {
  const projectId = useStore((state) => state.activeProjectId);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const projectName = projectRegistry.status === "ready"
    ? projectRegistry.projects.find((candidate) => candidate.id === projectId)?.name
    : undefined;

  const [tab, setTab] = useState<SkillsTab>(tabFor(settingsTarget) ?? "library");
  const [seenTarget, setSeenTarget] = useState(settingsTarget);
  if (settingsTarget !== seenTarget) {
    setSeenTarget(settingsTarget);
    const requested = tabFor(settingsTarget);
    if (requested) setTab(requested);
  }

  const [library, setLibrary] = useState<SkillLibraryDto>();
  const [libraryError, setLibraryError] = useState<unknown>();
  const [catalog, setCatalog] = useState<SkillCatalogDto>();
  const [catalogError, setCatalogError] = useState<unknown>();
  const [catalogWanted, setCatalogWanted] = useState(tab === "catalog");
  const [detail, setDetail] = useState<SkillDetailTarget | null>(null);
  const [editor, setEditor] = useState<SkillEditorSeed | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const selection = useRef(projectId);
  selection.current = projectId;

  const reloadLibrary = useCallback(async (fresh?: string) => {
    const asked = projectId;
    try {
      const next = await skillsApi.library(asked, fresh);
      if (selection.current !== asked) return;
      setLibrary(next);
      setLibraryError(undefined);
    } catch (cause) {
      if (selection.current === asked) setLibraryError(cause);
    }
  }, [projectId]);
  const reloadCatalog = useCallback(async () => {
    const asked = projectId;
    try {
      const next = await skillsApi.catalog(asked);
      if (selection.current !== asked) return;
      setCatalog(next);
      setCatalogError(undefined);
    } catch (cause) {
      if (selection.current === asked) setCatalogError(cause);
    }
  }, [projectId]);

  useEffect(() => { void reloadLibrary(); }, [reloadLibrary]);
  // The catalog reads repositories over the network, so it waits to be asked for.
  useEffect(() => { if (tab === "catalog") setCatalogWanted(true); }, [tab]);
  useEffect(() => { if (catalogWanted) void reloadCatalog(); }, [catalogWanted, reloadCatalog]);

  const reading = catalog?.sources.some((source) => source.sync === "syncing") ?? false;
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => void reloadCatalog(), POLL_MS);
    return () => clearTimeout(timer);
  }, [reading, catalog, reloadCatalog]);

  /** After a change. Installing touches no harness's own skills, so a checkmark
   *  waits only on Polyth's; `harnessId` names the harness that did change. */
  const reloadAll = useCallback(async (harnessId?: string) => {
    await Promise.all([reloadLibrary(harnessId), catalogWanted ? reloadCatalog() : Promise.resolve()]);
  }, [reloadLibrary, reloadCatalog, catalogWanted]);

  // An open skill takes the page over; Back lands on the same scroll position.
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef<number | null>(null);
  const pane = () => rootRef.current?.closest<HTMLElement>(".settings-pane-body") ?? null;
  const opener = useRef<HTMLElement | null>(null);
  const openDetail = (next: SkillDetailTarget) => {
    listScroll.current = pane()?.scrollTop ?? null;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(next);
  };
  const detailOpen = detail !== null;
  useLayoutEffect(() => {
    const scroller = pane();
    if (scroller && detailOpen) scroller.scrollTop = 0;
    if (detailOpen) return;
    if (scroller && listScroll.current !== null) scroller.scrollTop = listScroll.current;
    listScroll.current = null;
    // Back lands on the row it came from, for a keyboard as for the eye.
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    opener.current = null;
  }, [detailOpen]);

  const installFromRow = (skill: SkillCatalogSkillDto, scope: CapabilityInstallationScope) => {
    setBusy(skill.id);
    setNotice("");
    void skillsApi.install({
      id: skill.id,
      contentHash: skill.contentHash,
      scope,
      ...(scope === "project" && projectId ? { projectId } : {}),
    }).then(() => reloadAll()).catch((cause: unknown) => setNotice(message(cause))).finally(() => setBusy(null));
  };

  const updateEntry = (entry: SkillLibraryEntryDto) => {
    const managed = entry.managed;
    if (!managed) return;
    void (async () => {
      if (managed.modified && !await confirmAlert(tr("settings.skills.detail.updateConfirmEdited", { name: entry.name }), {
        title: tr("settings.skills.detail.updateTitle"),
        confirmLabel: tr("settings.skills.library.update"),
      })) return;
      setBusy(entry.name);
      setNotice("");
      try {
        await skillsApi.update(managed.scope as CapabilityInstallationScope, entry.name, managed.projectId);
        await reloadAll();
      } catch (cause) {
        setNotice(message(cause));
      } finally {
        setBusy(null);
      }
    })();
  };

  const adoptEntry = (entry: SkillLibraryEntryDto, scope: CapabilityInstallationScope) => {
    const native = entry.natives.find((row) => row.importable);
    if (!native) return;
    setBusy(entry.name);
    setNotice("");
    void skillsApi.adopt({
      harnessId: native.harnessId,
      name: native.nativeName,
      scope,
      ...(scope === "project" && projectId ? { projectId } : {}),
    }).then(() => reloadAll()).catch((cause: unknown) => setNotice(message(cause))).finally(() => setBusy(null));
  };

  const newScopes = (): CapabilityInstallationScope[] => [
    ...(projectId && library?.access.project ? ["project" as const] : []),
    ...(library?.access.space ? ["space" as const] : []),
  ];

  const editDetail = (loaded: SkillLibraryDetailDto) => {
    const managed = loaded.entry.managed;
    if (!managed) return;
    setDetail(null);
    setEditor({ skill: { ...managed, instructions: loaded.instructions }, scopes: [managed.scope as CapabilityInstallationScope] });
  };

  const backLabel = tab === "catalog" ? tr("settings.skills.tabCatalog") : tr("settings.skills.tabLibrary");

  return (
    <div
      className="skills-page"
      ref={rootRef}
      // Esc steps back out of a skill rather than closing Settings around it.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !detail || event.defaultPrevented) return;
        // Something open on top keeps its Esc. Settings itself is a dialog too,
        // but it holds this page rather than sitting over it.
        const overlay = (event.target as Element).closest("[role=dialog], [role=listbox], [role=menu]");
        if (overlay && !overlay.contains(rootRef.current)) return;
        event.preventDefault();
        event.stopPropagation();
        setDetail(null);
      }}
    >
      {detail && (
        <SkillDetailView
          target={detail}
          library={library}
          projectId={projectId}
          projectName={projectName}
          backLabel={backLabel}
          onBack={() => setDetail(null)}
          onChanged={reloadAll}
          onEdit={editDetail}
          avatarOf={(sourceId) => catalog?.sources.find((source) => source.id === sourceId)?.avatar}
        />
      )}
      <div hidden={detailOpen}>
        <PageHead blurb={tab === "catalog" ? tr("settings.skills.catalogBlurb") : tr("settings.skills.libraryBlurb")} />
        <SettingsTabs
          idBase="skills"
          label={tr("settings.skills.tabsLabel")}
          value={tab}
          onChange={(next) => { setEditor(null); setTab(next as SkillsTab); }}
          tabs={[
            { id: "library", label: tr("settings.skills.tabLibrary") },
            { id: "catalog", label: tr("settings.skills.tabCatalog") },
          ]}
        >
          <div hidden={tab !== "library"} data-settings-item="skills.catalog">
            {editor
              ? (
                <SkillEditor
                  seed={editor}
                  projectId={projectId}
                  projectName={projectName}
                  onClose={() => setEditor(null)}
                  onSaved={async () => { setEditor(null); await reloadAll(); }}
                />
              )
              : (
                <SkillLibraryView
                  library={library}
                  error={libraryError}
                  projectId={projectId}
                  busy={busy}
                  notice={tab === "library" ? notice : ""}
                  onReload={() => reloadLibrary("all")}
                  onOpen={(entry) => openDetail({ kind: "library", name: entry.name })}
                  onUpdate={updateEntry}
                  onAdopt={adoptEntry}
                  onNew={() => setEditor({ scopes: newScopes() })}
                  onBrowse={() => setTab("catalog")}
                />
              )}
          </div>
          <div hidden={tab !== "catalog"} data-settings-item="skills.browse">
            {catalogWanted && (
              <SkillCatalogView
                active={tab === "catalog"}
                catalog={catalog}
                error={catalogError}
                projectId={projectId}
                installing={busy}
                onReload={reloadCatalog}
                onOpen={(skill) => openDetail({ kind: "catalog", id: skill.id })}
                onInstall={installFromRow}
              />
            )}
            {notice && tab === "catalog" && <div className="form-error" role="alert">{notice}</div>}
          </div>
        </SettingsTabs>
      </div>
    </div>
  );
}
