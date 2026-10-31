import { useEffect, useState } from "react";
import { api, type BrowserVaultFillApprovalDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, PageHead, Row, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { useStore } from "../../../apps/web/src/store.ts";
import { getBrowserVisibility, setBrowserVisibility, subscribeBrowserVisibility, type BrowserVisibilityMode } from "./browserVisibility.ts";

function approvalHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export default function BrowserSettingsPage({ host }: { host: WebPackageHost }) {
  const { Button } = host.ui.components;
  const translate = host.ui.locale.translate;
  const projectRegistry = useStore((state) => state.projectRegistry);
  const [mode, setMode] = useState<BrowserVisibilityMode>(getBrowserVisibility);
  const [autoApprove, setAutoApprove] = useState(true);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const [autoApproveError, setAutoApproveError] = useState<string | null>(null);
  const [vaultApprovals, setVaultApprovals] = useState<BrowserVaultFillApprovalDto[]>([]);
  const [vaultApprovalsBusy, setVaultApprovalsBusy] = useState(false);
  const [vaultApprovalsError, setVaultApprovalsError] = useState<string | null>(null);

  useEffect(() => subscribeBrowserVisibility(() => setMode(getBrowserVisibility())), []);

  useEffect(() => {
    let cancelled = false;
    void api.browserAgentAutoApproveGet()
      .then((result) => {
        if (!cancelled) setAutoApprove(result.enabled);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAutoApproveError(host.errors.friendly(translate("browser.settings.agentAutoApprove"), error));
        }
      });
    return () => { cancelled = true; };
  }, [host.errors, translate]);

  useEffect(() => {
    let cancelled = false;
    void api.browserVaultFillApprovals()
      .then((rows) => {
        if (!cancelled) {
          setVaultApprovals(rows);
          setVaultApprovalsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setVaultApprovalsError(host.errors.friendly(translate("browser.settings.vaultFillApprovals"), error));
      });
    return () => { cancelled = true; };
  }, [host.errors, translate]);

  const projectName = (projectId: string) => (projectRegistry.status === "ready"
    ? projectRegistry.projects.find((project) => project.id === projectId)?.name
    : undefined) ?? translate("browser.settings.unknownProject");

  const setAgentAutoApprove = (checked: boolean) => {
    const previous = autoApprove;
    setAutoApprove(checked);
    setAutoApproveBusy(true);
    setAutoApproveError(null);
    void api.browserAgentAutoApproveSet(checked)
      .then((result) => setAutoApprove(result.enabled))
      .catch((error: unknown) => {
        setAutoApprove(previous);
        setAutoApproveError(host.errors.friendly(translate("browser.settings.agentAutoApprove"), error));
      })
      .finally(() => setAutoApproveBusy(false));
  };

  const clearApprovals = async () => {
    const confirmed = await confirmAlert(translate("browser.settings.clearVaultFillApprovalsConfirm"), {
      title: translate("browser.settings.clearVaultFillApprovalsTitle"),
      confirmLabel: translate("browser.settings.clearVaultFillApprovals"),
    });
    if (!confirmed) return;
    setVaultApprovalsBusy(true);
    setVaultApprovalsError(null);
    void api.browserVaultFillApprovalsClear()
      .then(() => setVaultApprovals([]))
      .catch((error: unknown) => setVaultApprovalsError(host.errors.friendly(translate("browser.settings.clearVaultFillApprovals"), error)))
      .finally(() => setVaultApprovalsBusy(false));
  };

  return (
    <div className="browser-settings-page">
      <PageHead title={translate("previewview.browser")} blurb={translate("browser.settings.blurb")} />
      <Section title={translate("browser.settings.agentSection")}>
        <Row
          label={translate("browser.settings.agentAutoApprove")}
          hint={translate("browser.settings.agentAutoApproveDescription")}
          itemId="browser.agent-auto-approve"
        >
          <Toggle
            on={autoApprove}
            disabled={autoApproveBusy}
            label={translate("browser.settings.agentAutoApprove")}
            onChange={setAgentAutoApprove}
          />
        </Row>
        {autoApproveError ? <p className="browser-settings-error" role="alert">{autoApproveError}</p> : null}
        <Row
          label={translate("previewview.browserVisibility")}
          hint={translate(mode === "auto-show" ? "browser.settings.visibilityAutoShowHint" : "browser.settings.visibilityBackgroundHint")}
          itemId="browser.visibility"
        >
          <Seg
            value={mode}
            label={translate("previewview.browserVisibility")}
            options={[
              ["background", translate("previewview.background")],
              ["auto-show", translate("previewview.autoShow")],
            ]}
            onChange={(next) => setBrowserVisibility(next)}
          />
        </Row>
      </Section>
      <Section
        title={translate("browser.settings.vaultFillApprovals")}
        hint={translate("browser.settings.vaultFillApprovalsDescription")}
        itemId="browser.vault-fill-approvals"
        action={vaultApprovals.length > 0
          ? (
            <Button
              size="sm"
              variant="ghost"
              className="browser-settings-clear"
              busy={vaultApprovalsBusy}
              disabled={vaultApprovalsBusy}
              onClick={() => { void clearApprovals(); }}
            >
              {translate("browser.settings.clearVaultFillApprovals")}
            </Button>
          )
          : undefined}
      >
        {vaultApprovalsError ? <p className="browser-settings-error" role="alert">{vaultApprovalsError}</p> : null}
        {vaultApprovals.length === 0
          ? <EmptyState compact icon="key" title={translate("browser.settings.vaultFillApprovalsNone")} body={translate("browser.settings.vaultFillApprovalsNoneHint")} />
          : (
            <ul className="browser-approval-list">
              {vaultApprovals.map((approval) => (
                <li
                  className="browser-approval-row"
                  key={`${approval.projectId}:${approval.handle}:${approval.origin}`}
                  title={`${approval.projectId} · ${approval.origin}`}
                >
                  <span className="browser-approval-site">{approvalHost(approval.origin)}</span>
                  <span className="browser-approval-meta">
                    {translate("browser.settings.vaultFillApprovalMeta", { handle: approval.handle, project: projectName(approval.projectId) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Section>
    </div>
  );
}

export type { BrowserVisibilityMode };
