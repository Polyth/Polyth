// Resolve one model against the policy manifest. Pure: no storage, no DOM.
import { POLICY_MANIFEST, type PolicyManifest, type PolicySource, type PrivacyPolicy } from "./policies.ts";

export interface PrivacyTarget {
  providerID: string;
  modelID: string;
  cost?: { input: number; output: number };
}

export interface ResolvedPrivacy {
  policy: PrivacyPolicy;
  source: PolicySource;
  checkedAt: string;
  /** True when a zero-retention answer was withheld because the snapshot is old. */
  stale: boolean;
  retentionDays?: number;
  trialOnly?: boolean;
}

const DAY_MS = 86_400_000;

const isZeroCost = (model: PrivacyTarget): boolean =>
  model.cost !== undefined && model.cost.input === 0 && model.cost.output === 0;

const isPaid = (model: PrivacyTarget): boolean =>
  model.cost !== undefined && (model.cost.input > 0 || model.cost.output > 0);

/** `undefined` when the manifest has nothing to say (another provider, or a
 *  provider model whose price is unknown and is not listed). */
export function resolveModelPrivacy(
  model: PrivacyTarget,
  now: number = Date.now(),
  manifest: PolicyManifest = POLICY_MANIFEST,
): ResolvedPrivacy | undefined {
  const stale = now - Date.parse(manifest.checkedAt) > manifest.staleAfterDays * DAY_MS;
  const answer = (
    policy: PrivacyPolicy,
    sourceId: string,
    extra: { retentionDays?: number; trialOnly?: boolean } = {},
  ): ResolvedPrivacy | undefined => {
    const source = manifest.sources[sourceId];
    if (!source) return undefined;
    const withheld = stale && policy === "zero-retention";
    return {
      policy: withheld ? "unverified" : policy,
      source,
      checkedAt: manifest.checkedAt,
      stale: withheld,
      ...(extra.retentionDays !== undefined ? { retentionDays: extra.retentionDays } : {}),
      ...(extra.trialOnly ? { trialOnly: true } : {}),
    };
  };

  const entry = manifest.entries.find(
    (candidate) => candidate.providerID === model.providerID && candidate.modelID === model.modelID,
  );
  if (entry) {
    return answer(entry.policy, entry.source, {
      ...(entry.retentionDays !== undefined ? { retentionDays: entry.retentionDays } : {}),
      ...(entry.trialOnly ? { trialOnly: true } : {}),
    });
  }
  const rule = manifest.providers.find((candidate) => candidate.providerID === model.providerID);
  if (!rule) return undefined;
  if (rule.listed.includes(model.modelID)) return answer(rule.listedDefault, rule.source);
  if (isZeroCost(model)) return answer("unverified", rule.source);
  if (isPaid(model)) return answer(rule.paid, rule.source);
  return undefined;
}
