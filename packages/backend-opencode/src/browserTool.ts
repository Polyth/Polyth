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
const TOOL_NAME = "polyth_browser";

/** Per-action copy is what the model reads; titles are native tool metadata. */
const ACTION_DEFINITIONS = [
  { action: "browser.open", title: "Open a page in the browser panel", description: "Open url in the in-app browser; use it to look at the running app. Set viewport to mobile, tablet or desktop to lay the page out at that size" },
  { action: "browser.snapshot", title: "Read the open page", description: "Read the open page: url, title, visible text, and interactive elements with the selectors the other browser actions accept. Pass selector to read only that part of a long page. Reports any errors the page logged" },
  { action: "browser.click", title: "Click on the open page", description: "Click an element; give selector, or text to match a link or button by its visible label" },
  { action: "browser.type", title: "Type into the open page", description: "Type value into the field matched by selector; set submit to press Enter afterwards" },
  { action: "browser.scroll", title: "Scroll the open page", description: "Scroll the page; direction is up, down, top, or bottom, or pass selector to bring one element into view" },
  { action: "browser.back", title: "Go back in the browser panel", description: "Return to the previous page in this tab; no parameters" },
  { action: "browser.forward", title: "Go forward in the browser panel", description: "Move forward again in this tab; no parameters" },
  { action: "browser.inspect", title: "Read how an element renders", description: "Read the computed styles of the element matched by selector — colours, fonts, spacing, borders — as the page actually renders them" },
  { action: "browser.capture", title: "Save a screenshot of the page", description: "Save what is currently visible as an image file in the project and return its path, so a change can be shown rather than described. Pass label to name it (for example before-fix)" },
  { action: "browser.resize", title: "Change the page viewport", description: "Lay the open page out at a different size; viewport is mobile, tablet, desktop, or fill to use the whole panel" },
  { action: "browser.colorScheme", title: "Change the page color scheme", description: "Emulate prefers-color-scheme on the open page; colorScheme is light, dark, or no-preference" },
] as const;
type BrowserToolAction = typeof ACTION_DEFINITIONS[number]["action"];
const ACTIONS = ACTION_DEFINITIONS.map((entry) => entry.action);
const ACTION_SET = new Set<string>(ACTIONS);
const ACTION_TITLES = Object.fromEntries(
  ACTION_DEFINITIONS.map((entry) => [entry.action, entry.title]),
);

const ENGINE_UNAVAILABLE =
  "The controlled browser is not available here: no Chromium executable was found. "
  + "Set POLYTH_CHROMIUM_PATH to a Chrome or Chromium binary. Nothing was changed. "
  + "Mention this to the user only if it affects what they asked for.";

const WEB_TOOL_DESCRIPTION =
  "Look at and interact with a web page in Polyth's in-app browser so you can check your own work rather than describing what you expect. This is the only way to drive a page — there is no separate browser MCP. Use one action per call. Open a page, snapshot it to read its text and interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page is an isolated Chromium context, not the user's personal browser.";

const bareName = (action: string): string => {
  const separator = action.indexOf(".");
  return separator === -1 ? action : action.slice(separator + 1);
};

/** Models drop the `browser.` namespace once the tool is already named *browser*. */
export function resolveBrowserToolAction(requested: unknown): { action: BrowserToolAction } | { error: string } {
  const value = typeof requested === "string" ? requested.trim() : "";
  if (value && ACTION_SET.has(value)) return { action: value as BrowserToolAction };
  if (value) {
    const matches = ACTIONS.filter((candidate) => bareName(candidate) === value);
    if (matches.length === 1) return { action: matches[0]! };
  }
  return {
    error: `Unsupported browser action: ${value || "missing"}. Use one of: ${ACTIONS.join(", ")}`,
  };
}

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

const colorSchemeFor = (value: unknown, required: boolean): "light" | "dark" | "no-preference" | undefined => {
  const colorScheme = nonEmpty(value);
  if (!colorScheme) {
    if (required) throw usage("colorScheme is required for browser.colorScheme");
    return undefined;
  }
  if (colorScheme !== "light" && colorScheme !== "dark" && colorScheme !== "no-preference") {
    throw usage("colorScheme must be light, dark, or no-preference");
  }
  return colorScheme;
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
  colorScheme: session.colorScheme,
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
    const resolution = resolveBrowserToolAction(payload.action);
    if ("error" in resolution) throw usage(resolution.error);
    const action = resolution.action;
    const capability = options.browser.capability();
    if (!capability.available) {
      throw Object.assign(new Error(ENGINE_UNAVAILABLE), { code: "unavailable" });
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
      const colorScheme = colorSchemeFor(parameters.colorScheme, false);
      if (!session) {
        session = await options.browser.create({
          projectId: context.projectId,
          ...(canonicalSessionId ? { sessionId: canonicalSessionId } : {}),
          url: url.toString(),
          ...(viewport ? { viewport } : {}),
          ...(colorScheme ? { colorScheme } : {}),
        });
      } else {
        if (options.browser.agentPaused(session.id)) {
          throw Object.assign(new Error("agent control is paused for this browser session"), { code: "agent-paused" });
        }
        if (viewport) {
          session = (await options.browser.action(session.id, { kind: "resize", viewport }, "agent")).session;
        }
        if (colorScheme) {
          session = (await options.browser.action(session.id, { kind: "color-scheme", colorScheme }, "agent")).session;
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
    } else if (action === "browser.colorScheme") {
      browserAction = { kind: "color-scheme", colorScheme: colorSchemeFor(parameters.colorScheme, true)! };
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
      const path = relativePath.split("\\").join("/");
      return {
        ...publicSession(options.browser.get(session.id) ?? session),
        path,
        mime: observation.screenshot.mime,
        hint: `Write ![](${path}) in your reply to show this image to the user; it is rendered under your message.`,
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
      const requested = nonEmpty((body as { action?: unknown }).action);
      const resolved = resolveBrowserToolAction(requested);
      const reported = "action" in resolved ? resolved.action : requested ?? "unknown";
      try {
        const data = await execute(registration, body as BrowserToolPayload);
        rc.json(200, {
          schemaVersion: TOOL_SCHEMA_VERSION,
          ok: true,
          action: reported,
          data,
        });
      } catch (error) {
        const e = error as Error & { code?: string };
        rc.json(200, {
          schemaVersion: TOOL_SCHEMA_VERSION,
          ok: false,
          action: reported,
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
    url: { type: "string", description: "http(s) URL for browser.open" },
    selector: { type: "string", description: "CSS selector from a browser.snapshot result" },
    text: { type: "string", description: "Visible label to match when no selector is given" },
    exact: { type: "boolean", description: "Require an exact visible-label match for browser.click" },
    value: { type: "string", description: "Text to type for browser.type" },
    submit: { type: "boolean", description: "Press Enter after typing" },
    direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction for browser.scroll" },
    viewport: { type: "string", enum: ["mobile", "tablet", "desktop", "fill"], description: "Page layout size; snapshots report which one is in effect" },
    colorScheme: { type: "string", enum: ["light", "dark", "no-preference"], description: "prefers-color-scheme emulation for browser.colorScheme" },
    label: { type: "string", description: "Short name for a browser.capture image, such as before-fix" },
  };
  const actionSchema = {
    type: "string",
    enum: ACTIONS,
    oneOf: ACTION_DEFINITIONS.map((entry) => ({ const: entry.action, description: entry.description })),
    description: "Browser action to perform",
  };
  return `export const PolythBrowserPlugin = async () => ({
  tool: {
    ${TOOL_NAME}: {
      description: ${JSON.stringify(WEB_TOOL_DESCRIPTION)},
      args: {
        action: ${JSON.stringify(actionSchema)},
        parameters: { type: "object", properties: ${JSON.stringify(parameters)}, additionalProperties: false, description: "Inputs for the action; use an empty object when none are needed" },
      },
      async execute(input, context) {
        const { action: requestedAction, parameters, ...flattened } = input ?? {}
        const resolvedParameters = { ...flattened, ...(parameters ?? {}) }
        const actionTitles = ${JSON.stringify(ACTION_TITLES)}
        const title = actionTitles[requestedAction]
          ?? actionTitles["browser." + requestedAction]
          ?? requestedAction
        if (typeof context.metadata === "function") {
          context.metadata({
            title,
            metadata: {
              ${TOOL_NAME}: {
                schemaVersion: ${TOOL_SCHEMA_VERSION},
                action: requestedAction,
                description: title,
              },
            },
          })
        }
        const endpoint = process.env.POLYTH_BROWSER_TOOL_URL
        const token = process.env.POLYTH_BROWSER_TOOL_TOKEN
        const failure = (payload) => ({
          title,
          output: JSON.stringify(payload),
          metadata: { polyth: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: requestedAction, description: title, ok: false } },
        })
        if (!endpoint || !token) {
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: requestedAction ?? "unknown", error: { message: "Polyth browser tool connection is unavailable", kind: "runtime" } })
        }
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { authorization: "Bearer " + token, "content-type": "application/json" },
            body: JSON.stringify({
              action: requestedAction,
              parameters: resolvedParameters,
              tool: ${JSON.stringify(TOOL_NAME)},
              context: { sessionID: context.sessionID, directory: context.directory },
            }),
            signal: context.abort,
          })
          const output = await response.text()
          let result = null
          try { result = JSON.parse(output) } catch {}
          const valid = result?.schemaVersion === ${TOOL_SCHEMA_VERSION} && typeof result?.ok === "boolean" && typeof result?.action === "string"
          if (typeof context.metadata === "function") {
            context.metadata({
              title,
              metadata: {
                ${TOOL_NAME}: {
                  schemaVersion: ${TOOL_SCHEMA_VERSION},
                  action: requestedAction,
                  description: title,
                  ok: valid && result.ok === true,
                },
              },
            })
          }
          if (valid) {
            return { title, output, metadata: { polyth: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: result.action, description: title, ok: result.ok === true } } }
          }
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: requestedAction ?? "unknown", error: { message: "Polyth returned an invalid response", kind: "runtime", status: response.status } })
        } catch (error) {
          if (context.abort?.aborted) throw error
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: requestedAction ?? "unknown", error: { message: error instanceof Error ? error.message : String(error), kind: "runtime" } })
        }
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
