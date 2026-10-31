import { useState, useSyncExternalStore } from "react";
import type { JsonObject, TaskTrackerProvider } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Button, TabPanel, Tabs } from "../../../apps/web/src/components/ui/index.ts";
import { connectCopy, PROVIDER_LABELS, ProviderMark, providerBlurb, providerState } from "./brand.tsx";
import { tt } from "./i18n.ts";
import { ConnectWizard } from "./connect.tsx";
import { TaskTrackerManagement } from "./management.tsx";
import { TaskTrackerBoard } from "./plugin.tsx";
import { updatePreferences, useManagement } from "./store.ts";
import { TASK_TRACKER_PROVIDERS } from "../src/types.ts";

/** Device-local window state: view options and the tab last open. The board
 * selection is remembered under `MEMORY_KEY` by the board itself. */
const CONFIG_KEY = "polyth.task-trackers.page";
const MEMORY_KEY = "polyth.task-trackers.page.last";
const TABS = [
  { id: "board" },
  { id: "services" },
] as const;

type PageTab = (typeof TABS)[number]["id"];

const isTab = (value: unknown): value is PageTab =>
  TABS.some((tab) => tab.id === value);

const readConfig = (): JsonObject => {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  } catch {
    return {};
  }
};

/** First-run screen: two large choices instead of an empty board. */
function Onboarding({
  canManage,
  canConnect,
  demoOff,
  onConnect,
}: {
  canManage: boolean;
  canConnect: boolean;
  demoOff: boolean;
  onConnect: (provider: TaskTrackerProvider) => void;
}) {
  return (
    <div className="tt-onboarding">
      <div className="tt-onboarding-copy">
        <strong>{tt("tasktrackers.page.onboarding.title")}</strong>
        <p>{tt("tasktrackers.page.onboarding.body")}</p>
        {!canManage && canConnect && <p>{tt("tasktrackers.page.onboarding.ownAccount")}</p>}
        {!canConnect && <p>{tt("tasktrackers.page.onboarding.askAdmin")}</p>}
      </div>
      <div className="tt-onboarding-choices">
        {TASK_TRACKER_PROVIDERS.map((provider, index) => (
          <button
            key={provider}
            type="button"
            className={`tt-choice ${provider}`}
            style={{ "--tt-i": index } as Record<string, number>}
            disabled={!canConnect}
            onClick={() => onConnect(provider)}
          >
            <ProviderMark provider={provider} size="lg" />
            <strong>{tt("tasktrackers.page.onboarding.connect", { provider: PROVIDER_LABELS[provider] })}</strong>
            <small>{providerBlurb(provider)}</small>
            <span className="tt-choice-cta" aria-hidden="true">{connectCopy(provider).cta}</span>
          </button>
        ))}
      </div>
      {demoOff && canManage && (
        <Button variant="ghost" size="sm" onClick={() => void updatePreferences({ demo: true })}>
          {tt("tasktrackers.page.onboarding.demo")}
        </Button>
      )}
    </div>
  );
}

/** The package home: one board for every tracker plus inline service management. */
export function TaskTrackersPage({ host }: { host: WebPackageHost }) {
  const sessionId = useSyncExternalStore(
    host.store.subscribe,
    () => host.store.getSnapshot().activeSessionId,
    () => null,
  );
  const { data, preferences } = useManagement();
  const [config, setConfig] = useState(readConfig);
  const [tab, setTab] = useState<PageTab>(() => isTab(config.tab) ? config.tab : "board");
  const [connecting, setConnecting] = useState<TaskTrackerProvider | null>(null);
  const canManage = data?.canManage ?? false;
  const canConnect = data?.canConnect ?? canManage;

  const usable = (data?.providers ?? []).some((info) => {
    const state = providerState({ ...info, enabled: preferences.providers[info.provider] });
    return state !== "off" && state !== "disconnected";
  });

  const updateConfig = (next: JsonObject) => {
    setConfig(next);
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  };
  const chooseTab = (id: string) => {
    if (!isTab(id)) return;
    setTab(id);
    updateConfig({ ...config, tab: id });
  };

  return (
    <div className="tt-page">
      <div className="tt-page-bar">
        <Tabs tabs={TABS.map((item) => ({ ...item, label: item.id === "board" ? tt("tasktrackers.page.tab.board") : tt("tasktrackers.page.tab.services") }))} value={tab} onChange={chooseTab} label={tt("tasktrackers.page.tabsLabel")} idBase="tt-page" size="sm" />
      </div>
      <TabPanel idBase="tt-page" tabId="board" active={tab === "board"} className="tt-page-panel">
        {(data && !usable
          ? <Onboarding canManage={canManage} canConnect={canConnect} demoOff={!preferences.demo} onConnect={setConnecting} />
          : <TaskTrackerBoard sessionId={sessionId} config={config} updateConfig={updateConfig} memoryKey={MEMORY_KEY} />)}
      </TabPanel>
      <TabPanel idBase="tt-page" tabId="services" active={tab === "services"} className="tt-page-panel tt-page-scroll">
        <TaskTrackerManagement intro={false} />
      </TabPanel>
      {connecting && <ConnectWizard provider={connecting} scope={canManage ? "space" : "personal"} onClose={() => setConnecting(null)} />}
    </div>
  );
}
