// Core utility-model helpers for chat→note distillation.

export function buildNotePrompt(transcript: string): string {
  return [
    "Distill the coding-assistant conversation below into a project note.",
    "Line 1: a <=60 character title. Then a blank line, then a concise markdown",
    "body capturing decisions, changes made, and open items. No preamble.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

export function parseNoteReply(raw: string): { title: string; body: string } {
  const clean = raw.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const nl = clean.indexOf("\n");
  if (nl === -1) return { title: clean.slice(0, 60), body: "" };
  return { title: clean.slice(0, nl).trim().slice(0, 120), body: clean.slice(nl + 1).trim() };
}
