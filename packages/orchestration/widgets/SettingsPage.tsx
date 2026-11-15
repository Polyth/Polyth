import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsNavigationTarget, WebPackageHost } from "@polyth/web-sdk";
import { Button, Notice, Skeleton, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import {
  DisclosureRow, ErrorState, ItemList, PageHead, SaveBar, Section, Seg, SettingsTabs, type SaveStatusState,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BUILTIN_ROLE_IDS, isBuiltinRole, isCustomRole, type OrchestrationState, type RoutingPolicy } from "../src/contracts.ts";
import {
  forgetModels, getState, isConflict, previewPolicy, recommendPolicy, resetPolicy, savePolicy, subagentRuleEnabled,
} from "./client.ts";
import { policiesEqual, policyOf } from "./helpers.ts";
import NowTab from "./NowTab.tsx";
import RolesTab from "./RolesTab.tsx";
import SafeguardsTab from "./SafeguardsTab.tsx";

type TabId = "now" | "roles" | "safeguards";
const REFOCUS_MS = 30_000;
const PREVIEW_MS = 400;

const tabForItem = (itemId?: string): TabId | null => {
  if (!itemId) return null;
  if (itemId.startsWith("orchestration.role")) return "roles";
  if (/quota|over-pace|exhausted|max-children|excluded/.test(itemId)) return "safeguards";
  if (itemId.includes("agent-text")) return "now";
  return null;
};

function HowItWorks({ mode }: { mode: "auto" | "roles" }) {
  const [open, setOpen] = useState(false);
  const steps = mode === "roles"
    ? [tr("orchestration.how.roles1"), tr("orchestration.how.roles2"), tr("orchestration.how.roles3")]
    : [tr("orchestration.how.auto1"), tr("orchestration.how.auto2"), tr("orchestration.how.auto3")];
  return (
    <ItemList>
      <DisclosureRow label={tr("orchestration.how.title")} open={open} onToggle={() => setOpen((v) => !v)} rowId="orchestration.how">
        <ol className="orch-steps">
          {steps.map((text, i) => (
            <li key={i}><span className="orch-step-n" aria-hidden="true">{i + 1}</span><span>{text}</span></li>
          ))}
        </ol>
      </DisclosureRow>
    </ItemList>
  );
}

export default function OrchestrationSettingsPage({ host, settingsTarget }: { host: WebPackageHost; settingsTarget?: SettingsNavigationTarget | undefined }) {
  const [saved, setSaved] = useState<OrchestrationState | null>(null);
  const [draft, setDraft] = useState<RoutingPolicy | null>(null);
  const [preview, setPreview] = useState<OrchestrationState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabId>(() => tabForItem(settingsTarget?.itemId) ?? "now");
  const [tabChosen, setTabChosen] = useState(() => tabForItem(settingsTarget?.itemId) !== null);
  const [saveState, setSaveState] = useState<SaveStatusState>("idle");
  const [saveError, setSaveError] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [ruleOn, setRuleOn] = useState(true);
  const [openRequest, setOpenRequest] = useState<{ id: string; n: number } | null>(null);
  const [filling, setFilling] = useState(false);
  const [filled, setFilled] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const draftRef = useRef<RoutingPolicy | null>(null);
  draftRef.current = draft;
  const savedRef = useRef<OrchestrationState | null>(null);
  savedRef.current = saved;
  const lastLoad = useRef(0);

  const dirty = !!saved && !!draft && !policiesEqual(draft, policyOf(saved.policy));

  /** Fetch the saved state. A clean draft follows it; a dirty one is kept unless `adopt`. */
  const load = useCallback(async (adopt = false, background = false) => {
    if (background) setRefreshing(true);
    lastLoad.current = Date.now();
    try {
      const next = await getState();
      const current = savedRef.current;
      const currentDraft = draftRef.current;
      const wasClean = !current || !currentDraft || policiesEqual(currentDraft, policyOf(current.policy));
      setSaved(next);
      setError(null);
      if (adopt || wasClean) setDraft(policyOf(next.policy));
      if (!current && !tabChosen) setTab(next.policy.mode === "roles" ? "roles" : "now");
    } catch (cause) {
      if (!savedRef.current) setError(cause);
    } finally {
      setRefreshing(false);
    }
  }, [tabChosen]);

  useEffect(() => {
    void load();
    void subagentRuleEnabled().then(setRuleOn);
  }, [load]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastLoad.current >= REFOCUS_MS) void load(false, true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  // Resolve the unsaved draft on the server so statuses and picks stay live.
  const seq = useRef(0);
  useEffect(() => {
    if (!draft || !saved) return;
    if (!dirty) { setPreview(null); setPreviewing(false); return; }
    const mine = ++seq.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      previewPolicy(draft).then((result) => {
        if (seq.current === mine) { setPreview(result); setPreviewing(false); }
      }, () => { if (seq.current === mine) setPreviewing(false); });
    }, PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [draft, saved, dirty]);

  const edit = (next: RoutingPolicy) => {
    setDraft(next);
    setSaveState("idle");
    setSaveError(undefined);
    setFilled(false);
  };

  const save = async () => {
    if (!draft || !saved) return;
    setSaveState("saving");
    setSaveError(undefined);
    try {
      const next = await savePolicy(draft, saved.policy.revision);
      setSaved(next);
      setDraft(policyOf(next.policy));
      setConflict(false);
      setFilled(false);
      setSaveState("saved");
      lastLoad.current = Date.now();
    } catch (cause) {
      if (isConflict(cause)) { setConflict(true); setSaveState("idle"); return; }
      setSaveState("error");
      setSaveError(host.errors.friendly(tr("orchestration.save.error"), cause));
    }
  };
  const discard = () => {
    if (saved) setDraft(policyOf(saved.policy));
    setSaveState("idle");
    setSaveError(undefined);
    setFilled(false);
  };
  const reset = async () => {
    if (!await confirmAlert(tr("orchestration.safe.resetConfirm"), {
      title: tr("orchestration.safe.resetTitle"),
      confirmLabel: tr("orchestration.safe.reset"),
      destructive: true,
    })) return;
    try {
      const next = await resetPolicy();
      setSaved(next);
      setDraft(policyOf(next.policy));
      setConflict(false);
      setSaveState("saved");
    } catch (cause) {
      setSaveState("error");
      setSaveError(host.errors.friendly(tr("orchestration.save.error"), cause));
    }
  };
  const refresh = () => {
    forgetModels();
    void load(false, true);
    void subagentRuleEnabled().then(setRuleOn);
  };
  const fill = async () => {
    if (!draft) return;
    setFilling(true);
    setFillError(null);
    try {
      const suggestion = await recommendPolicy();
      const builtin = suggestion.roles.filter((role) => isBuiltinRole(role.id))
        .sort((a, b) => BUILTIN_ROLE_IDS.indexOf(a.id as never) - BUILTIN_ROLE_IDS.indexOf(b.id as never));
      const current = draftRef.current ?? draft;
      edit({ ...current, mode: "roles", roles: [...builtin, ...current.roles.filter((role) => isCustomRole(role.id))] });
      setFilled(true);
    } catch (cause) {
      setFillError(host.errors.friendly(tr("orchestration.roles.fillError"), cause));
    } finally {
      setFilling(false);
    }
  };

  const view = preview ?? saved;
  const now = Date.now();
  const tabs = useMemo(() => [
    { id: "now", label: tr("orchestration.tabs.now") },
    { id: "roles", label: tr("orchestration.tabs.roles") },
    { id: "safeguards", label: tr("orchestration.tabs.safeguards") },
  ], [saved === null]);

  if (error && !saved) {
    return (
      <div className="orch-page">
        <PageHead blurb={tr("orchestration.page.blurb")} />
        <ErrorState title={tr("orchestration.load.error")} error={error} onRetry={() => { setError(null); void load(); }} />
      </div>
    );
  }
  if (!saved || !draft) {
    return (
      <div className="orch-page" aria-busy="true">
        <PageHead blurb={tr("orchestration.page.blurb")} />
        <div className="orch-skeleton" aria-hidden="true">
          {[0, 1, 2].map((n) => <Skeleton key={n} shape="block" height={52} />)}
        </div>
      </div>
    );
  }

  const inactiveNote = draft.mode === "auto" && tab === "safeguards";
  return (
    <div className="orch-page">
      <PageHead blurb={tr("orchestration.page.blurb")} />
      <div className="orch-notices">
        {!ruleOn && (
          <Notice tone="warning" actions={<Button size="sm" onClick={() => host.navigation.openSettingsPage("behavior")}>{tr("orchestration.notice.openBehavior")}</Button>}>
            {tr("orchestration.notice.behaviorOff")}
          </Notice>
        )}
        {!saved.routingAvailable && <Notice tone="info">{tr("orchestration.notice.usageOff")}</Notice>}
        {conflict && (
          <Notice tone="warning" actions={<Button size="sm" onClick={() => { setConflict(false); void load(true, true); }}>{tr("orchestration.notice.reload")}</Button>}>
            {tr("orchestration.notice.conflict")}
          </Notice>
        )}
      </div>
      <Section title={tr("orchestration.mode.title")} itemId="orchestration.mode">
        <div className="orch-seg">
          <Seg
            label={tr("orchestration.mode.title")}
            value={draft.mode}
            options={[["auto", tr("orchestration.mode.auto")], ["roles", tr("orchestration.mode.roles")]]}
            onChange={(mode) => edit({ ...draft, mode })}
          />
        </div>
        <p className="orch-hint">{draft.mode === "roles" ? tr("orchestration.mode.rolesHint") : tr("orchestration.mode.autoHint")}</p>
        <HowItWorks mode={draft.mode} />
      </Section>
      <SettingsTabs
        tabs={tabs}
        value={tab}
        onChange={(id) => { setTab(id as TabId); setTabChosen(true); }}
        label={tr("orchestration.tabs.label")}
        idBase="orchestration-tabs"
      >
        {tab === "now" && (
          <NowTab
            state={saved}
            loading={false}
            refreshing={refreshing}
            mode={saved.policy.mode}
            ceiling={saved.policy.quotaCeiling}
            now={now}
            onRefresh={refresh}
            onOpenRole={(id) => { setTab("roles"); setTabChosen(true); setOpenRequest({ id, n: Date.now() }); }}
          />
        )}
        {tab === "roles" && (
          <RolesTab
            draft={draft}
            setDraft={edit}
            resolvedRoles={view?.roles ?? []}
            pending={previewing}
            ceiling={draft.quotaCeiling}
            now={now}
            openRequest={openRequest}
            onFill={() => void fill()}
            filling={filling}
            filled={filled}
            fillError={fillError}
            onSwitchMode={() => edit({ ...draft, mode: "roles" })}
          />
        )}
        {tab === "safeguards" && (
          <>
            {inactiveNote && (
              <p className="orch-inline-note">
                {tr("orchestration.roles.inactive")}{" "}
                <button type="button" className="orch-link" onClick={() => edit({ ...draft, mode: "roles" })}>{tr("orchestration.roles.switch")}</button>
              </p>
            )}
            <SafeguardsTab draft={draft} setDraft={edit} onReset={() => void reset()} busy={saveState === "saving"} />
          </>
        )}
      </SettingsTabs>
      <SaveBar
        dirty={dirty}
        saving={saveState === "saving"}
        status={saveState}
        {...(saveError ? { error: saveError } : {})}
        onSave={() => void save()}
        onDiscard={discard}
      />
    </div>
  );
}
