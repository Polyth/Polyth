import type { ModelRef } from "@polyth/contracts";

/** When the generated message carries a body under its title. */
export type CommitDetails = "auto" | "always" | "never";

/** How Polyth words the commit messages it writes. Empty rules mean the
 *  built-in ones; `matchHistory` shows the model the target branch's recent
 *  subjects so each repository keeps its own convention. */
export interface CommitStyle {
  titleRule: string;
  detailsRule: string;
  details: CommitDetails;
  matchHistory: boolean;
}

export interface CommitSettings {
  mode: "session" | "small" | "custom";
  model?: ModelRef & { harnessId: string };
  /** Absent means the built-in style. */
  style?: CommitStyle;
}

/** Longest rule kept, in characters. Rules are model instructions, so they
 *  stay short enough to leave the diff its budget. */
export const COMMIT_RULE_MAX = 1500;

export const DEFAULT_COMMIT_STYLE: CommitStyle = Object.freeze({
  titleRule: "",
  detailsRule: "",
  details: "auto",
  matchHistory: false,
});

const DETAILS: readonly CommitDetails[] = ["auto", "always", "never"];

/** True when a style says nothing the built-in prompt does not already say. */
export function isDefaultCommitStyle(style: CommitStyle | undefined): boolean {
  return !style || (!style.titleRule && !style.detailsRule && style.details === "auto" && !style.matchHistory);
}

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

function parseRule(value: unknown, name: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(`${name} must be text`);
  // Normalise line endings and drop control characters a model would only
  // see as noise; keep newlines and tabs, which rules legitimately use.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (text.length > COMMIT_RULE_MAX) throw invalid(`${name} is longer than ${COMMIT_RULE_MAX} characters`);
  return text;
}

export function parseCommitStyle(value: unknown): CommitStyle | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Commit style must be an object");
  const input = value as Partial<Record<keyof CommitStyle, unknown>>;
  const details = input.details ?? "auto";
  if (typeof details !== "string" || !(DETAILS as readonly string[]).includes(details)) throw invalid("Choose when to write details");
  if (input.matchHistory !== undefined && typeof input.matchHistory !== "boolean") throw invalid("matchHistory must be true or false");
  const style: CommitStyle = {
    titleRule: parseRule(input.titleRule, "Title rule"),
    detailsRule: parseRule(input.detailsRule, "Details rule"),
    details: details as CommitDetails,
    matchHistory: input.matchHistory === true,
  };
  return isDefaultCommitStyle(style) ? undefined : style;
}

export function parseCommitSettings(value: unknown): CommitSettings {
  const input = value as (Partial<CommitSettings> & { style?: unknown }) | null;
  if (!input || !["session", "small", "custom"].includes(input.mode ?? "")) {
    throw Object.assign(new Error("Choose a commit message model"), { code: "invalid-input" });
  }
  const style = parseCommitStyle(input.style);
  const styled = style ? { style } : {};
  if (input.mode !== "custom") return { mode: input.mode!, ...styled };
  const model = input.model;
  if (!model || ![model.harnessId, model.providerID, model.modelID].every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw Object.assign(new Error("Choose a custom model and harness"), { code: "invalid-input" });
  }
  return { mode: "custom", model: { harnessId: model.harnessId, providerID: model.providerID, modelID: model.modelID, ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}) }, ...styled };
}
