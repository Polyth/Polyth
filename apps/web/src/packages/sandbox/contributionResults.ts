import {
  parseContributionResult,
  type ContributionResult,
  type ExternalResource,
  type StructuredContext,
} from "@polyth/package-sdk";
import { attachUpload } from "../../attachments.ts";
import { announce } from "../../components/a11y/announce.ts";

function safeFilename(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "external-context";
}

function metadataBlock(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  try {
    const json = JSON.stringify(metadata, null, 2);
    return json && json !== "{}" ? `\n\nMetadata\n\`\`\`json\n${json}\n\`\`\`` : "";
  } catch {
    return "";
  }
}

function dateLine(label: string, value: number | undefined): string | undefined {
  if (value === undefined || value < -8.64e15 || value > 8.64e15) return undefined;
  return `${label}: ${new Date(value).toISOString()}`;
}

function resourceDocument(resource: ExternalResource): string {
  const lines = [
    `# ${resource.title}`,
    "",
    `Provider: ${resource.provider}`,
    `Resource: ${resource.resourceId}`,
  ];
  if (resource.subtitle) lines.push(`Subtitle: ${resource.subtitle}`);
  if (resource.url) lines.push(`URL: ${resource.url}`);
  const retrieved = dateLine("Retrieved", resource.retrievedAt);
  if (retrieved) lines.push(retrieved);
  const fresh = dateLine("Fresh until", resource.freshUntil);
  if (fresh) lines.push(fresh);
  if (resource.provenance?.source) lines.push(`Source: ${resource.provenance.source}`);
  if (resource.provenance?.uri) lines.push(`Source URI: ${resource.provenance.uri}`);
  if (resource.summary) lines.push("", "## Summary", "", resource.summary);
  if (resource.text) lines.push("", "## Content", "", resource.text);
  return `${lines.join("\n")}${metadataBlock(resource.metadata)}\n`;
}

function contextDocument(context: StructuredContext): string {
  const lines = [
    `# ${context.title}`,
    "",
    `Provider: ${context.provider}`,
    `Source: ${context.sourceId}`,
  ];
  if (context.uri) lines.push(`URI: ${context.uri}`);
  const retrieved = dateLine("Retrieved", context.retrievedAt);
  if (retrieved) lines.push(retrieved);
  const fresh = dateLine("Fresh until", context.freshUntil);
  if (fresh) lines.push(fresh);
  if (context.summary) lines.push("", "## Summary", "", context.summary);
  lines.push("", "## Context", "", context.content);
  return `${lines.join("\n")}${metadataBlock(context.metadata)}\n`;
}

export async function applyContributionResult(
  result: ContributionResult,
  input: { sessionId?: string; projectId?: string } = {},
): Promise<ContributionResult> {
  const parsed = parseContributionResult(result);
  const items = [
    ...(parsed.resources ?? []).map((resource) => ({
      name: `${safeFilename(resource.title || resource.resourceId)}.md`,
      body: resourceDocument(resource),
    })),
    ...(parsed.context ?? []).map((context) => ({
      name: `${safeFilename(context.title || context.sourceId)}.md`,
      body: contextDocument(context),
    })),
  ];
  if (items.length && !input.projectId) throw new Error("Choose a project before attaching extension context.");
  for (const item of items) {
    const attached = await attachUpload(
      input.projectId!,
      input.sessionId,
      new File([item.body], item.name, { type: "text/markdown" }),
    );
    if (!attached.ok) throw new Error(attached.reason);
  }
  const announcement = parsed.message ?? parsed.status?.label;
  if (announcement) announce(announcement);
  return parsed;
}
