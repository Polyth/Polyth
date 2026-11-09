// How one attachment reaches the model. The planner is the single decision
// point shared by admission and the adapters: given the effective support map
// (harness ∩ model ∩ remote policy) it says whether a ref is delivered natively,
// emulated by a server-side text projection, or refused with a product-level
// reason. Adapters never invent their own answer, so the UI can never show a
// control whose attachment is dropped later.
import { attachmentModality } from "@polyth/contracts";
import type { AttachmentModality, AttachmentRef, FeatureSupport, TurnRejectionCode } from "@polyth/contracts";
import { extractPdfText, type PdfTextFailure } from "./pdfText.ts";

export type AttachmentDeliveryPlan =
  /** Hand the ref to the adapter unchanged; the harness delivers it. */
  | { kind: "native"; modality: AttachmentModality }
  /** The harness emulates this modality itself (for example an URL fetched
   *  into the prompt by the backend). Still a pass-through for the adapter. */
  | { kind: "harness-emulated"; modality: AttachmentModality }
  /** Read server-side and appended to the prompt as a delimited text section
   *  (a PDF contributes its extracted text layer). The ref must NOT be
   *  forwarded to the adapter. */
  | { kind: "text-projection"; modality: "file" | "pdf" }
  /** Nothing to deliver (browser context is merged into the prompt text). */
  | { kind: "prompt-merged"; modality?: AttachmentModality }
  /** The engine cannot take this content, but the uploaded file sits in the
   *  agent's workspace: Polyth names its path in the prompt so the agent can
   *  open it with its own tools, or tell the person it cannot. The ref must
   *  NOT be forwarded to the adapter. */
  | { kind: "file-reference"; modality: AttachmentModality }
  | { kind: "unsupported"; modality?: AttachmentModality; code: TurnRejectionCode; reason: string };

const MODALITY_NOUN: Record<AttachmentModality, string> = {
  image: "Image",
  file: "File",
  pdf: "PDF",
  audio: "Audio",
  url: "Link",
};

/** Human sentence for a refused attachment — names the engine, not the adapter. */
export const unsupportedAttachmentMessage = (
  modality: AttachmentModality | undefined,
  harnessName: string,
): string => modality
  ? `${MODALITY_NOUN[modality]} attachments are not supported by the ${harnessName} engine.`
  : `This attachment type is not supported by the ${harnessName} engine.`;

export interface AttachmentDeliveryInput {
  ref: AttachmentRef;
  /** Result of `effectiveAttachmentSupport` for the turn's harness and model. */
  support: Partial<Record<AttachmentModality, FeatureSupport>>;
  /** Display name of the resolved harness, used in refusal messages. */
  harnessName: string;
  /** False when the harness declares no attachment support at all, in which
   *  case Polyth cannot claim a refusal it has not verified. */
  supportDeclared?: boolean;
  /** `effectiveAttachmentDelivery(...).projected`: modalities Polyth converts
   *  to prompt text itself because neither harness nor model takes them. */
  projected?: readonly AttachmentModality[];
  /** True when an uploaded file lives where the agent works (a local project,
   *  or a remote one Polyth materializes into). Then a modality the engine
   *  cannot take is handed over as a path instead of being refused. */
  referenceable?: boolean;
}

/** Whether a ref names an uploaded or project file the agent could open. */
const isFileRef = (ref: AttachmentRef): boolean =>
  Boolean(ref.path) && ref.kind !== "url" && ref.kind !== "browser-context";

export function planAttachmentDelivery(input: AttachmentDeliveryInput): AttachmentDeliveryPlan {
  const { ref, support, harnessName } = input;
  if (ref.kind === "browser-context") {
    const shot = ref.browserContext?.crop ?? ref.browserContext?.screenshot;
    const modality = attachmentModality(ref);
    if (!shot || !modality) return { kind: "prompt-merged" };
    return support.image === "native" || support.image === "emulated"
      ? { kind: "native", modality: "image" }
      : { kind: "prompt-merged", modality: "image" };
  }
  const modality = attachmentModality(ref);
  if (!modality) {
    return {
      kind: "unsupported",
      code: "invalid-attachment",
      reason: `${ref.name} is not a kind of attachment Polyth can deliver.`,
    };
  }
  if (modality === "pdf" && input.projected?.includes("pdf")) return { kind: "text-projection", modality: "pdf" };
  const level = support[modality];
  if (level === undefined || level === "unsupported") {
    // Compatibility for older runtimes with no declaration is deliberately
    // narrow: ordinary UTF-8 text can use Polyth's guarded projection. Unknown
    // binary/native modalities are never forwarded on an assumption.
    if (level === undefined && input.supportDeclared === false && modality === "file"
        && (ref.mime?.startsWith("text/") || ref.mime === "application/json")) {
      return { kind: "text-projection", modality: "file" };
    }
    if (input.referenceable && isFileRef(ref)) return { kind: "file-reference", modality };
    return {
      kind: "unsupported",
      modality,
      code: "unsupported",
      reason: unsupportedAttachmentMessage(modality, harnessName),
    };
  }
  if (modality === "file" && level === "emulated") return { kind: "text-projection", modality: "file" };
  return level === "emulated"
    ? { kind: "harness-emulated", modality }
    : { kind: "native", modality };
}

// ---------------------------------------------------------------- projection

/** Per-file ceiling for an emulated text projection. */
export const TEXT_PROJECTION_MAX_BYTES = 64 * 1024;

export type TextProjection =
  | { ok: true; section: string; truncatedBytes: number }
  | { ok: false; code: TurnRejectionCode; reason: string };

const NUL = 0;

export type TextMaterialization =
  | { ok: true; content: string; truncatedBytes: number }
  | { ok: false; code: TurnRejectionCode; reason: string };

/** Longest complete UTF-8 prefix of `bytes` no longer than `limit` bytes. */
const utf8Prefix = (bytes: Uint8Array, limit: number): Uint8Array => {
  if (bytes.length <= limit) return bytes;
  let end = limit;
  // A continuation byte is 10xxxxxx; walk back to the lead byte that starts
  // the sequence straddling the cut so the decode never yields U+FFFD.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
};

const decodeStrict = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Fence long enough that the file's own backticks cannot close it. */
const fenceFor = (content: string): string => {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
};

export interface TextProjectionInput {
  /** Project-relative path, used verbatim in the section header. */
  path: string;
  /** 1-based inclusive line range for a `range` attachment. */
  range?: readonly [number, number];
  bytes: Uint8Array;
  maxBytes?: number;
}

/** Select a line range before applying the byte ceiling. This keeps a late
 * range reachable without ever decoding or retaining an unbounded string. */
const rangedBytes = (bytes: Uint8Array, range: readonly [number, number]): Uint8Array => {
  const from = Math.max(1, Math.trunc(range[0]));
  const to = Math.max(from, Math.trunc(range[1]));
  let line = 1;
  let start = from === 1 ? 0 : bytes.length;
  let end = bytes.length;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    line += 1;
    if (line === from) start = index + 1;
    if (line === to + 1) { end = index; break; }
  }
  return bytes.subarray(start, Math.max(start, end));
};

/** Canonical bounded UTF-8 materialization shared by prompt projection and
 * adapters that transport text in a native resource block. */
export function materializeAttachmentText(input: TextProjectionInput): TextMaterialization {
  const limit = input.maxBytes ?? TEXT_PROJECTION_MAX_BYTES;
  if (input.bytes.includes(NUL)) {
    return {
      ok: false,
      code: "invalid-attachment",
      reason: `${input.path} looks like a binary file, so its text cannot be attached.`,
    };
  }
  const selected = input.range ? rangedBytes(input.bytes, input.range) : input.bytes;
  const kept = utf8Prefix(selected, limit);
  const decoded = decodeStrict(kept);
  if (decoded === undefined) {
    return {
      ok: false,
      code: "invalid-attachment",
      reason: `${input.path} is not UTF-8 text, so it cannot be attached.`,
    };
  }
  return { ok: true, content: decoded, truncatedBytes: selected.length - kept.length };
}

/**
 * Render one file as a delimited prompt section. Deterministic for identical
 * input: head truncation on a UTF-8 boundary with an explicit byte count, and
 * a binary file is refused rather than smuggled in as mojibake.
 */
export function projectAttachmentText(input: TextProjectionInput): TextProjection {
  const materialized = materializeAttachmentText(input);
  if (!materialized.ok) return materialized;
  const { content, truncatedBytes } = materialized;
  const header = input.range
    ? `${input.path} (lines ${Math.trunc(input.range[0])}-${Math.trunc(input.range[1])})`
    : input.path;
  const fence = fenceFor(content);
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const section = [
    `Attached file: ${header}`,
    fence,
    body,
    fence,
    ...(truncatedBytes > 0 ? [`[truncated ${truncatedBytes} bytes]`] : []),
  ].join("\n");
  return { ok: true, section, truncatedBytes };
}

/** Per-PDF ceiling for its projected text layer; a document runs longer than
 *  a source file, so it gets more room before the head is truncated. */
export const PDF_PROJECTION_MAX_BYTES = 128 * 1024;

const PDF_FAILURE: Record<PdfTextFailure, (path: string) => string> = {
  "malformed": (path) => `${path} is not a readable PDF, so its text cannot be attached.`,
  "encrypted": (path) => `${path} is password-protected, so its text cannot be attached.`,
  "no-text": (path) => `${path} has no text layer (it may be a scan), so its text cannot be attached.`,
  "too-large": (path) => `${path} is too large for Polyth to extract its text.`,
};

export interface PdfProjectionInput {
  /** Project-relative path, used verbatim in the section header. */
  path: string;
  bytes: Uint8Array;
  maxBytes?: number;
}

/**
 * Render a PDF's text layer as one delimited prompt section, for a harness or
 * model that cannot take the document natively. Pages are marked so the model
 * can cite them; truncation keeps the head and states the dropped bytes.
 */
export function projectAttachmentPdf(input: PdfProjectionInput): TextProjection {
  const limit = input.maxBytes ?? PDF_PROJECTION_MAX_BYTES;
  // Stop extracting well past the ceiling instead of decoding a whole book.
  const extracted = extractPdfText(input.bytes, { maxChars: limit * 2 });
  if (!extracted.ok) {
    return { ok: false, code: "invalid-attachment", reason: PDF_FAILURE[extracted.reason](input.path) };
  }
  const { pages, pageCount } = extracted;
  const text = pages.length === 1
    ? pages[0]!
    : pages.map((page, index) => `[Page ${index + 1}]\n${page}`.trimEnd()).join("\n\n");
  const bytes = new TextEncoder().encode(text);
  const kept = utf8Prefix(bytes, limit);
  const content = new TextDecoder().decode(kept);
  const truncatedBytes = bytes.length - kept.length;
  const fence = fenceFor(content);
  const pagesLabel = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  const section = [
    `Attached PDF: ${input.path} (${pagesLabel}; text layer extracted by Polyth, images and layout omitted)`,
    fence,
    content,
    fence,
    ...(truncatedBytes > 0 || extracted.truncated
      ? [`[truncated${truncatedBytes > 0 ? ` ${truncatedBytes} bytes` : ""}; the PDF continues past this point]`]
      : []),
  ].join("\n");
  return { ok: true, section, truncatedBytes };
}

export interface FileReferenceInput {
  /** Workspace-relative path of the uploaded or selected file. */
  path: string;
  mime?: string;
  size?: number;
  /** Short reason Polyth could not inline it, e.g. "binary file". */
  reason?: string;
}

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
};

const oneLine = (value: string): string => value.replace(/[\r\n\t]+/g, " ").trim();

/**
 * A prompt section that hands the agent a file by path instead of by content:
 * any format is accepted, and the agent opens it with its own tools or says
 * plainly that it cannot. Deterministic for identical input.
 */
export function referenceAttachmentFile(input: FileReferenceInput): string {
  const facts = [
    input.mime && input.mime !== "application/octet-stream" ? oneLine(input.mime) : undefined,
    typeof input.size === "number" && Number.isFinite(input.size) && input.size >= 0 ? formatBytes(input.size) : undefined,
  ].filter(Boolean);
  const reason = input.reason ? oneLine(input.reason) : "its contents cannot be inlined here";
  return [
    `Attached file: ${oneLine(input.path)}${facts.length ? ` (${facts.join(", ")})` : ""}`,
    `[Saved in your workspace; ${reason}. Open it with your own tools if you can (for example, list or extract an archive). If you cannot work with this kind of file, tell the user so plainly instead of guessing what it contains.]`,
  ].join("\n");
}

/** Append projected sections after the user's text, preserving their order. */
export function composeProjectedPrompt(text: string, sections: readonly string[]): string {
  if (sections.length === 0) return text;
  const head = text.trim() ? [text] : [];
  return [...head, ...sections].join("\n\n");
}
