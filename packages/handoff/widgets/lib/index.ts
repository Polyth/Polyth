export {
  createHandoffClient,
  hashText,
  estimateTokens,
  type HandoffClient,
  type HandoffTarget,
} from "./client.ts";
export { formatTokenEstimate, deriveSessionTargetLabel, dockPasteTargetName } from "./format.ts";
export { dedupeHandoffSources, visibleHandoffSources, CUSTOM_NOTE_SOURCE_ID, SELECTED_FILES_SOURCE_ID } from "./sources.ts";
export { resolveInitialHandoffTarget } from "./resolveInitialHandoffTarget.ts";
export {
  noteNewSessionHandoffPending,
  takeNewSessionHandoffPending,
  flushNewSessionHandoffImport,
  resetNewSessionHandoffPending,
} from "../../src/newSessionProvenance.ts";
export { ContextDrawer } from "./ContextDrawer.tsx";
export { SendSheet } from "./SendSheet.tsx";
export { SurfaceDrawer } from "./SurfaceDrawer.tsx";
