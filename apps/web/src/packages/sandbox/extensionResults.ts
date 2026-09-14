import {
  parseContributionResult,
  type ContributionResult,
  type ExternalResource,
  type StructuredContext,
} from "@polyth/package-sdk";
import { attachUpload } from "../../attachments.ts";

export interface ContributionResultScope {
  sessionId?: string | null;
  projectId?: string | null;
}

export interface ContributionApplyResult {
  attached: number;
  failed: string[];
}

const safeName = (value: string, fallback: string): string => {
  const base = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").slice(0, 120);
  return base || fallback;
};

const dateLine = (label: string, value: number | undefined): string | undefined => {
  if (value === undefined || value < -8.64e15 || value > 8.64e15) return undefined;
  return `${label}: ${new Date(value).toISOString()}`;
};

const provenanceText = (item: ExternalResource | StructuredContext): string => {
  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push("");
  lines.push(`Provider: ${item.provider}`);
  if ("resourceId" in item) lines.push(`Resource: ${item.resourceId}`);
  if ("sourceId" in item) lines.push(`Source: ${item.sourceId}`);
  if ("subtitle" in item && item.subtitle) lines.push(`Subtitle: ${item.subtitle}`);
  if ("url" in item && item.url) lines.push(`URL: ${item.url}`);
  if ("uri" in item && item.uri) lines.push(`URI: ${item.uri}`);
  const retrieved = dateLine(
    "Retrieved",
    item.retrievedAt ?? ("provenance" in item ? item.provenance?.retrievedAt : undefined),
  );
  if (retrieved) lines.push(retrieved);
  const fresh = dateLine("Fresh until", item.freshUntil);
  if (fresh) lines.push(fresh);
  if ("provenance" in item && item.provenance?.source) lines.push(`Provenance: ${item.provenance.source}`);
  if ("provenance" in item && item.provenance?.uri) lines.push(`Provenance URI: ${item.provenance.uri}`);
  lines.push("");
  if ("summary" in item && item.summary) lines.push("## Summary", "", item.summary, "");
  if ("text" in item && item.text) lines.push("## Content", "", item.text);
  if ("content" in item && item.content) lines.push("## Context", "", item.content);
  if (item.metadata && Object.keys(item.metadata).length > 0) {
    lines.push("", "## Metadata", "", "```json", JSON.stringify(item.metadata, null, 2), "```");
  }
  return lines.join("\n").slice(0, 64_000);
};

async function attachStructuredText(
  projectId: string,
  sessionId: string | null | undefined,
  item: ExternalResource | StructuredContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const name = `${safeName(item.title, "external-context")}.md`;
  const file = new File([provenanceText(item)], name, { type: "text/markdown" });
  const attached = await attachUpload(projectId, sessionId, file);
  return attached.ok ? { ok: true } : { ok: false, reason: attached.reason };
}

export async function applyContributionResult(
  result: ContributionResult | undefined,
  scope: ContributionResultScope,
): Promise<ContributionApplyResult> {
  if (!result) return { attached: 0, failed: [] };
  const parsed = parseContributionResult(result);
  let attached = 0;
  const failed: string[] = [];
  const sessionId = scope.sessionId ?? null;

  for (const resource of parsed.resources ?? []) {
    if (!scope.projectId) {
      failed.push(resource.title);
      continue;
    }
    const outcome = await attachStructuredText(scope.projectId, sessionId, resource);
    if (outcome.ok) attached += 1;
    else failed.push(`${resource.title}: ${outcome.reason}`);
  }

  for (const context of parsed.context ?? []) {
    if (!scope.projectId) {
      failed.push(context.title);
      continue;
    }
    const outcome = await attachStructuredText(scope.projectId, sessionId, context);
    if (outcome.ok) attached += 1;
    else failed.push(`${context.title}: ${outcome.reason}`);
  }

  return { attached, failed };
}
