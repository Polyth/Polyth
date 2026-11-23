// "Run in terminal" on a shell code fence. The package only ever TYPES a
// command into the session's terminal; the person presses Enter. Nothing here
// sends a newline, and a block that would need one (several commands) is not
// offered at all, so the action can never execute anything by itself.

const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "powershell", "ps1", "pwsh"]);

export const SHELL_FENCE_LANGUAGES: readonly string[] = [...SHELL_LANGS];

/** The one command a shell block holds, ready to type; null when the block is
 *  not a single command (several commands, a heredoc-free multi-line script,
 *  or nothing at all). `console` blocks lose their `$ ` / `> ` prompts. */
export function shellCommandFromBlock(lang: string, text: string): string | null {
  const language = lang.trim().toLowerCase();
  if (!SHELL_LANGS.has(language)) return null;
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (language === "console") {
    const prompted = lines.filter((line) => /^\s*[$>] /.test(line) || /^\s*[$>]$/.test(line));
    // Output lines follow the prompt lines in a transcript: keep the commands.
    if (prompted.length > 0) lines = prompted.map((line) => line.replace(/^\s*[$>] ?/, ""));
  }
  const logical: string[] = [];
  let carry = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.endsWith("\\")) { carry += `${line.slice(0, -1).trimEnd()} `; continue; }
    const joined = (carry + (carry ? line.trimStart() : line)).trim();
    carry = "";
    if (joined !== "") logical.push(joined);
  }
  if (carry.trim() !== "") logical.push(carry.trim());
  if (logical.length !== 1) return null;
  const command = logical[0]!;
  // A control character could end the line or move the cursor when typed.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return null;
  return command;
}

export interface TypeRequest {
  id: number;
  sessionId: string;
  text: string;
}

let nextId = 1;
let pending: TypeRequest[] = [];
let version = 0;
const listeners = new Set<() => void>();

/** Queue a command for the session's terminal view, which types it as soon as
 *  a shell is attached (the pane may not be mounted yet). */
export function requestTypeIntoTerminal(sessionId: string, text: string): void {
  if (!sessionId || !text || /[\r\n]/.test(text)) return;
  pending = [...pending.filter((entry) => entry.sessionId !== sessionId), { id: nextId++, sessionId, text }];
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function takeTypeRequest(sessionId: string): TypeRequest | undefined {
  const request = pending.find((entry) => entry.sessionId === sessionId);
  if (request) pending = pending.filter((entry) => entry !== request);
  return request;
}

export function hasTypeRequest(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && pending.some((entry) => entry.sessionId === sessionId);
}

export function subscribeTypeRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function typeRequestVersion(): number {
  return version;
}
