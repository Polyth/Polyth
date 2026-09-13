// EXTENSION-SEAMS slice 2: Main is shell composition only — the durable
// header plus the workspace surface host. The old AppView switch lives in the
// surface registry; built-ins register themselves in
// workspace/builtinSurfaces.tsx (imported for its registrations), so adding a
// surface never edits this file.
import WorkspaceHost from "./workspace/WorkspaceHost.ts";
import "./workspace/builtinSurfaces.tsx";

export default function Main() {
  return (
    <main className="main">
      <WorkspaceHost />
    </main>
  );
}
