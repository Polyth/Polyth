import { randomUUID } from "node:crypto";
import type {
  AttachmentRef,
  TaskTrackerAttachmentDto,
  TaskTrackerService,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { imageTypeOfName } from "./common.ts";
import type { TaskPromptImages } from "./index.ts";

/**
 * A task handed to an agent brings its pictures along: every image on the
 * card is fetched from the tracker on the server (tracker file URLs answer
 * only to the account's credentials) and staged as a project `_inbox/*`
 * upload, so the first message carries it exactly like an image pasted into
 * the composer.
 */

/** The files package's attachment seam (`files.attachments`), structurally. */
export interface TaskImageStager {
  maxBytes: number;
  stage?(input: { projectId: string; name: string; bytes: Uint8Array }): Promise<{ path: string; size: number }>;
}

/** The server takes at most this many attachments in one turn. */
export const MAX_HANDOFF_IMAGES = 16;

/** Image types agent engines take as pictures. */
const SESSION_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface TaskHandoffImages extends TaskPromptImages {
  attachments: AttachmentRef[];
  attached: string[];
  missing: Array<{ name: string; reason: string }>;
}

const NONE: TaskHandoffImages = { attachments: [], attached: [], missing: [] };

const mimeOf = (value: string | undefined): string => (value ?? "").split(";")[0]!.trim().toLowerCase();

/** The card's attachments that are pictures, in the card's order. */
export const taskImages = (task: TaskTrackerTaskDto): TaskTrackerAttachmentDto[] =>
  (task.attachments ?? []).filter((item) =>
    mimeOf(item.mimeType).startsWith("image/") || imageTypeOfName(item.name) !== undefined);

const reasonOf = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : "it could not be downloaded";

/** Fetch and stage the task's images one at a time (bounded memory). A
 *  picture that cannot come along is named with its reason, never dropped
 *  silently; nothing here throws. */
export async function stageTaskImages(input: {
  task: TaskTrackerTaskDto;
  projectId: string;
  trackers: TaskTrackerService;
  stager: TaskImageStager | undefined;
}): Promise<TaskHandoffImages> {
  const { task, projectId, trackers, stager } = input;
  const images = taskImages(task);
  if (images.length === 0) return NONE;
  const stage = stager?.stage?.bind(stager);
  if (!stage || !trackers.attachmentContent) {
    return { ...NONE, missing: images.map((image) => ({ name: image.name, reason: "this server cannot pass images to sessions" })) };
  }
  const result: TaskHandoffImages = { attachments: [], attached: [], missing: [] };
  for (const [index, image] of images.entries()) {
    if (index >= MAX_HANDOFF_IMAGES) {
      result.missing.push({ name: image.name, reason: `only the first ${MAX_HANDOFF_IMAGES} images are attached` });
      continue;
    }
    try {
      const file = await trackers.attachmentContent(task.provider, task.id, image.id, false);
      const name = (file.name || image.name || "image").trim().slice(0, 200) || "image";
      const declared = mimeOf(file.mimeType);
      const mime = SESSION_IMAGE_TYPES.has(declared) ? declared : imageTypeOfName(name) ?? declared;
      if (!SESSION_IMAGE_TYPES.has(mime)) {
        result.missing.push({ name, reason: `${declared || "this"} images cannot be attached; PNG, JPEG, GIF and WebP can` });
        continue;
      }
      if (file.bytes.length > stager!.maxBytes) {
        result.missing.push({ name, reason: "the image is too large to attach" });
        continue;
      }
      const staged = await stage({ projectId, name, bytes: file.bytes });
      result.attachments.push({ id: randomUUID(), name, mime, size: staged.size, kind: "image", path: staged.path });
      result.attached.push(name);
    } catch (cause) {
      result.missing.push({ name: image.name, reason: reasonOf(cause) });
    }
  }
  return result;
}

/** The engine refused the pictures before the turn was admitted: say so in
 *  the prompt and send it without them, rather than leave the session idle. */
export const withoutAttachments = (images: TaskHandoffImages, reason: string): TaskHandoffImages => ({
  attachments: [],
  attached: [],
  missing: [...images.attached.map((name) => ({ name, reason })), ...images.missing],
});

/** A definite refusal of the attachments themselves, raised before anything
 *  was admitted, so sending again without them cannot duplicate the turn. */
export const attachmentsRefused = (cause: unknown): boolean => {
  const error = cause as { code?: unknown; mutationOutcome?: unknown } | null;
  if (!error || error.mutationOutcome === "unknown") return false;
  return error.code === "unsupported" || error.code === "invalid-attachment" || error.code === "invalid-input";
};
