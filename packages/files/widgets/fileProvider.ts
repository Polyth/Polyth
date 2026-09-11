import { api, httpStatusOf } from "@polyth/session/web-api";
import type { ResourceKind, ResourceProvider, ResourceRef } from "@polyth/web-sdk";

const baseOf = (path: string) => path.split("/").pop() ?? path;

type MediaKind = "image" | "audio" | "video" | "pdf";
const MEDIA_EXT: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
  ".webp": "image", ".avif": "image", ".bmp": "image", ".ico": "image",
  ".mp4": "video", ".m4v": "video", ".mov": "video", ".ogv": "video", ".webm": "video",
  ".aac": "audio", ".flac": "audio", ".m4a": "audio", ".mp3": "audio",
  ".oga": "audio", ".ogg": "audio", ".wav": "audio", ".weba": "audio",
  ".pdf": "pdf",
};

const TEXT_EXT = new Set([
  "js", "jsx", "ts", "tsx", "json", "yaml", "yml", "md", "markdown", "txt", "css", "html", "svg", "xml",
  "toml", "ini", "sh", "bash", "zsh", "cjs", "mjs", "cts", "mts", "map", "env", "rs", "go", "py", "rb",
  "java", "kt", "c", "h", "cpp", "hpp", "cs", "sql", "graphql", "vue", "svelte", "lock",
]);

function fileKindOf(path: string): ResourceKind {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === ".gitignore") return "text";
  const ext = base.match(/\.[^.]+$/)?.[0] ?? "";
  if (MEDIA_EXT[ext]) return "binary";
  if (!ext) return "unknown";
  const bare = ext.slice(1);
  if (TEXT_EXT.has(bare)) return "text";
  return "unknown";
}

export const fileResourceProvider: ResourceProvider = {
  scheme: "file",
  describe: (ref) => ({
    label: baseOf(ref.locator),
    kind: fileKindOf(ref.locator),
  }),
  read: async (ref, opts) => {
    const got = await api.filesRead(ref.projectId, ref.locator, ref.sessionId ?? undefined, opts);
    return {
      content: got.content,
      revision: got.revision,
      truncated: got.truncated,
      tooLarge: got.tooLarge,
      binary: got.tooLarge === true,
    };
  },
  write: async (ref, content, baseRevision) => {
    const res = await api.filesWrite(ref.projectId, ref.locator, content, baseRevision, ref.sessionId ?? undefined);
    return { revision: res.revision };
  },
  rename: async (ref, to) => {
    await api.filesRename(ref.projectId, ref.locator, to, ref.sessionId ?? undefined);
    return { ...ref, locator: to };
  },
  remove: async (ref) => {
    await api.filesDelete(ref.projectId, ref.locator, ref.sessionId ?? undefined);
  },
  stat: async (ref) => {
    try {
      const stat = await api.filesStat(ref.projectId, ref.locator, ref.sessionId ?? undefined);
      return { kind: "present", revision: stat.revision };
    } catch (err) {
      if (httpStatusOf(err) === 404) return { kind: "missing" };
      throw err;
    }
  },
  rawUrl: (ref) => api.filesRawUrl(ref.projectId, ref.locator, ref.sessionId ?? undefined),
};

export function fileRefFrom(projectId: string, sessionId: string | null, path: string): ResourceRef {
  return { scheme: "file", projectId, sessionId, locator: path };
}
