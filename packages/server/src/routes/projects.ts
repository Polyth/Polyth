import type { ProjectPatch } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";
import { loadAllowlistedIconifySvg, parseAllowlistedIconifyName, type IconifyFetch } from "./iconify.ts";

function sanitizeProjectIconSvg(svg: string): string {
  return svg
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<(script|foreignObject)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(?:xml)?ns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .trim();
}

function inlineAllowlistedIcon(name: string, svg: string, color: string): string {
  const ink = /^#[0-9a-f]{6}$/i.test(color) ? color.toLocaleLowerCase() : "#000000";
  let clean = sanitizeProjectIconSvg(svg).replace(/currentColor/gi, ink);
  if (!/^<svg[\s>]/i.test(clean)) {
    throw Object.assign(new Error("Couldn’t prepare the selected project icon."), { code: "invalid-input" });
  }
  const openingEnd = clean.indexOf(">");
  clean = `${clean.slice(0, openingEnd + 1)}<metadata id="polyth-iconify">${name}</metadata>${clean.slice(openingEnd + 1)}`;
  return `data:image/svg+xml;base64,${Buffer.from(clean).toString("base64")}`;
}

/** Project metadata stays a contributed route, keeping the HTTP gateway a
 * transport shell while the project feature owns its writes. */
export function projectRoutes(spaces: SpaceServicesFor, fetchImpl: IconifyFetch = fetch): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!match || method !== "PATCH") return false;
    const { projects } = spaces(rc.space);
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
