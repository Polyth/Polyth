// What a status-bar segment renders. `components/StatusBar.tsx` derives it once
// (one Git scan) and publishes it through React context, so the built-in
// segments stay presentational: moving, hiding or adding a segment never
// starts a second probe, and a segment dropped into an area that has no status
// bar around it simply renders nothing. Package segments (the workflow chip)
// fetch their own data; this model carries only the shell's own probes.
import { createContext, useContext } from "react";
import type { AppView } from "../store.ts";

export interface StatusbarChanges {
  /** Distinct changed files across the repositories in scope. */
  count: number;
  /** Repositories in scope, available or not. */
  repositories: number;
  unavailable: number;
  /** The count spans several repositories (none is focused in Files). */
  aggregate: boolean;
}

export interface StatusbarBranch {
  name: string;
  ahead: number;
  behind: number;
}

export interface StatusbarEditor {
  file: string;
  /** Repository alias when the file belongs to a named repository. */
  alias: string | null;
  language: string;
  line: number | null;
  column: number | null;
}

export interface StatusbarModel {
  projectId: string | null;
  sessionId: string | null;
  /** Display name of the active project; null while none is selected. */
  projectName: string | null;
  /** The session's model id; null when it has none. */
  modelId: string | null;
  agent: string | null;
  /** Null until the first scan of the current scope settles, and for folders
   *  that are not Git repositories. */
  branch: StatusbarBranch | null;
  changes: StatusbarChanges | null;
  editor: StatusbarEditor | null;
  view: AppView;
  /** Title of the workspace pane that is open beside Chat, if any. */
  paneTitle: string | null;
}

export const StatusbarModelContext = createContext<StatusbarModel | null>(null);

/** The published model, or null outside a status bar. */
export function useStatusbarModel(): StatusbarModel | null {
  return useContext(StatusbarModelContext);
}
