import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InstalledPluginDto, SessionEvent, UiSlotItem } from "@polyth/contracts";
import type {
  ContributionInvocationKind,
  ContributionResult,
  PackageJsonObject,
  RemoteUiNode,
} from "@polyth/package-sdk";
import { announce } from "../../components/a11y/announce.ts";
import { Button, Badge, Notice, Spinner } from "../../components/ui/index.ts";
import ResponsiveOverlay from "../../components/ui/ResponsiveOverlay.tsx";
import { getState } from "../../store.ts";
import { applyContributionResult } from "./extensionResults.ts";
import { RemoteUiView } from "./RemoteUi.tsx";
import { acquireSandboxRuntime, type SandboxRuntime } from "./runtime.ts";

interface ToolMatcher {
  tools?: string[];
  prefix?: string;
}

interface ToolPresentation {
  title?: string;
  subtitle?: string;
  output?: "auto" | "text" | "json" | "markdown" | "code" | "table";
}

interface ContributionDescriptor {
  kind: ContributionInvocationKind;
  id: string;
  label: string;
  title: string;
  description?: string;
  dynamic?: boolean;
  roles?: Array<"user" | "assistant" | "tool">;
  matcher?: ToolMatcher;
  presentation?: ToolPresentation;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const positiveInteger = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

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
  const matcherRaw = asRecord(props.matcher);
  const tools = Array.isArray(matcherRaw.tools)
    ? matcherRaw.tools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
    : undefined;
  const prefix = typeof matcherRaw.prefix === "string" && matcherRaw.prefix ? matcherRaw.prefix : undefined;
  const presentationRaw = asRecord(props.presentation);
  const output = presentationRaw.output === "auto" || presentationRaw.output === "text"
    || presentationRaw.output === "json" || presentationRaw.output === "markdown"
    || presentationRaw.output === "code" || presentationRaw.output === "table"
    ? presentationRaw.output
    : undefined;
  const roles = Array.isArray(props.roles)
    ? props.roles.filter((role): role is "user" | "assistant" | "tool" =>
      role === "user" || role === "assistant" || role === "tool")
    : undefined;
  return {
    kind: kind as ContributionInvocationKind,
    id,
    label,
    title: typeof props.title === "string" && props.title.trim() ? props.title.trim() : label,
    ...(typeof props.description === "string" && props.description.trim() ? { description: props.description.trim() } : {}),
    ...(props.dynamic === true ? { dynamic: true } : {}),
    ...(roles?.length ? { roles } : {}),
    ...(tools?.length || prefix ? { matcher: { ...(tools?.length ? { tools } : {}), ...(prefix ? { prefix } : {}) } } : {}),
    ...(Object.keys(presentationRaw).length ? {
      presentation: {
        ...(typeof presentationRaw.title === "string" ? { title: presentationRaw.title.slice(0, 240) } : {}),
        ...(typeof presentationRaw.subtitle === "string" ? { subtitle: presentationRaw.subtitle.slice(0, 500) } : {}),
        ...(output ? { output } : {}),
      },
    } : {}),
  };
}

function scopeOf(hostProps: Record<string, unknown>): { sessionId?: string; projectId?: string } {
  const state = getState();
  const sessionId = typeof hostProps.sessionId === "string" ? hostProps.sessionId : state.activeSessionId ?? undefined;
  const projectId = typeof hostProps.projectId === "string" ? hostProps.projectId : state.activeProjectId ?? undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}) };
}

function eventOf(hostProps: Record<string, unknown>): SessionEvent | null {
  const raw = hostProps.event;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Partial<SessionEvent>;
  return typeof event.type === "string" && positiveInteger(event.seq) ? event as SessionEvent : null;
}

function invocationData(
  descriptor: ContributionDescriptor,
  hostProps: Record<string, unknown>,
): PackageJsonObject | undefined {
  if (descriptor.kind === "message-action") {
    const eventSeq = positiveInteger(hostProps.eventSeq);
    return eventSeq ? { eventSeq } : undefined;
  }
  if (descriptor.kind === "command") {
    return {
      query: typeof hostProps.query === "string" ? hostProps.query.slice(0, 1_000) : "",
      arguments: typeof hostProps.arguments === "string" ? hostProps.arguments.slice(0, 4_000) : "",
    };
  }
  if (descriptor.kind === "tool-renderer") {
    const eventSeq = eventOf(hostProps)?.seq;
    return eventSeq ? { eventSeq } : undefined;
  }
  if (descriptor.kind === "attachment-provider" || descriptor.kind === "context-provider") {
    return typeof hostProps.query === "string" ? { query: hostProps.query.slice(0, 1_000) } : undefined;
  }
  const input = asRecord(hostProps.input);
  if (Object.keys(input).length === 0) return undefined;
  return JSON.parse(JSON.stringify(input)) as PackageJsonObject;
}

function toolName(event: SessionEvent | null): string {
  if (!event || (event.type !== "tool/call" && event.type !== "tool/result" && event.type !== "tool/error")) return "";
  const value = (event.data as Record<string, unknown>).tool;
  return typeof value === "string" ? value : "";
}

function toolMatches(descriptor: ContributionDescriptor, hostProps: Record<string, unknown>): boolean {
  if (descriptor.kind !== "tool-renderer") return true;
  const name = toolName(eventOf(hostProps));
  if (!name) return false;
  const matcher = descriptor.matcher;
  if (!matcher || (!matcher.tools?.length && !matcher.prefix)) return true;
  return Boolean(matcher.tools?.includes(name) || (matcher.prefix && name.startsWith(matcher.prefix)));
}

function messageRoleAllowed(descriptor: ContributionDescriptor, hostProps: Record<string, unknown>): boolean {
  if (descriptor.kind !== "message-action" || !descriptor.roles?.length) return true;
  const role = hostProps.messageRole;
  return (role === "user" || role === "assistant" || role === "tool") && descriptor.roles.includes(role);
}

function template(value: string | undefined, event: SessionEvent, name: string): string | undefined {
  if (!value) return undefined;
  const data = event.data as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title : "";
  const callId = typeof data.callId === "string" ? data.callId : "";
  return value
    .replaceAll("{{tool}}", name)
    .replaceAll("{{title}}", title)
    .replaceAll("{{callId}}", callId)
    .slice(0, 500);
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4_000);
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 4_000);
  } catch {
    return String(value).slice(0, 4_000);
  }
}

function tableNode(value: unknown): RemoteUiNode | null {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const objects = parsed.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === "object" && !Array.isArray(row)).slice(0, 100);
  if (!objects.length) return null;
  const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))].slice(0, 12);
  if (!columns.length) return null;
  return {
    type: "table",
    columns,
    rows: objects.map((row) => columns.map((column) => displayValue(row[column]).replace(/\s+/g, " ").slice(0, 500))),
  };
}

function declarativeToolTree(
  descriptor: ContributionDescriptor,
  hostProps: Record<string, unknown>,
): RemoteUiNode | null {
  const event = eventOf(hostProps);
  const name = toolName(event);
  if (!event || !name || !toolMatches(descriptor, hostProps)) return null;
  const data = event.data as Record<string, unknown>;
  const raw = event.type === "tool/error" ? data.error : event.type === "tool/result" ? data.output : data.input;
  const requested = descriptor.presentation?.output ?? "auto";
  const output = requested === "auto"
    ? (raw !== null && typeof raw === "object" ? "json" : "text")
    : requested;
  let content: RemoteUiNode;
  if (output === "table") {
    content = tableNode(raw) ?? { type: "code", language: "json", text: displayValue(raw) };
  } else if (output === "json") {
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    content = { type: "code", language: "json", text: displayValue(value) };
  } else if (output === "code") {
    content = { type: "code", text: displayValue(raw) };
  } else if (output === "markdown") {
    content = { type: "markdown", text: displayValue(raw) };
  } else {
    content = { type: "text", text: displayValue(raw) };
  }
  return {
    type: "card",
    title: template(descriptor.presentation?.title, event, name) ?? (typeof data.title === "string" ? data.title : name),
    ...(template(descriptor.presentation?.subtitle, event, name) ? { subtitle: template(descriptor.presentation?.subtitle, event, name) } : {}),
    children: [content],
  };
}

function useContributionExecution(
  plugin: InstalledPluginDto,
  descriptor: ContributionDescriptor,
  hostProps: Record<string, unknown>,
  applyStructuredResult: boolean,
) {
  const runtimeRef = useRef<SandboxRuntime | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const executionRef = useRef(0);
  const [tree, setTree] = useState<RemoteUiNode | null>(null);
  const [result, setResult] = useState<ContributionResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);

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
    setAppliedCount(0);
    setBusy(true);
    const surfaceId = `contribution:${descriptor.kind}:${descriptor.id}:${crypto.randomUUID()}`;
    try {
      const data = invocationData(descriptor, hostProps);
      if ((descriptor.kind === "message-action" || descriptor.kind === "tool-renderer") && !data) {
        throw new Error("This extension contribution is no longer bound to a canonical conversation item.");
      }
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
        ...(data ? { data } : {}),
      });
      if (execution !== executionRef.current) return undefined;
      setResult(next);
      if (next?.ui) setTree(next.ui);
      if (applyStructuredResult) {
        const applied = await applyContributionResult(next, scope);
        if (execution !== executionRef.current) return next;
        setAppliedCount(applied.attached);
        if (applied.failed.length > 0) setError(`Could not attach: ${applied.failed.join(", ")}`);
        if (applied.attached > 0) announce(`${applied.attached} extension item${applied.attached === 1 ? "" : "s"} attached`);
      }
      if (next?.message) announce(next.message);
      setBusy(false);
      return next;
    } catch (cause) {
      if (execution !== executionRef.current) return undefined;
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return undefined;
    }
  }, [applyStructuredResult, descriptor, dispose, hostProps, plugin]);

  return { tree, result, busy, error, appliedCount, run, dispose, runtimeRef };
}

function ContributionBody({ execution }: { execution: ReturnType<typeof useContributionExecution> }) {
  if (execution.error) return <Notice tone="warning" role="alert">{execution.error}</Notice>;
  if (execution.tree) {
    return <RemoteUiView tree={execution.tree} onAction={(action) => execution.runtimeRef.current?.sendAction(action)} />;
  }
  if (execution.busy) return <Spinner label="Loading extension" />;
  if (execution.result?.status) {
    return <Badge tone={execution.result.status.tone === "danger" ? "danger" : execution.result.status.tone === "warning" ? "warning" : execution.result.status.tone === "success" ? "success" : "neutral"}>{execution.result.status.label}</Badge>;
  }
  if (execution.appliedCount > 0) return <Badge tone="success">Added to composer</Badge>;
  if (execution.result?.message) return <Notice tone="info">{execution.result.message}</Notice>;
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
  const execution = useContributionExecution(plugin, descriptor, hostProps, true);
  const launch = () => {
    setOpen(true);
    void execution.run().then((result) => {
      if (result && !result.ui && !(result.status || result.message || result.resources?.length || result.context?.length)) setOpen(false);
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
        phone="sheet"
        restoreFocusRef={triggerRef}
        sheetSize={compact ? "auto" : "tall"}
        dialogSize={compact ? "sm" : "md"}
      >
        <ContributionBody execution={execution} />
      </ResponsiveOverlay>
    </>
  );
}

/** Imperative command submissions reuse the same execution hook, result
 * application, RemoteUI renderer, and adaptive overlay as slot-launched
 * contributions. The caller owns only the temporary React root. */
export function SandboxCommandInvocationOverlay({
  plugin,
  contributionId,
  label,
  query,
  arguments: commandArguments,
  sessionId,
  projectId,
  onClose,
}: {
  plugin: InstalledPluginDto;
  contributionId: string;
  label: string;
  query: string;
  arguments?: string;
  sessionId?: string;
  projectId?: string;
  onClose: () => void;
}) {
  const descriptor = useMemo<ContributionDescriptor>(() => ({
    kind: "command",
    id: contributionId,
    label,
    title: label,
  }), [contributionId, label]);
  const hostProps = useMemo<Record<string, unknown>>(() => ({
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
    query,
    arguments: commandArguments ?? "",
  }), [sessionId, projectId, query, commandArguments]);
  const execution = useContributionExecution(plugin, descriptor, hostProps, true);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let active = true;
    setCompleted(false);
    void execution.run().finally(() => {
      if (active) setCompleted(true);
    });
    return () => {
      active = false;
      execution.dispose();
    };
  // The invocation identity is immutable for this mounted command root.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, plugin.version, contributionId, query, commandArguments, sessionId, projectId]);

  const close = () => {
    execution.dispose();
    onClose();
  };
  const emptySuccess = completed
    && !execution.busy
    && !execution.error
    && !execution.tree
    && execution.result === undefined;
  return (
    <ResponsiveOverlay
      open
      onClose={close}
      title={`${plugin.name} · ${label}`}
      desktop="dialog"
      phone="sheet"
      sheetSize="tall"
      dialogSize="md"
    >
      {emptySuccess
        ? <Badge tone="success">Command completed</Badge>
        : <ContributionBody execution={execution} />}
    </ResponsiveOverlay>
  );
}

function InlineContribution({
  plugin,
  descriptor,
  hostProps,
  applyStructuredResult = false,
}: {
  plugin: InstalledPluginDto;
  descriptor: ContributionDescriptor;
  hostProps: Record<string, unknown>;
  applyStructuredResult?: boolean;
}) {
  const execution = useContributionExecution(plugin, descriptor, hostProps, applyStructuredResult);
  useEffect(() => {
    void execution.run();
    return execution.dispose;
  // Contribution identity and host scope are immutable for this mounted slot entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, plugin.version, descriptor.kind, descriptor.id]);

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
  const selected = typeof hostProps.selectedContributionId === "string" ? hostProps.selectedContributionId : undefined;
  if (selected && selected !== descriptor.id) return null;
  if (!messageRoleAllowed(descriptor, hostProps) || !toolMatches(descriptor, hostProps)) return null;
  if (descriptor.kind === "status-badge") {
    // Status badges are static manifest metadata. Rendering them must not load
    // an iframe or grant a background runtime opportunity on every session row.
    return <Badge tone="neutral">{descriptor.label}</Badge>;
  }
  if (descriptor.kind === "tool-renderer") {
    if (!descriptor.dynamic) {
      const tree = declarativeToolTree(descriptor, hostProps);
      return tree ? <RemoteUiView tree={tree} onAction={() => undefined} /> : null;
    }
    return <InlineContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
  }
  if (
    hostProps.presentation === "picker"
    && (descriptor.kind === "attachment-provider" || descriptor.kind === "context-provider")
  ) {
    return <InlineContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} applyStructuredResult />;
  }
  if (["settings-section", "widget", "surface"].includes(descriptor.kind)) {
    return <InlineContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
  }
  return <LauncherContribution plugin={plugin} descriptor={descriptor} hostProps={hostProps} />;
}
