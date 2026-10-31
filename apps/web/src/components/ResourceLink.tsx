import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpenResourceOptions, ResourceRef } from "@polyth/web-sdk";
import { openResource } from "../resources/navigation.ts";
import { resolveFileReference, type ResolvedFile } from "../resources/resolveFile.ts";
import { getState } from "../store.ts";
import { setDragResource } from "../dnd.ts";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import "./resource-link.css";
import { tr } from "../i18n/index.ts";

export interface ResourceLinkProps {
  resource: ResourceRef;
  children?: ReactNode;
  alias?: string;
  mode?: "compact" | "qualified" | "location" | "range";
  selection?: OpenResourceOptions["selection"];
  /** File rows already carry validated identity; prose paths resolve on use. */
  resolve?: boolean;
}

export default function ResourceLink({ resource, children, alias, mode = "qualified", selection, resolve = true }: ResourceLinkProps) {
  const key = JSON.stringify([resource, selection]);
  const anchor = useRef<HTMLButtonElement>(null);
  const epoch = useRef(0);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ResolvedFile[]>([]);
  const [deleted, setDeleted] = useState<ResolvedFile | null>(null);
  const preview = useRef(true);
  useEffect(() => {
    epoch.current++;
    setMissing(false); setBusy(false); setChoices([]); setDeleted(null);
    return () => { epoch.current++; };
  }, [key]);
  const suffix = selection && (mode === "location" || mode === "range")
    ? `:${selection.startLine}${mode === "range" && selection.endLine !== undefined && selection.endLine !== selection.startLine ? `–${selection.endLine}` : ""}` : "";
  const label = children ?? `${mode !== "compact" && alias ? `${alias} · ` : ""}${mode === "compact" ? resource.locator.split("/").pop() : resource.locator}${suffix}`;
  const choose = (match: ResolvedFile) => {
    setChoices([]);
    if (match.deletedDiff) setDeleted(match);
    else openResource(match.ref, { preview: preview.current, ...(selection ? { selection } : {}) });
  };
  if (missing) return <span className="resource-link-missing">{label}</span>;
  return <>
    <button type="button" ref={anchor} className="resource-link file-ref" title={`${resource.locator}\n${tr("resourcelink.openFile")}`}
      aria-busy={busy || undefined} draggable={resource.repositoryId !== undefined}
      onDragStart={(event) => setDragResource(event.dataTransfer, resource, selection)}
      onClick={(event) => {
        preview.current = !(event.metaKey || event.ctrlKey);
        if (!resolve) { choose({ ref: resource, alias: alias ?? "" }); return; }
        const sequence = ++epoch.current;
        const origin = getState();
        setBusy(true);
        void resolveFileReference(resource).then((matches) => {
          if (sequence !== epoch.current) return;
          setBusy(false);
          const current = getState();
          if (current.activeProjectId !== origin.activeProjectId || current.activeSessionId !== origin.activeSessionId) return;
          if (matches.length === 0) setMissing(true);
          else if (matches.length === 1) choose(matches[0]!);
          else setChoices(matches);
        }).catch(() => { if (sequence === epoch.current) { setBusy(false); setMissing(true); } });
      }}>{label}</button>
    <ResponsiveOverlay open={choices.length > 1} onClose={() => setChoices([])} title={tr("resourcelink.openPath", { path: resource.locator })}
      anchorRef={anchor} phone="sheet" className="resource-link-chooser">
      {choices.map((match) => <button type="button" className="resource-link-choice" key={match.ref.repositoryId} onClick={() => choose(match)}>
        <strong>{match.alias}{match.deletedDiff ? ` · ${tr("resourcelink.deleted")}` : ""}</strong><span>{match.ref.locator}</span>
      </button>)}
    </ResponsiveOverlay>
    <ResponsiveOverlay open={deleted !== null} onClose={() => setDeleted(null)} title={`${deleted?.alias ?? ""} · ${resource.locator} · ${tr("resourcelink.deleted")}`}
      phone="sheet" dialogSize="lg" className="resource-link-deleted">
      <pre>{deleted?.deletedDiff}</pre>
    </ResponsiveOverlay>
  </>;
}
