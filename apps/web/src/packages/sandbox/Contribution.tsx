import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InstalledPluginDto, UiSlotItem } from "@polyth/contracts";
import type {
  ContributionInvocationKind,
  ContributionResult,
  PackageJsonObject,
  RemoteUiNode,
} from "@polyth/package-sdk";
import { announce } from "../../components/a11y/announce.ts";
import { Button, Badge, Notice, Spinner } from "../../components/ui/index.ts";
import ResponsiveOverlay from "../../components/ui/ResponsiveOverlay.tsx";
import { getState, setUiError } from "../../store.ts";
import { applyContributionResult } from "./extensionResults.ts";
import { RemoteUiView } from "./RemoteUi.tsx";
import { acquireSandboxRuntime, type SandboxRuntime } from "./runtime.ts";

interface ContributionDescriptor {
  kind: ContributionInvocationKind;
  id: string;
  label: string;
  title: string;
  description?: string;
  dynamic?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function descriptorOf(item: UiSlotItem): ContributionDescriptor | null {
  const props = asRecord(item.props);
  const kind = typeof props.contributionKind === "string" ? props.contributionKind : "";
  const id = typeof props.contributionId === "string" ? props.contributionId : "";
  if (!id || ![
    "composer-action", "attachment-provider", "message-action", "session-action", "command",
    "tool-renderer", "status-badge", "settings-section", "context-provider", "widget", "surface",
  ].includes(kind)) return null;
  const label = typeof props.label === "string" && props.label.trim()
    ? props.label.trim()
    : typeof props.title === "string" && props.title.trim()
      ? props.title.trim()
      : id;
  return {
    kind: kind as ContributionInvocationKind,
    id,
    label,
    title: typeof props.title === "string" && props.title.trim() ? props.title.trim() : label,
    ...(typeof props.description === "string" && props.description.trim() ? { description: props.description.trim() } : {}),
    ...(props.dynamic === true ? { dynamic: true } : {}),
  };
}

function scopeOf(hostProps: Record<string, unknown>): { sessionId?: string; projectId?: string } {
  const state = getState();
  const sessionId = typeof hostProps.sessionId === "string" ? hostProps.sessionId : state.activeSessionId ?? undefined;
  const projectId = typeof hostProps.projectId === "string" ? hostProps.projectId : state.activeProjectId ?? undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}) };
}

function invocationData(
  descriptor: ContributionDescriptor,
  hostProps: Record<string, unknown>,
): PackageJsonObject | undefined {
  if (descriptor.kind === "message-action") {
    const id = typeof hostProps.messageId === "string" ? hostProps.messageId : "";
    const role = hostProps.messageRole === "assistant" || hostProps.messageRole === "tool" ? hostProps.messageRole : "user";
    if (!id) return undefined;
    return {
      message: {
        id,
        role,
        ...(typeof hostProps.messageText === "string" ? { text: hostProps.messageText.slice(0, 24_000) } : {}),
        ...(typeof hostProps.toolName === "string" ? { toolName: hostProps.toolName.slice(0, 160) } : {}),
      },
    };
  }
  if (descriptor.kind === "command") {
    return {
      query: typeof hostProps.query === "string" ? hostProps.query.slice(0, 1_000) : "",
      arguments: typeof hostProps.arguments === "string" ? hostProps.arguments.slice(0, 4_000) : "",
    };
  }
  if (descriptor.kind === "tool-renderer") {
    const tool = asRecord(hostProps.tool);
    if (!tool.callId || !tool.name) return undefined;
    const data: PackageJsonObject = {
      tool: {
        callId: String(tool.callId).slice(0, 240),
        name: String(tool.name).slice(0, 240),
        ...(tool.input && typeof tool.input === "object" ? { input: JSON.parse(JSON.stringify(tool.input)) } : {}),
        ...(tool.output !== undefined ? { output: JSON.parse(JSON.stringify(tool.output)) } : {}),
        ...(typeof tool.error === "string" ? { error: tool.error.slice(0, 8_000) } : {}),
      },
    };
    return data;
  }
  if (descriptor.kind === "attachment-provider" || descriptor.kind === "context-provider") {
    return typeof hostProps.query === "string" ? { query: hostProps.query.slice(0, 1_000) } : undefined;
  }
  const input = asRecord(hostProps.input);
  if (Object.keys(input).length === 0) return undefined;
  return JSON.parse(JSON.stringify(input)) as PackageJsonObject;
}

function useContributionExecution(
  plugin: InstalledPluginDto,
  descriptor: ContributionDescriptor,
  hostProps: Record<string, unknown>,
) {
  const runtimeRef = useRef<SandboxRuntime | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const executionRef = useRef(0);
  const [tree, setTree] = useState<RemoteUiNode | null>(null);
  const [result, setResult] = useState<ContributionResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dispose = useCallback(() => {
    executionRef.current += 1;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    setBusy(false);
  }, []);

  useEffect(() => dispose, [dispose]);

  const run = useCallback(async () => {
    dispose();
    const execution = executionRef.current;
    setError(null);
    setResult(undefined);
    setTree(null);
    setBusy(true);
    const surfaceId = `contribution:${descriptor.kind}:${descriptor.id}:${crypto.randomUUID()}`;
    try {
      const runtime = await acquireSandboxRuntime(plugin, surfaceId);
      if (execution !== executionRef.current) {
        runtime.dispose();
        return undefined;
      }
      runtimeRef.current = runtime;
      unsubscribeRef.current = runtime.subscribe((next) => {
        if (execution === executionRef.current && next) setTree(next);
      });
      const scope = scopeOf(hostProps);
      const next = await runtime.invokeContribution({
        kind: descriptor.kind,
        contributionId: descriptor.id,
        ...scope,
        ...(invocationData(descriptor, hostProps) ? { data: invocationData(descriptor, hostProps) } : {}),
      });
      if (execution !== executionRef.current) return undefined;
      setResult(next);
      if (next?.ui) setTree(next.ui);
      const applied = await applyContributionResult(next, scope);
      if (execution !== executionRef.current) return next;
      if (applied.failed.length > 0) {
        setError(`Could not attach: ${applied.failed.join(", ")}`);
      }
      if (applied.attached > 0) announce(`${applied.attached} extension item${applied.attached === 1 ? "" : "s"} attached`);
      if (next?.message) announce(next.message);
      setBusy(false);
      return next;
    } catch (cause) {
      if (execution !== executionRef.current) return undefined;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setBusy(false);
      return undefined;
    }
  }, [descriptor, dispose, hostProps, plugin]);

  return { tree, result, busy, error, run, dispose, runtimeRef };
}

function ContributionBody({
  execution,
}: {
  execution: ReturnType<typeof useContributionExecution>;
}) {
  if (execution.error) return <Notice tone="warning" role="alert">{execution.error}</Notice>;
  if (execution.tree) {
    return <RemoteUiView tree={execution.tree} onAction={(action) => execution.runtimeRef.current?.sendAction(action)} />;
  }
  if (execution.busy) return <Spinner label="Loading extension" />;
  if (execution.result?.status) {
    return <Badge tone={execution.result.status.tone === "danger" ? "danger" : execution.result.status.tone === "warning" ? "warning" : execution.result.status.tone === "success" ? "success" : "neutral"}>{execution.result.status.label}</Badge>;
  }
  return null;
}

function LauncherContribution({
  plugin,
  descriptor,
  hostProps,
}: {
  plugin: InstalledPluginDto;
  descriptor: ContributionDescriptor;
  hostProps: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const execution = useContributionExecution(plugin, descriptor, hostProps);
  const launch = () => {
    setOpen(true);
    void execution.run().then((result) => {
      if (result && !result.ui && !execution.tree && !(result.status || result.message)) setOpen(false);
    });
  };
  const close = () => {
    setOpen(false);
    execution.dispose();
  };
  const compact = descriptor.kind === "message-action" || descriptor.kind === "session-action";
  return (
    <>
      <Button
        ref={triggerRef}
        size="sm"
        variant="quiet"
        disabled={execution.busy}
        title={descriptor.description}
        onClick={launch}
      >
        {descriptor.label}
      </Button>
      <ResponsiveOverlay
        open={open}
        onClose={close}
        title={descriptor.title}
        desktop="dialog"
        restoreFocusRef={triggerRef}
        sheetSize={compact ? "auto" : "tall"}
        dialogSize={compact ? "sm" : "md"}
      >
        <ContributionBody execution={execution} />
      </ResponsiveOverlay>
    </>
  );
}

function InlineContribution({
  plugin,
  descriptor,
  hostProps,
}: {
  plugin: InstalledPluginDto;
  descriptor: ContributionDescriptor;
  hostProps: Record<string, unknown>;
}) {
  const execution = useContributionExecution(plugin, descriptor, hostProps);
  useEffect(() => {
    void execution.run();
    return execution.dispose;
  // Contribution identity is immutable for this mounted slot entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, plugin.version, descriptor.kind, descriptor.id]);

  if (descriptor.kind === "status-badge" && execution.result?.status) {
    const status = execution.result.status;
    return <Badge tone={status.tone === "danger" ? "danger" : status.tone === "warning" ? "warning" : status.tone === "success" ? "success" : "neutral"}>{status.label}</Badge>;
  }
  if (descriptor.kind === "tool-renderer" && execution.error) return null;
  return <ContributionBody execution={execution} />;
}

export function SandboxContributionSlot({
  plugin,
  item,
  hostProps,
}: {
  plugin: InstalledPluginDto;
  item: UiSlotItem;
  hostProps: Record<string, unknown>;
}): ReactNode {
  const descriptor = useMemo(() => descriptorOf(item), [item]);
  if (!descriptor) return null;
  if (descriptor.kind === "tool-renderer") {
    if (!descriptor.dynamic) return null;
    return <InlineContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
  }
  if (["settings-section", "status-badge", "widget", "surface"].includes(descriptor.kind)) {
    return <InlineContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
  }
  return <LauncherContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
}

export function reportContributionError(message: string): void {
  setUiError(message);
}
