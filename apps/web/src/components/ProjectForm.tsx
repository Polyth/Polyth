import { useState, type FormEvent } from "react";
import { useEscape } from "../useEscape.ts";

export default function ProjectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (path: string, name: string, create: boolean) => Promise<void>;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [create, setCreate] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEscape(!!onCancel, () => onCancel?.());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return setError("Enter a project path.");
    setBusy(true);
    setError("");
    try {
      await onSubmit(path.trim(), name.trim(), create);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <label>Project folder <span>absolute path on this machine</span>
        <input autoFocus value={path} placeholder="/workspace/my-project" onChange={(e) => setPath(e.target.value)} />
      </label>
      <label className="project-name">Display name <span>optional — defaults to the folder name</span>
        <input value={name} placeholder="My project" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="project-create"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} /> Create the folder if it doesn't exist yet</label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary-btn" disabled={busy}>{busy ? "Opening…" : create ? "Create & open" : "Open project"}</button>
      </div>
    </form>
  );
}
