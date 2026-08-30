import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserTarget,
  JsonObject,
  RouteHandler,
  SessionEvent,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createBrowserService,
  createChromiumDriver,
  createFakeDriver,
  demoWeb,
  findChromiumExecutable,
  redactObservationText,
  type BrowserService,
} from "./index.ts";
import { originOf } from "./policy.ts";

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

const targetText = (target: BrowserTarget): string => {
  if ("selector" in target) return target.selector;
  if ("text" in target) return `text "${target.text}"`;
  if ("role" in target) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  return `(${target.point.x},${target.point.y})`;
};

const summarize = (action: BrowserAction): string => {
  switch (action.kind) {
    case "click": return `click ${targetText(action.target)}`;
    case "point": return `point at ${targetText(action.target)}`;
    case "type": return `type into ${targetText(action.target)} (${action.text.length} chars${action.submit ? ", submit" : ""})`;
    case "press": return `press ${action.key}`;
    case "scroll": return action.target ? `scroll to ${targetText(action.target)}` : `scroll ${action.x ?? 0},${action.y ?? 0}`;
    case "select": return `select ${action.value} in ${targetText(action.target)}`;
    case "wait": return `wait ${action.condition}${action.value ? ` ${action.value}` : ""}`;
    case "back": return "go back";
    case "forward": return "go forward";
    case "reload": return "reload";
    case "resize": return `resize to ${action.viewport.width}×${action.viewport.height}`;
    case "color-scheme": return `emulate ${action.colorScheme} color scheme`;
    case "inspect": return `inspect ${action.selector}`;
  }
};

export function browserRoutes(deps: {
  browser: BrowserService;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  shotsDir: string;
}): RouteHandler {
  const { browser, append } = deps;
  const saveShot = async (
    browserSessionId: string,
    revision: number,
    data: Uint8Array,
    mime: string,
  ): Promise<string> => {
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
        const input = await body();
        browser.approveOrigin(String(input.origin ?? ""));
        json(200, { origins: browser.approvals() });
        return true;
      }
      if (path === "/api/browser/sessions" && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const all = browser.list();
        json(200, projectId ? all.filter((session) => session.projectId === projectId) : all);
        return true;
      }
      if (path === "/api/browser/sessions" && method === "POST") {
        const input = await body();
        const viewport = input.viewport as { width?: number; height?: number } | undefined;
        const colorScheme = input.colorScheme === "light"
          || input.colorScheme === "dark"
          || input.colorScheme === "no-preference"
          ? input.colorScheme
          : undefined;
        if (input.colorScheme !== undefined && !colorScheme) {
          json(400, {
            error: "invalid-input",
            message: "colorScheme must be light, dark, or no-preference",
          });
          return true;
        }
        const target = String(input.url ?? "");
        const session = await browser.create({
          projectId: String(input.projectId ?? ""),
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(target ? { url: target } : {}),
          ...(viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
            ? { viewport: { width: viewport.width, height: viewport.height } }
            : {}),
          ...(colorScheme ? { colorScheme } : {}),
        });
        // If a URL was requested but the session stayed at about:blank, the
        // initial navigation needed approval — surface it to the client.
        if (target && session.url === "about:blank") {
          json(200, {
            session,
            approval: { origin: originOf(target) ?? target, message: `external origin ${originOf(target) ?? target} needs a per-origin approval` },
          });
        } else {
          json(200, session);
        }
        return true;
      }

      let match = path.match(/^\/api\/browser\/sessions\/([^/]+)$/);
      if (match && method === "GET") {
        const session = browser.get(match[1]!);
        json(session ? 200 : 404, session ?? { error: "not-found" });
        return true;
      }
      if (match && method === "DELETE") {
        await browser.close(match[1]!);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/navigate$/);
      if (match && method === "POST") {
        const id = match[1]!;
        const input = await body();
        const actor = input.actor === "agent" ? "agent" as const : "user" as const;
        const target = String(input.url ?? "");
        const linked = browser.get(id)?.sessionId;
        if (linked) {
          await append(linked, "browser/action-requested", {
            browserSessionId: id,
            actor,
            actionSummary: `navigate ${target}`,
          });
        }
        try {
          const session = await browser.navigate(id, target, actor);
          if (linked) {
            await append(linked, "browser/action-completed", {
              browserSessionId: id,
              actor,
              url: session.url,
              title: session.title,
            });
          }
          json(200, session);
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (linked) {
            await append(linked, "browser/action-failed", {
              browserSessionId: id,
              actor,
              code: failure.code ?? "internal",
              message: failure.message,
            });
          }
          // A user navigation that needs approval is an expected product flow,
          // not a failed transport request. Keep the durable failed-action
          // record, but let the client open its approval dialog without a
          // noisy 403 in the browser console.
          if (actor === "user" && failure.code === "approval-required") {
            json(200, {
              session: browser.get(id),
              approval: { origin: originOf(target) ?? target, message: failure.message },
            });
          } else {
            json(STATUS[failure.code ?? ""] ?? 500, {
              error: failure.code ?? "internal",
              message: failure.message,
            });
          }
        }
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/actions$/);
      if (match && method === "POST") {
        const id = match[1]!;
        const input = await body();
        const actor = input.actor === "agent" ? "agent" as const : "user" as const;
        const action = input.action as BrowserAction | undefined;
        if (!action || typeof action !== "object" || !("kind" in action)) {
          json(400, { error: "invalid-input", message: "action required" });
          return true;
        }
        const linked = browser.get(id)?.sessionId;
        if (linked) {
          await append(linked, "browser/action-requested", {
            browserSessionId: id,
            actor,
            actionSummary: redactObservationText(summarize(action), { maxChars: 300 }),
          });
        }
        try {
          const { actionId, session, result } = await browser.action(id, action, actor);
          if (linked) {
            await append(linked, "browser/action-completed", {
              browserSessionId: id,
              actionId,
              actor,
              url: session.url,
              title: session.title,
            });
          }
          json(200, { actionId, session, ...(result ? { result } : {}) });
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (linked) {
            await append(linked, "browser/action-failed", {
              browserSessionId: id,
              actor,
              code: failure.code ?? "internal",
              message: failure.message,
            });
          }
          json(STATUS[failure.code ?? ""] ?? 500, {
            error: failure.code ?? "internal",
            message: failure.message,
          });
        }
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/observe$/);
      if (match && method === "POST") {
        const id = match[1]!;
        const input = await body();
        const observation = await browser.observe(id, {
          includeScreenshot: input.includeScreenshot === true,
          ...(typeof input.selector === "string" && input.selector.trim()
            ? { selector: input.selector }
            : {}),
        });
        let screenshotRef: string | undefined;
        if (observation.screenshot) {
          screenshotRef = await saveShot(
            id,
            browser.get(id)?.revision ?? 0,
            observation.screenshot.data,
            observation.screenshot.mime,
          );
        }
        const payload = {
          url: observation.url,
          title: observation.title,
          text: observation.text,
          accessibilityDigest: observation.accessibilityDigest ?? "",
          ...(screenshotRef ? { screenshotRef } : {}),
        };
        const linked = browser.get(id)?.sessionId;
        if (linked) {
          await append(linked, "browser/observation", {
            browserSessionId: id,
            ...payload,
          });
        }
        json(200, {
          ...payload,
          ...(observation.screenshot ? {
            screenshot: {
              mime: observation.screenshot.mime,
              data: Buffer.from(observation.screenshot.data).toString("base64"),
            },
          } : {}),
        });
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/pause-agent$/);
      if (match && method === "POST") {
        const input = await body();
        browser.pauseAgent(match[1]!, input.paused !== false);
        json(200, { ok: true, paused: browser.agentPaused(match[1]!) });
        return true;
      }
      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/console$/);
      if (match && method === "GET") {
        json(200, browser.console(match[1]!));
        return true;
      }
      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/frame$/);
      if (match && method === "GET") {
        const frame = browser.latestFrame(
          match[1]!,
          Number(url.searchParams.get("afterRevision") ?? 0),
        );
        if (!frame) {
          json(204, {});
          return true;
        }
        json(200, {
          revision: frame.revision,
          mime: frame.mime,
          data: Buffer.from(frame.data).toString("base64"),
        });
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(STATUS[failure.code ?? ""] ?? 500, {
        error: failure.code ?? "internal",
        message: failure.message,
      });
      return true;
    }
  };
}

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  // Internal browser: Chromium if configured/found, fake driver behind
  // POLYTH_FAKE_BROWSER=1, otherwise an honest unavailable state. Created at
  // load time because the runtime pool's browser-tool bridge needs it even
  // while this package's routes are disabled.
  const chromiumPath = process.env.POLYTH_FAKE_BROWSER === "1" ? null : await findChromiumExecutable();
  const driver = process.env.POLYTH_FAKE_BROWSER === "1"
    ? createFakeDriver(demoWeb())
    : chromiumPath
      ? createChromiumDriver(chromiumPath)
      : null;
  const browser = createBrowserService({
    driver,
    unavailableReason: "browser engine unavailable: no Chromium executable found (set POLYTH_CHROMIUM_PATH)",
  });
  host.services.provide(serverServiceKey<BrowserService>("browser"), browser);
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      // The bridge is composition-root-owned (only backend-opencode may talk
      // to the OpenCode process); it is published after package load.
      const bridge = host.services.require(
        serverServiceKey<{ route: RouteHandler }>("browser.tool-bridge"),
      );
      const browserRoute = browserRoutes({
        browser,
        append: (sessionId, type, data) => host.events.append(
          sessionId,
          type,
          data,
          { ignorable: true, producerPlugin: "review" },
        ),
        shotsDir: join(host.storageDir, "browser-shots"),
      });
      routes ??= async (request) => {
        if (await bridge.route(request)) return true;
        return browserRoute(request);
      };
    },
    async onDisable() {
      await browser.closeAll();
    },
  };
}
