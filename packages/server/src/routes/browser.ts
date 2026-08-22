// Controlled-browser routes (WP14). Invariant: action-requested appends
// BEFORE the action runs; observations append BEFORE the payload returns —
// nothing becomes model-visible without a log record.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserTarget, JsonObject, SessionEvent } from "@polyth/contracts";
import type { BrowserService } from "@polyth/browser";
import { redactObservationText } from "@polyth/browser";
import type { RouteHandler } from "../http.ts";

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  "invalid-url": 400,
  unavailable: 503,
  limit: 429,
  timeout: 504,
  "agent-paused": 409,
  "stale-frame": 409,
  conflict: 409,
  "blocked-scheme": 403,
  "blocked-credentials": 403,
  "blocked-private": 403,
  "approval-required": 403,
  "download-blocked": 403,
  "dns-error": 502,
};

const summarize = (action: BrowserAction): string => {
  switch (action.kind) {
    case "click": return `click ${targetText(action.target)}`;
    case "type": return `type into ${targetText(action.target)} (${action.text.length} chars${action.submit ? ", submit" : ""})`;
    case "press": return `press ${action.key}`;
    case "scroll": return action.target ? `scroll to ${targetText(action.target)}` : `scroll ${action.x ?? 0},${action.y ?? 0}`;
    case "select": return `select ${action.value} in ${targetText(action.target)}`;
    case "wait": return `wait ${action.condition}${action.value ? ` ${action.value}` : ""}`;
    case "back": return "go back";
    case "forward": return "go forward";
    case "reload": return "reload";
    case "resize": return `resize to ${action.viewport.width}×${action.viewport.height}`;
    case "inspect": return `inspect ${action.selector}`;
  }
};

const targetText = (t: BrowserTarget): string => {
  if ("selector" in t) return t.selector;
  if ("text" in t) return `text "${t.text}"`;
  if ("role" in t) return `${t.role}${t.name ? ` "${t.name}"` : ""}`;
  return `(${t.point.x},${t.point.y})`;
};

export function browserRoutes(deps: {
  browser: BrowserService;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  shotsDir: string;
}): RouteHandler {
  const { browser, append } = deps;

  const saveShot = async (browserSessionId: string, revision: number, data: Uint8Array, mime: string): Promise<string> => {
    await mkdir(deps.shotsDir, { recursive: true });
    const name = `${browserSessionId}-${revision}.${mime.includes("webp") ? "webp" : "jpg"}`;
    await writeFile(join(deps.shotsDir, name), data);
    return name;
  };

  return async ({ path, method, url, body, json }) => {
    try {
      if (path === "/api/browser/capability" && method === "GET") {
        json(200, browser.capability());
        return true;
      }
      if (path === "/api/browser/approvals" && method === "GET") {
        json(200, { origins: browser.approvals() });
        return true;
      }
      if (path === "/api/browser/approvals" && method === "POST") {
        const b = await body();
        browser.approveOrigin(String(b.origin ?? ""));
        json(200, { origins: browser.approvals() });
        return true;
      }
      if (path === "/api/browser/sessions" && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const all = browser.list();
        json(200, projectId ? all.filter((s) => s.projectId === projectId) : all);
        return true;
      }
      if (path === "/api/browser/sessions" && method === "POST") {
        const b = await body();
        const viewport = b.viewport as { width?: number; height?: number } | undefined;
        const dto = await browser.create({
          projectId: String(b.projectId ?? ""),
          ...(b.sessionId ? { sessionId: String(b.sessionId) } : {}),
          ...(b.url ? { url: String(b.url) } : {}),
          ...(viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
            ? { viewport: { width: viewport.width, height: viewport.height } }
            : {}),
        });
        json(200, dto);
        return true;
      }

      let m = path.match(/^\/api\/browser\/sessions\/([^/]+)$/);
      if (m && method === "GET") {
        const dto = browser.get(m[1]!);
        json(dto ? 200 : 404, dto ?? { error: "not-found" });
        return true;
      }
      if (m && method === "DELETE") {
        await browser.close(m[1]!);
        json(200, { ok: true });
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/navigate$/);
      if (m && method === "POST") {
        const id = m[1]!;
        const b = await body();
        const actor = b.actor === "agent" ? "agent" as const : "user" as const;
        const target = String(b.url ?? "");
        const linked = browser.get(id)?.sessionId;
        if (linked) {
          await append(linked, "browser/action-requested", {
            browserSessionId: id, actor, actionSummary: `navigate ${target}`,
          });
        }
        try {
          const dto = await browser.navigate(id, target, actor);
          if (linked) {
            await append(linked, "browser/action-completed", { browserSessionId: id, actor, url: dto.url, title: dto.title });
          }
          json(200, dto);
        } catch (err) {
          const e = err as Error & { code?: string };
          if (linked) {
            await append(linked, "browser/action-failed", { browserSessionId: id, actor, code: e.code ?? "internal", message: e.message });
          }
          json(STATUS[e.code ?? ""] ?? 500, { error: e.code ?? "internal", message: e.message });
        }
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/actions$/);
      if (m && method === "POST") {
        const id = m[1]!;
        const b = await body();
        const actor = b.actor === "agent" ? "agent" as const : "user" as const;
        const action = b.action as BrowserAction | undefined;
        if (!action || typeof action !== "object" || !("kind" in action)) {
          json(400, { error: "invalid-input", message: "action required" });
          return true;
        }
        const linked = browser.get(id)?.sessionId;
        // append BEFORE executing: the model-visible record exists even if the
        // process dies mid-action.
        if (linked) {
          await append(linked, "browser/action-requested", {
            browserSessionId: id, actor,
            actionSummary: redactObservationText(summarize(action), { maxChars: 300 }),
          });
        }
        try {
          const { actionId, session, result } = await browser.action(id, action, actor);
          if (linked) {
            await append(linked, "browser/action-completed", { browserSessionId: id, actionId, actor, url: session.url, title: session.title });
          }
          json(200, { actionId, session, ...(result ? { result } : {}) });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (linked) {
            await append(linked, "browser/action-failed", { browserSessionId: id, actor, code: e.code ?? "internal", message: e.message });
          }
          json(STATUS[e.code ?? ""] ?? 500, { error: e.code ?? "internal", message: e.message });
        }
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/observe$/);
      if (m && method === "POST") {
        const id = m[1]!;
        const b = await body();
        const obs = await browser.observe(id, {
          includeScreenshot: b.includeScreenshot === true,
          ...(typeof b.selector === "string" && b.selector.trim() ? { selector: b.selector } : {}),
        });
        let screenshotRef: string | undefined;
        if (obs.screenshot) {
          const dto = browser.get(id);
          screenshotRef = await saveShot(id, dto?.revision ?? 0, obs.screenshot.data, obs.screenshot.mime);
        }
        const payload = {
          url: obs.url, title: obs.title, text: obs.text,
          accessibilityDigest: obs.accessibilityDigest ?? "",
          ...(screenshotRef ? { screenshotRef } : {}),
        };
        // observation appends BEFORE it is returned to any caller (incl. agent)
        const linked = browser.get(id)?.sessionId;
        if (linked) await append(linked, "browser/observation", { browserSessionId: id, ...payload });
        json(200, payload);
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/pause-agent$/);
      if (m && method === "POST") {
        const b = await body();
        browser.pauseAgent(m[1]!, b.paused !== false);
        json(200, { ok: true, paused: browser.agentPaused(m[1]!) });
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/console$/);
      if (m && method === "GET") {
        json(200, browser.console(m[1]!));
        return true;
      }

      m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/frame$/);
      if (m && method === "GET") {
        const after = Number(url.searchParams.get("afterRevision") ?? 0);
        const frame = browser.latestFrame(m[1]!, after);
        if (!frame) { json(204, {}); return true; }
        json(200, {
          revision: frame.revision, mime: frame.mime,
          data: Buffer.from(frame.data).toString("base64"),
        });
        return true;
      }

      return false;
    } catch (err) {
      const e = err as Error & { code?: string };
      json(STATUS[e.code ?? ""] ?? 500, { error: e.code ?? "internal", message: e.message });
      return true;
    }
  };
}
