import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  AgentCapabilityContribution,
  BrowserAction,
  BrowserSessionDto,
  JsonObject,
  ToolExecutionContext,
} from "@polyth/contracts";
import type { BrowserService } from "./index.ts";

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
  "browser.colorScheme",
] as const;
type BrowserToolAction = typeof ACTIONS[number];
const ACTION_SET = new Set<string>(ACTIONS);

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
  fill: { width: 1280, height: 800 },
} as const;

const DESCRIPTION =
  "Open, read, and interact with a page in Polyth's controlled in-app browser. Use browser.open first, then browser.snapshot before clicking or typing. The browser is an isolated project-scoped Chromium context, not the user's personal browser.";

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Absolute http(s) URL for browser.open" },
        selector: { type: "string", description: "CSS selector returned by browser.snapshot" },
        text: { type: "string", description: "Visible label for browser.click" },
        exact: { type: "boolean" },
        value: { type: "string", description: "Text for browser.type" },
        submit: { type: "boolean" },
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        viewport: { type: "string", enum: ["mobile", "tablet", "desktop", "fill"] },
        colorScheme: { type: "string", enum: ["light", "dark", "no-preference"] },
        label: { type: "string", description: "Short filename label for browser.capture" },
      },
    },
  },
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const resolveAction = (value: unknown): BrowserToolAction => {
  const requested = text(value);
  if (requested && ACTION_SET.has(requested)) return requested as BrowserToolAction;
  if (requested) {
    const matches = ACTIONS.filter((action) => action.slice("browser.".length) === requested);
    if (matches.length === 1) return matches[0]!;
  }
  throw invalid(`Unsupported browser action: ${requested ?? "missing"}. Use one of: ${ACTIONS.join(", ")}`);
};

const viewport = (value: unknown, required: boolean): { width: number; height: number } | undefined => {
  const name = text(value);
  if (!name) {
    if (required) throw invalid("viewport is required for browser.resize");
    return undefined;
  }
  if (!(name in VIEWPORTS)) throw invalid("viewport must be mobile, tablet, desktop, or fill");
  return VIEWPORTS[name as keyof typeof VIEWPORTS];
};

const colorScheme = (value: unknown, required: boolean): "light" | "dark" | "no-preference" | undefined => {
  const scheme = text(value);
  if (!scheme) {
    if (required) throw invalid("colorScheme is required for browser.colorScheme");
    return undefined;
  }
  if (scheme !== "light" && scheme !== "dark" && scheme !== "no-preference") {
    throw invalid("colorScheme must be light, dark, or no-preference");
  }
  return scheme;
};

const target = (parameters: Record<string, unknown>) => {
  const selector = text(parameters.selector);
  if (selector) return { selector };
  const label = text(parameters.text);
  if (label) return { text: label, exact: parameters.exact === true };
  throw invalid("browser.click requires selector or text");
};

const publicSession = (session: BrowserSessionDto): JsonObject => ({
  browserSessionId: session.id,
  url: session.url,
  title: session.title,
  viewport: { width: session.viewport.width, height: session.viewport.height },
  colorScheme: session.colorScheme,
  revision: session.revision,
});

const slug = (value: unknown): string => String(value ?? "page")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48)
  .replace(/-+$/g, "") || "page";

export function createBrowserAgentTool(
  browser: BrowserService,
  now: () => Date = () => new Date(),
): AgentCapabilityContribution {
  const execute = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    if (ctx.signal?.aborted) throw Object.assign(new Error("browser action aborted"), { code: "aborted" });
    const action = resolveAction(input.action);
    const parameters = object(input.parameters);
    const capability = browser.capability();
    if (!capability.available) {
      throw Object.assign(new Error(capability.reason ?? "controlled browser unavailable"), { code: "unavailable" });
    }
    const candidates = browser.list().filter((session) =>
      session.projectId === ctx.projectId && session.status !== "closed");
    let session = candidates.find((candidate) => candidate.sessionId === ctx.sessionId)
      ?? candidates.at(-1)
      ?? null;

    if (action === "browser.open") {
      const rawUrl = text(parameters.url);
      if (!rawUrl) throw invalid("url is required for browser.open");
      let url: URL;
      try { url = new URL(rawUrl); } catch { throw invalid("url must be an absolute http(s) URL"); }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("url must use http or https");
      const nextViewport = viewport(parameters.viewport, false);
      const nextScheme = colorScheme(parameters.colorScheme, false);
      if (!session) {
        session = await browser.create({
          projectId: ctx.projectId,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          url: url.toString(),
          ...(nextViewport ? { viewport: nextViewport } : {}),
          ...(nextScheme ? { colorScheme: nextScheme } : {}),
        });
      } else {
        if (browser.agentPaused(session.id)) throw Object.assign(new Error("agent control is paused for this browser session"), { code: "agent-paused" });
        if (nextViewport) session = (await browser.action(session.id, { kind: "resize", viewport: nextViewport }, "agent")).session;
        if (nextScheme) session = (await browser.action(session.id, { kind: "color-scheme", colorScheme: nextScheme }, "agent")).session;
        session = await browser.navigate(session.id, url.toString(), "agent");
      }
      return { output: JSON.stringify(publicSession(session)), metadata: { action } };
    }

    if (!session) throw invalid("No controlled browser is open for this project. Call browser.open first.");
    if (browser.agentPaused(session.id)) throw Object.assign(new Error("agent control is paused for this browser session"), { code: "agent-paused" });

    if (action === "browser.snapshot") {
      const selector = text(parameters.selector);
      const observation = await browser.observe(session.id, selector ? { selector } : undefined);
      const errors = browser.console(session.id).filter((entry) => entry.level === "error").slice(-20).map((entry) => entry.message);
      return {
        output: JSON.stringify({
          ...publicSession(browser.get(session.id) ?? session),
          text: observation.text,
          accessibility: observation.accessibilityDigest ?? "",
          ...(selector ? { selector } : {}),
          ...(errors.length ? { errors } : {}),
        }),
        metadata: { action },
      };
    }

    if (action === "browser.capture") {
      const observation = await browser.observe(session.id, { includeScreenshot: true });
      if (!observation.screenshot) throw new Error("the browser returned no screenshot");
      const extension = observation.screenshot.mime.includes("png")
        ? "png" : observation.screenshot.mime.includes("webp") ? "webp" : "jpg";
      const stamp = now().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      const relativePath = join(".polyth", "screenshots", `${slug(parameters.label)}-${stamp}.${extension}`);
      const absolutePath = resolve(ctx.cwd, relativePath);
      const bounded = relative(resolve(ctx.cwd), absolutePath);
      if (bounded.startsWith("..") || resolve(ctx.cwd, bounded) !== absolutePath) throw new Error("screenshot path escaped the project");
      await mkdir(resolve(ctx.cwd, ".polyth", "screenshots"), { recursive: true });
      await writeFile(absolutePath, observation.screenshot.data);
      const path = relativePath.split("\\").join("/");
      return {
        output: JSON.stringify({
          ...publicSession(browser.get(session.id) ?? session),
          path,
          mime: observation.screenshot.mime,
          hint: `Write ![](${path}) in your reply to show this image to the user.`,
        }),
        metadata: { action },
      };
    }

    let browserAction: BrowserAction;
    if (action === "browser.click") browserAction = { kind: "click", target: target(parameters) };
    else if (action === "browser.type") {
      const selector = text(parameters.selector);
      if (!selector) throw invalid("selector is required for browser.type");
      if (typeof parameters.value !== "string") throw invalid("value is required for browser.type");
      browserAction = { kind: "type", target: { selector }, text: parameters.value, submit: parameters.submit === true };
    } else if (action === "browser.scroll") {
      const selector = text(parameters.selector);
      const direction = text(parameters.direction);
      if (selector) browserAction = { kind: "scroll", target: { selector } };
      else if (direction === "up" || direction === "down") browserAction = { kind: "scroll", y: direction === "up" ? -600 : 600 };
      else if (direction === "top" || direction === "bottom") browserAction = { kind: "press", key: direction === "top" ? "Home" : "End" };
      else throw invalid("browser.scroll requires selector or direction: up, down, top, or bottom");
    } else if (action === "browser.back") browserAction = { kind: "back" };
    else if (action === "browser.forward") browserAction = { kind: "forward" };
    else if (action === "browser.inspect") {
      const selector = text(parameters.selector);
      if (!selector) throw invalid("selector is required for browser.inspect");
      browserAction = { kind: "inspect", selector };
    } else if (action === "browser.resize") browserAction = { kind: "resize", viewport: viewport(parameters.viewport, true)! };
    else if (action === "browser.colorScheme") browserAction = { kind: "color-scheme", colorScheme: colorScheme(parameters.colorScheme, true)! };
    else throw invalid(`Unsupported browser action: ${action}`);

    const result = await browser.action(session.id, browserAction, "agent");
    return {
      output: JSON.stringify({ ...publicSession(result.session), ...(result.result ? { result: result.result } : {}) }),
      metadata: { action },
    };
  };

  return {
    descriptor: {
      id: "browser.polyth-browser",
      kind: "tool",
      owner: "browser",
      scope: "project",
      revision: "1",
      name: "polyth_browser",
      description: DESCRIPTION,
      inputSchema,
      trust: "device",
      mutating: true,
    },
    execute,
  };
}
