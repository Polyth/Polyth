import { Fragment, useEffect, useRef, useState, type ComponentType } from "react";
import type { UiSlot } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { Button, GlassDock, Separator } from "../../../apps/web/src/components/ui/index.ts";
import { highlight } from "../../../apps/web/src/highlight.ts";
import { tr, type TranslationKey } from "../../../apps/web/src/i18n/index.ts";
import { guardedAutoApproveAllowed, guardedMayAllow, useGuardrails } from "../../../apps/web/src/guardrails.ts";
import { openSession } from "../../../apps/web/src/init.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { groupPermissions } from "./groupPermissions.ts";
import { confirmFullAccess } from "./fullAccess.ts";
import { outsideTaskLabel, permissionBlastRadius, riskReasonLabels, sessionWorkspaceRoots, type Translate } from "./blastRadius.ts";

type PermissionAction = "once" | "always" | "reject" | "session" | "all" | "delegate";

function ResponsiveLabel({ full, short }: { full: string; short: string }) {
  return <><span className="permission-action-full">{full}</span><span className="permission-action-short">{short}</span></>;
}

function isBrowserRequest(p: PendingPermission): boolean {
  return p.permission === "package-tool"
    && (p.tool === "polyth_browser"
      || p.tool === "browser.polyth-browser"
      || p.tool?.startsWith("browser.") === true
      || p.patterns.some((pattern) => pattern === "browser.polyth-browser"));
}

function isCommandRequest(p: PendingPermission): boolean {
  const perm = (p.permission || "").toLowerCase().trim();
  const tool = (p.tool || "").toLowerCase().trim();
  const title = (p.preview?.title || "").toLowerCase().trim();
  if (["bash", "sh", "shell", "terminal", "run_command", "command"].includes(perm)) return true;
  if (["bash", "sh", "shell", "terminal", "run_command"].includes(tool)) return true;
  if (title.startsWith("run_command") || title.startsWith("bash") || title.startsWith("terminal")) return true;
  return false;
}

function isMcpRequest(p: PendingPermission): boolean {
  if (isBrowserRequest(p)) return false;
  const perm = (p.permission || "").toLowerCase().trim();
  const tool = (p.tool || "").toLowerCase().trim();
  const title = (p.preview?.title || "").toLowerCase().trim();
  if (perm === "package-tool" || perm === "mcp" || perm === "call_mcp_tool" || perm.startsWith("mcp_") || perm.startsWith("mcp__")) return true;
  if (tool === "polyth_mcp" || tool === "call_mcp_tool" || tool.startsWith("mcp_") || tool.startsWith("mcp__")) return true;
  if (title.startsWith("package-tool") || title.includes("mcp") || title.includes("call_mcp_tool")) return true;
  if (p.patterns.some((pat) => pat.startsWith("mcp_") || pat.startsWith("mcp__") || pat.includes("call_mcp_tool"))) return true;
  return false;
}

function formatServerName(raw?: string): string {
  if (!raw) return "MCP";
  const lower = raw.toLowerCase().trim();
  const known: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    mempalace: "MemPalace",
    homeassistant: "Home Assistant",
    "home-assistant": "Home Assistant",
    "polyth-agent-tools": "Agent Tools",
    filesystem: "File System",
    sqlite: "SQLite",
    postgres: "PostgreSQL",
    postgresql: "PostgreSQL",
    polyth: "Polyth",
    slack: "Slack",
  };
  if (known[lower]) return known[lower];
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatToolName(raw?: string): string {
  if (!raw) return tr("permissionbanner.param.tool");
  return raw
    .replace(/^polyth_/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatParamKey(raw: string): string {
  const custom: Record<string, string> = {
    owner: "owner",
    repo: "repository",
    pr: "pullRequest",
    pull_number: "pullRequestNumber",
    pullnumber: "pullRequestNumber",
    issue_number: "issueNumber",
    issuenumber: "issueNumber",
    query: "query",
    url: "url",
    uri: "uri",
    path: "filePath",
    file_path: "filePath",
    filepath: "filePath",
    targetfile: "targetFile",
    target_file: "targetFile",
    commandline: "command",
    command_line: "command",
    command: "command",
    cmd: "command",
    branch: "branch",
    branch_name: "branch",
    commit: "commit",
    sha: "commitSha",
    entity_id: "entityId",
    entityid: "entityId",
    service: "service",
    domain: "domain",
    timeout: "timeout",
    action: "action",
    message: "message",
    prompt: "prompt",
    content: "content",
    title: "title",
    description: "description",
  };
  const lower = raw.toLowerCase();
  if (custom[lower]) return tr(`permissionbanner.param.${custom[lower]}` as TranslationKey);
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatParamValue(val: unknown): { text: string; isCode?: boolean; href?: string } {
  if (val === null || val === undefined) return { text: "—" };
  if (typeof val === "boolean") return { text: val ? tr("permissionbanner.param.yes") : tr("permissionbanner.param.no") };
  if (typeof val === "number") return { text: String(val) };
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^https?:\/\//i.test(trimmed)) return { text: trimmed, href: trimmed };
    if (trimmed.length > 50 || trimmed.includes("\n") || trimmed.includes("/") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return { text: trimmed, isCode: true };
    }
    return { text: trimmed };
  }
  if (Array.isArray(val)) {
    if (val.every((item) => typeof item === "string" || typeof item === "number")) {
      return { text: val.join(", ") };
    }
    return { text: JSON.stringify(val), isCode: true };
  }
  if (typeof val === "object") {
    return { text: JSON.stringify(val), isCode: true };
  }
  return { text: String(val) };
}

interface McpEntry {
  key: string;
  text: string;
  isCode?: boolean;
  href?: string;
}

function parseMcpDetails(p: PendingPermission, lines: string[]): {
  server: string;
  tool: string;
  entries: McpEntry[];
  fallbackLines: string[];
} {
  const mcpMatch = (p.tool || p.permission || "").match(/^mcp[_-]+([^_]+)[_-]+(.+)$/i);
  let server = mcpMatch ? mcpMatch[1] : undefined;
  let tool = mcpMatch ? mcpMatch[2] : undefined;

  if (p.tool === "polyth_peer") {
    server = server || "Polyth";
    tool = tool || "Peer Observations";
  } else if (p.tool === "polyth_home_assistant") {
    server = server || "Home Assistant";
    tool = tool || "Device Control";
  } else if (p.tool === "polyth_mcp") {
    server = server || "Polyth MCP";
  } else if (p.tool && !tool) {
    tool = p.tool;
  }

  const entries: McpEntry[] = [];
  const fallbackLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.ServerName && typeof parsed.ServerName === "string") {
          server = parsed.ServerName;
        }
        if (parsed.ToolName && typeof parsed.ToolName === "string") {
          tool = parsed.ToolName;
        }
        const args = (parsed.Arguments && typeof parsed.Arguments === "object" && !Array.isArray(parsed.Arguments))
          ? parsed.Arguments as Record<string, unknown>
          : (parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input))
            ? parsed.input as Record<string, unknown>
            : (parsed.parameters && typeof parsed.parameters === "object" && !Array.isArray(parsed.parameters))
              ? parsed.parameters as Record<string, unknown>
              : parsed;

        for (const [k, v] of Object.entries(args)) {
          if (k === "ServerName" || k === "ToolName") continue;
          const formatted = formatParamValue(v);
          entries.push({ key: formatParamKey(k), ...formatted });
        }
        continue;
      } catch {
        // Fall back to text parsing
      }
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0 && colonIdx < 30) {
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      const lowerKey = k.toLowerCase();
      if (lowerKey === "servername" || lowerKey === "server") {
        server = v;
        continue;
      }
      if (lowerKey === "toolname" || lowerKey === "tool") {
        tool = v;
        continue;
      }
      if (lowerKey === "arguments" || lowerKey === "args") {
        if (v.startsWith("{") && v.endsWith("}")) {
          try {
            const parsed = JSON.parse(v) as Record<string, unknown>;
            for (const [argK, argV] of Object.entries(parsed)) {
              entries.push({ key: formatParamKey(argK), ...formatParamValue(argV) });
            }
            continue;
          } catch {
            // Keep as regular entry
          }
        }
      }
      entries.push({ key: formatParamKey(k), ...formatParamValue(v) });
      continue;
    }

    if (trimmed.includes(".")) {
      const parts = trimmed.split(".");
      const actionName = parts[parts.length - 1]!;
      entries.push({
        key: "Action",
        ...formatParamValue(actionName.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
      });
      continue;
    }

    fallbackLines.push(trimmed);
  }

  return {
    server: formatServerName(server),
    tool: formatToolName(tool),
    entries,
    fallbackLines,
  };
}

function CommandPreview({ lines }: { lines: string[] }) {
  const commandLines = lines.flatMap((l) => l.split(/\r?\n/).filter((s) => s.length > 0));
  const displayLines = commandLines.length > 0 ? commandLines : lines;
  return (
    <div className="permission-preview permission-terminal">
      {/* Shell text reads left to right in every locale. */}
      <div className="permission-terminal-body" dir="ltr">
        {displayLines.map((line, index) => (
          <div key={index} className="permission-terminal-line">
            <span className="permission-terminal-prompt" aria-hidden="true">$</span>
            <code
              className="permission-terminal-code"
              dangerouslySetInnerHTML={{ __html: highlight(line, "sh") }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function McpPreview({
  server,
  tool,
  entries,
  fallbackLines,
}: {
  server: string;
  tool: string;
  entries: McpEntry[];
  fallbackLines: string[];
}) {
  return (
    <div className="permission-preview permission-mcp">
      <div className="permission-mcp-header">
        <div className="permission-mcp-badge">
          <Icon.plug />
          <span className="permission-mcp-server">{server}</span>
        </div>
        <span className="permission-mcp-tool">{tool}</span>
      </div>
      {entries.length > 0 ? (
        <dl className="permission-mcp-params">
          {entries.map((entry, idx) => (
            <div key={idx} className="permission-mcp-row">
              <dt className="permission-mcp-key">{entry.key}</dt>
              <dd className="permission-mcp-val">
                {entry.href ? (
                  <a href={entry.href} target="_blank" rel="noreferrer" className="permission-mcp-link">
                    {entry.text} <Icon.external />
                  </a>
                ) : entry.isCode ? (
                  <code>{entry.text}</code>
                ) : (
                  <span>{entry.text}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : fallbackLines.length > 0 ? (
        <div className="permission-mcp-fallback">
          {fallbackLines.map((line, idx) => (
            <code key={idx}>{line}</code>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const translate: Translate = (key, vars) => tr(key as Parameters<typeof tr>[0], vars);

/** Generic provider labels such as "Edit" repeat information already conveyed
 * by the target and do not deserve a second visual row. Keep only a genuinely
 * descriptive, server-built title. */
function requestTitle(p: PendingPermission, browser: boolean): string | null {
  if (browser) return tr("permissionbanner.agentWantsToUseBrowser");
  const title = p.preview?.title?.trim();
  if (!title) return null;
  const normalized = title.toLocaleLowerCase();
  if (normalized === p.permission.trim().toLocaleLowerCase()) return null;
  if (p.tool && normalized === p.tool.trim().toLocaleLowerCase()) return null;
  return title;
}

/** The subagent behind a request: a parent's mirrored card names its source;
 * a subagent's own card has a parent session to delegate to. */
function useRequestOrigin(p: PendingPermission): { subagentId?: string; subagentTitle?: string; delegable: boolean } {
  const subagentId = p.sourceSessionId;
  const subagentTitle = useStore((state) => subagentId
    ? state.sessions.find((row) => row.id === subagentId)?.title
    : undefined);
  const hasParent = useStore((state) => Boolean(state.sessions.find((row) => row.id === p.sessionId)?.parentId));
  return { subagentId, subagentTitle, delegable: Boolean(subagentId) || hasParent };
}

/** Marks a scroll body with `data-more-above` / `data-more-below` while
 * content sits past that edge, so CSS can fade it in every browser (phones
 * hide scrollbars). Attributes only: no re-render per scroll frame. */
function useScrollEdges() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = ref.current;
    if (!body) return;
    const update = () => {
      const below = body.scrollHeight - body.clientHeight - body.scrollTop;
      body.toggleAttribute("data-more-above", body.scrollTop > 1);
      body.toggleAttribute("data-more-below", below > 1);
    };
    update();
    body.addEventListener("scroll", update, { passive: true });
    // The body resizes with the card; its content grows as requests change.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(body);
    const content = body.querySelector(":scope > .permission-request-content");
    if (content) observer?.observe(content);
    return () => {
      body.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  return ref;
}

const POLICY_SETTLE_MS = 1500;

/** Send one call per request together; report the ones that failed. */
async function failedRequests(
  requests: readonly PendingPermission[],
  send: (request: PendingPermission) => Promise<unknown>,
): Promise<{ ids: string[]; reason: unknown }> {
  const results = await Promise.allSettled(requests.map(send));
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  return {
    ids: requests.filter((_, index) => results[index]!.status === "rejected").map((request) => request.requestId),
    reason: rejected?.reason,
  };
}

/** The host's slot renderer, for package notes about one request (`session.permission.notes`). */
export type PermissionNotesSlot = ComponentType<{ slot: UiSlot; context?: Record<string, unknown> }>;

function PermissionRow({ requests, Slot }: { requests: PendingPermission[]; Slot?: PermissionNotesSlot }) {
  const bodyRef = useScrollEdges();
  const [busy, setBusy] = useState<PermissionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Protected mode mirror; the server refuses these replies regardless.
  const guardrails = useGuardrails();
  const mayAllow = guardedMayAllow(guardrails);
  const mayAutoApprove = guardedAutoApproveAllowed(guardrails);
  // WebSocket delivery may lag the reply. Retain confirmed replies locally so
  // a partial failure or a newly arriving request cannot replay a decision.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const pending = requests.filter((request) => !answered.has(request.requestId));
  // Delegations sent from this card, shown before the server marks them.
  const [handedOver, setHandedOver] = useState<Set<string>>(() => new Set());
  const p = pending[0] ?? requests[0]!;
  const browser = isBrowserRequest(p);
  const isCommand = !browser && isCommandRequest(p);
  const isMcp = !browser && !isCommand && isMcpRequest(p);
  const title = requestTitle(p, browser);
  const lines = p.preview !== undefined && p.preview.lines.length > 0 ? p.preview.lines : p.patterns;
  // Auto-Approve never answers a high-risk request, so offering it here would
  // not resolve this card. The person allows or denies it, or opts into Full
  // access ("Allow all"), which asks for confirmation first.
  const highRisk = p.preview?.risk === "high";
  const riskReasons = highRisk ? riskReasonLabels(p.preview?.reasons, translate) : [];
  // The Judgment second opinion left a routine request for the person.
  const outsideTask = !highRisk ? outsideTaskLabel(p.preview, translate) : undefined;
  // What the request would touch, read from the same request text the card
  // shows; the server's assessment above still decides.
  const session = useStore((state) => state.sessions.find((row) => row.id === (p.sourceSessionId ?? p.sessionId)));
  const blastRadius = permissionBlastRadius(p, sessionWorkspaceRoots(session), translate);
  // No policy answers a composer-shell confirmation, so it offers neither.
  const policyAction: PermissionAction | null = p.manual ? null : highRisk ? "all" : "session";
  const origin = useRequestOrigin(p);
  // A composer-shell confirmation is the person's own command; no agent
  // answers it. Delegating also needs the right to approve.
  const delegated = pending.every((request) => request.delegated || handedOver.has(request.requestId));
  const mayDelegate = mayAllow && origin.delegable && !p.manual;

  // A mirrored card belongs to the subagent: only its policy answers it.
  const policySessionId = p.sourceSessionId ?? p.sessionId;

  const unhide = (ids: readonly string[]) => setAnswered((previous) => {
    const next = new Set(previous);
    for (const id of ids) next.delete(id);
    return next;
  });

  const reply = async (action: PermissionAction) => {
    if (busy || pending.length === 0) return;
    // Every decision shows its result at the click: the snapshot is hidden
    // (or marked delegated) before the server answers. Only the click's own
    // requests are covered; later arrivals need their own decision.
    const snapshot = [...pending];
    const snapshotIds = snapshot.map((request) => request.requestId);
    if (action === "all") {
      // The only wait left is the person reading the confirmation.
      setBusy(action);
      const confirmed = await confirmFullAccess();
      setBusy(null);
      if (!confirmed) return;
    }
    setError(null);
    try {
      if (action === "session" || action === "all") {
        setAnswered((previous) => new Set([...previous, ...snapshotIds]));
        try {
          // The canonical session policy also reconciles this open request
          // before the server answers; Full access does so for held ones too.
          await api.autoAcceptSet(policySessionId, action === "all" ? "all" : "on");
        } catch (reason) {
          unhide(snapshotIds);
          throw reason;
        }
        // A policy acknowledgement is not an individual request resolution:
        // whatever it left open (a child's opt-out) comes back. Resolved
        // requests leave through canonical events, which may trail the HTTP
        // answer; the grace keeps them from flashing back meanwhile.
        // ponytail: fixed grace; key on the resolved events if WS lag outgrows it.
        setTimeout(() => unhide(snapshotIds), POLICY_SETTLE_MS);
      } else if (action === "delegate") {
        // Each request is handed over on its own; the parent agent answers
        // them through its session tool, and a person may still answer here.
        // The server reuses an earlier delegation, so a retry after a failed
        // wake re-sends the same message instead of a second one.
        setHandedOver((previous) => new Set([...previous, ...snapshotIds]));
        const failed = await failedRequests(snapshot, (request) => api.delegatePermission(request.sessionId, request.requestId));
        if (failed.ids.length > 0) {
          setHandedOver((previous) => {
            const next = new Set(previous);
            for (const id of failed.ids) next.delete(id);
            return next;
          });
          throw failed.reason;
        }
      } else {
        // Only failed replies come back; a confirmed one stays hidden so a
        // retry never replays it.
        setAnswered((previous) => new Set([...previous, ...snapshotIds]));
        const failed = await failedRequests(snapshot, (request) => api.replyPermission(
          request.sessionId,
          request.requestId,
          action,
        ));
        if (failed.ids.length > 0) {
          unhide(failed.ids);
          throw failed.reason;
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("common.error"));
    }
  };

  if (pending.length === 0) return null;

  const mcpDetails = isMcp ? parseMcpDetails(p, lines) : null;

  return (
    <div className="perm-row permission-request">
      {/* Everything that explains the request scrolls; the decision row
          below it stays in view however long the explanation gets. */}
      <div className="permission-request-body" ref={bodyRef}>
        {/* Edge fades: shown only while more content sits above or below. */}
        <span className="permission-scroll-edge" data-edge="start" aria-hidden="true" />
        <div className="permission-request-content">
          {origin.subagentId && (
            <p className="permission-source">
              <Icon.hierarchy />
              <span className="permission-source-label">
                {tr("permissionbanner.fromSubagent", { title: origin.subagentTitle ?? origin.subagentId.slice(0, 8) })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="permission-source-open"
                aria-label={`${tr("permissionbanner.openSubagent")}: ${origin.subagentTitle ?? origin.subagentId}`}
                onClick={() => void openSession(origin.subagentId!).catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : tr("common.error")))}
              >
                {tr("permissionbanner.openSubagent")}
              </Button>
            </p>
          )}
          {/* The MCP preview already names the server and tool. */}
          {title && !mcpDetails && <strong className="permission-request-title">{title}</strong>}
          {pending.length > 1 && <span className="permission-request-count">{tr("permissionbanner.requestCount", { count: pending.length })}</span>}
          {browser && (
            <p className="permission-browser-capabilities">
              {tr("permissionbanner.browserActionCapabilities")}
            </p>
          )}
          {outsideTask && (
            <p className="permission-outside-task" role="note">{outsideTask}</p>
          )}
          {highRisk && (
            <div className="permission-risk" role="note">
              <strong>{tr("permissionbanner.highRisk")}</strong>
              {riskReasons.length > 0 && (
                <ul>{riskReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              )}
              {blastRadius.length > 0 && (
                <div className="permission-blast">
                  <span className="permission-blast-heading">{tr("permissionbanner.blastHeading")}</span>
                  <ul>
                    {blastRadius.map((line, index) => (
                      <li key={index}>
                        <span className="permission-blast-text">
                          {line.target ? (
                            <>
                              {line.target.before}
                              <bdi className="permission-blast-target" dir="ltr">{line.target.value}</bdi>
                              {line.target.after}
                            </>
                          ) : line.text}
                        </span>
                        {line.notes.map((note) => <span key={note} className="permission-blast-note">{note}</span>)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {lines.length > 0 && (
            isCommand ? (
              <CommandPreview lines={lines} />
            ) : isMcp && mcpDetails ? (
              <McpPreview
                server={mcpDetails.server}
                tool={mcpDetails.tool}
                entries={mcpDetails.entries}
                fallbackLines={mcpDetails.fallbackLines}
              />
            ) : (
              <div className="permission-preview" dir="ltr">
                {lines.map((line, index) => <code key={index}>{line}</code>)}
              </div>
            )
          )}

        </div>
        <span className="permission-scroll-edge" data-edge="end" aria-hidden="true" />
      </div>
      {/* Package notes (a judge's verdict) sit on the decision, outside the
          scrolling explanation, so they stay in view next to the buttons. */}
      {Slot && <Slot slot="session.permission.notes" context={{
        sessionId: p.sessionId,
        requestId: p.requestId,
        ...(p.sourceSessionId ? { sourceSessionId: p.sourceSessionId } : {}),
      }} />}
      <div className="perm-actions" aria-label={tr("permissionbanner.permissionRequested")}>
        <Button size="sm" variant="danger" className="permission-deny" aria-label={tr("permissionbanner.deny")} busy={busy === "reject"} disabled={busy !== null} onClick={() => void reply("reject")}>
          <ResponsiveLabel full={tr("permissionbanner.deny")} short={tr("permissionbanner.denyShort")} />
        </Button>
        {mayAllow && <Button size="sm" variant="primary" className="permission-allow" aria-label={tr("permissionbanner.allowOnce")} busy={busy === "once"} disabled={busy !== null} onClick={() => void reply("once")}>
          <ResponsiveLabel full={tr("permissionbanner.allowOnce")} short={tr("permissionbanner.once")} />
        </Button>}
        {mayDelegate && (!delegated || error !== null) && (
          <Button
            size="sm"
            variant="quiet"
            className="permission-delegate"
            aria-label={tr("permissionbanner.delegateTitle")}
            title={tr("permissionbanner.delegateTitle")}
            busy={busy === "delegate"}
            disabled={busy !== null}
            onClick={() => void reply("delegate")}
          >
            <ResponsiveLabel full={tr("permissionbanner.delegate")} short={tr("permissionbanner.delegateShort")} />
          </Button>
        )}
        {mayAutoApprove && policyAction === "session" && (
          <Button
            size="sm"
            variant="quiet"
            className="permission-session"
            aria-label={tr("permissionbanner.allowAllSession")}
            title={tr("permissionbanner.allowAllSession")}
            busy={busy === "session"}
            disabled={busy !== null}
            onClick={() => void reply("session")}
          >
            <ResponsiveLabel full={tr("permissionbanner.allSession")} short={tr("permissionbanner.session")} />
          </Button>
        )}
        {/* Full access sits on the same row as the other decisions; its
            danger ink and confirmation keep it from reading as routine. */}
        {mayAutoApprove && policyAction === "all" && (
          <Button
            size="sm"
            variant="quiet"
            className="permission-allow-all"
            aria-label={tr("permissionbanner.allowAllTitle")}
            title={tr("permissionbanner.allowAllTitle")}
            busy={busy === "all"}
            disabled={busy !== null}
            onClick={() => void reply("all")}
          >
            {tr("permissionbanner.allowAll")}
          </Button>
        )}
      </div>
      {!mayAllow && <p className="permission-waiting" role="status">{tr("permissionbanner.waitingForApproval")}</p>}
      {mayAllow && delegated && <p className="permission-waiting permission-delegated" role="status">{tr("permissionbanner.delegated")}</p>}
      {error && <p className="permission-error" role="alert">{error}</p>}
    </div>
  );
}

export default function PermissionBanner({ permissions, Slot }: { permissions: PendingPermission[]; Slot?: PermissionNotesSlot }) {
  const groups = groupPermissions(permissions);
  if (groups.length === 0) return null;
  return (
    <GlassDock className="perm-banner permission-toast" role="alert" aria-live="assertive" aria-relevant="additions text">
      <div className="perm-title">
        <span className="permission-mode-icon" aria-hidden="true"><Icon.shield /></span>
        {tr("permissionbanner.permissionRequested")}
      </div>
      {groups.map((group, index) => (
        <Fragment key={group.key}>
          {index > 0 && <Separator decorative />}
          <PermissionRow requests={group.requests} Slot={Slot} />
        </Fragment>
      ))}
    </GlassDock>
  );
}
