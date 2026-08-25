/**
 * Canonical English messages owned by the fusion package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "fusionview.attribution": "Attribution",
  "fusionview.contributors": "Contributors",
  "fusionview.disagreements": "Disagreements",
  "fusionview.filterModels": "Filter models…",
  "fusionview.fuse": "Fuse",
  "fusionview.fusedAnswer": "Fused answer",
  "fusionview.fusing": "Fusing…",
  "fusionview.modelFusion": "Model fusion",
  "fusionview.moreRefineFilter": "more — refine filter",
  "fusionview.noDisagreementsRecorded": "No disagreements recorded.",
  "fusionview.noSessionOpen": "No session open",
  "fusionview.nothingFusedYet": "Nothing fused yet",
  "fusionview.openASessionToFuseAnswersFrom": "Open a session to fuse answers from several models.",
  "fusionview.prompt": "Prompt",
  "fusionview.promptToFuseAcrossModels": "Prompt to fuse across models…",
  "fusionview.selectModelsAndFuseAPromptInto": "Select models and fuse a prompt into one weighted answer.",
  "fusionview.synthesizeSeveralModelOutputsIntoOneWeighted": "Synthesize several model outputs into one weighted answer.",
  "fusionview.synthesizing": "Synthesizing…",
  "fusionview.waitingForWeights": "Waiting for weights…",
} as const;

export type FusionMessageKey = keyof typeof en;
export type FusionMessages = Record<FusionMessageKey, string>;
