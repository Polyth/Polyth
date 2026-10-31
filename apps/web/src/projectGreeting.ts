// Per-project fresh-session greeting. `Project.greeting` is absent for the
// built-in line, "" when the project hides it, or custom text where each
// `{project}` token marks the highlighted project name.

export const PROJECT_GREETING_TOKEN = "{project}";

/** One rendered greeting: plain text runs interleaved with the project name. */
export type ProjectGreetingPart = { kind: "text"; text: string } | { kind: "name" };

/** null hides the greeting; otherwise the custom text split around the name
 *  token. Absent greetings return undefined so callers render the default. */
export function projectGreetingParts(greeting: string | undefined): ProjectGreetingPart[] | null | undefined {
  if (greeting === undefined) return undefined;
  const text = greeting.trim();
  if (!text) return null;
  const parts: ProjectGreetingPart[] = [];
  text.split(PROJECT_GREETING_TOKEN).forEach((run, index) => {
    if (index > 0) parts.push({ kind: "name" });
    if (run) parts.push({ kind: "text", text: run });
  });
  return parts;
}
