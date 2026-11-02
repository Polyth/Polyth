// Shared classification of commit authors and Co-authored-by trailers. Release
// notes use it to credit people only; the pull-request co-author check uses it
// to reject an AI agent, model or harness credited as a co-author. Keep both
// consumers on one definition so a new agent identity cannot pass one of them.

export const AI_EMAILS = new Set(["noreply@anthropic.com", "cursoragent@cursor.com", "noreply@opencode.ai", "noreply@openai.com", "noreply@google.com"]);
export const AI_NAMES = /^(claude|codex|gpt|chatgpt|openai|gemini|copilot|cursor\b|cursor agent|opencode|devin|aider|sweep|jules|amp\b|pi agent)/i;
export const BOT = /\[bot\]$|^(actions|github-actions)@|@localhost$|^noreply@github\.com$|^(dependabot|renovate)/i;

/** { name, email } → "human", "bot" or "agent". */
export function identityKind(person) {
  const email = (person.email ?? "").toLowerCase();
  const name = person.name ?? "";
  if (BOT.test(name) || BOT.test(email)) return "bot";
  if (AI_EMAILS.has(email) || AI_NAMES.test(name)) return "agent";
  return "human";
}

/** Co-authored-by trailers of a commit message. */
export function parseCoAuthors(body) {
  const people = [];
  for (const match of (body ?? "").matchAll(/^co-authored-by:\s*(.+?)\s*<([^>\s]+)>\s*$/gim)) {
    people.push({ name: match[1], email: match[2] });
  }
  return people;
}
