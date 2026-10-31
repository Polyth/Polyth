import { createHash } from "node:crypto";
import { chmod, constants, copyFile, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AttachmentRef, WorkspaceContext } from "@polyth/contracts";
import { attachmentModality, composeTurnPrompt } from "@polyth/harness-runtime";

/**
 * Antigravity's stream-json input is text-only (CLI 1.2.9 rejects every other
 * content block), but its own `view_file` tool reads images, PDFs and audio as
 * model media, and `read_url_content` fetches a page. Polyth therefore stages
 * each binary attachment in a private directory the CLI is launched with
 * (`--add-dir`), and the runtime's PreInvocation hook injects the matching
 * tool calls before the turn's first model call. The prompt also names every
 * staged path, so a model can still open an attachment itself if a CLI version
 * ignores the injected steps.
 */
export type AgyInjectedStep =
  | { toolCall: { name: string; args: Record<string, string> } }
  | { userMessage: string };

export interface AgyStagedAttachments {
  /** Prompt section appended after the user's text; empty without attachments. */
  manifest: string;
  /** Tool calls injected before the turn's first model invocation. */
  steps: AgyInjectedStep[];
  /** Staged absolute paths `view_file` may read without an approval prompt. */
  paths: string[];
  /** Attached links `read_url_content` may fetch without an approval prompt. */
  urls: string[];
}

export type AgyAttachmentResult =
  | { ok: true; text: string; staged: AgyStagedAttachments }
  | { ok: false; code: "invalid-attachment" | "unsupported"; message: string };

export const AGY_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const AGY_ATTACHMENT_TURN_MAX_BYTES = 128 * 1024 * 1024;
export const AGY_ATTACHMENT_MAX_COUNT = 16;
/** Turn directories kept so a later turn can reopen an earlier attachment. */
const RETAINED_TURNS = 24;

/** The CLI derives the media type `view_file` sends to the model from the file
 * extension, so a staged copy always carries the canonical one for its MIME. */
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/webm": ".webm",
  "audio/aiff": ".aiff",
  "audio/x-aiff": ".aiff",
};

const inside = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

const formatSize = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const displayName = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120) || "attachment";

/** A path-safe staged file name with the canonical extension for its MIME. */
export const stagedFileName = (index: number, name: string, mime: string): string => {
  const current = extname(name).toLowerCase();
  const base = name.slice(0, name.length - extname(name).length)
    .normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64) || "attachment";
  const extension = EXTENSIONS[mime.toLowerCase()] ?? (/^\.[a-z0-9]{1,8}$/.test(current) ? current : "");
  return `${index}-${base}${extension}`;
};

type Source = {
  index: number;
  label: string;
  kind: "image" | "pdf" | "audio" | "url";
  mime?: string;
  path?: string;
  url?: string;
  /** Workspace roots a ref path must stay inside; captures are server-owned. */
  allowedRoots?: string[];
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Antigravity attachment directory is unsafe");
  await chmod(path, 0o700);
};

/** Keep the newest turn directories; attachments are copies, never originals. */
const prune = async (root: string): Promise<void> => {
  const names = await readdir(root).catch(() => [] as string[]);
  const entries = await Promise.all(names.map(async (name) => {
    const info = await lstat(join(root, name)).catch(() => undefined);
    return info?.isDirectory() && !info.isSymbolicLink() ? { name, mtime: info.mtimeMs } : undefined;
  }));
  const directories = entries.filter((entry): entry is { name: string; mtime: number } => !!entry)
    .sort((a, b) => b.mtime - a.mtime);
  await Promise.all(directories.slice(RETAINED_TURNS)
    .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })));
};

export interface StageAttachmentsInput {
  /** Private per-runtime directory; the CLI is launched with it as `--add-dir`. */
  root: string;
  turnId: string;
  cwd: string;
  text: string;
  attachments?: readonly AttachmentRef[];
  workspace?: WorkspaceContext;
}

type Failure = Extract<AgyAttachmentResult, { ok: false }>;
const failure = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

/** Resolve, validate and copy one turn's binary attachments. Text files never
 * reach this point: Polyth projects them into the prompt server-side. */
export async function stageAgyAttachments(input: StageAttachmentsInput): Promise<AgyAttachmentResult> {
  const composed = composeTurnPrompt(input.text, input.attachments);
  const sources: Source[] = [];
  const repositoryRoot = (ref: AttachmentRef): string | undefined => {
    if (ref.repositoryId === undefined) return input.cwd;
    const repository = input.workspace?.repositories.find((item) => item.repositoryId === ref.repositoryId);
    return repository?.state === "ready" ? repository.path : undefined;
  };
  for (const image of composed.images) {
    sources.push({
      index: sources.length + 1, label: "browser capture", kind: "image", mime: image.mime,
      path: isAbsolute(image.localPath) ? image.localPath : join(input.cwd, image.localPath),
    });
  }
  for (const ref of input.attachments ?? []) {
    if (ref.kind === "browser-context") continue;
    const modality = attachmentModality(ref);
    const label = displayName(ref.name);
    if (modality === "url") {
      const raw = ref.url?.trim() ?? "";
      let parsed: URL | undefined;
      try { parsed = new URL(raw); } catch { parsed = undefined; }
      if (!parsed || !/^https?:$/.test(parsed.protocol) || raw.length > 4096)
        return failure("invalid-attachment", `${label} is not an http(s) link Antigravity can open.`);
      sources.push({ index: sources.length + 1, label, kind: "url", url: parsed.href });
      continue;
    }
    if (modality !== "image" && modality !== "pdf" && modality !== "audio") {
      return failure("unsupported", modality === "file"
        ? `${label} must be attached as text; Antigravity opens only images, PDFs, audio and links directly.`
        : `${label} is not a kind of attachment Antigravity can open.`);
    }
    const root = repositoryRoot(ref);
    if (!ref.path || !root) return failure("invalid-attachment", `${label} could not be read for Antigravity.`);
    sources.push({
      index: sources.length + 1, label, kind: modality, mime: ref.mime,
      path: isAbsolute(ref.path) ? ref.path : join(root, ref.path), allowedRoots: [root],
    });
  }
  if (!sources.length) return { ok: true, text: composed.text, staged: { manifest: "", steps: [], paths: [], urls: [] } };
  if (sources.length > AGY_ATTACHMENT_MAX_COUNT)
    return failure("invalid-attachment", `Antigravity accepts at most ${AGY_ATTACHMENT_MAX_COUNT} attachments per message.`);

  const attachmentsRoot = join(input.root, "attachments");
  const turnDirectory = join(attachmentsRoot, createHash("sha256").update(input.turnId).digest("hex").slice(0, 32));
  const staged: AgyStagedAttachments = { manifest: "", steps: [], paths: [], urls: [] };
  const lines: string[] = [];
  const abandon = async (result: Failure): Promise<Failure> => {
    await rm(turnDirectory, { recursive: true, force: true }).catch(() => undefined);
    return result;
  };
  let total = 0;
  try {
    await ensurePrivateDirectory(input.root);
    await ensurePrivateDirectory(attachmentsRoot);
    // An operation ID is admitted once; restaging it replaces any partial copy.
    await rm(turnDirectory, { recursive: true, force: true });
    await ensurePrivateDirectory(turnDirectory);
    for (const source of sources) {
      if (source.kind === "url") {
        staged.urls.push(source.url!);
        lines.push(`${source.index}. link ${source.url}`);
        continue;
      }
      const real = await realpath(source.path!).catch(() => undefined);
      if (!real) return abandon(failure("invalid-attachment", `${source.label} could not be read for Antigravity.`));
      if (source.allowedRoots) {
        const roots = await Promise.all(source.allowedRoots.map((root) => realpath(root).catch(() => resolve(root))));
        if (!roots.some((root) => inside(root, real)))
          return abandon(failure("invalid-attachment", `${source.label} is outside this session's workspace.`));
      }
      const info = await stat(real);
      if (!info.isFile()) return abandon(failure("invalid-attachment", `${source.label} is not a file.`));
      if (info.size > AGY_ATTACHMENT_MAX_BYTES) {
        return abandon(failure("invalid-attachment",
          `${source.label} is larger than Antigravity's ${formatSize(AGY_ATTACHMENT_MAX_BYTES)} attachment limit.`));
      }
      total += info.size;
      if (total > AGY_ATTACHMENT_TURN_MAX_BYTES) {
        return abandon(failure("invalid-attachment",
          `These attachments exceed Antigravity's ${formatSize(AGY_ATTACHMENT_TURN_MAX_BYTES)} per-message limit.`));
      }
      const mime = (source.mime ?? "application/octet-stream").toLowerCase();
      const target = join(turnDirectory, stagedFileName(source.index, source.label, mime));
      await copyFile(real, target, constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
      staged.paths.push(target);
      lines.push(`${source.index}. ${source.kind === "pdf" ? "PDF" : source.kind} "${source.label}" (${mime}, ${formatSize(info.size)}): ${target}`);
    }
  } catch {
    return abandon(failure("invalid-attachment", "Antigravity could not stage the attachments for this message."));
  }
  await prune(attachmentsRoot).catch(() => undefined);
  staged.manifest = [
    "Attachments from the user (delivered by Polyth):",
    ...lines,
    "Polyth staged each attachment. Inspect each file with view_file and each link with read_url_content before your first response.",
  ].join("\n");
  const text = composed.text.trim() ? `${composed.text}\n\n${staged.manifest}` : staged.manifest;
  return { ok: true, text, staged };
}
