import { useState, type ReactNode } from "react";
import { Button } from "../../../../apps/web/src/components/ui/index.ts";
import { EmptyState, NumberField, PageHead, Row, Section, Seg, Toggle } from "../../../../apps/web/src/components/settings/parts.tsx";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { sourceProblem } from "./alertsModel.ts";
import { limitSourceName, orderLimitSources } from "./limitsModel.ts";
import { useUsageLimits, type UsageLimitSnapshotDto } from "./limitsClient.ts";
import { UsageAlertsSections } from "./UsageAlertsSettings.tsx";
import {
  LIMIT_BAR_COLORS,
  isLimitSourceVisible,
  setLimitSourceVisible,
  updateUsageLimitsPrefs,
  useUsageLimitsPrefs,
  type LimitBarColor,
  type LimitBarFactor,
} from "./limitsPrefs.ts";

const formatUpdatedAt = (at: number): string => new Intl.DateTimeFormat(getLocale(), {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
}).format(at);

const plural = (count: number, one: Parameters<typeof tr>[0], many: Parameters<typeof tr>[0]) =>
  tr(new Intl.PluralRules(getLocale()).select(count) === "one" ? one : many, { count });

type SourceStatus = { tone: "ok" | "warn" | "error" | "idle"; label: string; fix?: string };

function sourceStatus(provider: UsageLimitSnapshotDto): SourceStatus {
  const error = provider.error;
  if (error?.code === "login-renewing") {
    return { tone: "idle", label: tr("usage.setStatusRenewing"), fix: tr("usage.setStatusRenewingFix") };
  }
  if (error && !["never-fetched", "not-refreshed"].includes(error.code)) {
    // Same reading as the source-problem notification, so the two never disagree.
    const problem = sourceProblem(provider);
    if (problem === "key") {
      return { tone: "warn", label: tr("usage.setStatusKey"), fix: tr("usage.setStatusKeyFix") };
    }
    return problem === "sign-in"
      ? { tone: "warn", label: tr("usage.setStatusSignIn"), fix: tr("usage.setStatusSignInFix") }
      : { tone: "error", label: tr("usage.setStatusError"), fix: tr("usage.setStatusErrorFix") };
  }
  if (!(provider.fetchedAt > 0)) return { tone: "idle", label: tr("usage.setStatusNotChecked") };
  if (provider.stale) return { tone: "idle", label: tr("usage.setStatusOutOfDate") };
  return { tone: "ok", label: tr("usage.setStatusUpToDate") };
}

function sourceSummary(provider: UsageLimitSnapshotDto): string {
  const parts = [
    provider.accountLabel && provider.accountLabel !== limitSourceName(provider) ? provider.accountLabel : "",
    plural(provider.windows.length, "usage.setLimitsCountOne", "usage.setLimitsCountOther"),
    provider.balances.length ? plural(provider.balances.length, "usage.setBalancesCountOne", "usage.setBalancesCountOther") : "",
    provider.fetchedAt > 0 ? tr("usage.setUpdatedAt", { time: formatUpdatedAt(provider.fetchedAt) }) : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

const barFactorLabel = (factor: LimitBarFactor): string =>
  tr(factor === "percent" ? "usage.setFactorPercent" : factor === "pace" ? "usage.setFactorPace" : "usage.setFactorStatic");

const barColorLabel = (color: LimitBarColor): string => tr(({
  accent: "usage.setColourAccent",
  green: "usage.setColourGreen",
  amber: "usage.setColourAmber",
  red: "usage.setColourRed",
  blue: "usage.setColourBlue",
  purple: "usage.setColourPurple",
  neutral: "usage.setColourNeutral",
} as const)[color]);

export function UsageLimitsSettings(): ReactNode {
  const prefs = useUsageLimitsPrefs();
  const limits = useUsageLimits();
  const [refreshingSource, setRefreshingSource] = useState<string | null>(null);

  const refreshSource = async (providerId: string) => {
    setRefreshingSource(providerId);
    try {
      await limits.refreshProvider(providerId);
    } finally {
      setRefreshingSource(null);
    }
  };

  return (
    <div className="usage-limits-settings">
      <PageHead title={tr("usage.name")} blurb={tr("usage.setPageBlurb")} />

      <Section title={tr("usage.setDisplay")} itemId="usage.limits.display">
        <Row label={tr("usage.limitValues")} hint={tr("usage.setLimitValuesHint")}>
          <Seg
            label={tr("usage.limitValues")}
            value={prefs.displayMode}
            onChange={(displayMode) => updateUsageLimitsPrefs({ displayMode })}
            options={[["remaining", tr("usage.setRemaining")], ["used", tr("usage.setUsed")]]}
          />
        </Row>
        <Row label={tr("usage.setResetTime")} hint={tr("usage.setResetTimeHint")}>
          <Seg
            label={tr("usage.setResetTime")}
            value={prefs.resetFormat}
            onChange={(resetFormat) => updateUsageLimitsPrefs({ resetFormat })}
            options={[["relative", tr("usage.setRelative")], ["exact", tr("usage.setExact")], ["both", tr("usage.setBoth")]]}
          />
        </Row>
      </Section>

      <Section title={tr("usage.limitBarColour")} hint={tr("usage.setBarColourHint")} itemId="usage.limits.barColour">
        <Row label={tr("usage.setColourBy")} hint={tr("usage.setColourByHint")}>
          <Seg
            label={tr("usage.setBarColourSource")}
            value={prefs.barFactor}
            onChange={(barFactor) => updateUsageLimitsPrefs({ barFactor })}
            options={(["percent", "pace", "static"] as LimitBarFactor[]).map((value) => [value, barFactorLabel(value)])}
          />
        </Row>
        {prefs.barFactor === "static" ? (
          <Row label={tr("usage.limitBarColour")} hint={tr("usage.setBarColourStaticHint", { option: tr("usage.setFactorStatic") })}>
            <Seg
              label={tr("usage.limitBarColour")}
              value={prefs.barColor}
              onChange={(barColor) => updateUsageLimitsPrefs({ barColor })}
              options={LIMIT_BAR_COLORS.map((value) => [value, barColorLabel(value)] as [LimitBarColor, string])}
            />
          </Row>
        ) : null}
        {prefs.barFactor === "percent" ? (
          <Row label={tr("usage.setFullAlertAt")} hint={tr("usage.setFullAlertAtHint")}>
            <NumberField
              label={tr("usage.setCriticalThreshold")}
              unit="%"
              min={0}
              max={prefs.lowRemainingPercent}
              value={prefs.criticalRemainingPercent}
              onCommit={(criticalRemainingPercent) => updateUsageLimitsPrefs({ criticalRemainingPercent })}
            />
          </Row>
        ) : null}
      </Section>

      <Section title={tr("usage.setPace")} itemId="usage.limits.pace">
        <Row label={tr("usage.setShowPace")} hint={tr("usage.setShowPaceHint")}>
          <Toggle on={prefs.showPace} onChange={(showPace) => updateUsageLimitsPrefs({ showPace })} label={tr("usage.setShowPace")} />
        </Row>
        <Row label={tr("usage.setShowProjections")} disabled={!prefs.showPace} hint={prefs.showPace ? tr("usage.setShowProjectionsHint") : tr("usage.setShowProjectionsOff")}>
          <Toggle
            on={prefs.showProjections}
            disabled={!prefs.showPace}
            onChange={(showProjections) => updateUsageLimitsPrefs({ showProjections })}
            label={tr("usage.setShowProjections")}
          />
        </Row>
        <Row label={tr("usage.setPaceSensitivity")} hint={tr("usage.setPaceSensitivityHint")}>
          <Seg
            label={tr("usage.setPaceSensitivity")}
            value={prefs.paceSensitivity}
            onChange={(paceSensitivity) => updateUsageLimitsPrefs({ paceSensitivity })}
            options={[["stable", tr("usage.setStable")], ["balanced", tr("usage.setBalanced")], ["responsive", tr("usage.setResponsive")]]}
          />
        </Row>
      </Section>

      <Section title={tr("usage.setHighlights")} hint={tr("usage.setHighlightsHint")} itemId="usage.limits.warnings">
        <Row label={tr("usage.setLowRemaining")} hint={tr("usage.setLowRemainingHint")}>
          <NumberField
            label={tr("usage.setLowThreshold")}
            unit="%"
            min={1}
            max={50}
            value={prefs.lowRemainingPercent}
            onCommit={(lowRemainingPercent) => updateUsageLimitsPrefs({ lowRemainingPercent })}
          />
        </Row>
        <Row label={tr("usage.setPaceRisk")} hint={tr("usage.setPaceRiskHint")}>
          <Toggle on={prefs.paceWarnings} onChange={(paceWarnings) => updateUsageLimitsPrefs({ paceWarnings })} label={tr("usage.setPaceRisk")} />
        </Row>
      </Section>

      <UsageAlertsSections providers={limits.providers} />

      <Section
        title={tr("usage.limitsSummarySources")}
        hint={tr("usage.setSourcesHint")}
        itemId="usage.limits.sources"
        action={(
          <Button size="sm" variant="quiet" busy={limits.refreshing} onClick={limits.refresh}>
            {tr("usage.limitRefreshAll")}
          </Button>
        )}
      >
        {limits.error ? <div className="usage-limit-source-error" role="status">{limits.error}</div> : null}

        <div className="usage-limits-source-settings">
          {orderLimitSources(limits.providers, prefs.sourceOrder).map((provider) => {
            const visible = isLimitSourceVisible(provider.providerId, prefs);
            const name = limitSourceName(provider);
            const status = sourceStatus(provider);
            return (
              <div className="usage-limits-source-row" key={provider.providerId}>
                <div className="usage-limits-source-text">
                  <div className="usage-limits-source-title">
                    <strong>{name}</strong>
                    <span className={`usage-limits-status usage-limits-status--${status.tone}`}>{status.label}</span>
                  </div>
                  <p>{sourceSummary(provider)}</p>
                  {provider.error && status.fix ? (
                    <p className="usage-limits-source-problem">
                      {provider.error.message.replace(/[.\s]+$/, "")}. {status.fix}
                    </p>
                  ) : null}
                </div>
                <div className="usage-limits-source-actions">
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={refreshingSource === provider.providerId}
                    aria-label={tr("usage.setRefreshSource", { name })}
                    onClick={() => void refreshSource(provider.providerId)}
                  >
                    {tr("usage.limitRefresh")}
                  </Button>
                  <Toggle
                    on={visible}
                    onChange={(next) => setLimitSourceVisible(provider.providerId, next)}
                    label={tr("usage.setShowSource", { name })}
                  />
                </div>
              </div>
            );
          })}
          {!limits.loading && limits.providers.length === 0 ? (
            <EmptyState compact icon="usage" title={tr("usage.setNoSources")} body={tr("usage.setNoSourcesBody")} />
          ) : null}
        </div>
      </Section>
    </div>
  );
}

export default UsageLimitsSettings;
