import { useEffect, useState, type ReactNode } from "react";
import type { InstalledPluginDto } from "@polyth/contracts";
import type {
  ContributionInvocationKind,
  PackageJsonObject,
  RemoteUiNode,
} from "@polyth/package-sdk";
import { announce } from "../../components/a11y/announce.ts";
import { Button, Notice, ResponsiveOverlay, Spinner } from "../../components/ui/index.ts";
import { getState } from "../../store.ts";
import { applyContributionResult } from "./contributionResults.ts";
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

export function contributionInvocationRequest(props: SandboxContributionActionProps): HostContributionInvocationRequest {
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

export default function SandboxContributionAction(props: SandboxContributionActionProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<HostContributionInvocationRequest | null>(null);

  if (!roleAllowed(props)) return null;

  const activate = () => {
    try {
      setRequest(contributionInvocationRequest(props));
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
  const [tree, setTree] = useState<RemoteUiNode | null>(null);
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
          const applied = await applyContributionResult(result, {
            sessionId: props.request.sessionId,
            projectId: props.request.projectId,
          });
          if (!active) return;
          if (applied.ui) setTree(applied.ui);
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
