import type { ProjectComposition, ProjectPatch } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";
import { loadAllowlistedIconifySvg, parseAllowlistedIconifyName, type IconifyFetch } from "./iconify.ts";

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

function sanitizeProjectIconSvg(svg: string): string {
  return svg
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<(script|foreignObject)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\sxmlns:xlink\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .trim();
}

function ensureProjectIconSvgXmlns(svg: string): string {
  if (/\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/i.test(svg)) return svg;
  return svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function inlineAllowlistedIcon(name: string, svg: string, _color: string): string {
  let clean = ensureProjectIconSvgXmlns(sanitizeProjectIconSvg(svg));
  if (!/^<svg[\s>]/i.test(clean)) {
    throw Object.assign(new Error("Couldn’t prepare the selected project icon."), { code: "invalid-input" });
  }
  const openingEnd = clean.indexOf(">");
  clean = `${clean.slice(0, openingEnd + 1)}<metadata id="polyth-iconify">${name}</metadata>${clean.slice(openingEnd + 1)}`;
  return `data:image/svg+xml;base64,${Buffer.from(clean).toString("base64")}`;
}

/** Project metadata stays a contributed route, keeping the HTTP gateway a
 * transport shell while the project feature owns its writes. Composition-aware
 * onboarding uses /api/projects/setup so creation + composition is one durable
 * operation rather than a client-side create-then-PATCH sequence. */
export function projectRoutes(spaces: SpaceServicesFor, fetchImpl: IconifyFetch = fetch): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const { projects } = spaces(rc.space);

    if (path === "/api/projects/setup" && method === "POST") {
      const input = await body();
      const mode = input.mode;
      if (mode !== "add" && mode !== "create") throw invalid("mode must be add or create");
      if (typeof input.path !== "string" || !input.path.trim()) throw invalid("path is required");
      if (input.name !== undefined && typeof input.name !== "string") throw invalid("name must be text");
      const composition = input.composition as ProjectComposition | undefined;
      const project = mode === "create"
        ? await projects.create(input.path, input.name as string | undefined, composition)
        : await projects.add(input.path, input.name as string | undefined, composition);
      json(200, project);
      return true;
    }

    const settingsMatch = path.match(/^\/api\/projects\/([^/]+)\/settings$/);
    if (settingsMatch && (method === "GET" || method === "PUT")) {
      if (!projects.getPresentationSettings || !projects.putPresentationSettings) {
        throw Object.assign(new Error("project settings are unavailable"), { code: "not-supported" });
      }
      const projectId = decodeURIComponent(settingsMatch[1]!);
      if (method === "GET") {
        json(200, await projects.getPresentationSettings(projectId));
        return true;
      }
      const input = await body();
      json(200, await projects.putPresentationSettings(projectId, input.settings as Record<string, unknown>));
      return true;
    }

    const match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!match || method !== "PATCH") return false;
    if (!projects.update) throw Object.assign(new Error("project updates are unavailable"), { code: "not-supported" });
    const patch = await body() as ProjectPatch;
    if (typeof patch.icon === "string") {
      const iconifyName = parseAllowlistedIconifyName(
        patch.icon.startsWith("iconify:") ? patch.icon : (patch.icon.includes("/") ? "" : patch.icon),
      );
      if (iconifyName) {
        const svg = await loadAllowlistedIconifySvg(iconifyName, fetchImpl);
        const color = typeof patch.color === "string" ? patch.color : "#000000";
        patch.icon = inlineAllowlistedIcon(iconifyName, svg, color);
      }
    }
    json(200, await projects.update(decodeURIComponent(match[1]!), patch));
    return true;
  };
}
