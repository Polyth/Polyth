import type { TrackStepInput } from "@polyth/contracts";

/** Compact UI syntax: one step per line, optionally `Title :: instructions`. */
export function parseTrackSteps(text: string, testCommand: string): TrackStepInput[] {
  const command = testCommand.trim();
  if (!command) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("::");
      const title = (separator < 0 ? line : line.slice(0, separator)).trim();
      const prompt = (separator < 0 ? line : line.slice(separator + 2)).trim();
      return {
        title,
        prompt: prompt || title,
        testCommand: command,
      };
    })
    .filter((step) => step.title.length > 0);
}
