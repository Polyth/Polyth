// Runtime recovery instructions are model-only metadata. Older clients or
// handoff paths can still deliver the wrapper in visible text, so remove only
// a leading, complete internal recovery block at the browser display boundary.
// Persisted event data and runtime prompts remain unchanged.
export { stripRecoveryContextBlocks } from "@polyth/contracts";
