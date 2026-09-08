import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { ContextBundleDto, ContextBundleSectionDto } from "@polyth/contracts";
import { bundleCopyText } from "@polyth/handoff";
import { Button, Textarea } from "../../../../apps/web/src/components/ui/index.ts";
import Picker from "../../../../apps/web/src/components/Picker.tsx";
import type { HandoffClient } from "./index.ts";
import { formatTokenEstimate } from "./format.ts";
import { SurfaceDrawer } from "./SurfaceDrawer.tsx";
import {
  CUSTOM_NOTE_SOURCE_ID,
  dedupeHandoffSources,
  SELECTED_FILES_SOURCE_ID,
  type HandoffSourceRow,
} from "./sources.ts";

function omissionSummary(bundle: ContextBundleDto): string | null {
  if (!bundle.omissions?.length) return null;
  return bundle.omissions
    .map((o) => `${o.total} ${o.label.toLowerCase()} · ${o.included} included · ${o.omitted} omitted (${o.reason})`)
    .join(" · ");
}

export function ContextDrawer(props: {
  client: HandoffClient;
  projectId: string;
  sessionId: string;
  presetId: string;
  presetLabel: string;
  instruction: string;
  presetSourceIds?: string[];
  changedFiles?: string[];
  warnTokenThreshold?: number;
  onBundle(bundle: ContextBundleDto): void;
  onClose(): void;
}) {
  const [instruction, setInstruction] = useState(props.instruction);
  const [sources, setSources] = useState<HandoffSourceRow[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<ContextBundleDto | null>(null);
  const [removedSectionIds, setRemovedSectionIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInstruction(props.instruction);
  }, [props.instruction]);

  useEffect(() => {
    void props.client.listSources(props.projectId, props.sessionId).then((listed) => {
      const rows = dedupeHandoffSources(listed);
      setSources(rows);
      const initial: Record<string, boolean> = {};
      for (const source of rows) initial[source.id] = source.defaultOn ?? false;
      setSelected(initial);
    });
  }, [props.client, props.projectId, props.sessionId]);

  const visibleSources = useMemo(() => {
    if (!props.presetSourceIds?.length) return sources;
    const allowed = new Set(props.presetSourceIds);
    return sources.filter((source) => allowed.has(source.id));
  }, [props.presetSourceIds, sources]);

  const noteEnabled = Boolean(selected[CUSTOM_NOTE_SOURCE_ID]);
  const filesEnabled = Boolean(selected[SELECTED_FILES_SOURCE_ID]);

  const enabledSources = (): Array<{ id: string; params?: Record<string, unknown> }> =>
    visibleSources
      .filter((source) => selected[source.id])
      .map((source) => {
        if (source.id === CUSTOM_NOTE_SOURCE_ID) return { id: source.id, params: { text: note } };
        if (source.id === SELECTED_FILES_SOURCE_ID && filePaths.length) {
          return { id: source.id, params: { paths: filePaths } };
        }
        return { id: source.id };
      });

  const estimated = visibleSources
    .filter((source) => selected[source.id])
    .reduce((sum, source) => sum + source.tokens, 0)
    + (noteEnabled ? Math.ceil(note.length / 4) : 0);

  const visibleSections = (bundle: ContextBundleDto): ContextBundleSectionDto[] =>
    bundle.sections.filter((section) => !removedSectionIds.has(section.id));

  const copyPrepared = async (bundle: ContextBundleDto) => {
    const text = bundleCopyText(bundle, removedSectionIds);
    await navigator.clipboard.writeText(text);
    props.onBundle({ ...bundle, sections: visibleSections(bundle), markdown: text });
  };

  const build = async (mode: "copy" | "preview") => {
    setBusy(true);
    setError(null);
    try {
      const bundle = await props.client.createBundle({
        projectId: props.projectId,
        sessionId: props.sessionId,
        presetId: props.presetId,
        label: props.presetLabel,
        instruction,
        sources: enabledSources(),
        ...(props.warnTokenThreshold !== undefined ? { warnTokenThreshold: props.warnTokenThreshold } : {}),
      });
      if (mode === "preview") {
        setPreview(bundle);
        setRemovedSectionIds(new Set());
      } else {
        await copyPrepared(bundle);
      }
      return bundle;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <span className="handoff-drawer-estimate">Estimated {formatTokenEstimate(estimated)} tokens</span>
      <div className="handoff-actions">
        <Button size="sm" onClick={() => void build("preview")} disabled={busy}>Preview</Button>
        <Button size="sm" onClick={() => void build("copy")} disabled={busy}>Copy</Button>
      </div>
    </>
  );

  if (preview) {
    const sections = visibleSections(preview);
    const copyText = bundleCopyText(preview, removedSectionIds);
    const omissionText = omissionSummary(preview);
    const previewFooter = (
      <>
        <span className="handoff-drawer-estimate">Preview · {formatTokenEstimate(preview.tokens)} tokens</span>
        <div className="handoff-actions">
          <Button variant="ghost" onClick={() => { setPreview(null); setRemovedSectionIds(new Set()); }}>Edit</Button>
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(copyText)}>Copy</Button>
          <Button variant="ghost" onClick={() => {
            const blob = new Blob([copyText], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${preview.label}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          >
            Export .md
          </Button>
        </div>
      </>
    );
    return (
      <SurfaceDrawer title={`Context preview · ${formatTokenEstimate(preview.tokens)}`} onClose={props.onClose} footer={previewFooter}>
        {preview.warning ? (
          <div className="handoff-bundle-warning">
            <p>Context is very large · {formatTokenEstimate(preview.warning.tokens)} tokens</p>
          </div>
        ) : null}
        {omissionText ? <p className="handoff-bundle-omission">{omissionText}</p> : null}
        {sections.map((section) => (
          <div key={section.id} className="handoff-preview-section">
            <h5>{section.title}</h5>
            <pre className="handoff-preview-body">{section.body}</pre>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRemovedSectionIds((prev) => new Set([...prev, section.id]))}
            >
              Remove section
            </Button>
          </div>
        ))}
      </SurfaceDrawer>
    );
  }

  return (
    <SurfaceDrawer title={props.presetLabel} onClose={props.onClose} footer={footer}>
      <div className="handoff-source-list">
        {visibleSources.map((source) => (
          <div key={source.id} className="handoff-source-row">
            <label className="handoff-source-check">
              <input
                type="checkbox"
                checked={Boolean(selected[source.id])}
                onChange={(e) => setSelected((prev) => ({ ...prev, [source.id]: e.target.checked }))}
              />
            </label>
            <div className="handoff-source-copy">
              <div className="handoff-source-line">
                <strong>{source.label}</strong>
                <span className="handoff-source-tokens">{formatTokenEstimate(source.tokens)}</span>
              </div>
              {source.description ? <p className="handoff-source-desc">{source.description}</p> : null}
            </div>
            {source.id === CUSTOM_NOTE_SOURCE_ID && noteEnabled ? (
              <Textarea
                className="handoff-source-extra"
                value={note}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
                rows={3}
                placeholder="Add a note"
              />
            ) : null}
            {source.id === SELECTED_FILES_SOURCE_ID && filesEnabled ? (
              <Picker
                label="Files"
                items={(props.changedFiles ?? []).map((path) => ({ id: path, label: path, group: "Changed files" }))}
                values={filePaths}
                onPick={(id) => setFilePaths((prev) => (
                  prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
                ))}
                placeholder="Select files"
                searchable
              />
            ) : null}
          </div>
        ))}
      </div>
      <label className="handoff-instruction-field">
        <span className="handoff-field-label">Instruction</span>
        <Textarea value={instruction} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setInstruction(e.target.value)} rows={4} />
      </label>
      {error ? <p className="handoff-error">{error}</p> : null}
    </SurfaceDrawer>
  );
}
