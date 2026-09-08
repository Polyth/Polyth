// How one attachment reaches the model. The planner is the single decision
// point shared by admission and the adapters: given the effective support map
// (harness ∩ model ∩ remote policy) it says whether a ref is delivered natively,
// emulated by a server-side text projection, or refused with a product-level
// reason. Adapters never invent their own answer, so the UI can never show a
// control whose attachment is dropped later.
import type { AttachmentModality, AttachmentRef, FeatureSupport, TurnRejectionCode } from "@polyth/contracts";
import { attachmentModality } from "./features.ts";

export type AttachmentDeliveryPlan =
  /** Hand the ref to the adapter unchanged; the harness delivers it. */
  | { kind: "native"; modality: AttachmentModality }
  /** The harness emulates this modality itself (for example an URL fetched
   *  into the prompt by the backend). Still a pass-through for the adapter. */
  | { kind: "harness-emulated"; modality: AttachmentModality }
  /** Read server-side and appended to the prompt as a delimited text section.
   *  The ref must NOT be forwarded to the adapter. */
  | { kind: "text-projection"; modality: "file" }
  /** Nothing to deliver (browser context is merged into the prompt text). */
  | { kind: "prompt-merged"; modality?: AttachmentModality }
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
}

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
  const level = support[modality];
  if (level === undefined || level === "unsupported") {
    if (input.supportDeclared === false) return { kind: "native", modality };
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

/**
 * Render one file as a delimited prompt section. Deterministic for identical
 * input: head truncation on a UTF-8 boundary with an explicit byte count, and
 * a binary file is refused rather than smuggled in as mojibake.
 */
export function projectAttachmentText(input: TextProjectionInput): TextProjection {
  const limit = input.maxBytes ?? TEXT_PROJECTION_MAX_BYTES;
  if (input.bytes.includes(NUL)) {
    return {
      ok: false,
      code: "invalid-attachment",
      reason: `${input.path} looks like a binary file, so its text cannot be attached.`,
    };
  }
  const kept = utf8Prefix(input.bytes, limit);
  const decoded = decodeStrict(kept);
  if (decoded === undefined) {
    return {
      ok: false,
      code: "invalid-attachment",
      reason: `${input.path} is not UTF-8 text, so it cannot be attached.`,
    };
  }
  let content = decoded;
  let truncatedBytes = input.bytes.length - kept.length;
  if (input.range) {
    const [from, to] = input.range;
    const lines = content.split("\n");
    const start = Math.max(1, Math.trunc(from));
    const end = Math.max(start, Math.trunc(to));
    content = lines.slice(start - 1, end).join("\n");
    // A ranged slice of a truncated head would report bytes the user never
    // asked for; the range itself is the stated bound.
    truncatedBytes = 0;
  }
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

/** Append projected sections after the user's text, preserving their order. */
export function composeProjectedPrompt(text: string, sections: readonly string[]): string {
  if (sections.length === 0) return text;
  const head = text.trim() ? [text] : [];
  return [...head, ...sections].join("\n\n");
}
