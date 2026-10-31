/** Continuity never reads credentials or native transcripts. Known secrets are
 * replaced at the server boundary, and common credential syntax is redacted
 * here before budgeting so truncation cannot expose part of a credential. */
export function redactContinuity(text: string, secrets: readonly string[] = []): string {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
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
