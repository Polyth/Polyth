// Which limit sources and windows meter a harness/model. Pure and
// server-safe: the Limits widget (`widgets/usage/limitsModel.ts`) and the
// delegation shortlist (`src/routing.ts`) share these rules.
import type { SessionProjection } from "@polyth/contracts";
import type { UsageLimitAccount } from "./limits.ts";
import { harnessAccountOf } from "./providerIdentity.ts";

const sourceId = (value: string): string => value.trim().toLowerCase();

// A harness or model provider names its limit source differently from the source's own id.
const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "claude-code": "claude",
  openai: "codex",
  chatgpt: "codex",
  commandcode: "command-code",
  grok: "xai",
  // Regional/legacy provider ids bill through the same regional source.
  "kimi-code": "kimi-for-coding",
  kimi: "kimi-for-coding",
  "kimi-code-plan-cn": "kimi-for-coding",
  "xiaomi-token-plan-cn": "xiaomi",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-sgp": "xiaomi",
  "xiaomi-mimo": "xiaomi",
  alibaba: "alibaba-coding-plan",
  // Gemini CLI companion logins bill through the Google source.
  gemini: "google",
  "gemini-cli": "google",
  "google-gemini-cli": "google",
  "opencode-gemini-auth": "google",
};

/** Model providers may spell a source differently from the harness or the source id. */
const MODEL_SOURCE_ALIASES: Readonly<Record<string, string>> = {
  ...SOURCE_ALIASES,
  // Zen is the model provider `opencode`; it is not the OpenCode harness. Keeping
  // this aliases to the model role stops an OpenCode-harness session that runs an
  // Anthropic model from also showing Zen limits.
  opencode: "opencode-zen",
};

export const canonicalSource = (id: string): string => SOURCE_ALIASES[sourceId(id)] ?? sourceId(id);
const canonicalModelSource = (id: string): string =>
  MODEL_SOURCE_ALIASES[sourceId(id)] ?? sourceId(id);

export interface LimitSourceRef {
  providerId: string;
  account?: UsageLimitAccount;
}

/** The source family: the account's harness family, otherwise the source itself. */
export const sourceFamily = (source: LimitSourceRef): string =>
  canonicalSource(source.account?.family ?? source.providerId);

export type LimitsSession = Pick<SessionProjection, "resolvedHarnessId" | "model">;

/**
 * Limit sources of the session's harness or model provider, in snapshot order.
 * A session on one account of a multi-account harness sees that account's
 * source alone: its model provider must not add the family's default account,
 * nor any other account of it.
 */
export function currentLimitSources(session: LimitsSession | null, available: readonly (string | LimitSourceRef)[]): string[] {
  const sources = available.map((entry) => typeof entry === "string" ? { providerId: entry } : entry);
  const harness = session?.resolvedHarnessId ? sourceId(session.resolvedHarnessId) : "";
  const ownAccount = harness
    ? sources.find((source) => source.account && sourceId(source.account.harnessId) === harness)
    : undefined;
  // An account's source can be missing (older server, not yet discovered);
  // the harness id still says which family must not answer for it.
  const parsed = harnessAccountOf(harness);
  const accountFamily = ownAccount ? sourceFamily(ownAccount) : parsed ? canonicalSource(parsed.harnessId) : undefined;
  const wanted = [
    session?.resolvedHarnessId ? canonicalSource(session.resolvedHarnessId) : undefined,
    session?.model?.providerID ? canonicalModelSource(session.model.providerID) : undefined,
  ].filter((id): id is string => Boolean(id));
  return sources
    .filter((source) => accountFamily && sourceFamily(source) === accountFamily
      ? source === ownAccount
      : wanted.includes(canonicalSource(source.providerId)))
    .map((source) => source.providerId);
}

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A `<model>/<period>` window id belongs to that model alone; every other window is account-wide. */
export function windowAppliesToModel(windowId: string, modelId: string | undefined): boolean {
  const slash = windowId.indexOf("/");
  if (slash < 0) return true;
  const have = new Set(words(modelId ?? ""));
  return words(windowId.slice(0, slash)).every((word) => have.has(word));
}
