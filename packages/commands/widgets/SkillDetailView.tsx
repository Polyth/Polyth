// One skill, read before it is used. The same page serves a catalog skill being
// considered and a skill already in the library: what it says, what it brings,
// and which of your harnesses have it.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CapabilityInstallationScope,
  SkillCatalogDetailDto,
  SkillFileDto,
  SkillFilePreviewDto,
  SkillHarnessDto,
  SkillHarnessMode,
  SkillLibraryDetailDto,
  SkillLibraryDto,
  SkillLibraryEntryDto,
  SkillReachDefault,
  SkillReachInput,
} from "@polyth/contracts/capability-installations";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { ErrorState, Seg, SettingsTabs } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  BackIcon,
  Badge,
  Button,
  CheckIcon,
  ExternalLinkIcon,
  Icon,
  Notice,
  Select,
  ShieldIcon,
  Skeleton,
  Spinner,
  Switch,
} from "../../../apps/web/src/components/ui/index.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { MarkdownDoc } from "../../../apps/web/src/markdown.tsx";
import { SkillMark, harnessStyle } from "./SkillParts.tsx";
import { familyMode, skillReach } from "../src/skillReach.ts";
import {
  availabilityOf,
  defaultInstallScope,
  formatBytes,
  harnessGroups,
  reachOf,
  tokenEstimate,
  type HarnessAvailability,
} from "./skillModel.ts";
import { skillsApi } from "./skillsApi.ts";

export type SkillDetailTarget =
  | { kind: "catalog"; id: string }
  | { kind: "library"; name: string };

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const filesLabel = (count: number, bytes: number): string => {
  const size = formatBytes(bytes);
  return count === 1 ? tr("settings.skills.detail.filesValue.one", { size }) : tr("settings.skills.detail.filesValue", { count, size });
};

function stateLabel(row: HarnessAvailability, blocked: boolean): string {
  switch (row.state) {
    case "polyth": return row.harness.delivery === "prompt" ? tr("settings.skills.state.polythPrompt") : tr("settings.skills.state.polythNative");
    case "off": return tr("settings.skills.state.off");
    case "unsupported": return blocked && row.harness.delivery !== "none" ? tr("settings.skills.state.unsupportedBlocked") : tr("settings.skills.state.unsupportedNone");
    case "own":
      if (row.native?.source === "project") return tr("settings.skills.state.ownProject");
      if (row.native?.source === "plugin") return tr("settings.skills.state.ownPlugin");
      if (row.native?.source === "bundled") return tr("settings.skills.state.ownBundled");
      return tr("settings.skills.state.ownUser");
    case "muted": return row.harness.inherits ? tr("settings.skills.state.muted") : tr("settings.skills.state.inheritOff");
    case "absent": return "";
  }
}

/** What one change to a managed skill's reach says. */
export type ReachChange = Pick<SkillReachInput, "default" | "family" | "harness">;

const MODE_LABEL: Record<SkillHarnessMode, () => string> = {
  off: () => tr("settings.skills.reach.modeOff"),
  on: () => tr("settings.skills.reach.modeOn"),
  always: () => tr("settings.skills.reach.modeAlways"),
};
const REACH_HINT: Record<SkillReachDefault, () => string> = {
  all: () => tr("settings.skills.reach.hintAll"),
  some: () => tr("settings.skills.reach.hintSome"),
  none: () => tr("settings.skills.reach.hintNone"),
};

const formatTokens = (count: number): string =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(count);

/** Where a managed skill works: one default for every harness, then families
 *  and accounts that differ. Every switch says only what Polyth can deliver. */
function ReachPanel({ entry, harnesses, instructions, canWrite, busy, onReach }: {
  entry: SkillLibraryEntryDto & { managed: NonNullable<SkillLibraryEntryDto["managed"]> };
  harnesses: readonly SkillHarnessDto[];
  /** The skill's text, to say what "always" costs. */
  instructions: string | undefined;
  canWrite: boolean;
  busy: string;
  onReach: (change: ReachChange) => void;
}) {
  const reach = skillReach(entry.managed);
  const rows = availabilityOf(entry, harnesses);
  const groups = harnessGroups(rows);
  const blocked = Boolean(entry.managed.disallowedTools?.length);
  const tokens = instructions?.trim() ? formatTokens(tokenEstimate(instructions)) : undefined;
  const nowhere = reach.default === "none";
  const locked = !canWrite || busy === "reach";
  const deliverable = rows.filter((row) => row.mode !== undefined);
  const working = deliverable.filter((row) => row.mode !== "off").length;
  const options = (["off", "on", "always"] as const)
    // Its text in every chat would skip the tool block the skill relies on.
    .filter((mode) => mode !== "always" || !blocked)
    .map((mode) => ({
      value: mode,
      label: MODE_LABEL[mode](),
      ...(mode === "always" && tokens ? { detail: tr("settings.skills.reach.alwaysDetail", { tokens }) } : {}),
    }));
  const modeSelect = (label: string, value: SkillHarnessMode, onChange: (mode: SkillHarnessMode) => void) => (
    <Select
      className="skills-mode"
      label={label}
      value={value}
      options={options}
      searchable={false}
      align="end"
      disabled={locked || nowhere}
      onChange={(next) => onChange(next as SkillHarnessMode)}
    />
  );

  const harnessRow = (row: HarnessAvailability, member: boolean) => {
    const name = member ? row.harness.accountLabel ?? tr("settings.skills.reach.mainAccount") : row.harness.name;
    if (row.mode === undefined) {
      return (
        <li key={row.harness.id} className={`skills-harness is-quiet${member ? " is-member" : ""}`}>
          <span className="skills-harness-name">
            {row.harness.color && <span className="skills-harness-dot" style={harnessStyle(row.harness)} aria-hidden="true" />}
            {name}
          </span>
          <span className="skills-harness-state">{stateLabel(row, blocked)}</span>
          <span className="skills-harness-control">
            {row.native?.locked && row.state === "own" ? <span className="skills-harness-locked">{tr("settings.skills.state.locked")}</span> : null}
          </span>
        </li>
      );
    }
    // Off for Polyth, but the harness still loads a copy of its own: say so.
    const ownCopy = row.native?.enabled ? stateLabel({ ...row, state: "own" }, blocked) : "";
    const delivery = row.mode === "always"
      ? (tokens ? tr("settings.skills.reach.alwaysDetail", { tokens }) : tr("settings.skills.reach.modeAlways"))
      : row.mode === "on" && !nowhere ? stateLabel(row, blocked) : ownCopy;
    const differs = member && row.source === "harness";
    return (
      <li key={row.harness.id} className={`skills-harness${row.mode === "off" || nowhere ? " is-quiet" : ""}${member ? " is-member" : ""}`}>
        <span className="skills-harness-name">
          {row.harness.color && <span className="skills-harness-dot" style={harnessStyle(row.harness)} aria-hidden="true" />}
          {name}
        </span>
        <span className="skills-harness-state">
          {delivery}
          {differs && (
            <span className="skills-reach-differs">
              {delivery ? " · " : ""}{tr("settings.skills.reach.differs")}
              {!locked && !nowhere && (
                <button type="button" className="skills-reset" onClick={() => onReach({ harness: { id: row.harness.id, mode: null } })}>
                  {tr("settings.skills.reach.reset")}
                </button>
              )}
            </span>
          )}
        </span>
        <span className="skills-harness-control">
          {modeSelect(
            tr("settings.skills.detail.harnessSwitch", { skill: entry.title, harness: row.harness.name }),
            row.mode,
            (mode) => onReach({ harness: { id: row.harness.id, mode } }),
          )}
        </span>
      </li>
    );
  };

  return (
    <>
      <div className="skills-reach">
        <Seg<SkillReachDefault>
          label={tr("settings.skills.reach.label")}
          value={reach.default}
          options={[
            ["all", tr("settings.skills.reach.all")],
            ["some", tr("settings.skills.reach.some")],
            ["none", tr("settings.skills.reach.none")],
          ]}
          disabled={locked}
          onChange={(next) => { if (next !== reach.default) onReach({ default: next }); }}
        />
        <p className="skills-tab-hint">{REACH_HINT[reach.default]()}</p>
      </div>
      <ul className={`skills-harnesses is-reach${nowhere ? " is-nowhere" : ""}`}>
        {groups.map((group) => {
          const controllable = group.rows.filter((row) => row.mode !== undefined);
          if (group.rows.length < 2) return harnessRow(group.rows[0]!, false);
          return (
            <Fragment key={group.family}>
              <li className={`skills-harness is-family${nowhere ? " is-quiet" : ""}`}>
                <span className="skills-harness-name">{group.name}</span>
                <span className="skills-harness-state">{tr("settings.skills.reach.accounts", { count: group.rows.length })}</span>
                <span className="skills-harness-control">
                  {controllable.length > 0 && modeSelect(
                    tr("settings.skills.detail.harnessSwitch", { skill: entry.title, harness: group.name }),
                    familyMode(reach, group.family).mode,
                    (mode) => onReach({ family: { id: group.family, mode } }),
                  )}
                </span>
              </li>
              {group.rows.map((row) => harnessRow(row, true))}
            </Fragment>
          );
        })}
      </ul>
      {deliverable.length > 0 && (
        <p className="skills-reach-summary">{tr("settings.skills.reach.summary", { count: nowhere ? 0 : working, total: deliverable.length })}</p>
      )}
    </>
  );
}

/** A skill only harnesses have: each harness's own copy, and the switch Polyth
 *  has over it where the harness takes one. */
function AvailabilityList({ entry, harnesses, canControlNative, busy, onNative }: {
  entry: SkillLibraryEntryDto;
  harnesses: readonly SkillHarnessDto[];
  canControlNative: boolean;
  busy: string;
  onNative: (harnessId: string, nativeName: string, enabled: boolean) => void;
}) {
  const rows = availabilityOf(entry, harnesses);
  const blocked = Boolean(entry.managed?.disallowedTools?.length);
  const absent = rows.filter((row) => row.state === "absent");
  return (
    <ul className="skills-harnesses">
      {rows.filter((row) => row.state !== "absent").map((row) => {
        const quiet = row.state === "off" || row.state === "muted" || row.state === "unsupported";
        let control: ReactNode = null;
        if (!entry.managed && row.native && !row.native.locked && row.harness.inherits) {
          control = (
            <Switch
              label={tr("settings.skills.detail.harnessSwitch", { skill: entry.title, harness: row.harness.name })}
              checked={row.native.enabled}
              disabled={!canControlNative || busy === row.harness.id}
              onChange={(enabled) => onNative(row.harness.id, row.native!.nativeName, enabled)}
            />
          );
        } else if (row.native?.locked && row.state === "own") {
          control = <span className="skills-harness-locked">{tr("settings.skills.state.locked")}</span>;
        }
        return (
          <li key={row.harness.id} className={`skills-harness${quiet ? " is-quiet" : ""}`}>
            <span className="skills-harness-name">
              {row.harness.color && <span className="skills-harness-dot" style={harnessStyle(row.harness)} aria-hidden="true" />}
              {row.harness.name}
            </span>
            <span className="skills-harness-state">{stateLabel(row, blocked)}</span>
            <span className="skills-harness-control">{control}</span>
          </li>
        );
      })}
      {absent.length > 0 && (
        <li className="skills-harness is-absent">
          {tr("settings.skills.state.absentSummary", { names: absent.map((row) => row.harness.name).join(", ") })}
        </li>
      )}
    </ul>
  );
}

function FilesPanel({ files, load }: {
  files: readonly SkillFileDto[];
  load: (path: string) => Promise<SkillFilePreviewDto>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillFilePreviewDto | null>(null);
  const [failure, setFailure] = useState("");
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 200);
  const toggle = async (path: string) => {
    if (open === path) {
      setOpen(null);
      return;
    }
    setOpen(path);
    setPreview(null);
    setFailure("");
    try {
      const next = await load(path);
      setPreview((current) => current ?? next);
    } catch (cause) {
      setFailure(message(cause));
    }
  };
  return (
    <>
      <ul className="skills-files">
        {shown.map((file) => (
          <li key={file.path} className="skills-file">
            <button type="button" className="skills-file-head" aria-expanded={open === file.path} onClick={() => void toggle(file.path)}>
              <span className="skills-file-path">{file.path}</span>
              {file.kind === "script" && <Badge tone="warning">{tr("settings.skills.detail.canRunBadge")}</Badge>}
              <span className="skills-file-size">{formatBytes(file.bytes)}</span>
            </button>
            {open === file.path && (
              <div className="skills-file-body">
                {failure
                  ? <p className="form-error" role="alert">{failure}</p>
                  : !preview
                    ? <Spinner label={tr("settings.skills.detail.loading")} />
                    : preview.text === undefined
                      ? <p className="skills-file-note">{tr("settings.skills.detail.binaryFile")}</p>
                      : (
                        <>
                          <pre className="skills-file-text">{preview.text}</pre>
                          {preview.truncated && <p className="skills-file-note">{tr("settings.skills.detail.truncated")}</p>}
                        </>
                      )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {files.length > shown.length && (
        <div className="skills-more">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {tr("settings.skills.catalog.showMore", { count: files.length - shown.length })}
          </Button>
        </div>
      )}
    </>
  );
}

function DetailSkeleton() {
  return (
    <article className="skills-detail" aria-busy="true">
      <div className="skills-detail-head">
        <Skeleton shape="block" width={48} height={48} />
        <div className="skills-detail-titles">
          <Skeleton width="42%" />
          <Skeleton width="26%" />
        </div>
      </div>
      <Skeleton width="92%" />
      <Skeleton width="74%" />
    </article>
  );
}

function SkillDetailBody({ target, library, projectId, projectName, onBack, onChanged, onEdit, avatarOf }: {
  target: SkillDetailTarget;
  library: SkillLibraryDto | undefined;
  projectId: string | null;
  projectName: string | undefined;
  onBack: () => void;
  /** Something about skills changed: the lists behind this page reload. A
   *  harness id says that harness's own skills are what changed. */
  onChanged: (harnessId?: string) => Promise<void>;
  onEdit: (detail: SkillLibraryDetailDto) => void;
  backLabel: string;
  avatarOf: (sourceId: string) => string | undefined;
}) {
  const [catalogDetail, setCatalogDetail] = useState<SkillCatalogDetailDto>();
  const [libraryDetail, setLibraryDetail] = useState<SkillLibraryDetailDto>();
  const [loadError, setLoadError] = useState<unknown>();
  // A catalog skill is read first; a library skill is first about where it works.
  const firstTab = target.kind === "catalog" ? "instructions" : "harnesses";
  const [tab, setTab] = useState(firstTab);
  const [scope, setScope] = useState<CapabilityInstallationScope | undefined>();
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [justDone, setJustDone] = useState(false);
  const [changedNote, setChangedNote] = useState(false);

  const key = target.kind === "catalog" ? `c:${target.id}` : `l:${target.name}`;
  const load = async () => {
    try {
      if (target.kind === "catalog") setCatalogDetail(await skillsApi.catalogDetail(target.id, projectId));
      else setLibraryDetail(await skillsApi.libraryDetail(target.name, projectId));
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause);
    }
  };
  useEffect(() => {
    setCatalogDetail(undefined);
    setLibraryDetail(undefined);
    setTab(firstTab);
    setFailure("");
    setJustDone(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);

  const access = library?.access;
  const chosenScope = scope ?? (access ? defaultInstallScope(access, projectId) : undefined);
  const harnesses = library?.harnesses ?? [];

  const whereLabel = (where: CapabilityInstallationScope): string => where === "project"
    ? (projectName ? tr("settings.skillspage.whereProjectNamed", { name: projectName }) : tr("settings.skillspage.whereThisProject"))
    : tr("settings.skillspage.whereThisSpace");

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setFailure("");
    try {
      await work();
      await onChanged();
      await load();
    } catch (cause) {
      setFailure(message(cause));
      // The catalog moved on while this page was open: show what is there now.
      if ((cause as { code?: string }).code === "conflict" || (cause as { status?: number }).status === 409) {
        setChangedNote(true);
        await load();
      }
    } finally {
      setBusy("");
    }
  };

  if (loadError) {
    return (
      <article className="skills-detail">
        <ErrorState compact error={loadError} onRetry={() => void load()} />
      </article>
    );
  }
  const loaded = target.kind === "catalog" ? catalogDetail : libraryDetail;
  if (!loaded) return <DetailSkeleton />;

  const scopeSelect = (label: string) => {
    if (!access) return null;
    const options = [
      ...(projectId && access.project ? [{
        value: "project",
        label: tr("settings.commandspage.thisProject"),
        ...(projectName ? { detail: projectName } : {}),
      }] : []),
      ...(access.space ? [{ value: "space", label: tr("settings.skillspage.scopeSpace") }] : []),
    ];
    if (options.length < 2) return null;
    return (
      <Select
        className="skills-scope"
        label={label}
        value={chosenScope ?? "project"}
        options={options}
        searchable={false}
        align="end"
        onChange={(value) => setScope(value as CapabilityInstallationScope)}
      />
    );
  };

  const entry: SkillLibraryEntryDto | undefined = target.kind === "library"
    ? library?.skills.find((row) => row.name === target.name || row.natives.some((native) => native.nativeName === target.name)) ?? libraryDetail?.entry
    : catalogDetail?.skill.installed?.length
      ? library?.skills.find((row) => row.name === catalogDetail.skill.name && row.managed?.origin?.kind === "catalog" && row.catalogId === catalogDetail.skill.id)
      : undefined;
  const managed = entry?.managed;

  const canWriteManaged = Boolean(access && managed && (managed.scope === "space" ? access.space : access.project));
  const setReach = (change: ReachChange) => {
    if (!managed || !entry) return;
    setBusy("reach");
    setFailure("");
    void skillsApi.reach({
      name: entry.name,
      scope: managed.scope as CapabilityInstallationScope,
      ...(managed.projectId ? { projectId: managed.projectId } : {}),
      ...change,
    }).then(() => onChanged()).catch((cause: unknown) => setFailure(message(cause))).finally(() => setBusy(""));
  };
  const harnessesTab = (shownEntry: SkillLibraryEntryDto, instructions: string | undefined, ownHint: string) => {
    if (!library) return null;
    if (shownEntry.managed) {
      return (
        <ReachPanel
          entry={shownEntry as SkillLibraryEntryDto & { managed: NonNullable<SkillLibraryEntryDto["managed"]> }}
          harnesses={library.harnesses}
          instructions={instructions}
          canWrite={canWriteManaged}
          busy={busy}
          onReach={setReach}
        />
      );
    }
    return (
      <>
        <p className="skills-tab-hint">{ownHint}</p>
        <AvailabilityList
          entry={shownEntry}
          harnesses={library.harnesses}
          canControlNative={access?.nativePolicy ?? false}
          busy={busy}
          onNative={setNativeHarness}
        />
      </>
    );
  };
  const setNativeHarness = (harnessId: string, nativeName: string, enabled: boolean) => {
    setBusy(harnessId);
    setFailure("");
    void skillsApi.nativeSkill(harnessId, nativeName, enabled, projectId)
      .then(() => onChanged(harnessId)).catch((cause: unknown) => setFailure(message(cause))).finally(() => setBusy(""));
  };

  const update = () => {
    if (!managed || !entry) return;
    void (async () => {
      if (managed.modified && !await confirmAlert(tr("settings.skills.detail.updateConfirmEdited", { name: entry.name }), {
        title: tr("settings.skills.detail.updateTitle"),
        confirmLabel: tr("settings.skills.library.update"),
      })) return;
      await run("update", () => skillsApi.update(
        managed.scope as CapabilityInstallationScope,
        entry.name,
        managed.projectId,
      ));
    })();
  };
  const remove = () => {
    if (!managed || !entry) return;
    const where = managed.scope as CapabilityInstallationScope;
    void (async () => {
      if (!await confirmAlert(tr("settings.skillspage.removeConfirm", { name: entry.name, where: whereLabel(where) }), {
        title: tr("settings.skillspage.removeSkillTitle"),
        confirmLabel: tr("settings.skillspage.remove"),
        destructive: true,
      })) return;
      await run("remove", () => skillsApi.remove(where, entry.name, managed.projectId, managed.revision));
      if (target.kind === "library" && !entry.natives.length) onBack();
    })();
  };

  /** The page's one primary action, and what it says once done. */
  const installedPanel = managed && (
    <div className="skills-actions-group">
      {entry?.updateAvailable && <Button variant="primary" size="sm" busy={busy === "update"} disabled={!canWriteManaged} onClick={update}>{tr("settings.skills.library.update")}</Button>}
      {target.kind === "library" && libraryDetail && canWriteManaged && (
        <Button size="sm" disabled={Boolean(busy)} onClick={() => onEdit(libraryDetail)}>{tr("settings.skillspage.edit")}</Button>
      )}
      {canWriteManaged && <Button size="sm" variant="ghost" className="commands-delete" busy={busy === "remove"} disabled={Boolean(busy)} onClick={remove}>{tr("settings.skillspage.remove")}</Button>}
    </div>
  );

  if (target.kind === "catalog" && catalogDetail) {
    const { skill, source } = catalogDetail;
    const taken = chosenScope ? skill.nameTakenIn?.includes(chosenScope) : false;
    const install = () => {
      if (!chosenScope) return;
      void (async () => {
        if (taken && !await confirmAlert(tr("settings.skills.detail.replaceConfirm", { name: skill.name, where: whereLabel(chosenScope) }), {
          title: tr("settings.skills.detail.replaceTitle"),
          confirmLabel: tr("settings.skills.detail.replaceAction"),
          destructive: true,
        })) return;
        await run("install", async () => {
          await skillsApi.install({
            id: skill.id,
            contentHash: skill.contentHash,
            scope: chosenScope,
            ...(chosenScope === "project" && projectId ? { projectId } : {}),
            ...(taken ? { replace: true } : {}),
          });
          setJustDone(true);
        });
      })();
    };
    const installed = skill.installed?.[0];
    const blockedTools = Boolean(catalogDetail.disallowedTools?.length);
    const reach = reachOf(harnesses, blockedTools);
    return (
      <article className="skills-detail" key={key}>
        <header className="skills-detail-head">
          <span className="skills-detail-mark"><SkillMark avatar={source.avatar} /></span>
          <div className="skills-detail-titles">
            <h2 className="skills-detail-title">{skill.title}</h2>
            <p className="skills-detail-by">{[source.label, skill.collection].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="skills-detail-actions">
            {installed
              ? (
                <>
                  {installed.state === "outdated"
                    ? <Button variant="primary" size="sm" busy={busy === "update"} disabled={!canWriteManaged} onClick={update}>{tr("settings.skills.library.update")}</Button>
                    : <span className="skills-installed"><Icon icon={CheckIcon} size="sm" />{tr("settings.skills.catalog.installed")}</span>}
                  {canWriteManaged && <Button size="sm" variant="ghost" className="commands-delete" busy={busy === "remove"} disabled={Boolean(busy)} onClick={remove}>{tr("settings.skillspage.remove")}</Button>}
                </>
              )
              : skill.tooLarge || !chosenScope
                ? null
                : (
                  <>
                    {scopeSelect(tr("settings.skills.detail.installFor"))}
                    <Button variant="primary" size="sm" busy={busy === "install"} onClick={install}>{tr("settings.skills.detail.install")}</Button>
                  </>
                )}
          </div>
        </header>
        <p className="skills-detail-desc">{skill.description}</p>

        {changedNote && <Notice tone="info">{tr("settings.skills.detail.changed")}</Notice>}
        {failure && !changedNote && <Notice tone="error" role="alert">{failure}</Notice>}
        {justDone && installed && (
          <Notice tone="success" role="status">
            {blockedTools
              ? tr("settings.skills.detail.readyHintNoSlash")
              : tr("settings.skills.detail.readyHint", { name: skill.name })}
          </Notice>
        )}
        {skill.hiddenText && <Notice tone="warning" heading={tr("settings.skills.detail.hiddenTitle")}>{tr("settings.skills.detail.hiddenBody")}</Notice>}
        {skill.tooLarge && <Notice>{tr("settings.skills.detail.tooLargeBody")}</Notice>}
        {!chosenScope && !installed && !skill.tooLarge && access && <Notice>{tr("settings.skills.detail.noPermission")}</Notice>}

        <dl className="skills-facts">
          <div className="skills-fact is-wide">
            <dt>{tr("settings.skills.detail.works")}</dt>
            <dd>
              {harnesses.length === 0
                ? "—"
                : reach.length === harnesses.length
                  ? tr("settings.skills.detail.worksAll", { count: harnesses.length })
                  : tr("settings.skills.detail.worksSome", { count: reach.length, total: harnesses.length })}
              {reach.length > 0 && <small>{reach.map((harness) => harness.name).join(", ")}</small>}
            </dd>
          </div>
          <div className="skills-fact">
            <dt>{tr("settings.skills.detail.files")}</dt>
            <dd>{filesLabel(skill.files, skill.bytes)}</dd>
          </div>
          <div className="skills-fact">
            <dt>{tr("settings.skills.detail.canRun")}</dt>
            <dd>
              {skill.scripts === 0
                ? tr("settings.skills.detail.noScripts")
                : skill.scripts === 1 ? tr("settings.skills.detail.canRunValue.one") : tr("settings.skills.detail.canRunValue", { count: skill.scripts })}
            </dd>
          </div>
          <div className="skills-fact">
            <dt>{tr("settings.skills.detail.license")}</dt>
            <dd>{skill.license ?? source.license ?? tr("settings.skills.detail.licenseNone")}</dd>
          </div>
          {catalogDetail.allowedTools?.length ? (
            <div className="skills-fact">
              <dt>{tr("settings.skills.detail.tools")}</dt>
              <dd className="mono">{catalogDetail.allowedTools.join(", ")}</dd>
            </div>
          ) : null}
          {catalogDetail.disallowedTools?.length ? (
            <div className="skills-fact">
              <dt>{tr("settings.skills.detail.blockedTools")}</dt>
              <dd className="mono">{catalogDetail.disallowedTools.join(", ")}</dd>
            </div>
          ) : null}
          <div className="skills-fact">
            <dt>{tr("settings.skills.detail.source")}</dt>
            <dd>
              <a href={catalogDetail.url ?? source.url} target="_blank" rel="noreferrer" className="skills-link">
                {source.repository}{source.commit ? <span className="mono"> @ {source.commit.slice(0, 7)}</span> : null}
                <Icon icon={ExternalLinkIcon} size="sm" />
              </a>
            </dd>
          </div>
        </dl>

        <p className="skills-trust"><Icon icon={ShieldIcon} size="sm" />{tr("settings.skills.detail.trust")}</p>

        <SettingsTabs
          idBase="skill-detail"
          label={tr("settings.skills.detail.tabsLabel")}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "instructions", label: tr("settings.skills.detail.tabInstructions") },
            { id: "files", label: tr("settings.skills.detail.tabFiles", { count: catalogDetail.files.length }) },
            ...(entry && library ? [{ id: "harnesses", label: tr("settings.skills.detail.tabHarnesses") }] : []),
          ]}
        >
          {tab === "instructions" && <div className="skills-reading"><MarkdownDoc text={catalogDetail.instructions} keyBase={`skill-${skill.id}`} /></div>}
          {tab === "files" && <FilesPanel files={catalogDetail.files} load={(path) => skillsApi.catalogFile(skill.id, path)} />}
          {tab === "harnesses" && entry && harnessesTab(entry, catalogDetail.instructions, tr("settings.skills.detail.availableHintOwn"))}
        </SettingsTabs>
      </article>
    );
  }

  const detail = libraryDetail!;
  const shown = entry ?? detail.entry;
  const origin = shown.managed?.origin;
  const adoptable = !shown.managed && shown.natives.find((native) => native.importable);
  const by = [
    origin?.kind === "catalog" ? origin.sourceLabel : origin?.kind === "harness" ? tr("settings.skills.library.fromHarness", { name: origin.harnessName }) : undefined,
    shown.managed ? (shown.managed.scope === "space" ? tr("settings.skills.library.scopeSpace") : tr("settings.skills.library.scopeProject")) : undefined,
    shown.managed ? undefined : shown.natives.map((native) => harnesses.find((row) => row.id === native.harnessId)?.name ?? native.harnessId).join(", "),
  ].filter(Boolean).join(" · ");
  const totalBytes = detail.files.reduce((sum, file) => sum + file.bytes, 0);
  const scripts = detail.files.filter((file) => file.kind === "script").length;
  const adopt = () => {
    if (!adoptable || !chosenScope) return;
    void run("adopt", async () => {
      await skillsApi.adopt({
        harnessId: adoptable.harnessId,
        name: adoptable.nativeName,
        scope: chosenScope,
        ...(chosenScope === "project" && projectId ? { projectId } : {}),
      });
      setJustDone(true);
    });
  };
  return (
    <article className="skills-detail" key={key}>
      <header className="skills-detail-head">
        <span className="skills-detail-mark"><SkillMark avatar={shown.avatar ?? (origin?.kind === "catalog" ? avatarOf(origin.sourceId) : undefined)} /></span>
        <div className="skills-detail-titles">
          <h2 className="skills-detail-title">{shown.title}</h2>
          {by && <p className="skills-detail-by">{by}</p>}
        </div>
        <div className="skills-detail-actions">
          {installedPanel}
          {adoptable && chosenScope && (
            <>
              {scopeSelect(tr("settings.skills.detail.installFor"))}
              <Button variant="primary" size="sm" busy={busy === "adopt"} onClick={adopt}>{tr("settings.skills.detail.useEverywhere")}</Button>
            </>
          )}
        </div>
      </header>
      {shown.description && <p className="skills-detail-desc">{shown.description}</p>}

      {failure && <Notice tone="error" role="alert">{failure}</Notice>}
      {justDone && shown.managed && <Notice tone="success" role="status">{tr("settings.skills.detail.adoptedHint")}</Notice>}
      {shown.managed?.modified && shown.updateAvailable && <Notice>{tr("settings.skills.detail.editedHint")}</Notice>}

      {(detail.files.length > 0 || detail.url) && (
        <dl className="skills-facts">
          {detail.files.length > 0 && (
            <div className="skills-fact">
              <dt>{tr("settings.skills.detail.files")}</dt>
              <dd>{filesLabel(detail.files.length, totalBytes)}</dd>
            </div>
          )}
          {detail.files.length > 0 && (
            <div className="skills-fact">
              <dt>{tr("settings.skills.detail.canRun")}</dt>
              <dd>{scripts === 0 ? tr("settings.skills.detail.noScripts") : scripts === 1 ? tr("settings.skills.detail.canRunValue.one") : tr("settings.skills.detail.canRunValue", { count: scripts })}</dd>
            </div>
          )}
          {detail.url && origin?.kind === "catalog" && (
            <div className="skills-fact">
              <dt>{tr("settings.skills.detail.source")}</dt>
              <dd>
                <a href={detail.url} target="_blank" rel="noreferrer" className="skills-link">
                  {origin.repository}{origin.commit ? <span className="mono"> @ {origin.commit.slice(0, 7)}</span> : null}
                  <Icon icon={ExternalLinkIcon} size="sm" />
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}

      <SettingsTabs
        idBase="skill-detail"
        label={tr("settings.skills.detail.tabsLabel")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "harnesses", label: tr("settings.skills.detail.tabHarnesses") },
          { id: "instructions", label: tr("settings.skills.detail.tabInstructions") },
          ...(detail.files.length ? [{ id: "files", label: tr("settings.skills.detail.tabFiles", { count: detail.files.length }) }] : []),
        ]}
      >
        {tab === "harnesses" && harnessesTab(shown, detail.instructions, tr("settings.skills.detail.availableHintOwn"))}
        {tab === "instructions" && (detail.instructions
          ? <div className="skills-reading"><MarkdownDoc text={detail.instructions} keyBase={`skill-${shown.name}`} /></div>
          : <p className="skills-file-note">{tr("settings.skills.detail.noInstructions")}</p>)}
        {tab === "files" && <FilesPanel files={detail.files} load={(path) => skillsApi.libraryFile(shown.name, path, projectId)} />}
      </SettingsTabs>
    </article>
  );
}

/** Focus moves into the page that just took over, so a keyboard is not left on a
 *  row that is now hidden. Back stays outside what loads, so focus survives the
 *  swap from placeholder to page. */
export function SkillDetailView(props: Parameters<typeof SkillDetailBody>[0]) {
  const back = useRef<HTMLButtonElement>(null);
  const key = props.target.kind === "catalog" ? props.target.id : props.target.name;
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, [key]);
  return (
    <div className="skills-detail-page">
      <button type="button" ref={back} className="skills-back" onClick={props.onBack}>
        <Icon icon={BackIcon} size="sm" />
        {props.backLabel}
      </button>
      <SkillDetailBody {...props} />
    </div>
  );
}
