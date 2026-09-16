import {
  decodeSvgDataUrl,
  ensureProjectIconSvgXmlns,
  isProjectIconBundledPath,
  isProjectIconRasterDataUrl,
  isProjectIconSvgDataUrl,
} from "./projectIconPicker.ts";
import { projectIconMaskBlobUrl } from "./projectIconLoader.ts";

export {
  isProjectIconBundledPath,
  isProjectIconRasterDataUrl,
  isProjectIconSvgDataUrl,
} from "./projectIconPicker.ts";

export type ProjectIconMaskStyle = {
  WebkitMaskImage: string;
  maskImage: string;
};

export function projectIconMaskStyle(icon: string): ProjectIconMaskStyle | null {
  if (isProjectIconBundledPath(icon)) {
    return { WebkitMaskImage: `url("${icon}")`, maskImage: `url("${icon}")` };
  }
  if (!isProjectIconSvgDataUrl(icon)) return null;
  const svg = decodeSvgDataUrl(icon);
  if (!svg || !/<svg[\s>]/i.test(svg)) return null;
  if (/\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/i.test(svg)) {
    return { WebkitMaskImage: `url("${icon}")`, maskImage: `url("${icon}")` };
  }
  return null;
}

export function projectIconSvgBlobMaskUrl(icon: string): string {
  const svg = decodeSvgDataUrl(icon);
  if (!svg) return "";
  return projectIconMaskBlobUrl(icon, ensureProjectIconSvgXmlns(svg));
}
