import { api, httpStatusOf } from "@polyth/session/web-api";
import type { ResourceProvider, ResourceRef } from "@polyth/web-sdk";
import { registerResourceProvider } from "../../../apps/web/src/resources/providers.ts";

const baseOf = (path: string) => path.split("/").pop() ?? path;

export const fileResourceProvider: ResourceProvider = {
  scheme: "file",
  describe: (ref) => ({
    label: baseOf(ref.locator),
    kind: "text",
  }),
  read: async (ref) => {
    const got = await api.filesRead(ref.projectId, ref.locator, ref.sessionId ?? undefined);
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

registerResourceProvider(fileResourceProvider);
