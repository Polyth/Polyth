// F2: shared per-row file actions for the Files and Changes panels —
// Open / Copy path / Add to chat (attachment pill on the active composer).
import { useEffect, useRef, useState } from "react";
import { copyText } from "../utils.ts";
import { attachProjectFile } from "../attachments.ts";
import { getState, setUiError } from "../store.ts";
import { tr } from "../i18n/index.ts";

export default function FileRowActions({ projectId, path, onOpen }: {
  projectId: string;
  path: string;
  /** Row-appropriate open action (viewer, diff, …). Omitted = no Open item. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const addToChat = () => {
    setOpen(false);
    void attachProjectFile(projectId, getState().activeSessionId, path).then((r) => {
      if (!r.ok) setUiError(tr("composer.couldNotAttach", { reason: r.reason }));
    });
  };

  return (
    <span className="file-row-actions" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        className="small-btn"
        title={tr("filerowactions.actionsForValue", { path: path })}
        aria-label={tr("filerowactions.actionsForValue", { path: path })}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >⋯</button>
      {open && (
        <div className="file-row-menu" role="menu">
          {onOpen && (
            <button role="menuitem" onClick={() => { setOpen(false); onOpen(); }}>{tr("common.open")}</button>
          )}
          <button role="menuitem" onClick={() => { setOpen(false); void copyText(path); }}>{tr("filerowactions.copyPath")}</button>
          <button role="menuitem" onClick={addToChat}>{tr("filerowactions.addToChat")}</button>
        </div>
      )}
    </span>
  );
}
