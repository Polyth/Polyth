// The keyboard and touch way to move a chat: pick a project from a list. A drag
// in the navigator skips this and goes straight to the same confirmation.
import { requestSessionMove, sessionMoveTargets } from "../sessionMove.ts";
import { setOverlay, useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";
import ProjectGlyph from "./ProjectGlyph.tsx";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import "./MoveSessionDialog.css";

export default function MoveSessionDialog() {
  const session = useStore((state) => state.sessions.find((row) => row.id === state.movingSessionId) ?? null);
  const projects = useStore((state) => state.projectRegistry.projects);
  const close = () => setOverlay(null);
  const targets = session ? sessionMoveTargets(session, projects) : [];
  return (
    <ResponsiveOverlay
      open={session !== null}
      onClose={close}
      title={tr("sessionMove.pickTitle")}
      desktop="dialog"
      phone="sheet"
      className="session-move"
    >
      {targets.length === 0
        ? <p className="session-move-empty">{tr("sessionMove.noOtherProjects")}</p>
        : (
          <ul className="session-move-list">
            {targets.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="session-move-row"
                  onClick={() => {
                    close();
                    if (session) void requestSessionMove(session, project);
                  }}
                >
                  <ProjectGlyph project={project} />
                  <span className="session-move-row-copy">
                    <span className="session-move-row-name">{project.name || project.path}</span>
                    {!project.personal && <span className="session-move-row-path">{project.path}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </ResponsiveOverlay>
  );
}
