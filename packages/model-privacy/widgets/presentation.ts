// Policy → what the model lists and the composer draw.
import type { ModelAnnotation, ModelAnnotationIcon, ModelAnnotationTarget, ModelAnnotationTone } from "@polyth/models/model-annotations";
import type { PrivacyPolicy } from "../src/policies.ts";
import { resolveModelPrivacy, type ResolvedPrivacy } from "../src/resolvePolicy.ts";
import { createModelPrivacyCopy, fill, formatCheckedDate } from "./copy.ts";
import type { ModelPrivacyPrefs } from "./prefs.ts";

interface PolicyLook {
  tone: ModelAnnotationTone;
  icon: ModelAnnotationIcon;
  /** Marked in lists by default (a caution). Reassuring facts wait for `showAll`. */
  caution: boolean;
  /** Worth a chip beside the composer's model. */
  chip: boolean;
}

export const POLICY_LOOK: Readonly<Record<PrivacyPolicy, PolicyLook>> = {
  "zero-retention": { tone: "positive", icon: "shield", caution: false, chip: false },
  "retained-no-training": { tone: "neutral", icon: "shield", caution: false, chip: false },
  "may-improve": { tone: "notice", icon: "eye", caution: true, chip: true },
  "retained-training": { tone: "warning", icon: "eye", caution: true, chip: true },
  unclear: { tone: "neutral", icon: "question", caution: true, chip: true },
  unverified: { tone: "neutral", icon: "question", caution: true, chip: false },
  "upstream-terms": { tone: "neutral", icon: "question", caution: false, chip: false },
};

export interface PrivacyStatement {
  resolved: ResolvedPrivacy;
  look: PolicyLook;
  label: string;
  detail: string;
  meta: string;
  chip: string;
}

export function privacyStatement(model: ModelAnnotationTarget, locale: string, now?: number): PrivacyStatement | undefined {
  const resolved = resolveModelPrivacy(model, now);
  if (!resolved) return undefined;
  const copy = createModelPrivacyCopy(locale);
  const text = copy.policy[resolved.policy];
  const date = formatCheckedDate(resolved.checkedAt, locale);
  const detail = [
    text.detail,
    resolved.retentionDays !== undefined ? fill(copy.retainedDays, { days: resolved.retentionDays }) : "",
    resolved.trialOnly ? copy.trialOnly : "",
  ].filter(Boolean).join(" ");
  return {
    resolved,
    look: POLICY_LOOK[resolved.policy],
    label: text.label,
    detail,
    meta: fill(resolved.stale ? copy.stale : copy.checked, { date }),
    chip: text.chip,
  };
}

export function privacyAnnotations(
  model: ModelAnnotationTarget,
  locale: string,
  prefs: ModelPrivacyPrefs,
  now?: number,
): ModelAnnotation[] {
  const statement = privacyStatement(model, locale, now);
  if (!statement) return [];
  const copy = createModelPrivacyCopy(locale);
  return [{
    key: "privacy",
    tone: statement.look.tone,
    icon: statement.look.icon,
    label: statement.label,
    heading: copy.heading,
    detail: statement.detail,
    meta: statement.meta,
    href: statement.resolved.source.url,
    hrefLabel: copy.sourceLink,
    // A paid route's vendor terms are a details fact, never a row mark.
    inline: statement.look.caution || (prefs.showAll && statement.resolved.policy !== "upstream-terms"),
  }];
}
