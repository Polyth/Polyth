/**
 * Canonical English messages owned by the multirun package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "multirunview.agent": "agent",
  "multirunview.agentDefault": "Agent: Default",
  "multirunview.filterModels": "Filter models…",
  "multirunview.model": "Model",
  "multirunview.noRunsYet": "No runs yet",
  "multirunview.noSessionOpen": "No session open",
  "multirunview.openASessionToRunTheSame": "Open a session to run the same prompt across models.",
  "multirunview.pickAtLeastOneModel": "Pick at least one model.",
  "multirunview.pickThisRun": "Pick this run",
  "multirunview.pickUpToThreeModelsAndSend": "Pick up to three models and send a prompt to compare runs side by side.",
  "multirunview.picked": "Picked ✓",
  "multirunview.promptToSendToEveryRun": "Prompt to send to every run…",
  "multirunview.samePromptSeveralBackendsInParallelPick": "Same prompt, several backends in parallel — pick the run that becomes canon.",
  "multirunview.valueTok": "{value} tok",
} as const;

export type MultirunMessageKey = keyof typeof en;
export type MultirunMessages = Record<MultirunMessageKey, string>;
