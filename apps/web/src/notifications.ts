// Notification routing (WP15) — pure logic, node:test friendly. The router in
// notify.ts feeds store snapshots through diffNotifications and shows the
// results; deterministic templates derive from already-logged state, so no
// new session event is needed. Secrets are redacted and previews bounded
// before anything reaches a native notification.

import type { NotificationKind } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

/** Native and centre delivery share one normative kind contract. */
export type NotifyKind = NotificationKind;

export interface SessionSnapshot {
  id: string;
  projectId: string;
  title: string;
  status: string;
  parentId?: string;
  attention?: { questions: number; permissions: number };
}

export interface NotificationSpec {
  /** Stable dedupe key: replaying the same transition never re-notifies. */
  key: string;
  kind: NotifyKind;
  /** Session activated on click — the parent for subagent completions. */
  sessionId: string;
  title: string;
  body: string;
}

const DONE = new Set(["idle", "finished", "failed", "waiting"]);

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  // whole header line: "authorization: Bearer x" must not leave the token behind
  /\b(authorization|proxy-authorization)\s*[:=][^\n]+/gi,
  /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

export function redactNotifyText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

const ALLOWED_VARS = new Set(["project", "session", "status", "preview"]);
const MAX_VAR_CHARS = 80;
const MAX_BODY_CHARS = 200;

/** Allowlisted template variables; unknown `{vars}` stay literal, values are
 *  control-char-stripped, redacted, and capped. Output is bounded. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    if (!ALLOWED_VARS.has(name)) return whole; // never substitute unknowns
    const raw = vars[name] ?? "";
    // eslint-disable-next-line no-control-regex
    const clean = redactNotifyText(raw.replace(/[\u0000-\u001f\u007f]/g, " "));
    return clean.length > MAX_VAR_CHARS ? `${clean.slice(0, MAX_VAR_CHARS)}…` : clean;
  });
  return out.length > MAX_BODY_CHARS ? `${out.slice(0, MAX_BODY_CHARS)}…` : out;
}

export const DEFAULT_NOTIFY_TEMPLATE = "{session} — {status}";

export interface DiffOptions {
  kinds: Set<NotifyKind>;
  template?: string;
  /** projectId → display name for the {project} variable. */
  projectNames?: Map<string, string>;
}

/** Compare consecutive store snapshots and derive notification specs.
 *  Sessions absent from `prev` are primed silently (no replay noise). */
export function diffNotifications(
  prev: Map<string, SessionSnapshot>,
  next: SessionSnapshot[],
  opts: DiffOptions,
): NotificationSpec[] {
  const specs: NotificationSpec[] = [];
  const template = opts.template || DEFAULT_NOTIFY_TEMPLATE;
  const byId = new Map(next.map((s) => [s.id, s]));

  const varsFor = (s: SessionSnapshot, status: string, preview = ""): Record<string, string> => ({
    project: opts.projectNames?.get(s.projectId) ?? s.projectId,
    session: s.title || tr("notifications.session"),
    status,
    preview,
  });

  for (const s of next) {
    const before = prev.get(s.id);
    if (!before) continue; // first sight: prime, never notify on replay

    // -- turn finished/failed -------------------------------------------------
    if (before.status === "working" && DONE.has(s.status) && s.status !== before.status) {
      const failed = s.status === "failed";
      if (s.parentId) {
        // delegated agent: attribute to the parent session
        if (opts.kinds.has("subagent")) {
          const parent = byId.get(s.parentId);
          specs.push({
            key: `${s.id}:subagent:${s.status}`,
            kind: "subagent",
            sessionId: s.parentId,
            title: parent?.title || tr("notifications.delegatedAgent"),
            body: renderTemplate(template, {
              ...varsFor(
                parent ?? s,
                failed ? tr("notifications.delegatedAgentFailed") : tr("notifications.delegatedAgentFinished"),
              ),
              preview: s.title || "",
            }),
          });
        }
      } else if (opts.kinds.has(failed ? "failed" : "completed")) {
        specs.push({
          key: `${s.id}:turn:${s.status}`,
          kind: failed ? "failed" : "completed",
          sessionId: s.id,
          title: s.title || tr("notifications.session"),
          body: renderTemplate(
            template,
            varsFor(s, failed ? tr("notifications.failed") : tr("notifications.finished")),
          ),
        });
      }
    }

    // -- new questions / permission requests ----------------------------------
    const qBefore = before.attention?.questions ?? 0;
    const qNow = s.attention?.questions ?? 0;
    if (qNow > qBefore && opts.kinds.has("question")) {
      specs.push({
        key: `${s.id}:question:${qNow}`,
        kind: "question",
        sessionId: s.id,
        title: s.title || tr("notifications.session"),
        body: renderTemplate(template, varsFor(s, tr("notifications.hasQuestionForYou"))),
      });
    }
    const pBefore = before.attention?.permissions ?? 0;
    const pNow = s.attention?.permissions ?? 0;
    if (pNow > pBefore && opts.kinds.has("permission")) {
      specs.push({
        key: `${s.id}:permission:${pNow}`,
        kind: "permission",
        sessionId: s.id,
        title: s.title || tr("notifications.session"),
        body: renderTemplate(template, varsFor(s, tr("notifications.needsPermissionDecision"))),
      });
    }
  }
  return specs;
}
