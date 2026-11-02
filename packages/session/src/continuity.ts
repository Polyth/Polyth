/** Continuity never reads credentials or native transcripts. Known secrets are
 * replaced at the server boundary, and common credential syntax is redacted
 * here before budgeting so truncation cannot expose part of a credential. */
const PRIVATE_KEY_BEGIN = /-----BEGIN [^-]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [^-]*PRIVATE KEY-----/g;

/** Replaces each BEGIN…END private-key block. The END is searched once per
 * BEGIN from where it ends, and the scan stops at the first BEGIN with no END
 * (no later one can have one), so repeated BEGIN markers stay linear. */
function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(text);
    if (!end) break;
    out += text.slice(from, begin.index) + "[redacted private key]";
    from = end.index + end[0].length;
    PRIVATE_KEY_BEGIN.lastIndex = from;
  }
  return out + text.slice(from);
}

export function redactContinuity(text: string, secrets: readonly string[] = []): string {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  return redactPrivateKeys(text)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, "[redacted authorization]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted token]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]");
}

export interface ContinuityWorkspace {
  cwd: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  files?: string[];
}
