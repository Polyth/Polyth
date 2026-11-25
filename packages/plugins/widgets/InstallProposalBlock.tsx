// The install block an agent leaves in the chat (`plugins/install-proposed`)
// for a package it built. Everything it shows comes from the server's reading
// of the manifest; the install is pinned to that manifest. One click runs the
// same install → grant → enable that Settings → Packages runs, under the same
// server checks, then tells the agent how it went with an ordinary message.
import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import type { InstalledPluginDto, SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Icon, PackageIcon, WarningIcon } from "../../../apps/web/src/components/ui/index.ts";
import { copyText } from "../../../apps/web/src/utils.ts";
import { readInstallProposal } from "../src/installProposal.ts";
import { capabilityRequired } from "./PluginPermissions.tsx";
import { capabilityLabel } from "./pluginTaxonomy.ts";

type MessageKey = Parameters<typeof tr>[0];
type Access = { install: boolean; enable: boolean };

const SURFACES: Record<string, MessageKey> = {
  surfaces: "packages.plugins.proposal.surface.window",
  panels: "packages.plugins.proposal.surface.panels",
  widgets: "packages.plugins.proposal.surface.widgets",
  commands: "packages.plugins.proposal.surface.commands",
  composerActions: "packages.plugins.proposal.surface.composer",
  attachmentProviders: "packages.plugins.proposal.surface.composer",
  messageActions: "packages.plugins.proposal.surface.chat",
  sessionActions: "packages.plugins.proposal.surface.chat",
  toolRenderers: "packages.plugins.proposal.surface.chat",
  contextProviders: "packages.plugins.proposal.surface.chat",
  statusBadges: "packages.plugins.proposal.surface.chat",
  settingsSections: "packages.plugins.proposal.surface.settings",
};

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const list = (items: string[]): string => [...new Set(items)].join(" · ");

export default function InstallProposalBlock({ host, event, sessionId }: {
  host: WebPackageHost;
  event: SessionEvent;
  sessionId: string | undefined;
}) {
  const proposal = readInstallProposal(event.data);
  const packageId = proposal?.packageId ?? "";
  // undefined while loading; null when the package is not installed.
  const [plugin, setPlugin] = useState<InstalledPluginDto | null | undefined>(undefined);
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!packageId) return;
    let live = true;
    void Promise.all([api.pluginsList(), api.pluginsInstallAccess()]).then(([plugins, allowed]) => {
      if (!live) return;
      setPlugin(plugins.find((item) => item.id === packageId) ?? null);
      setAccess(allowed);
    });
    return () => { live = false; };
  }, [packageId]);

  if (!proposal) return null;
  const name = proposal.name;
  const ready = plugin?.enabled === true;
  // A fresh install needs the owner; enabling a server package does too.
  const canAct = access !== null && (plugin
    ? access.enable && (!proposal.server || access.install)
    : access.install && access.enable);

  const install = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let next = plugin ?? await api.pluginsInstall(proposal.source, { expectManifestSha256: proposal.manifestSha256 });
      // The list carries the access review a fresh install has not had yet.
      next = (await api.pluginsList()).find((item) => item.id === next.id) ?? next;
      const review = next.permissions.review;
      if (review && (review.connections.length > 0 || review.capabilities.some(capabilityRequired))) {
        next = await api.pluginsGrant(
          next.id,
          review.capabilities.filter(capabilityRequired).map((item) => item.name),
          review.connections.map((item) => item.id),
        );
      }
      if (!next.enabled) next = await api.pluginsOp(next.id, "enable");
      setPlugin(next);
      if (sessionId) {
        void host.conversation.send(sessionId, next.status === "error"
          ? tr("packages.plugins.proposal.replyFailed", { id: next.id, error: next.lastError ?? "" })
          : tr("packages.plugins.proposal.replyInstalled", { id: next.id }));
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    const link = `${location.origin}/?settings=packages&install=${encodeURIComponent(proposal.source)}`;
    setCopied(await copyText(link));
  };

  const capabilities = proposal.capabilities.filter((item) => item.required).map((item) => capabilityLabel(item.name));
  const surfaces = proposal.surfaces.flatMap((key) => SURFACES[key] ? [tr(SURFACES[key])] : []);

  if (ready) {
    return (
      <aside className="plugin-proposal" data-state="ready" data-event-seq={event.seq}>
        <span className="plugin-proposal-mark" aria-hidden="true"><Icon icon={PackageIcon} size="sm" /></span>
        <div className="plugin-proposal-head">
          <span className="plugin-proposal-title">{tr("packages.plugins.proposal.installed", { name })}</span>
          <Button variant="ghost" size="sm" onClick={() => host.navigation.openSettingsPage("packages")}>
            {tr("packages.plugins.proposal.open")}
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="plugin-proposal" data-event-seq={event.seq} aria-label={tr("packages.plugins.proposal.title", { name })}>
      <span className="plugin-proposal-mark" aria-hidden="true"><Icon icon={PackageIcon} size="sm" /></span>
      <div className="plugin-proposal-head">
        <strong className="plugin-proposal-title">{tr("packages.plugins.proposal.title", { name })}</strong>
        {proposal.version && <span className="plugin-proposal-version">{proposal.version}</span>}
      </div>
      {proposal.description && <p className="plugin-proposal-description">{proposal.description}</p>}
      <dl className="plugin-proposal-facts">
        {capabilities.length > 0 && <div><dt>{tr("packages.plugins.proposal.can")}</dt><dd>{list(capabilities)}</dd></div>}
        {proposal.connections.length > 0 && <div><dt>{tr("packages.plugins.proposal.connects")}</dt><dd>{list(proposal.connections)}</dd></div>}
        {surfaces.length > 0 && <div><dt>{tr("packages.plugins.proposal.appears")}</dt><dd>{list(surfaces)}</dd></div>}
      </dl>
      {/* Only someone who can install it is asked to weigh server code. */}
      {proposal.server && access?.install && (
        <p className="plugin-proposal-warning">
          <Icon icon={WarningIcon} size="sm" />
          <span>{tr("packages.plugins.proposal.serverWarning")}</span>
        </p>
      )}
      {access && !canAct && (
        <p className="plugin-proposal-note">
          {tr(plugin ? "packages.plugins.proposal.adminOnly" : "packages.plugins.proposal.ownerOnly")}
        </p>
      )}
      {error && <p className="plugin-proposal-error" role="alert">{tr("packages.plugins.proposal.failed", { error })}</p>}
      <div className="plugin-proposal-actions">
        {access === null || plugin === undefined
          ? null
          : canAct
            ? (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void install()}>
                {busy
                  ? tr("packages.plugins.proposal.installing")
                  : tr(plugin ? "packages.plugins.proposal.enable" : "packages.plugins.proposal.install")}
              </Button>
            )
            : !plugin && (
              <Button variant="quiet" size="sm" onClick={() => void copyLink()}>
                {tr(copied ? "packages.plugins.proposal.copied" : "packages.plugins.proposal.copyLink")}
              </Button>
            )}
      </div>
    </aside>
  );
}
