import { useEffect, useState, type ReactNode } from "react";
import type { InstalledPluginDto } from "@polyth/contracts";
import {
  parseContributionResult,
  type ContributionInvocationKind,
  type ContributionResult,
  type ExternalResource,
  type PackageJsonObject,
  type StructuredContext,
} from "@polyth/package-sdk";
import { attachUpload } from "../../attachments.ts";
import { announce } from "../../components/a11y/announce.ts";
import { Button, Notice, ResponsiveOverlay, Spinner } from "../../components/ui/index.ts";
import { getState } from "../../store.ts";
import { RemoteUiView } from "./RemoteUi.tsx";
import {
  acquireSandboxRuntime,
  type HostContributionInvocationRequest,
  type SandboxRuntime,
} from "./runtime.ts";

const CONTRIBUTION_SURFACE_ID = "__contributions__";

export interface SandboxContributionActionProps {
  plugin: InstalledPluginDto;
  kind: ContributionInvocationKind;
  contributionId: string;
  label: string;
  description?: string;
  roles?: readonly string[];
  context: Record<string, unknown>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const integer = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

function invocationRequest(props: SandboxContributionActionProps): HostContributionInvocationRequest {
  const state = getState();
  const sessionId = text(props.context.sessionId) ?? state.activeSessionId ?? undefined;
  const projectId = text(props.context.projectId) ?? state.activeProjectId ?? undefined;
  const data: PackageJsonObject = {};
  if (props.kind === "message-action" || props.kind === "tool-renderer") {
    const eventSeq = integer(props.context.eventSeq);
    if (!eventSeq) throw new Error("This extension action is no longer bound to a conversation item.");
    data.eventSeq = eventSeq;
  }
  if (props.kind === "command") {
    data.query = text(props.context.query) ?? "";
    data.arguments = text(props.context.arguments) ?? "";
  }
  if (props.kind === "attachment-provider" || props.kind === "context-provider") {
    data.query = text(props.context.query) ?? "";
  }
  return {
    kind: props.kind,
    contributionId: props.contributionId,
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(Object.keys(data).length ? { data } : {}),
  };
}

function roleAllowed(props: SandboxContributionActionProps): boolean {
  if (props.kind !== "message-action" || !props.roles?.length) return true;
  const explicit = text(props.context.role);
  const fallback = props.context.kind === "assistant" || props.context.kind === "response"
    ? "assistant"
    : props.context.kind === "tool" ? "tool" : "user";
  return props.roles.includes(explicit ?? fallback);
}

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

function resourceDocument(resource: ExternalResource): string {
  const lines = [
    `# ${resource.title}`,
    "",
    `Provider: ${resource.provider}`,
    `Resource: ${resource.resourceId}`,
  ];
  if (resource.subtitle) lines.push(`Subtitle: ${resource.subtitle}`);
  if (resource.url) lines.push(`URL: ${resource.url}`);
  if (resource.retrievedAt !== undefined) lines.push(`Retrieved: ${new Date(resource.retrievedAt).toISOString()}`);
  if (resource.freshUntil !== undefined) lines.push(`Fresh until: ${new Date(resource.freshUntil).toISOString()}`);
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
  lines.push(`Retrieved: ${new Date(context.retrievedAt).toISOString()}`);
  if (context.freshUntil !== undefined) lines.push(`Fresh until: ${new Date(context.freshUntil).toISOString()}`);
  if (context.summary) lines.push("", "## Summary", "", context.summary);
  lines.push("", "## Context", "", context.content);
  return `${lines.join("\n")}${metadataBlock(context.metadata)}\n`;
}

async function attachResult(result: ContributionResult, sessionId?: string, projectId?: string): Promise<void> {
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
  if (items.length && !projectId) throw new Error("Choose a project before attaching extension context.");
  for (const item of items) {
    const attached = await attachUpload(
      projectId!,
      sessionId,
      new File([item.body], item.name, { type: "text/markdown" }),
    );
    if (!attached.ok) throw new Error(attached.reason);
  }
  const announcement = parsed.message ?? parsed.status?.label;
  if (announcement) announce(announcement);
}

export default function SandboxContributionAction(props: SandboxContributionActionProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<HostContributionInvocationRequest | null>(null);

  if (!roleAllowed(props)) return null;

  const activate = () => {
    try {
      setRequest(invocationRequest(props));
      setOpen(true);
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="quiet"
        title={props.description ? `${props.label} — ${props.description}` : `${props.label} — ${props.plugin.name}`}
        onClick={activate}
      >
        {props.label}
      </Button>
      {request && (
        <ContributionOverlay
          open={open}
          plugin={props.plugin}
          title={props.label}
          request={request}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ContributionOverlay(props: {
  open: boolean;
  plugin: InstalledPluginDto;
  title: string;
  request: HostContributionInvocationRequest;
  onClose: () => void;
}) {
  const [tree, setTree] = useState<import("@polyth/package-sdk").RemoteUiNode | null>(null);
  const [runtime, setRuntime] = useState<SandboxRuntime | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    let acquired: SandboxRuntime | null = null;
    let unsubscribe: (() => void) | undefined;
    setTree(null);
    setError("");
    setBusy(true);
    void acquireSandboxRuntime(props.plugin, CONTRIBUTION_SURFACE_ID).then(async (next) => {
      if (!active) {
        next.dispose();
        return;
      }
      acquired = next;
      setRuntime(next);
      unsubscribe = next.subscribe((value) => { if (active) setTree(value); });
      try {
        const result = await next.invokeContribution(props.request);
        if (!active) return;
        if (result) {
          await attachResult(result, props.request.sessionId, props.request.projectId);
          if (!active) return;
          if (result.ui) setTree(parseContributionResult(result).ui ?? null);
        }
        setBusy(false);
        props.onClose();
      } catch (cause) {
        if (!active) return;
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, (cause) => {
      if (!active) return;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unsubscribe?.();
      acquired?.dispose();
    };
  }, [props.open, props.plugin.id, props.plugin.version, props.plugin.sandbox?.integrity, JSON.stringify(props.request)]);

  return (
    <ResponsiveOverlay
      open={props.open}
      onClose={props.onClose}
      title={`${props.plugin.name} · ${props.title}`}
      desktop="dialog"
      dialogSize="md"
      sheetSize="tall"
      className="polyth-extension-contribution"
    >
      {error ? (
        <Notice tone="error" heading="Extension action failed">{error}</Notice>
      ) : tree ? (
        <RemoteUiView tree={tree} onAction={(action) => runtime?.sendAction(action)} />
      ) : (
        <div role="status" aria-live="polite" aria-busy={busy} className="polyth-sandbox-pending">
          <Spinner size="sm" />
          <span>{busy ? "Loading extension…" : "Waiting for extension…"}</span>
        </div>
      )}
    </ResponsiveOverlay>
  );
}
