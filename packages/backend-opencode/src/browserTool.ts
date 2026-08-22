import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage } from "node:http";
import type { BrowserService } from "@polyth/browser";
import type { BrowserAction, BrowserSessionDto, JsonObject } from "@polyth/contracts";
import { stripJsonc } from "./config.ts";

export const BROWSER_TOOL_PATH = "/internal/opencode/browser-tool";
const TOOL_SCHEMA_VERSION = 1;
const ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
] as const;
type BrowserToolAction = typeof ACTIONS[number];

const ACTION_SET = new Set<string>(ACTIONS);
const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
  fill: { width: 1280, height: 800 },
} as const;

export interface OpenCodeBrowserToolConfig {
  endpoint: string;
  token: string;
  pluginDirectory: string;
}

export interface BrowserToolRegistration {
  token: string;
  dispose(): void;
}

interface BrowserToolContext {
  projectId: string;
  cwd: string;
}

interface BrowserToolPayload {
  action?: unknown;
  parameters?: unknown;
  context?: {
    sessionID?: unknown;
    directory?: unknown;
  };
}

interface BrowserToolRouteRequest {
  req: IncomingMessage;
  path: string;
  method: string;
  body(): Promise<Record<string, unknown>>;
  json(code: number, body: unknown): void;
}

export interface BrowserToolBridge {
  register(context: BrowserToolContext): BrowserToolRegistration;
  route(rc: BrowserToolRouteRequest): Promise<boolean>;
  execute(token: string, payload: BrowserToolPayload): Promise<JsonObject>;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const nonEmpty = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const usage = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const targetFor = (parameters: Record<string, unknown>) => {
  const selector = nonEmpty(parameters.selector);
  if (selector) return { selector };
  const text = nonEmpty(parameters.text);
  if (text) return { text, exact: parameters.exact === true };
  throw usage("browser.click requires selector or text");
};

const viewportFor = (value: unknown, required: boolean): { width: number; height: number } | undefined => {
  const name = nonEmpty(value);
  if (!name) {
    if (required) throw usage("viewport is required for browser.resize");
    return undefined;
  }
  if (!(name in VIEWPORTS)) throw usage("viewport must be mobile, tablet, desktop, or fill");
  return VIEWPORTS[name as keyof typeof VIEWPORTS];
};

const slug = (value: unknown): string => {
  const normalized = String(value ?? "page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || "page";
};

const loopback = (address: string | undefined): boolean => {
  const value = (address ?? "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
};

const sameToken = (provided: string, expected: string): boolean => {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

const publicSession = (session: BrowserSessionDto): JsonObject => ({
  browserSessionId: session.id,
  url: session.url,
  title: session.title,
  viewport: {
    width: session.viewport.width,
    height: session.viewport.height,
  },
  revision: session.revision,
});

export function createBrowserToolBridge(options: {
  browser: BrowserService;
  canonicalSessionId?: (backendSessionId: string) => string | undefined;
  now?: () => Date;
}): BrowserToolBridge {
  const registrations = new Map<string, BrowserToolContext>();
  const now = options.now ?? (() => new Date());

  const registrationOf = (token: string): BrowserToolContext => {
    const context = registrations.get(token);
    if (!context) throw Object.assign(new Error("browser tool registration is unavailable"), { code: "unauthorized" });
    return context;
  };

  const sessionFor = (context: BrowserToolContext, backendSessionId: string | null): BrowserSessionDto | null => {
    const canonical = backendSessionId ? options.canonicalSessionId?.(backendSessionId) : undefined;
    const candidates = options.browser.list().filter(
      (session) => session.projectId === context.projectId && session.status !== "closed",
    );
    return (canonical ? candidates.find((session) => session.sessionId === canonical) : undefined)
      ?? candidates.at(-1)
      ?? null;
  };

  const execute = async (token: string, payload: BrowserToolPayload): Promise<JsonObject> => {
    const context = registrationOf(token);
    const action = nonEmpty(payload.action);
    if (!action || !ACTION_SET.has(action)) {
      throw usage(`Unsupported browser action: ${action ?? "missing"}. Use one of: ${ACTIONS.join(", ")}`);
    }
    const parameters = asObject(payload.parameters);
    const backendSessionId = nonEmpty(payload.context?.sessionID);
    const canonicalSessionId = backendSessionId
      ? options.canonicalSessionId?.(backendSessionId)
      : undefined;
    let session = sessionFor(context, backendSessionId);

    if (action === "browser.open") {
      const rawUrl = nonEmpty(parameters.url);
      if (!rawUrl) throw usage("url is required for browser.open");
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw usage("url must be an absolute http(s) URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw usage("url must use http or https");
      }
      const viewport = viewportFor(parameters.viewport, false);
      if (!session) {
        session = await options.browser.create({
          projectId: context.projectId,
          ...(canonicalSessionId ? { sessionId: canonicalSessionId } : {}),
          url: url.toString(),
          ...(viewport ? { viewport } : {}),
        });
      } else {
        if (options.browser.agentPaused(session.id)) {
          throw Object.assign(new Error("agent control is paused for this browser session"), { code: "agent-paused" });
        }
        if (viewport) {
          session = (await options.browser.action(session.id, { kind: "resize", viewport }, "agent")).session;
        }
        session = await options.browser.navigate(session.id, url.toString(), "agent");
      }
      return publicSession(session);
    }

    if (!session) {
      throw usage("No controlled browser is open for this project. Call browser.open first.");
    }
    if (options.browser.agentPaused(session.id)) {
      throw Object.assign(new Error("agent control is paused for this browser session"), { code: "agent-paused" });
    }

    if (action === "browser.snapshot") {
      const selector = nonEmpty(parameters.selector) ?? undefined;
      const observation = await options.browser.observe(session.id, selector ? { selector } : undefined);
      const errors = options.browser.console(session.id)
        .filter((entry) => entry.level === "error")
        .slice(-20)
        .map((entry) => entry.message);
      return {
        ...publicSession(options.browser.get(session.id) ?? session),
        text: observation.text,
        accessibility: observation.accessibilityDigest ?? "",
        ...(selector ? { selector } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };
    }

    let browserAction: BrowserAction | null = null;
    if (action === "browser.click") {
      browserAction = { kind: "click", target: targetFor(parameters) };
    } else if (action === "browser.type") {
      const selector = nonEmpty(parameters.selector);
      if (!selector) throw usage("selector is required for browser.type");
      if (typeof parameters.value !== "string") throw usage("value is required for browser.type");
      browserAction = {
        kind: "type",
        target: { selector },
        text: parameters.value,
        submit: parameters.submit === true,
      };
    } else if (action === "browser.scroll") {
      const selector = nonEmpty(parameters.selector);
      const direction = nonEmpty(parameters.direction);
      if (selector) {
        browserAction = { kind: "scroll", target: { selector } };
      } else if (direction === "up" || direction === "down") {
        browserAction = { kind: "scroll", y: direction === "up" ? -600 : 600 };
      } else if (direction === "top" || direction === "bottom") {
        browserAction = { kind: "press", key: direction === "top" ? "Home" : "End" };
      } else {
        throw usage("browser.scroll requires selector or direction: up, down, top, or bottom");
      }
    } else if (action === "browser.back") {
      browserAction = { kind: "back" };
    } else if (action === "browser.forward") {
      browserAction = { kind: "forward" };
    } else if (action === "browser.inspect") {
      const selector = nonEmpty(parameters.selector);
      if (!selector) throw usage("selector is required for browser.inspect");
      browserAction = { kind: "inspect", selector };
    } else if (action === "browser.resize") {
      browserAction = { kind: "resize", viewport: viewportFor(parameters.viewport, true)! };
    }

    if (action === "browser.capture") {
      const observation = await options.browser.observe(session.id, { includeScreenshot: true });
      if (!observation.screenshot) throw new Error("the browser returned no screenshot");
      const extension = observation.screenshot.mime.includes("png")
        ? "png"
        : observation.screenshot.mime.includes("webp") ? "webp" : "jpg";
      const stamp = now().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      const relativePath = join(".polyth", "screenshots", `${slug(parameters.label)}-${stamp}.${extension}`);
      const absolutePath = resolve(context.cwd, relativePath);
      const rel = relative(resolve(context.cwd), absolutePath);
      if (rel.startsWith("..")) throw new Error("screenshot path escaped the project");
      await mkdir(resolve(context.cwd, ".polyth", "screenshots"), { recursive: true });
      await writeFile(absolutePath, observation.screenshot.data);
      return {
        ...publicSession(options.browser.get(session.id) ?? session),
        path: relativePath.split("\\").join("/"),
        mime: observation.screenshot.mime,
      };
    }

    if (!browserAction) throw usage(`Unsupported browser action: ${action}`);
    const result = await options.browser.action(session.id, browserAction, "agent");
    return {
      ...publicSession(result.session),
      ...(result.result ? { result: result.result } : {}),
    };
  };

  return {
    register(context) {
      const token = randomBytes(32).toString("base64url");
      registrations.set(token, { projectId: context.projectId, cwd: resolve(context.cwd) });
      return {
        token,
        dispose: () => { registrations.delete(token); },
      };
    },
    execute,
    async route(rc) {
      if (rc.path !== BROWSER_TOOL_PATH) return false;
      if (rc.method !== "POST") {
        rc.json(405, { error: "method-not-allowed" });
        return true;
      }
      const header = rc.req.headers.authorization;
      const provided = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : "";
      const registration = [...registrations.keys()].find((token) => sameToken(provided, token));
      if (!registration || !loopback(rc.req.socket.remoteAddress)) {
        rc.json(401, { error: "unauthorized" });
        return true;
      }
      const body = await rc.body();
      try {
        const data = await execute(registration, body as BrowserToolPayload);
        rc.json(200, {
          schemaVersion: TOOL_SCHEMA_VERSION,
          ok: true,
          action: nonEmpty(body.action) ?? "unknown",
          data,
        });
      } catch (error) {
        const e = error as Error & { code?: string };
        rc.json(200, {
          schemaVersion: TOOL_SCHEMA_VERSION,
          ok: false,
          action: nonEmpty(body.action) ?? "unknown",
          error: {
            message: e.message,
            kind: e.code === "invalid-input" ? "usage" : "runtime",
          },
        });
      }
      return true;
    },
  };
}

export function createBrowserToolPluginSource(): string {
  const parameters = {
    url: { type: "string", description: "Absolute http(s) URL for browser.open" },
    selector: { type: "string", description: "CSS selector from the page" },
    text: { type: "string", description: "Visible label for browser.click" },
    exact: { type: "boolean" },
    value: { type: "string", description: "Text for browser.type" },
    submit: { type: "boolean" },
    direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
    viewport: { type: "string", enum: ["mobile", "tablet", "desktop", "fill"] },
    label: { type: "string", description: "Short filename label for browser.capture" },
  };
  return `export const PolythBrowserPlugin = async () => ({
  tool: {
    polyth_browser: {
      description: ${JSON.stringify("Look at and interact with the controlled browser shared with Polyth. Use one browser.* action per call. Open a page, snapshot it, then use selectors to click, type, scroll, inspect, capture, or resize.")},
      args: {
        action: { type: "string", enum: ${JSON.stringify(ACTIONS)}, description: "Browser action to perform" },
        parameters: { type: "object", properties: ${JSON.stringify(parameters)}, additionalProperties: false, description: "Action inputs; use an empty object when none are needed" },
      },
      async execute(input, context) {
        const endpoint = process.env.POLYTH_BROWSER_TOOL_URL
        const token = process.env.POLYTH_BROWSER_TOOL_TOKEN
        const { action, parameters, ...flattened } = input ?? {}
        const resolvedParameters = { ...flattened, ...(parameters ?? {}) }
        if (!endpoint || !token) return JSON.stringify({ schemaVersion: 1, ok: false, action: action ?? "unknown", error: { message: "Polyth browser tool connection is unavailable", kind: "runtime" } })
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ action, parameters: resolvedParameters, context: { sessionID: context.sessionID, directory: context.directory } }),
          signal: context.abort,
        })
        return await response.text()
      },
    },
  },
})
`;
}

export async function prepareBrowserToolEnvironment(
  config: OpenCodeBrowserToolConfig,
  baseEnv: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  await mkdir(config.pluginDirectory, { recursive: true });
  const pluginPath = join(config.pluginDirectory, "polyth-browser-plugin.js");
  await writeFile(pluginPath, createBrowserToolPluginSource(), { encoding: "utf8", mode: 0o600 });
  const existingRaw = baseEnv.OPENCODE_CONFIG_CONTENT;
  let existing: Record<string, unknown> = {};
  if (existingRaw?.trim()) {
    const parsed = JSON.parse(stripJsonc(existingRaw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object before injecting the browser tool");
    }
    existing = parsed as Record<string, unknown>;
  }
  const pluginUrl = pathToFileURL(pluginPath).href;
  const configured = Array.isArray(existing.plugin) ? existing.plugin : [];
  const plugins = [
    ...configured.filter((entry) => entry !== pluginUrl && (!Array.isArray(entry) || entry[0] !== pluginUrl)),
    pluginUrl,
  ];
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...existing, plugin: plugins }),
    POLYTH_BROWSER_TOOL_URL: config.endpoint,
    POLYTH_BROWSER_TOOL_TOKEN: config.token,
  };
}
