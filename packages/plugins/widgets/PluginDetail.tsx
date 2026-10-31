// One added package, in place of the Packages page (the host yields the page
// while this is open). A hero with the identity and the one primary control,
// then tabs: what it is, what it may access, how it updates, what it adds,
// and what it logged.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "@polyth/session/web-api";
import type { InstalledPluginDto } from "@polyth/contracts";
import {
  EmptyState,
  ErrorState,
  ItemList,
  ItemRow,
  ReadonlyRow,
  Row,
  Section,
  SettingsTabs,
} from "../../../apps/web/src/components/settings/parts.tsx";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Menu,
  Select,
  Switch,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  AppsIcon,
  BackIcon,
  CommandIcon,
  LayersIcon,
  MoreVerticalIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldIcon,
  UploadIcon,
} from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { PluginGallery, PluginMark } from "./PluginGallery.tsx";
import { AccessList, ConnectionReview, capabilityRequired } from "./PluginPermissions.tsx";
import {
  PACKAGE_CLASSIFIERS,
  availableUpdate,
  contributionViews,
  classifierGroups,
  classifierLabel,
  describeSourceLabel,
  groupLabel,
  isSandboxed,
  pluginStatus,
  sourceCanRefetch,
} from "./pluginTaxonomy.ts";
import { needsReviewToEnable, type PluginLibrary } from "./usePluginLibrary.ts";

export type PluginDetailTab = "overview" | "permissions" | "updates" | "contributions" | "logs";

function formatTime(at: number, withDate: boolean): string {
  try {
    return new Date(at).toLocaleString(undefined, withDate
      ? { dateStyle: "medium", timeStyle: "short" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return new Date(at).toISOString();
  }
}

function PluginLogs({ id, name }: { id: string; name: string }) {
  const [lines, setLines] = useState<Array<{ at: number; line: string }> | null>(null);
  const load = () => { void api.pluginsLogs(id).then(setLines).catch(() => setLines([])); };
  useEffect(load, [id]);
  return (
    <div className="plugin-logs">
      <div className="plugin-panel-tools">
        <Button size="sm" variant="ghost" iconStart={RefreshIcon} onClick={load}>{tr("packages.plugins.refresh")}</Button>
      </div>
      {lines !== null && lines.length === 0
        ? <EmptyState compact icon="terminal" title={tr("settings.pages.noLogOutput")} />
        : (
          <div className="plugin-log" role="log" aria-label={tr("settings.pages.logsForValue", { id: name })}>
            {(lines ?? []).map((entry, index) => (
              <div key={index} className="plugin-log-line">
                <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at, false)}</time>
                <span>{entry.line}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const GROUP_ICON: Readonly<Record<string, typeof AppsIcon>> = {
  widget: AppsIcon,
  command: CommandIcon,
  settings: SettingsIcon,
};

/** What the package adds to Polyth, one titled group per kind in the shared
 *  classifier order, then its connections. */
function Contributions({ plugin }: { plugin: InstalledPluginDto }) {
  const views = contributionViews(plugin);
  const groups = [...new Set(views.map((view) => view.group))].sort((left, right) => {
    const rank = (group: string) => {
      const index = PACKAGE_CLASSIFIERS.findIndex((item) => item.id === group);
      return index < 0 ? PACKAGE_CLASSIFIERS.length : index;
    };
    return rank(left) - rank(right);
  });
  const connections = plugin.connections ?? [];
  return (
    <div className="plugin-contributions">
      <p className="plugin-panel-lede">{tr("packages.plugins.contributionsHint")}</p>
      {groups.map((group) => (
        <Section key={group} title={group === "other" ? tr("settings.packagespage.categoryOther") : classifierLabel(group)}>
          <ItemList>
            {views.filter((view) => view.group === group).map((view) => (
              <ItemRow
                key={view.key}
                icon={<Icon icon={GROUP_ICON[group] ?? LayersIcon} size="sm" />}
                title={view.title}
                {...(view.description ? { description: view.description } : {})}
              />
            ))}
          </ItemList>
        </Section>
      ))}
      {connections.length > 0 && (
        <Section title={tr("packages.plugins.connections")}>
          <ItemList>
            {connections.map((connection) => (
              <ItemRow
                key={connection.id}
                icon={<Icon icon={ShieldIcon} size="sm" />}
                title={connection.label}
                meta={<Badge tone={connection.status === "connected" ? "success" : connection.status === "error" ? "danger" : "neutral"} dot>{tr(`packages.plugins.connectionStatus.${connection.status}` as Parameters<typeof tr>[0])}</Badge>}
                {...(connection.account || connection.error ? { description: connection.error ?? connection.account } : {})}
              />
            ))}
          </ItemList>
        </Section>
      )}
    </div>
  );
}

export function PluginDetail({
  plugin,
  library,
  tab,
  onTab,
  onBack,
  onUploadNew,
}: {
  plugin: InstalledPluginDto;
  library: PluginLibrary;
  tab: PluginDetailTab;
  onTab: (tab: PluginDetailTab) => void;
  onBack: () => void;
  /** Opens the installer for a new archive of an uploaded package. */
  onUploadNew: () => void;
}) {
  const headingId = useId();
  const backRef = useRef<HTMLButtonElement>(null);
  const busy = library.busy.has(plugin.id);
  const status = pluginStatus(plugin);
  const sandboxed = isSandboxed(plugin);
  const review = plugin.permissions.review;
  const reviewPending = Boolean(review && (review.capabilities.length > 0 || review.connections.length > 0));
  const refetchable = plugin.updatable ?? sourceCanRefetch(plugin.source);
  const update = availableUpdate(plugin);
  const hasOptional = Boolean(review?.capabilities.some((item) => !capabilityRequired(item)));
  // While access waits for review, the list below shows only what is
  // already approved instead of repeating the review card.
  const underReview = new Set(reviewPending ? review!.capabilities.map((item) => item.name) : []);
  const approved = plugin.permissions.requested.filter((item) => !underReview.has(item.name));
  const showContributions = plugin.contributions.length > 0 || (plugin.widgets?.length ?? 0) > 0 || (plugin.connections?.length ?? 0) > 0;
  const current: PluginDetailTab = tab === "contributions" && !showContributions ? "overview" : tab;

  // Opening a detail moves focus to its Back control, like any page change.
  useEffect(() => { backRef.current?.focus({ preventScroll: true }); }, [plugin.id]);

  const tabs = [
    { id: "overview", label: tr("packages.plugins.tabOverview") },
    {
      id: "permissions",
      label: reviewPending
        ? <span className="plugin-tab-label">{tr("packages.plugins.tabPermissions")}<span className="plugin-tab-dot" aria-label={tr("packages.plugins.needsReview")} /></span>
        : tr("packages.plugins.tabPermissions"),
    },
    { id: "updates", label: tr("packages.plugins.updates") },
    ...(showContributions ? [{ id: "contributions", label: tr("packages.plugins.tabContributions") }] : []),
    { id: "logs", label: tr("settings.pages.logs") },
  ];

  const menu: MenuEntry[] = [
    ...(plugin.enabled ? [{ id: "reload", label: tr("packages.plugins.reload"), icon: RefreshIcon, onSelect: () => void library.reload(plugin) }] : []),
    ...(refetchable ? [{
      id: "check",
      label: tr("packages.plugins.checkForUpdates"),
      disabled: library.checking !== null,
      onSelect: () => void library.checkUpdate(plugin),
    }] : [{ id: "upload", label: tr("packages.plugins.uploadNewVersion"), icon: UploadIcon, onSelect: onUploadNew }]),
    ...(plugin.previousVersion ? [{
      id: "rollback",
      label: tr("packages.plugins.rollbackToVersion", { version: plugin.previousVersion }),
      onSelect: () => void library.rollback(plugin),
    }] : []),
    "separator",
    { id: "uninstall", label: tr("settings.pages.uninstall"), danger: true, onSelect: () => void library.remove(plugin) },
  ];

  let primary: ReactNode;
  if (reviewPending && current === "permissions") {
    // The review card below carries the one primary action of this view.
    primary = null;
  } else if (plugin.update && reviewPending) {
    primary = <Button size="sm" variant="primary" disabled={busy} onClick={() => onTab("permissions")}>{tr("packages.plugins.reviewUpdate")}</Button>;
  } else if (needsReviewToEnable(plugin)) {
    primary = <Button size="sm" variant="primary" disabled={busy} onClick={() => onTab("permissions")}>{tr("packages.plugins.reviewAndEnable")}</Button>;
  } else {
    primary = (
      <>
        {update && refetchable && (
          <Button size="sm" variant="quiet" busy={busy} onClick={() => void library.stageUpdate(plugin)}>
            {plugin.fork && !plugin.updateCheck?.version
              ? tr("packages.plugins.syncFork", { count: plugin.updateCheck?.behind ?? 0 })
              : tr("packages.plugins.updateToVersion", { version: update })}
          </Button>
        )}
        <Switch
          checked={plugin.enabled}
          disabled={busy}
          label={plugin.enabled
            ? tr("settings.packagespage.disableValue", { value: plugin.name })
            : tr("settings.packagespage.enableValue", { value: plugin.name })}
          onChange={(enabled) => void library.setEnabled(plugin, enabled)}
        />
      </>
    );
  }

  const check = plugin.updateCheck;
  const updateStatus = check?.error
    ? tr("packages.plugins.updateCheckFailed", { error: check.error })
    : check?.available
      ? check.version
        ? tr("packages.plugins.updateAvailableVersion", { version: check.version })
        : tr("packages.plugins.forkBehind", { count: check.behind ?? 0 })
      : check
        ? tr("packages.plugins.upToDate")
        : tr("packages.plugins.neverChecked");

  return (
    <section className="plugin-detail" aria-labelledby={headingId}>
      <div className="plugin-detail-back">
        <Button ref={backRef} size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>
          {tr("settings.packagespage.packages")}
        </Button>
      </div>

      <header className={`plugin-hero${primary ? " has-primary" : ""}`}>
        <span className="plugin-hero-tile" aria-hidden="true"><PluginMark plugin={plugin} size="lg" /></span>
        <div className="plugin-hero-copy">
          <h3 className="plugin-hero-title" id={headingId}>
            <span className="plugin-hero-name">{plugin.name}</span>
            <span className="plugin-hero-version">{plugin.version}</span>
          </h3>
          <p className="plugin-hero-meta">
            <Badge tone={status.tone} dot>{status.label}</Badge>
            <span>{sandboxed ? tr("packages.plugins.sandboxedPackage") : tr("packages.plugins.trustedLocalPackage")}</span>
          </p>
        </div>
        {primary && <div className="plugin-hero-primary">{primary}</div>}
        <div className="plugin-hero-menu">
          <Menu label={tr("packages.plugins.packageActions", { name: plugin.name })} entries={menu} align="end">
            {(trigger) => (
              <IconButton {...trigger} icon={MoreVerticalIcon} size="sm" label={tr("packages.plugins.packageActions", { name: plugin.name })} />
            )}
          </Menu>
        </div>
      </header>

      {library.error && <ErrorState compact error={library.error} />}
      {plugin.enabled && plugin.lastError && (
        <ErrorState compact title={tr("packages.plugins.failedToStart")} error={plugin.lastError} />
      )}

      <SettingsTabs
        tabs={tabs}
        value={current}
        onChange={(id) => onTab(id as PluginDetailTab)}
        label={tr("packages.plugins.detailTabs", { name: plugin.name })}
      >
        {current === "overview" && (
          <div className="plugin-overview">
            {(plugin.description || plugin.summary) && (
              <div className="plugin-about">
                {plugin.description && <p className="plugin-lede">{plugin.description}</p>}
                {plugin.summary && <p>{plugin.summary}</p>}
              </div>
            )}
            {plugin.screenshots && plugin.screenshots.length > 0 && (
              <PluginGallery screenshots={plugin.screenshots} name={plugin.name} />
            )}
            <Section title={tr("packages.plugins.details")}>
              <dl className="plugin-facts">
                {classifierGroups(plugin).map(({ group, labels }) => (
                  <div key={group}>
                    <dt>{groupLabel(group)}</dt>
                    <dd>{labels.join(" · ")}</dd>
                  </div>
                ))}
                {(plugin.tags?.length ?? 0) > 0 && (
                  <div>
                    <dt>{tr("packages.plugins.tags")}</dt>
                    <dd>{plugin.tags!.join(" · ")}</dd>
                  </div>
                )}
                <div>
                  <dt>{tr("packages.plugins.source")}</dt>
                  <dd title={plugin.source}>{describeSourceLabel(plugin.source)}</dd>
                </div>
              </dl>
              <p className="plugin-trust">
                <Icon icon={sandboxed ? ShieldIcon : ShieldAlertIcon} size="sm" />
                <span>{sandboxed ? tr("packages.plugins.sandboxedPackageHint") : tr("packages.plugins.trustedLocalPackageHint")}</span>
              </p>
            </Section>
            <Section title={tr("packages.plugins.uninstallTitle")} tone="danger">
              <Row label={tr("packages.plugins.uninstallValue", { name: plugin.name })} hint={tr("packages.plugins.uninstallHint")}>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void library.remove(plugin)}>
                  {tr("settings.pages.uninstall")}
                </Button>
              </Row>
            </Section>
          </div>
        )}

        {current === "permissions" && (
          <div className="plugin-permissions">
            {reviewPending && review && (
              <div className="plugin-review" role="group" aria-labelledby={`${headingId}-review`}>
                <div className="plugin-review-head">
                  <span className="plugin-review-mark" aria-hidden="true"><Icon icon={ShieldAlertIcon} size="sm" /></span>
                  <div>
                    <strong id={`${headingId}-review`}>
                      {plugin.update
                        ? tr("packages.plugins.updateAsksForAccess", { version: plugin.update.version })
                        : tr("packages.plugins.asksForAccess", { name: plugin.name })}
                    </strong>
                    <p>{tr("packages.plugins.grantToEnable")}</p>
                  </div>
                </div>
                <AccessList items={review.capabilities} label={tr("packages.plugins.additionalAccessRequested")} />
                <ConnectionReview items={review.connections} />
                <div className="plugin-review-actions">
                  {plugin.update ? (
                    <>
                      <Button size="sm" variant="primary" busy={busy} onClick={() => void library.approve(plugin)}>{tr("packages.plugins.approveUpdate")}</Button>
                      {hasOptional && <Button size="sm" variant="quiet" disabled={busy} onClick={() => void library.approve(plugin, { includeOptional: true })}>{tr("packages.plugins.approveUpdateAndOptional")}</Button>}
                    </>
                  ) : !plugin.enabled ? (
                    <>
                      <Button size="sm" variant="primary" busy={busy} onClick={() => void library.approve(plugin, { enableAfter: true })}>{tr("packages.plugins.approveAndEnable")}</Button>
                      {hasOptional && <Button size="sm" variant="quiet" disabled={busy} onClick={() => void library.approve(plugin, { enableAfter: true, includeOptional: true })}>{tr("packages.plugins.enableAndOptional")}</Button>}
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="primary" busy={busy} onClick={() => void library.approve(plugin)}>{tr("packages.plugins.approveAccess")}</Button>
                      {hasOptional && <Button size="sm" variant="quiet" disabled={busy} onClick={() => void library.approve(plugin, { includeOptional: true })}>{tr("packages.plugins.approveOptionalToo")}</Button>}
                    </>
                  )}
                </div>
              </div>
            )}
            {approved.length > 0 || !reviewPending ? (
              <Section
                title={reviewPending ? tr("packages.plugins.approvedAccess") : tr("packages.plugins.requestedAccess")}
                hint={sandboxed ? tr("packages.plugins.doesNotRequestServerExecution") : tr("packages.plugins.trustedLocalPackageHint")}
              >
                {approved.length > 0
                  ? <AccessList items={approved} label={tr("packages.plugins.requestedAccess")} />
                  : <p className="plugin-quiet">{tr("packages.plugins.noAccessRequested")}</p>}
              </Section>
            ) : (
              <p className="plugin-review-note">
                {sandboxed ? tr("packages.plugins.doesNotRequestServerExecution") : tr("packages.plugins.trustedLocalPackageHint")}
              </p>
            )}
          </div>
        )}

        {current === "updates" && (
          <div className="plugin-rows">
            <ReadonlyRow label={tr("packages.plugins.source")} value={describeSourceLabel(plugin.source)} />
            {refetchable ? (
              <>
                {plugin.fork && (
                  <ReadonlyRow
                    label={tr("packages.plugins.forkFollows")}
                    value={plugin.fork.ref === "HEAD" ? tr("packages.plugins.defaultBranch") : plugin.fork.ref}
                    hint={tr("packages.plugins.forkPreservesCommits")}
                  />
                )}
                <Row
                  label={tr("packages.plugins.latestVersion")}
                  hint={check ? `${updateStatus} · ${tr("packages.plugins.lastChecked", { time: formatTime(check.checkedAt, true) })}` : updateStatus}
                >
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={library.checking === plugin.id}
                    disabled={library.checking !== null}
                    onClick={() => void library.checkUpdate(plugin)}
                  >
                    {tr("packages.plugins.checkForUpdates")}
                  </Button>
                  {!plugin.update && (
                    <Button size="sm" variant="quiet" disabled={busy || library.checking !== null} onClick={() => void library.stageUpdate(plugin)}>
                      {plugin.fork ? tr("packages.plugins.syncForkNow") : tr("packages.plugins.updateNow")}
                    </Button>
                  )}
                </Row>
                <Row label={tr("packages.plugins.autoUpdate")} hint={tr("packages.plugins.autoUpdateHint")}>
                  <Switch
                    checked={plugin.autoUpdate === true}
                    disabled={busy}
                    label={tr("packages.plugins.autoUpdate")}
                    onChange={(autoUpdate) => void library.updateSettings(plugin, { autoUpdate })}
                  />
                </Row>
                {plugin.fork && (
                  <Row label={tr("packages.plugins.forkStrategy")}>
                    <Select
                      label={tr("packages.plugins.forkStrategy")}
                      value={plugin.fork.strategy}
                      disabled={busy}
                      options={[
                        { value: "rebase", label: tr("packages.plugins.forkStrategyRebase"), detail: tr("packages.plugins.forkStrategyRebaseHint") },
                        { value: "merge", label: tr("packages.plugins.forkStrategyMerge"), detail: tr("packages.plugins.forkStrategyMergeHint") },
                      ]}
                      onChange={(value) => void library.updateSettings(plugin, { forkStrategy: value === "merge" ? "merge" : "rebase" })}
                    />
                  </Row>
                )}
              </>
            ) : (
              <Row label={tr("packages.plugins.latestVersion")} hint={tr("packages.plugins.updateNeedsArchiveHint")}>
                <Button size="sm" variant="quiet" iconStart={UploadIcon} onClick={onUploadNew}>{tr("packages.plugins.uploadNewVersion")}</Button>
              </Row>
            )}
            {plugin.previousVersion && (
              <Row label={tr("packages.plugins.previousVersion")} hint={tr("packages.plugins.previousVersionHint", { version: plugin.previousVersion })}>
                <Button size="sm" variant="quiet" disabled={busy} onClick={() => void library.rollback(plugin)}>
                  {tr("packages.plugins.rollbackToVersion", { version: plugin.previousVersion })}
                </Button>
              </Row>
            )}
          </div>
        )}

        {current === "contributions" && <Contributions plugin={plugin} />}

        {current === "logs" && <PluginLogs id={plugin.id} name={plugin.name} />}
      </SettingsTabs>
    </section>
  );
}
