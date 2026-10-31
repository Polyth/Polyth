// Uploaded raster project icons are stored inline as base64 data URLs. Base64
// image bytes do not compress, so one 320px PNG made the project list ~90 KB
// on every boot and reconnect. A client that opts in (`?iconRefs=1`) gets a
// versioned URL for such an icon instead and loads the bytes once; clients
// without the flag (older bundled shells, CLI, MCP) keep the inline value.
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

// SVG is excluded on purpose: served from this origin it could run script when
// opened directly, and the inline Iconify SVGs are small anyway.
const RASTER_ICON = /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]+={0,2})$/;
const ICON_REF_MIN_CHARS = 4096;

const iconVersion = (icon: string): string => createHash("sha256").update(icon).digest("hex").slice(0, 16);

export const projectIconRef = (projectId: string, icon: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/icon?v=${iconVersion(icon)}`;

/** The list form for an opted-in client: large raster icons become refs. */
export function withProjectIconRef<T extends { id: string; icon?: string }>(project: T): T {
  const icon = project.icon;
  if (!icon || icon.length < ICON_REF_MIN_CHARS || !RASTER_ICON.test(icon)) return project;
  return { ...project, icon: projectIconRef(project.id, icon) };
}

/** A PATCH that echoes the ref it was given means "keep the stored icon". */
export function isProjectIconRef(value: string): boolean {
  return value.startsWith("/api/projects/");
}

export function sendProjectIcon(res: ServerResponse, icon: string | undefined, version: string | null): boolean {
  const match = icon?.match(RASTER_ICON);
  if (!match) return false;
  const current = version === iconVersion(icon!);
  res.writeHead(200, {
    "content-type": match[1]!,
    // The version names exact bytes; an outdated ref still shows the current icon.
    "cache-control": current ? "private, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  res.end(Buffer.from(match[2]!, "base64"));
  return true;
}
