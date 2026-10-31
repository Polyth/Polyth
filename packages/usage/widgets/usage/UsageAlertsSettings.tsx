import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  BellIcon,
  BlockedIcon,
  Button,
  ChartIcon,
  GaugeIcon,
  Icon,
  IconButton,
  KeyIcon,
  RefreshIcon,
  Switch,
  TimerIcon,
  WarningIcon,
  type LucideIcon,
} from "../../../../apps/web/src/components/ui/index.ts";
import { CheckGroup, ItemList, ItemRow, NumberField, ResetLink, Row, Section, Seg, Toggle } from "../../../../apps/web/src/components/settings/parts.tsx";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import {
  alertsPaused,
  LOW_ALERT_LEVELS,
  resetUsageAlertPrefs,
  isAlertSourceMuted,
  updateUsageAlertPrefs,
  usageAlertPrefsAreDefault,
  useUsageAlertPrefs,
  type AlertDuration,
  type AlertPaceLevel,
  type CacheLeadMinutes,
  type TurnSummaryPart,
  type TurnSummaryScope,
  type UsageAlertPrefs,
} from "./alertsPrefs.ts";
import {
  subscribeUsageAlertsController,
  usageAlertsController,
  type UsageAlertPreviewRule,
} from "./alertsController.ts";
import { limitSourceName, orderLimitSources } from "./limitsModel.ts";
import type { UsageLimitSnapshotDto } from "./limitsClient.ts";
import { isLimitSourceVisible, sourceId, useUsageLimitsPrefs } from "./limitsPrefs.ts";

type RuleKey = "pace" | "low" | "exhausted" | "restored" | "sourceProblems" | "turn" | "cache";

interface RuleView {
  key: RuleKey;
  preview: UsageAlertPreviewRule;
  icon: LucideIcon;
  /** Tone of the tile glyph while the rule is on. */
  tone: "amber" | "red" | "green" | "accent" | "teal";
  title: string;
  description: string;
  options?: ReactNode;
}

const list = (items: readonly string[]): string => {
  try {
    return new Intl.ListFormat(getLocale(), { style: "long", type: "disjunction" }).format(items);
  } catch {
    return items.join(" or ");
  }
};

const andList = (items: readonly string[]): string => {
  try {
    return new Intl.ListFormat(getLocale(), { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(" and ");
  }
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const clock = (at: number): string => {
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(getLocale(), sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
};

/** The next local 8:00, at least an hour away. */
const tomorrowMorning = (now: number): number => {
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() - now < 3_600_000) next.setDate(next.getDate() + 1);
  return next.getTime();
};

const partLabel = (part: TurnSummaryPart): string =>
  tr(part === "tokens" ? "usage.alPartTokensLc" : part === "cost" ? "usage.alPartCostLc" : "usage.alPartLimitsLc");

function summaryDescription(prefs: UsageAlertPrefs): string {
  const parts = prefs.turnParts.map(partLabel);
  if (!parts.length) return tr("usage.alSummaryNothing");
  const what = capitalize(andList(parts));
  const all = prefs.turnScope === "all";
  if (prefs.turnMinTokens <= 0) return tr(all ? "usage.alSummaryAll" : "usage.alSummaryActive", { what });
  return tr(all ? "usage.alSummaryAllSize" : "usage.alSummaryActiveSize", { what, size: Math.round(prefs.turnMinTokens / 1000) });
}

function enabledCount(prefs: UsageAlertPrefs): number {
  return (["pace", "low", "exhausted", "restored", "sourceProblems", "turn", "cache"] as const)
    .filter((key) => prefs[key]).length;
}

function usePreview(): ((rule: UsageAlertPreviewRule) => void) | null {
  const controller = useSyncExternalStore(subscribeUsageAlertsController, usageAlertsController, usageAlertsController);
  return controller ? controller.preview : null;
}

/** Re-render when a pause ends so the status line stops saying "Paused". */
function usePauseClock(pausedUntil: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = pausedUntil - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [pausedUntil]);
  return now;
}

function RuleList({ label, rules, prefs, preview, off }: {
  label: string;
  rules: readonly RuleView[];
  prefs: UsageAlertPrefs;
  preview: ((rule: UsageAlertPreviewRule) => void) | null;
  /** The master switch is off: rules keep their state but read as inactive. */
  off: boolean;
}) {
  return (
    <ItemList label={label} className="usage-alert-rules">
      {rules.map((rule) => {
        const on = prefs[rule.key];
        return (
          <Fragment key={rule.key}>
            <ItemRow
              className={`usage-alert-rule usage-alert-rule--${rule.tone}${on && !off ? " is-on" : ""}`}
              data-usage-alert-rule={rule.key}
              icon={<Icon icon={rule.icon} size="md" />}
              title={rule.title}
              description={rule.description}
              inactive={!on || off}
              trailing={(
                <>
                  {preview ? (
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={BellIcon}
                      label={tr("usage.alPreview", { title: rule.title })}
                      onClick={() => preview(rule.preview)}
                    />
                  ) : null}
                  <Switch
                    checked={on}
                    disabled={off}
                    label={rule.title}
                    onChange={(next) => updateUsageAlertPrefs({ [rule.key]: next } as Partial<UsageAlertPrefs>)}
                  />
                </>
              )}
            />
            {on && !off && rule.options ? (
              <div className="usage-alert-options" role="listitem" aria-label={tr("usage.alOptionsAria", { title: rule.title })}>
                {rule.options}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </ItemList>
  );
}

export function UsageAlertsSections({ providers }: { providers: readonly UsageLimitSnapshotDto[] }): ReactNode {
  const prefs = useUsageAlertPrefs();
  const limitsPrefs = useUsageLimitsPrefs();
  const preview = usePreview();
  const now = usePauseClock(prefs.pausedUntil);
  const paused = alertsPaused(prefs, now);
  const off = !prefs.enabled;
  const sources = orderLimitSources(providers)
    .filter((provider) => isLimitSourceVisible(provider.providerId, limitsPrefs) && provider.windows.some((window) => window.limit > 0));
  const watched = sources.filter((provider) => !isAlertSourceMuted(provider.providerId, prefs)).map((provider) => provider.providerId);
  const count = enabledCount(prefs);

  const status = off
    ? tr("usage.alStatusOff")
    : paused
      ? tr("usage.alStatusPaused", { time: clock(prefs.pausedUntil) })
      : tr("usage.alStatusCount", { count, total: 7 });

  const limitRules: RuleView[] = [
    {
      key: "pace",
      preview: "pace",
      icon: GaugeIcon,
      tone: "amber",
      title: tr("usage.alPaceTitle"),
      description: prefs.paceLevel === "likely"
        ? tr("usage.alPaceDescLikely")
        : tr("usage.alPaceDescElevated"),
      options: (
        <Row label={tr("usage.alAlertWhen")} hint={tr("usage.alPaceHint")}>
          <Seg<AlertPaceLevel>
            label={tr("usage.alAlertWhen")}
            value={prefs.paceLevel}
            onChange={(paceLevel) => updateUsageAlertPrefs({ paceLevel })}
            options={[["elevated", tr("usage.alAbovePace")], ["likely", tr("usage.alLikelyRunOut")]]}
          />
        </Row>
      ),
    },
    {
      key: "low",
      preview: "low",
      icon: WarningIcon,
      tone: "amber",
      title: tr("usage.alLowTitle"),
      description: prefs.lowLevels.length
        ? tr("usage.alLowDesc", { levels: list(prefs.lowLevels.map((level) => `${level}%`)) })
        : tr("usage.alLowNone"),
      options: (
        <Row label={tr("usage.alLevels")} hint={tr("usage.alLevelsHint")}>
          <span className="usage-alert-checks"><CheckGroup<string>
            label={tr("usage.alLevels")}
            columns={3}
            value={prefs.lowLevels.map(String)}
            options={LOW_ALERT_LEVELS.map((level) => ({ id: String(level), label: `${level}%` }))}
            onChange={(next) => updateUsageAlertPrefs({ lowLevels: next.map(Number) })}
          /></span>
        </Row>
      ),
    },
    {
      key: "exhausted",
      preview: "exhausted",
      icon: BlockedIcon,
      tone: "red",
      title: tr("usage.alExhaustedTitle"),
      description: tr("usage.alExhaustedDesc"),
    },
    {
      key: "restored",
      preview: "restored",
      icon: RefreshIcon,
      tone: "green",
      title: tr("usage.alRestoredTitle"),
      description: tr("usage.alRestoredDesc"),
    },
    {
      key: "sourceProblems",
      preview: "source",
      icon: KeyIcon,
      tone: "amber",
      title: tr("usage.alSignInTitle"),
      description: tr("usage.alSignInDesc"),
    },
  ];

  const turnRules: RuleView[] = [
    {
      key: "turn",
      preview: "summary",
      icon: ChartIcon,
      tone: "accent",
      title: tr("usage.alTurnTitle"),
      description: summaryDescription(prefs),
      options: (
        <>
          <Row label={tr("usage.alChats")} hint={prefs.turnScope === "all" ? tr("usage.alChatsHintAll") : tr("usage.alChatsHintActive")}>
            <Seg<TurnSummaryScope>
              label={tr("usage.alChats")}
              value={prefs.turnScope}
              onChange={(turnScope) => updateUsageAlertPrefs({ turnScope })}
              options={[["active", tr("usage.alThisChat")], ["all", tr("usage.alAllChats")]]}
            />
          </Row>
          <Row label={tr("usage.alShow")} hint={tr("usage.alShowHint")}>
            <span className="usage-alert-checks"><CheckGroup<TurnSummaryPart>
              label={tr("usage.alShow")}
              columns={3}
              value={prefs.turnParts}
              options={[
                { id: "tokens", label: tr("usage.alPartTokens") },
                { id: "cost", label: tr("usage.alPartCost") },
                { id: "limits", label: tr("usage.alPartLimits") },
              ]}
              onChange={(turnParts) => updateUsageAlertPrefs({ turnParts })}
            /></span>
          </Row>
          <Row label={tr("usage.alSkipSmall")} hint={tr("usage.alSkipSmallHint")}>
            <NumberField
              label={tr("usage.alSkipTurnsUnder")}
              unit={tr("usage.alKTokens")}
              min={0}
              max={10_000}
              value={Math.round(prefs.turnMinTokens / 1000)}
              onCommit={(value) => updateUsageAlertPrefs({ turnMinTokens: value * 1000 })}
            />
          </Row>
          <Row label={tr("usage.alOnScreen")} hint={tr("usage.alOnScreenHint")}>
            <Seg<AlertDuration>
              label={tr("usage.alOnScreen")}
              value={prefs.turnDuration}
              onChange={(turnDuration) => updateUsageAlertPrefs({ turnDuration })}
              options={[["brief", tr("usage.alSeconds", { seconds: 4 })], ["normal", tr("usage.alSeconds", { seconds: 8 })], ["long", tr("usage.alSeconds", { seconds: 15 })]]}
            />
          </Row>
        </>
      ),
    },
    {
      key: "cache",
      preview: "cache",
      icon: TimerIcon,
      tone: "teal",
      title: tr("usage.alCacheTitle"),
      description: tr("usage.alCacheDesc", { minutes: prefs.cacheLeadMinutes }),
      options: (
        <Row label={tr("usage.alWarnBefore")} hint={tr("usage.alWarnBeforeHint")}>
          <Seg<CacheLeadMinutes>
            label={tr("usage.alWarnBefore")}
            value={prefs.cacheLeadMinutes}
            onChange={(cacheLeadMinutes) => updateUsageAlertPrefs({ cacheLeadMinutes })}
            options={[[1, tr("usage.alMinutes", { minutes: 1 })], [2, tr("usage.alMinutes", { minutes: 2 })], [5, tr("usage.alMinutes", { minutes: 5 })]]}
          />
        </Row>
      ),
    },
  ];

  return (
    <>
      <Section
        title={tr("usage.alNotifications")}
        hint={tr("usage.alNotificationsHint")}
        itemId="usage.alerts"
        action={<ResetLink disabled={usageAlertPrefsAreDefault(prefs)} onClick={resetUsageAlertPrefs} />}
      >
        <Row label={tr("usage.alerts")} hint={status}>
          <Toggle on={prefs.enabled} onChange={(enabled) => updateUsageAlertPrefs({ enabled })} label={tr("usage.alerts")} />
        </Row>
        <Row
          label={tr("usage.alPause")}
          disabled={off}
          hint={paused ? tr("usage.alPauseHintOn") : tr("usage.alPauseHintOff")}
        >
          {paused ? (
            <Button size="sm" variant="quiet" disabled={off} onClick={() => updateUsageAlertPrefs({ pausedUntil: 0 })}>
              {tr("usage.alResumeNow")}
            </Button>
          ) : (
            <span className="usage-alert-pause">
              <Button size="sm" variant="quiet" disabled={off} onClick={() => updateUsageAlertPrefs({ pausedUntil: Date.now() + 3_600_000 })}>
                {tr("usage.alOneHour")}
              </Button>
              <Button size="sm" variant="quiet" disabled={off} onClick={() => updateUsageAlertPrefs({ pausedUntil: tomorrowMorning(Date.now()) })}>
                {tr("usage.alUntil", { time: clock(tomorrowMorning(now)) })}
              </Button>
            </span>
          )}
        </Row>
        <Row label={tr("usage.alKeepOnScreen")} disabled={off} hint={tr("usage.alKeepOnScreenHint")}>
          <Toggle on={prefs.keepOnScreen} disabled={off} onChange={(keepOnScreen) => updateUsageAlertPrefs({ keepOnScreen })} label={tr("usage.alKeepOnScreen")} />
        </Row>
      </Section>

      <Section title={tr("usage.limitAlerts")} hint={tr("usage.alLimitAlertsHint")} itemId="usage.alerts.limits">
        <RuleList label={tr("usage.limitAlerts")} rules={limitRules} prefs={prefs} preview={off ? null : preview} off={off} />
        {sources.length > 1 ? (
          <Row label={tr("usage.alWatchSources")} layout="stacked" disabled={off} hint={tr("usage.alWatchSourcesHint")}>
            <span className="usage-alert-checks is-start"><CheckGroup<string>
              label={tr("usage.alWatchSources")}
              columns={2}
              disabled={off}
              value={watched}
              options={sources.map((provider) => ({ id: provider.providerId, label: limitSourceName(provider) }))}
              onChange={(next) => {
                // Sources not listed here (hidden, or not reporting now) keep their choice.
                const listed = new Set(sources.map((provider) => sourceId(provider.providerId)));
                const kept = prefs.mutedSources.filter((id) => !listed.has(id));
                const muted = sources.filter((provider) => !next.includes(provider.providerId)).map((provider) => provider.providerId);
                updateUsageAlertPrefs({ mutedSources: [...kept, ...muted] });
              }}
            /></span>
          </Row>
        ) : null}
      </Section>

      <Section title={tr("usage.turnAlerts")} hint={tr("usage.alTurnsHint")} itemId="usage.alerts.turns">
        <RuleList label={tr("usage.turnAlerts")} rules={turnRules} prefs={prefs} preview={off ? null : preview} off={off} />
      </Section>
    </>
  );
}
