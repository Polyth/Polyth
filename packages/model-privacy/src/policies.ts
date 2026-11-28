// How each model's provider says it handles the prompts sent to it, as a
// dated, sourced snapshot. The set of free models changes every few weeks, so
// this lives in a removable package, never in the core. Nothing here is fetched
// at runtime: re-read the sources, update the entries and `checkedAt`, and the
// manifest test keeps the shape honest.
//
// Wording follows the source; a model the source does not name is never
// assumed safe (see `resolveModelPrivacy`).

export type PrivacyPolicy =
  /** The provider keeps nothing and never trains on it. */
  | "zero-retention"
  /** Kept for a while (abuse/safety), never used for training. */
  | "retained-no-training"
  /** Collected data may be used to improve the model. */
  | "may-improve"
  /** Collected data is retained and used to improve the model. */
  | "retained-training"
  /** The source talks about the model but does not say clearly. */
  | "unclear"
  /** Not in this snapshot, or the snapshot is too old to vouch for it. */
  | "unverified"
  /** Paid route whose retention follows the upstream model vendor. */
  | "upstream-terms";

export interface PolicySource {
  url: string;
  title: string;
}

export interface PolicyEntry {
  providerID: string;
  modelID: string;
  policy: PrivacyPolicy;
  source: string;
  /** Days the provider keeps the data, when the source says. */
  retentionDays?: number;
  /** The source says: trial use only, no personal or confidential data. */
  trialOnly?: boolean;
  /** Taken off the catalog; kept so an old session's model still reads right. */
  retired?: boolean;
}

export interface ProviderRule {
  providerID: string;
  /** What the source says for this provider's models it does not list. */
  listedDefault: PrivacyPolicy;
  /** Model ids the source names with the default policy. Zero-cost models
   *  outside entries and this list are `unverified`. */
  listed: readonly string[];
  /** Paid models: retention follows the upstream vendor. */
  paid: PrivacyPolicy;
  source: string;
}

export interface PolicyManifest {
  schemaVersion: 1;
  /** ISO date the sources were last read. */
  checkedAt: string;
  /** After this many days a `zero-retention` answer is shown as unverified. */
  staleAfterDays: number;
  sources: Readonly<Record<string, PolicySource>>;
  providers: readonly ProviderRule[];
  entries: readonly PolicyEntry[];
}

const ZEN = "opencode-models";

export const POLICY_MANIFEST: PolicyManifest = {
  schemaVersion: 1,
  checkedAt: "2026-11-27",
  staleAfterDays: 120,
  sources: {
    [ZEN]: { url: "https://opencode.ai/docs/console/models/", title: "OpenCode docs: Models, Privacy" },
  },
  providers: [
    {
      providerID: "opencode",
      // "Our providers follow a zero-retention policy and do not use your data
      // for model training, with the following exceptions".
      listedDefault: "zero-retention",
      listed: ["deepseek-v4.1-flash-free", "hy4-flash-free", "jev-1.13-free"],
      // OpenAI, Anthropic, Google and xAI APIs keep requests 30–55 days.
      paid: "upstream-terms",
      source: ZEN,
    },
  ],
  entries: [
    { providerID: "opencode", modelID: "big-pickle", policy: "may-improve", source: ZEN },
    { providerID: "opencode", modelID: "flint-40b-free", policy: "may-improve", retentionDays: 30, source: ZEN },
    { providerID: "opencode", modelID: "seaglass-alpha-free", policy: "retained-training", source: ZEN },
    { providerID: "opencode", modelID: "iceman-free", policy: "retained-training", source: ZEN },
    { providerID: "opencode", modelID: "tidepool-alpha-free", policy: "retained-training", retired: true, source: ZEN },
    { providerID: "opencode", modelID: "nemotron-3.5-lightning-free", policy: "retained-training", trialOnly: true, source: ZEN },
    { providerID: "opencode", modelID: "nemotron-3.5-super-vl-free", policy: "retained-training", trialOnly: true, source: ZEN },
    { providerID: "opencode", modelID: "beam-free", policy: "retained-no-training", retentionDays: 30, source: ZEN },
    // Not an exception, but the page says the team is "using this time to
    // collect feedback" without saying what that covers.
    { providerID: "opencode", modelID: "mimo-v2.6-flash-free", policy: "unclear", source: ZEN },
  ],
};
