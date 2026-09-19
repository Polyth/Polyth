import { useMemo, type ReactNode } from "react";
import { getLocale } from "../../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../../apps/web/src/store.ts";
import { Checkbox, Select, TextInput } from "../../../../apps/web/src/components/ui/index.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import {
  setBlockHidden,
  setProviderCostProfile,
  setProviderHidden,
  setUsageDashboardPrefs,
  useUsagePrefs,
  type UsageBreakdownDimension,
  type UsageMetricId,
  type UsageProviderSort,
} from "../usagePrefs.ts";
import { buildUsageDashboardData } from "./dashboardData.ts";
import { useQuotaSnapshots } from "./quotaUi.tsx";

const CARD_METRICS: ReadonlyArray<{ id: UsageMetricId; label: string }> = [
  { id: "cost", label: "Cost / value" },
  { id: "tokens", label: "Tokens" },
  { id: "sessions", label: "Sessions" },
  { id: "ttft", label: "TTFT" },
  { id: "tps", label: "tok/s" },
  { id: "cache", label: "Cache" },
  { id: "errors", label: "Errors" },
  { id: "success", label: "Success rate" },
];

const CHARTS = [
  ["usage-trend", "Usage over time"],
  ["distribution", "Top consumers"],
] as const;

const DIMENSION_OPTIONS = [
  { value: "provider", label: "Provider" },
  { value: "model", label: "Model" },
  { value: "harness", label: "Harness" },
  { value: "project", label: "Project" },
];

const money = (value: number): string =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function UsageSettings(): ReactNode {
  const sessions = useStore((state) => state.sessions);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const { snapshots } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const projectLabels = useMemo(
    () => Object.fromEntries(projectRegistry.projects.map((project) => [project.id, project.name])),
    [projectRegistry.projects],
  );
  const data = useMemo(
    () => buildUsageDashboardData(sessions, snapshots, prefs.dashboard.rangeDays, Date.now(), projectLabels),
    [projectLabels, prefs.dashboard.rangeDays, sessions, snapshots],
  );

  const setMetricVisible = (metric: UsageMetricId, visible: boolean): void => {
    const current = prefs.dashboard.cardMetrics;
    const next = visible
      ? [...current.filter((item) => item !== metric), metric]
      : current.filter((item) => item !== metric);
    setUsageDashboardPrefs({ cardMetrics: next });
  };

  return (
    <div className="usage-settings-page">
      <div className="usage-settings-intro">
        <h2>Usage</h2>
        <p>Choose what the dashboard shows. Preferences are mirrored to the server for this Space.</p>
      </div>

      <section className="usage-settings-section" data-settings-item="usage.appearance">
        <div className="usage-settings-heading">
          <h3>Appearance</h3>
          <p>Keep the operational view dense by default, or add a little more breathing room.</p>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">Density</div>
            <div className="set-row-hint">Compact is optimized for phones and quick quota scanning.</div>
          </div>
          <div className="set-row-control">
            <Select
              label="Density"
              ariaLabel="Usage density"
              value={prefs.dashboard.layout}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
              ]}
              onChange={(value) => setUsageDashboardPrefs({
                layout: value === "comfortable" ? "comfortable" : "compact",
              })}
            />
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">Default range</div>
            <div className="set-row-hint">Custom ranges are selected directly in Usage and are remembered too.</div>
          </div>
          <div className="set-row-control">
            <Select
              label="Default range"
              ariaLabel="Default usage range"
              value={String(prefs.dashboard.rangeDays)}
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
              ]}
              onChange={(value) => setUsageDashboardPrefs({
                rangeDays: value === "30" ? 30 : value === "90" ? 90 : 7,
                rangeMode: "preset",
              })}
            />
          </div>
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.statistics">
        <div className="usage-settings-heading">
          <h3>Provider cards</h3>
          <p>Unavailable telemetry is hidden automatically rather than replaced with invented values.</p>
        </div>
        <div className="usage-settings-block-grid">
          {CARD_METRICS.map(({ id, label }) => (
            <Checkbox
              key={id}
              checked={prefs.dashboard.cardMetrics.includes(id)}
              label={label}
              onChange={(visible) => setMetricVisible(id, visible)}
            />
          ))}
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">Performance statistic</div>
            <div className="set-row-hint">Used for TTFT and output speed when historical performance samples are available.</div>
          </div>
          <div className="set-row-control">
            <Select
              label="Performance statistic"
              ariaLabel="Performance statistic"
              value={prefs.dashboard.performanceStatistic}
              options={[
                { value: "p50", label: "Median / p50" },
                { value: "average", label: "Average" },
                { value: "p95", label: "p95" },
              ]}
              onChange={(value) => setUsageDashboardPrefs({
                performanceStatistic: value === "average" || value === "p95" ? value : "p50",
              })}
            />
          </div>
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.charts">
        <div className="usage-settings-heading">
          <h3>Overview</h3>
          <p>Keep only the analytical views you use; performance charts stay hidden until persisted latency samples exist.</p>
        </div>
        <div className="usage-settings-block-grid">
          {CHARTS.map(([id, label]) => (
            <Checkbox
              key={id}
              checked={!prefs.hiddenBlocks.includes(id)}
              label={label}
              onChange={(visible) => setBlockHidden(id, !visible)}
            />
          ))}
        </div>
        <div className="usage-settings-chart-controls">
          <Select
            label="Chart style"
            ariaLabel="Usage chart style"
            value={prefs.dashboard.chartStyle}
            options={[
              { value: "bar", label: "Bars" },
              { value: "line", label: "Lines" },
            ]}
            onChange={(value) => setUsageDashboardPrefs({ chartStyle: value === "line" ? "line" : "bar" })}
          />
          <Select
            label="Default metric"
            ariaLabel="Default chart metric"
            value={prefs.dashboard.chartMetric}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
              { value: "sessions", label: "Sessions" },
            ]}
            onChange={(value) => setUsageDashboardPrefs({
              chartMetric: value === "cost" || value === "sessions" ? value : "tokens",
            })}
          />
          <Select
            label="Time-series grouping"
            ariaLabel="Usage chart grouping"
            value={prefs.dashboard.chartGrouping}
            options={DIMENSION_OPTIONS}
            onChange={(value) => setUsageDashboardPrefs({ chartGrouping: value as UsageBreakdownDimension })}
          />
          <Select
            label="Top-consumers grouping"
            ariaLabel="Top consumers grouping"
            value={prefs.dashboard.distributionGrouping}
            options={DIMENSION_OPTIONS}
            onChange={(value) => setUsageDashboardPrefs({ distributionGrouping: value as UsageBreakdownDimension })}
          />
          <Checkbox
            checked={prefs.dashboard.showChartLegend}
            label="Show chart legend"
            onChange={(showChartLegend) => setUsageDashboardPrefs({ showChartLegend })}
          />
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.providers">
        <div className="usage-settings-heading">
          <h3>Provider display</h3>
          <p>Sort cards for the way you work and keep secondary value signals optional.</p>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">Sort providers</div>
            <div className="set-row-hint">Quota puts the providers closest to their limit first.</div>
          </div>
          <div className="set-row-control">
            <Select
              label="Provider sort"
              ariaLabel="Provider sort"
              value={prefs.dashboard.providerSort}
              options={[
                { value: "quota", label: "Quota pressure" },
                { value: "spend", label: "Spend" },
                { value: "usage", label: "Token usage" },
                { value: "name", label: "Name" },
                { value: "manual", label: "Manual order" },
              ]}
              onChange={(value) => setUsageDashboardPrefs({ providerSort: value as UsageProviderSort })}
            />
          </div>
        </div>
        <div className="usage-settings-block-grid">
          <Checkbox
            checked={prefs.dashboard.showApiEquivalent}
            label="Show API-equivalent value"
            onChange={(showApiEquivalent) => setUsageDashboardPrefs({ showApiEquivalent })}
          />
          <Checkbox
            checked={prefs.dashboard.showValueMultiplier}
            label="Show subscription value multiplier"
            onChange={(showValueMultiplier) => setUsageDashboardPrefs({ showValueMultiplier })}
          />
          <Checkbox
            checked={prefs.dashboard.showQuotaDetails}
            label="Show quota windows on cards"
            onChange={(showQuotaDetails) => setUsageDashboardPrefs({ showQuotaDetails })}
          />
        </div>
        <div className="usage-settings-provider-visibility">
          {data.providers.map((provider) => (
            <Checkbox
              key={provider.id}
              checked={!prefs.hiddenProviders.includes(provider.id)}
              label={provider.label}
              onChange={(visible) => setProviderHidden(provider.id, !visible)}
            />
          ))}
        </div>
      </section>

      <section className="usage-settings-section" data-settings-item="usage.costs">
        <div className="usage-settings-heading">
          <h3>Costs & budgets</h3>
          <p>Recorded API cost stays telemetry. Subscription price and API budget are display metadata only.</p>
        </div>
        <div className="usage-settings-provider-list">
          {data.providers.map((provider) => {
            const profile = prefs.providerCosts[provider.id] ?? {
              billing: "api" as const,
              monthlyCost: null,
              monthlyBudget: null,
            };
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
                    <span>{money(provider.monthCost)} recorded this month</span>
                  </div>
                </div>
                <div className="usage-settings-provider-controls">
                  <Select
                    label={`${provider.label} billing type`}
                    ariaLabel={`${provider.label} billing type`}
                    value={profile.billing}
                    options={[
                      { value: "api", label: "API" },
                      { value: "subscription", label: "Subscription" },
                    ]}
                    onChange={(billing) => setProviderCostProfile(provider.id, {
                      billing: billing === "subscription" ? "subscription" : "api",
                    })}
                  />
                  <label className="usage-settings-price">
                    <span>{profile.billing === "subscription" ? "Monthly price" : "Monthly budget"}</span>
                    <span className="usage-settings-money-input">
                      <span aria-hidden="true">$</span>
                      <TextInput
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        defaultValue={profile.billing === "subscription"
                          ? profile.monthlyCost ?? ""
                          : profile.monthlyBudget ?? ""}
                        aria-label={`${provider.label} ${profile.billing === "subscription" ? "monthly price" : "monthly budget"}`}
                        placeholder="0.00"
                        onBlur={(event) => {
                          const raw = event.currentTarget.value.trim();
                          const value = raw === "" ? null : Number(raw);
                          setProviderCostProfile(provider.id, profile.billing === "subscription"
                            ? { monthlyCost: value }
                            : { monthlyBudget: value });
                        }}
                      />
                    </span>
                  </label>
                  <span className="usage-settings-provider-plan">
                    {profile.billing === "subscription"
                      ? profile.monthlyCost === null ? "Price not set" : `${money(profile.monthlyCost)} / month`
                      : profile.monthlyBudget === null ? "No budget" : `${money(profile.monthlyBudget)} budget`}
                  </span>
                </div>
              </div>
            );
          })}
          {data.providers.length === 0 && (
            <p className="usage-settings-empty">Providers appear after Polyth sees session usage or a quota feed.</p>
          )}
        </div>
      </section>
    </div>
  );
}
