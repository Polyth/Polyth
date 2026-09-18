import { useMemo, type ReactNode } from "react";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../../apps/web/src/store.ts";
import {
  Checkbox,
  Select,
  TextInput,
} from "../../../../apps/web/src/components/ui/index.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import {
  setBlockHidden,
  setProviderCostProfile,
  setUsageDashboardPrefs,
  useUsagePrefs,
} from "../usagePrefs.ts";
import { buildUsageDashboardData } from "./dashboardData.ts";
import { useQuotaSnapshots } from "./quotaUi.tsx";

const OVERVIEW_BLOCKS = [
  ["spend", "Spend"],
  ["tokens", "Tokens"],
  ["sessions", "Sessions"],
  ["cache", "Cache hit"],
  ["cohorts", "Usage over time"],
  ["cost-context", "Cost context"],
  ["provider-spend", "Cost by provider"],
  ["models", "Model breakdown"],
  ["provider-activity", "Provider activity"],
  ["actions", "Quick actions"],
] as const;

const formatMoney = (value: number): string =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function UsageSettings(): ReactNode {
  const sessions = useStore((state) => state.sessions);
  const projectId = useStore((state) => state.activeProjectId);
  const { snapshots } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const projectSessions = useMemo(
    () => sessions.filter((session) => session.projectId === projectId),
    [projectId, sessions],
  );
  const data = useMemo(
    () => buildUsageDashboardData(projectSessions, snapshots, prefs.dashboard.rangeDays),
    [projectSessions, snapshots, prefs.dashboard.rangeDays],
  );

  return (
    <div className="usage-settings-page">
      <div className="usage-settings-intro">
        <h2>Usage</h2>
        <p>Configure presentation, charts, and billing metadata. The Usage dashboard itself stays in the workspace.</p>
      </div>

      <section className="usage-settings-section" data-settings-item="usage.appearance">
        <div className="usage-settings-heading">
          <h3>Appearance</h3>
          <p>These choices apply immediately to the Usage workspace view.</p>
        </div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{tr("usage.usagedashboard.dashboardDensity")}</div>
            <div className="set-row-hint">Choose how much breathing room cards and statistics use.</div>
          </div>
          <div className="set-row-control">
            <Select
              label={tr("usage.usagedashboard.dashboardDensity")}
              ariaLabel={tr("usage.usagedashboard.dashboardDensity")}
              value={prefs.dashboard.layout}
              options={[
                { value: "expanded", label: tr("usage.usagedashboard.expanded") },
                { value: "compact", label: tr("usage.usagedashboard.compact") },
              ]}
              onChange={(layout) => setUsageDashboardPrefs({ layout: layout === "compact" ? "compact" : "expanded" })}
            />
          </div>
        </div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{tr("usage.usagedashboard.usageRange")}</div>
            <div className="set-row-hint">Default reporting window for spend, token, model, and provider statistics.</div>
          </div>
          <div className="set-row-control">
            <Select
              label={tr("usage.usagedashboard.usageRange")}
              ariaLabel={tr("usage.usagedashboard.usageRange")}
              value={String(prefs.dashboard.rangeDays)}
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
              ]}
              onChange={(value) => setUsageDashboardPrefs({
                rangeDays: value === "30" ? 30 : value === "90" ? 90 : 7,
              })}
            />
          </div>
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.charts">
        <div className="usage-settings-heading">
          <h3>Charts</h3>
          <p>Chart.js renders Usage visualizations; choose the presentation without changing the underlying data.</p>
        </div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">Usage over time</div>
            <div className="set-row-hint">Bars are best for discrete daily totals; lines make trends easier to scan.</div>
          </div>
          <div className="set-row-control usage-settings-chart-controls">
            <Select
              label="Chart style"
              ariaLabel="Chart style"
              value={prefs.dashboard.chartStyle}
              options={[
                { value: "bar", label: "Bars" },
                { value: "line", label: "Lines" },
              ]}
              onChange={(chartStyle) => setUsageDashboardPrefs({ chartStyle: chartStyle === "line" ? "line" : "bar" })}
            />
            <Select
              label={tr("usage.usagedashboard.chartMetric")}
              ariaLabel={tr("usage.usagedashboard.chartMetric")}
              value={prefs.dashboard.chartMetric}
              options={[
                { value: "tokens", label: tr("usage.usagedashboard.tokens") },
                { value: "cost", label: tr("usage.usagedashboard.cost") },
                { value: "sessions", label: tr("usage.usagedashboard.sessions") },
              ]}
              onChange={(chartMetric) => setUsageDashboardPrefs({
                chartMetric: chartMetric === "cost" || chartMetric === "sessions" ? chartMetric : "tokens",
              })}
            />
            <Checkbox
              checked={prefs.dashboard.showChartLegend}
              label="Show chart legends"
              onChange={(showChartLegend) => setUsageDashboardPrefs({ showChartLegend })}
            />
          </div>
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.statistics">
        <div className="usage-settings-heading">
          <h3>Statistics</h3>
          <p>Choose which overview blocks are visible. Reordering still happens directly on the dashboard.</p>
        </div>
        <div className="usage-settings-block-grid">
          {OVERVIEW_BLOCKS.map(([id, label]) => (
            <Checkbox
              key={id}
              checked={!prefs.hiddenBlocks.includes(id)}
              label={label}
              onChange={(visible) => setBlockHidden(id, !visible)}
            />
          ))}
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.costs">
        <div className="usage-settings-heading">
          <h3>Provider billing</h3>
          <p>Mark each provider as API usage or a subscription. Subscription price is local display metadata; recorded session spend stays untouched.</p>
        </div>

        <div className="usage-settings-provider-list">
          {data.providers.map((provider) => {
            const profile = prefs.providerCosts[provider.id] ?? { billing: "api" as const, monthlyCost: null };
            return (
              <div className="usage-settings-provider" key={provider.id}>
                <div className="usage-settings-provider-main">
                  <ProviderLogo
                    providerID={provider.id}
                    providerName={provider.label}
                    className="usage-settings-provider-logo"
                  />
                  <div>
                    <strong>{provider.label}</strong>
                    <span>
                      {profile.billing === "subscription"
                        ? `Spent ${formatMoney(provider.cost)} in the selected range`
                        : `${formatMoney(provider.cost)} recorded API spend`}
                    </span>
                  </div>
                </div>

                <div className="usage-settings-provider-controls">
                  <Select
                    label={`${provider.label} billing type`}
                    ariaLabel={`${provider.label} billing type`}
                    value={profile.billing}
                    options={[
                      { value: "api", label: "API usage" },
                      { value: "subscription", label: "Subscription" },
                    ]}
                    onChange={(billing) => setProviderCostProfile(provider.id, {
                      billing: billing === "subscription" ? "subscription" : "api",
                    })}
                  />
                  {profile.billing === "subscription" && (
                    <label className="usage-settings-price">
                      <span>Monthly cost</span>
                      <span className="usage-settings-money-input">
                        <span aria-hidden="true">$</span>
                        <TextInput
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={profile.monthlyCost ?? ""}
                          aria-label={`${provider.label} monthly subscription cost`}
                          placeholder="0.00"
                          onChange={(event) => {
                            const value = event.target.value.trim();
                            setProviderCostProfile(provider.id, {
                              monthlyCost: value === "" ? null : Number(value),
                            });
                          }}
                        />
                      </span>
                    </label>
                  )}
                  {profile.billing === "subscription" && (
                    <span className="usage-settings-provider-plan">
                      {profile.monthlyCost === null ? "Monthly price not set" : `${formatMoney(profile.monthlyCost)} / month`}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {data.providers.length === 0 && (
            <p className="usage-settings-empty">Providers appear here after Polyth sees session usage or a quota feed.</p>
          )}
        </div>
      </section>
    </div>
  );
}
