// Delegation shortlist: the account's favorites plus its most-used
// harness/model pairs, each annotated with live quota headroom. Pure — the
// server entry supplies observations, quota snapshots, favorites, the live
// model catalog and the harness roster. Output is sized for an agent's
// context, not a dashboard.
import type { ModelDescriptor } from "@polyth/contracts";
import { friendlyModelId } from "@polyth/contracts/model-presentation";
import type {
  ServerModelRoutingCandidate,
  ServerModelRoutingQuota,
  ServerModelRoutingReport,
} from "@polyth/plugins";
import type { UsageObservation } from "./analytics/contracts.ts";
import type { UsageLimitSnapshot } from "./limits.ts";
import { currentLimitSources, sourceFamily, windowAppliesToModel, type LimitSourceRef } from "./limitSources.ts";
import { canonicalHarnessId, canonicalProviderId, isPlaceholderProviderId } from "./providerIdentity.ts";

export const DEFAULT_ROUTING_LIMIT = 12;
export const MAX_ROUTING_LIMIT = 50;
export const DEFAULT_ROUTING_WINDOW_DAYS = 30;
/** Oldest server catalog copy a shortlist may be built from. Harness-level
 *  discovery TTLs still apply beneath it. */
export const ROUTING_CATALOG_MAX_AGE_MS = 60_000;

export interface ModelRoutingInput {
  observations: readonly UsageObservation[];
  snapshots: readonly UsageLimitSnapshot[];
  /** `harness::provider/model` keys in the user's order. */
  favorites: readonly string[];
  /** The live native catalog across harnesses. Every pair is named as the row
   *  a spawn must select: telemetry reports what ran (`claude-opus-5-5`),
   *  which can be an alias row's resolution (`opus`) rather than a row, and
   *  harnesses retire models. A harness without rows here (catalog
   *  unreadable or absent) passes its pairs through unverified. */
  catalog?: readonly ModelDescriptor[];
  available: (harnessId: string) => boolean;
  now: number;
  windowDays?: number;
  limit?: number;
  /** Restrict to one harness; quotas then cover only its candidates. */
  harnessId?: string;
  /** Rank exactly these `harness::provider/model` keys, whether or not they
   *  were used (a caller's own allow-list); pairs the live catalog no longer
   *  offers are left out like any other. */
  pairs?: readonly string[];
}

/** `harness::provider/model`; the model id itself may contain `/`. */
export function parseFavoriteKey(key: string): { harnessId: string; providerID: string; modelID: string } | undefined {
  const split = key.indexOf("::");
  const harnessId = split > 0 ? key.slice(0, split) : "opencode";
  const rest = split > 0 ? key.slice(split + 2) : key;
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { harnessId: canonicalHarnessId(harnessId), providerID: rest.slice(0, slash), modelID: rest.slice(slash + 1) };
}

/** The Limits widget's own rules (`limitSources.ts`) decide which sources and
 *  windows meter a pair, so the shortlist and the widget never disagree. One
 *  refinement: Antigravity meters Google and third-party models in separate
 *  `google-*` / `third-party-*` windows. The widget shows both; a routing
 *  decision must not call a Gemini model blocked by the third-party window. */
const windowApplies = (source: LimitSourceRef, windowId: string, modelID: string): boolean => {
  if (!windowAppliesToModel(windowId, modelID)) return false;
  if (sourceFamily(source) !== "antigravity") return true;
  const google = /gemini|gemma|google/i.test(modelID);
  if (/^google[-_]/i.test(windowId)) return google;
  if (/^third[-_]party[-_]/i.test(windowId)) return !google;
  return true;
};

/** Metered windows only: balances and zero-limit placeholders carry no headroom. */
const meteredWindows = (snapshot: UsageLimitSnapshot) =>
  snapshot.windows.filter((window) => window.limit > 0
    && !snapshot.balances.some((balance) => balance.id === window.id));

interface Pair {
  harnessId: string;
  providerID: string;
  modelID: string;
}

interface Tally extends Pair {
  turns: number;
  failed: number;
  sessions: Set<string>;
  lastUsedAt: number;
  /** False when the harness's catalog could not confirm the pair. */
  listed: boolean;
  /** What an alias row runs now (`Claude Opus 5.5` for `opus`). */
  runs?: string;
  /** Ids a `<model>/<period>` quota window may name: the row and what it runs. */
  quotaModel: string;
}

const pairKey = (harnessId: string, providerID: string, modelID: string): string =>
  `${harnessId}\u0000${providerID}\u0000${modelID}`;

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** An alias that names part of what it runs (`opus` for `claude-opus-5-5`)
 *  says which model was meant; one that does not (`default`) only follows
 *  whatever the account default is today. */
const aliasNamesModel = (alias: string, concrete: string): boolean => {
  const have = new Set(words(concrete));
  const need = words(alias);
  return need.length > 0 && need.every((word) => have.has(word));
};

type Resolution =
  | { kind: "listed"; row: ModelDescriptor }
  | { kind: "unverified" }
  | { kind: "unlisted" };

/**
 * Name a pair the way its harness's live catalog does. The exact row wins;
 * then a row whose provider is only spelled differently (`claude-code` and
 * `anthropic`); then an alias row that resolves to the reported id; then the
 * row whose advertised variant the id spells out (`gemini-3.8-flash-high` for
 * `gemini-3.8-flash` with a `high` variant). A catalog that lists none of
 * these no longer offers the pair.
 */
const createCatalogResolver = (catalog: readonly ModelDescriptor[]) => {
  const byHarness = new Map<string, ModelDescriptor[]>();
  for (const row of catalog) {
    if (!row.harnessId) continue;
    const harnessId = canonicalHarnessId(row.harnessId);
    byHarness.set(harnessId, [...byHarness.get(harnessId) ?? [], row]);
  }
  const provider = (id: string): string => canonicalProviderId(id) || id.trim();
  return (pair: Pair, preferred: (row: ModelDescriptor) => number | undefined): Resolution => {
    const rows = byHarness.get(pair.harnessId);
    if (!rows?.length) return { kind: "unverified" };
    const sameProvider = (row: ModelDescriptor): boolean => provider(row.providerID) === provider(pair.providerID);
    const exact = rows.find((row) => row.providerID === pair.providerID && row.modelID === pair.modelID)
      ?? rows.find((row) => sameProvider(row) && row.modelID === pair.modelID);
    if (exact) return { kind: "listed", row: exact };
    const aliases = rows.filter((row) => sameProvider(row) && row.resolvedModelID === pair.modelID);
    if (!aliases.length) {
      const variant = rows.find((row) => sameProvider(row)
        && row.variants?.some((name) => pair.modelID === `${row.modelID}-${name}`));
      return variant ? { kind: "listed", row: variant } : { kind: "unlisted" };
    }
    // Several aliases can run the same model (`default` and `opus`): the
    // user's own star decides first, then the alias that names the model,
    // then catalog order.
    const starred = aliases
      .filter((row) => preferred(row) !== undefined)
      .sort((a, b) => preferred(a)! - preferred(b)!)[0];
    return {
      kind: "listed",
      row: starred ?? aliases.find((row) => aliasNamesModel(row.modelID, pair.modelID)) ?? aliases[0]!,
    };
  };
};

export function buildModelRouting(input: ModelRoutingInput): ServerModelRoutingReport {
  const report = rankModelRouting(input);
  return { ...report, text: formatModelRouting(report) };
}

function rankModelRouting(input: ModelRoutingInput): Omit<ServerModelRoutingReport, "text"> {
  const windowDays = Math.max(1, Math.min(365, Math.round(input.windowDays ?? DEFAULT_ROUTING_WINDOW_DAYS)));
  const limit = Math.max(1, Math.min(MAX_ROUTING_LIMIT, Math.round(input.limit ?? DEFAULT_ROUTING_LIMIT)));
  const from = input.now - windowDays * 86_400_000;
  const onlyHarness = input.harnessId ? canonicalHarnessId(input.harnessId) : undefined;

  // What telemetry reported, before naming it as a catalog row.
  const observed = new Map<string, Omit<Tally, "listed" | "runs" | "quotaModel">>();
  for (const observation of input.observations) {
    if (observation.timestamp < from || !observation.modelId) continue;
    const harnessId = canonicalHarnessId(observation.harnessId);
    if (harnessId === "unknown" || isPlaceholderProviderId(observation.providerId)) continue;
    if (onlyHarness && harnessId !== onlyHarness) continue;
    const providerID = observation.providerId!.trim();
    const key = pairKey(harnessId, providerID, observation.modelId);
    const tally = observed.get(key) ?? {
      harnessId, providerID, modelID: observation.modelId, turns: 0, failed: 0, sessions: new Set<string>(), lastUsedAt: 0,
    };
    tally.turns += 1;
    if (observation.status === "failed") tally.failed += 1;
    tally.sessions.add(observation.sessionId);
    tally.lastUsedAt = Math.max(tally.lastUsedAt, observation.timestamp);
    observed.set(key, tally);
  }

  const resolve = createCatalogResolver(input.catalog ?? []);
  const tallies = new Map<string, Tally>();
  const unlisted = new Set<string>();
  /** The tally a pair counts toward, keyed by the selection a spawn names. */
  const target = (pair: Pair, preferred: (row: ModelDescriptor) => number | undefined): [string, Tally] | undefined => {
    const resolution = resolve(pair, preferred);
    if (resolution.kind === "unlisted") {
      unlisted.add(pairKey(pair.harnessId, pair.providerID, pair.modelID));
      return undefined;
    }
    const selection: Pair = resolution.kind === "listed"
      ? { harnessId: pair.harnessId, providerID: resolution.row.providerID, modelID: resolution.row.modelID }
      : { harnessId: pair.harnessId, providerID: pair.providerID, modelID: pair.modelID };
    const key = pairKey(selection.harnessId, selection.providerID, selection.modelID);
    let tally = tallies.get(key);
    if (!tally) {
      const runs = resolution.kind === "listed" && resolution.row.resolvedModelID !== resolution.row.modelID
        ? resolution.row.resolvedModelID
        : undefined;
      tally = {
        ...selection, turns: 0, failed: 0, sessions: new Set(), lastUsedAt: 0,
        listed: resolution.kind === "listed",
        ...(runs ? { runs: friendlyModelId(runs) } : {}),
        quotaModel: runs ? `${selection.modelID} ${runs}` : selection.modelID,
      };
      tallies.set(key, tally);
    }
    return [key, tally];
  };

  const favoriteRank = new Map<string, number>();
  input.favorites.forEach((raw, index) => {
    const parsed = parseFavoriteKey(raw);
    if (!parsed || onlyHarness && parsed.harnessId !== onlyHarness) return;
    const resolved = target(parsed, () => undefined);
    if (resolved && !favoriteRank.has(resolved[0])) favoriteRank.set(resolved[0], index);
  });
  const starred = (harnessId: string) => (row: ModelDescriptor): number | undefined =>
    favoriteRank.get(pairKey(harnessId, row.providerID, row.modelID));
  for (const pair of observed.values()) {
    const resolved = target(pair, starred(pair.harnessId));
    if (!resolved) continue;
    const tally = resolved[1];
    tally.turns += pair.turns;
    tally.failed += pair.failed;
    for (const sessionId of pair.sessions) tally.sessions.add(sessionId);
    tally.lastUsedAt = Math.max(tally.lastUsedAt, pair.lastUsedAt);
  }

  // An explicit allow-list replaces the usage shortlist: unused pairs are
  // ranked too, and nothing outside the list is.
  let only: Set<string> | undefined;
  if (input.pairs) {
    only = new Set();
    for (const raw of input.pairs) {
      const parsed = parseFavoriteKey(raw);
      if (!parsed || onlyHarness && parsed.harnessId !== onlyHarness) continue;
      const resolved = target(parsed, starred(parsed.harnessId));
      if (resolved) only.add(resolved[0]);
    }
  }

  const snapshots = input.snapshots;
  const sourcesOf = (pair: { harnessId: string; providerID: string; modelID: string }): Set<string> =>
    new Set(currentLimitSources(
      { resolvedHarnessId: pair.harnessId, model: { providerID: pair.providerID, modelID: pair.modelID } },
      snapshots,
    ));

  const sourcesByPair = new Map<string, Set<string>>();
  const candidates: ServerModelRoutingCandidate[] = [...tallies.entries()].filter(([key]) => !only || only.has(key)).map(([key, tally]) => {
    let quotaUsed: number | undefined;
    let blockedUntil: number | undefined;
    let blocked = false;
    const sources = sourcesOf(tally);
    sourcesByPair.set(key, sources);
    for (const snapshot of snapshots) {
      if (!sources.has(snapshot.providerId)) continue;
      for (const window of meteredWindows(snapshot)) {
        if (!windowApplies(snapshot, window.id, tally.quotaModel)) continue;
        // A window whose reset already passed no longer constrains anything.
        if (window.resetsAt !== undefined && window.resetsAt <= input.now) continue;
        const used = Math.min(1, window.used / window.limit);
        quotaUsed = Math.max(quotaUsed ?? 0, used);
        if (used >= 1) {
          blocked = true;
          if (window.resetsAt !== undefined) blockedUntil = Math.max(blockedUntil ?? 0, window.resetsAt);
        }
      }
    }
    const available = input.available(tally.harnessId);
    return {
      harnessId: tally.harnessId,
      providerID: tally.providerID,
      modelID: tally.modelID,
      ...(tally.runs ? { runs: tally.runs } : {}),
      listed: tally.listed,
      favorite: favoriteRank.has(key),
      turns: tally.turns,
      sessions: tally.sessions.size,
      failed: tally.failed,
      ...(tally.lastUsedAt ? { lastUsedAt: tally.lastUsedAt } : {}),
      available,
      ...(quotaUsed !== undefined ? { quotaUsed } : {}),
      ...(blockedUntil !== undefined ? { blockedUntil } : {}),
      blocked,
    };
  });

  // Usable before unusable; then favorites in the user's order weighted by
  // real use, then everything else by use. A favorite nobody has run in the
  // window still outranks an unstarred model with a handful of turns.
  const usable = (candidate: ServerModelRoutingCandidate): number => candidate.available && !candidate.blocked ? 0 : 1;
  const rankKey = (candidate: ServerModelRoutingCandidate): string =>
    pairKey(candidate.harnessId, candidate.providerID, candidate.modelID);
  candidates.sort((a, b) =>
    usable(a) - usable(b)
    || Number(b.favorite) - Number(a.favorite)
    || b.turns - a.turns
    || (favoriteRank.get(rankKey(a)) ?? 0) - (favoriteRank.get(rankKey(b)) ?? 0)
    || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  const shown = candidates.slice(0, limit);
  const quotas: ServerModelRoutingQuota[] = snapshots
    .filter((snapshot) => shown.some((candidate) => sourcesByPair.get(rankKey(candidate))?.has(snapshot.providerId)))
    .map((snapshot) => ({
      sourceId: snapshot.providerId,
      // A plan or account name ("max", "Work") helps choose; an email
      // address or a repeat of the source id is noise in model context.
      ...(snapshot.accountLabel && !snapshot.accountLabel.includes("@")
        && snapshot.accountLabel.toLowerCase() !== snapshot.providerId.toLowerCase()
        ? { label: snapshot.accountLabel }
        : {}),
      windows: meteredWindows(snapshot).map((window) => {
        const pace = snapshot.pace[window.id]?.pace;
        return {
          id: window.id,
          label: window.label,
          used: Math.min(1, window.used / window.limit),
          ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
          ...(pace ? { pace } : {}),
        };
      }),
      stale: snapshot.stale,
      fetchedAt: snapshot.fetchedAt,
    }))
    .filter((quota) => quota.windows.length > 0);

  return {
    windowDays,
    generatedAt: input.now,
    candidates: shown,
    quotas,
    omitted: candidates.length - shown.length,
    unlisted: unlisted.size,
    ...(input.catalog?.length ? {} : { catalogUnavailable: true }),
  };
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 10) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** One line per candidate and per quota source — the agent-facing form. */
export function formatModelRouting(report: Omit<ServerModelRoutingReport, "text">): string {
  const naming = report.catalogUnavailable ? "" : "; models as each harness's live catalog names them";
  const lines = [
    `Delegation candidates (★=favorite, ${report.windowDays}d use, quota = fullest applicable window used${naming}). Spawn: agent.spawn harnessId=<harness> model={providerID,modelID}.`,
  ];
  if (report.catalogUnavailable && report.candidates.length) {
    lines.push("(no live model catalog could be read: model ids below are unverified)");
  }
  if (!report.candidates.length) lines.push("(no favorites or recent usage; agent.spawn without a model uses Polyth Auto)");
  report.candidates.forEach((candidate, index) => {
    const parts = [
      `${index + 1}. ${candidate.favorite ? "★ " : ""}${candidate.harnessId} ${candidate.providerID}/${candidate.modelID}${candidate.runs ? ` (${candidate.runs})` : ""}`,
      candidate.turns
        ? `${candidate.turns}t/${candidate.sessions}s${candidate.failed ? ` ${percent(candidate.failed / candidate.turns)} fail` : ""}${candidate.lastUsedAt ? ` last ${formatDuration(report.generatedAt - candidate.lastUsedAt)} ago` : ""}`
        : "unused",
      candidate.quotaUsed !== undefined ? `quota ${percent(candidate.quotaUsed)}` : "",
      !candidate.available ? "UNAVAILABLE: harness not running" : "",
      candidate.available && !candidate.listed && !report.catalogUnavailable ? "model unverified: no live catalog" : "",
      candidate.blocked
        ? `BLOCKED${candidate.blockedUntil ? ` ~${formatDuration(candidate.blockedUntil - report.generatedAt)}` : ""}`
        : "",
    ].filter(Boolean);
    lines.push(parts.join(" · "));
  });
  if (report.omitted > 0) lines.push(`(+${report.omitted} more; raise parameters.limit)`);
  if (report.unlisted > 0) {
    lines.push(`(${report.unlisted} used or starred model${report.unlisted === 1 ? " is" : "s are"} no longer offered by ${report.unlisted === 1 ? "its harness" : "their harnesses"}; left out)`);
  }
  if (report.quotas.length) {
    lines.push("Quotas:");
    for (const quota of report.quotas) {
      const windows = quota.windows.map((window) =>
        `${window.label.split(" · ")[0]} ${percent(window.used)}${window.resetsAt && window.resetsAt > report.generatedAt ? ` ↻${formatDuration(window.resetsAt - report.generatedAt)}` : ""}${window.pace === "over" ? " over-pace" : ""}`);
      lines.push(`- ${quota.sourceId}${quota.label ? ` (${quota.label})` : ""}: ${windows.join(", ")}${quota.stale ? " [stale]" : ""}`);
    }
  }
  return lines.join("\n");
}
