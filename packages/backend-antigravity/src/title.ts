import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Antigravity stores each conversation's generated title in a sibling
 *  annotation file (`<conversation-id>.pbtxt`) as protobuf-text
 *  `title:"..."`. Only that metadata is read; native transcript/history is
 *  never imported. */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_ANNOTATION_BYTES = 64 * 1024;

export const parseAntigravityAnnotationTitle = (content: string): string | undefined => {
  const match = /(?:^|\n)\s*title\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(content);
  if (!match?.[1]) return undefined;
  const decoded = match[1]
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
  if (!decoded) return undefined;
  return decoded.slice(0, 200);
};

export interface AntigravityTitleReader {
  read(conversationId: string): Promise<string | undefined>;
}

export const createAntigravityTitleReader = (annotationsDir: string): AntigravityTitleReader => ({
  async read(conversationId) {
    if (!SAFE_CONVERSATION_ID.test(conversationId)) return undefined;
    const file = join(annotationsDir, `${conversationId}.pbtxt`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ANNOTATION_BYTES) return undefined;
      return parseAntigravityAnnotationTitle(await readFile(file, "utf8"));
    } catch {
      return undefined;
    }
  },
});
