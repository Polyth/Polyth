import { useStore } from "../store.ts";

export default function StatusBar() {
  const branch = useStore((s) => s.gitBranch);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const left = [
    branch,
    session?.model ? `${session.model.providerID}/${session.model.modelID}` : "",
    session?.agent ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="statusbar">
      <span className="statusbar-left">{left || "polyth"}</span>
      <span className="header-spacer" />
    </div>
  );
}
