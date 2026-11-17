import { compactionLatestTokens } from "@polyth/contracts/compaction-policy";

/** Whether switching this chat to a model would make the next send compact
 *  first: the chat no longer fits that model's window and the window is
 *  smaller than the current one. The same rule as the composer's
 *  `modelSwitchOverflow` (apps/web/src/chatMemory.ts), shown on the row
 *  before the pick instead of after it. */
export function chatOverflowsModel(input: {
  usage?: number;
  modelLimit?: number;
  currentLimit?: number;
}): boolean {
  const { usage, modelLimit, currentLimit } = input;
  if (usage === undefined || !Number.isFinite(usage)) return false;
  if (modelLimit === undefined || !Number.isFinite(modelLimit)) return false;
  if (currentLimit !== undefined && modelLimit >= currentLimit) return false;
  const latest = compactionLatestTokens(modelLimit);
  if (latest === undefined || usage < latest) return false;
  return true;
}
