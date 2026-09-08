import type {
  AttachmentModality,
  AttachmentRef,
  FeatureSupport,
  ModelDescriptor,
  RuntimeCapabilities,
  TokenUsage,
} from "@polyth/contracts";
import { formatBrowserContextForModel } from "@polyth/contracts";

const PLACEHOLDER_TITLES = new Set([
  "",
  "new session",
  "untitled",
  "(untitled)",
  "untitled session",
  "(untitled session)",
]);

/** Derive a short session title from the first line of user text. */
export const titleFromPrompt = (text: string, max = 48): string => {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
};

/** English/ISO/uuid/ses_ placeholder detection (shell i18n extras stay in apps/web). */
export const isPlaceholderTitle = (title: string, sessionId?: string): boolean => {
  const t = title.trim();
  if (PLACEHOLDER_TITLES.has(t.toLowerCase())) return true;
  if (/^new session - \d{4}-\d{2}-\d{2}t/i.test(t)) return true;
  if (sessionId !== undefined && t === sessionId) return true;
  if (t.startsWith("ses_")) return true;
  if (/^[0-9a-f-]{8,}$/i.test(t)) return true;
  return false;
};

const floorUsage = (value: number): number => Math.max(0, value);

/** Delta between cumulative usage snapshots; floors at 0. */
export const deltaTokenUsage = (
  previousCumulative: TokenUsage | undefined,
  currentCumulative: TokenUsage,
): TokenUsage => ({
  input: floorUsage(currentCumulative.input - (previousCumulative?.input ?? 0)),
  output: floorUsage(currentCumulative.output - (previousCumulative?.output ?? 0)),
  ...(currentCumulative.reasoning !== undefined
    ? { reasoning: floorUsage(currentCumulative.reasoning - (previousCumulative?.reasoning ?? 0)) }
    : {}),
  ...(currentCumulative.cacheRead !== undefined
    ? { cacheRead: floorUsage(currentCumulative.cacheRead - (previousCumulative?.cacheRead ?? 0)) }
    : {}),
  ...(currentCumulative.cacheWrite !== undefined
    ? { cacheWrite: floorUsage(currentCumulative.cacheWrite - (previousCumulative?.cacheWrite ?? 0)) }
    : {}),
});

/** Delta cost between cumulative snapshots; undefined when no change. */
export const deltaCost = (
  previousCumulative: number | undefined,
  currentCumulative: number | undefined,
): number | undefined => {
  if (currentCumulative === undefined) return undefined;
  const prev = previousCumulative ?? 0;
  const delta = currentCumulative - prev;
  if (!Number.isFinite(delta) || delta <= 0) return undefined;
  return delta;
};

const MODEL_INPUT_MODALITIES = new Set<AttachmentModality>(["image", "pdf", "audio"]);

const browserCapture = (ref: {
  kind?: string;
  browserContext?: {
    crop?: { localPath?: string; mime?: string };
    screenshot?: { localPath?: string; mime?: string };
  };
}): { localPath: string; mime: string } | undefined => {
  if (ref.kind !== "browser-context") return undefined;
  const shot = ref.browserContext?.crop ?? ref.browserContext?.screenshot;
  if (!shot?.localPath || !shot.mime?.startsWith("image/")) return undefined;
  return { localPath: shot.localPath, mime: shot.mime };
};

/** Classify one attachment ref into a delivery modality. */
export const attachmentModality = (ref: AttachmentRef): AttachmentModality | undefined => {
  if (ref.kind === "browser-context") {
    const shot = ref.browserContext?.crop ?? ref.browserContext?.screenshot;
    if (shot?.mime?.startsWith("image/")) return "image";
    return undefined;
  }
  // Presentational `/api/files/raw` URLs on path attachments must not win over
  // mime/kind. True link attachments use kind: "url".
  if (ref.kind === "url") return "url";
  if (ref.mime?.startsWith("image/") || ref.kind === "image") return "image";
  if (ref.mime === "application/pdf") return "pdf";
  if (ref.mime?.startsWith("audio/")) return "audio";
  if (ref.path || ref.kind === "file" || ref.kind === "range") return "file";
  if (ref.url) return "url";
  return undefined;
};

const modalityFromCapability = (cap: string): AttachmentModality | undefined => {
  if (cap === "input:image") return "image";
  if (cap === "attachment" || cap === "input:file") return "file";
  if (cap === "input:pdf") return "pdf";
  if (cap === "input:audio") return "audio";
  if (cap === "input:url") return "url";
  return undefined;
};

/** Merge browser-context text into the prompt and collect materialized captures. */
export const composeTurnPrompt = (
  text: string,
  attachments?: readonly AttachmentRef[],
): { text: string; images: Array<{ localPath: string; mime: string }> } => {
  const images: Array<{ localPath: string; mime: string }> = [];
  const browserTexts: string[] = [];
  for (const ref of attachments ?? []) {
    if (ref.kind !== "browser-context") continue;
    if (ref.browserContext) browserTexts.push(formatBrowserContextForModel(ref.browserContext));
    const shot = browserCapture(ref);
    if (shot) images.push(shot);
  }
  return {
    text: browserTexts.length
      ? (text.trim() ? `${text}\n\n${browserTexts.join("\n\n")}` : browserTexts.join("\n\n"))
      : text,
    images,
  };
};

const intersectSupport = (
  a: FeatureSupport | undefined,
  b: FeatureSupport | undefined,
): FeatureSupport | undefined => {
  if (a === "unsupported" || b === "unsupported") return "unsupported";
  if (a === "emulated" || b === "emulated") return "emulated";
  if (a === "native" && b === "native") return "native";
  return undefined;
};

/** Intersection of harness capabilities, model capabilities, and remote policy. */
export const effectiveAttachmentSupport = (
  harness: RuntimeCapabilities,
  modelCapabilities: readonly string[] | undefined,
  remote: boolean,
  materializeAvailable = false,
): Partial<Record<AttachmentModality, FeatureSupport>> => {
  const harnessModalities = harness.attachments?.modalities ?? {};
  const modelModalities = new Map<AttachmentModality, FeatureSupport>();
  for (const cap of modelCapabilities ?? []) {
    const modality = modalityFromCapability(cap);
    if (modality) modelModalities.set(modality, "native");
  }
  const result: Partial<Record<AttachmentModality, FeatureSupport>> = {};
  const keys = new Set<AttachmentModality>([
    ...Object.keys(harnessModalities) as AttachmentModality[],
    ...modelModalities.keys(),
  ]);
  for (const modality of keys) {
    const harnessSupport = harnessModalities[modality];
    const modelSupport = modelModalities.get(modality);
    if (!harnessSupport || harnessSupport === "unsupported") continue;
    if (MODEL_INPUT_MODALITIES.has(modality)
      && modelCapabilities !== undefined
      && modelSupport === undefined) continue;
    if (modelSupport === "unsupported") continue;
    if (remote && (modality === "file" || modality === "pdf" || modality === "audio")) {
      if (!materializeAvailable) continue;
      const intersected = intersectSupport(harnessSupport, modelSupport ?? "native");
      if (intersected) result[modality] = intersected === "native" ? "emulated" : intersected;
      continue;
    }
    const intersected = intersectSupport(harnessSupport, modelSupport ?? "native");
    if (intersected) result[modality] = intersected;
  }
  return result;
};
