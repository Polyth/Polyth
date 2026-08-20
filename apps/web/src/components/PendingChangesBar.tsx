import { useMemo, useState } from "react";
import type { RenderModel } from "../reduce.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { selectPendingChanges } from "../pendingChanges.ts";
import { openChanges, useStore } from "../store.ts";

export default function PendingChangesBar({ model }: { model: RenderModel }) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const working = model.turn?.status === "working";
  const status = useGitStatus(projectId, working, sessionId);
  const selected = useMemo(
    () => selectPendingChanges(status, model.changedFiles),
    [status, model.changedFiles],
  );
  const changeKey = `${selected.source}:${[...selected.paths].sort().join("\0")}`;
  const [dismissedKey, setDismissedKey] = useState("");

  if (selected.paths.length === 0 || dismissedKey === changeKey) return null;
  const count = selected.paths.length;

  return (
    <div className="pending-changes-bar" role="status">
      <button className="pending-changes-main" onClick={() => openChanges()}>
        <span className="pending-changes-dot" aria-hidden="true" />
        {count} {count === 1 ? "file" : "files"} changed
      </button>
      <details className="pending-changes-files">
        <summary aria-label="List changed files">Files</summary>
        <div className="pending-changes-menu">
          {selected.paths.map((path) => (
            <button key={path} className="mono" title={path} onClick={() => openChanges(path)}>
              {path}
            </button>
          ))}
        </div>
      </details>
      <button
        className="pending-changes-dismiss"
        aria-label="Dismiss changed files"
        title="Dismiss until the file set changes"
        onClick={() => setDismissedKey(changeKey)}
      >
        ×
      </button>
    </div>
  );
}
