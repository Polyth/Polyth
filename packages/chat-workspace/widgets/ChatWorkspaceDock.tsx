import { useState } from "react";
import type { ContextBundleDto, HandoffBundleStaleDto } from "@polyth/contracts";
import { bundleCopyText, presetById } from "@polyth/handoff";
import type { HandoffClient } from "@polyth/handoff/web";
import { Button, Menu, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { ContextDrawer, formatTokenEstimate } from "@polyth/handoff/web";

function omissionSummary(bundle: ContextBundleDto): string | null {
  if (!bundle.omissions?.length) return null;
  const first = bundle.omissions[0]!;
  return `${first.total} changed files · ${first.included} included · ${first.omitted} omitted`;
}

export function ChatWorkspaceDock(props: {
  client: HandoffClient;
  projectId: string;
  sessionId: string | null;
  sessionTitle: string;
  providerId: string;
  providerName: string;
  tabTitle?: string | null;
  bundle: ContextBundleDto | null;
  excludedSectionIds: ReadonlySet<string>;
  changedFiles?: string[];
  warnTokenThreshold?: number;
  stale: HandoffBundleStaleDto | null;
  copied: boolean;
  drawer: {
    open: boolean;
    presetId: string;
    presetLabel: string;
    instruction: string;
    presetSourceIds: string[];
  } | null;
  onOpenDrawer(input: {
    presetId: string;
    presetLabel: string;
    instruction: string;
    presetSourceIds: string[];
  }): void;
  onCloseDrawer(): void;
  onBundle(bundle: ContextBundleDto | null): void;
  onExcludedSectionsChange?(ids: Set<string>): void;
  onCopied(copied: boolean): void;
  onPasteResult(): void;
  onBuild(presetId: string, label: string, instruction: string, sourceIds: string[]): void;
  mismatchKept?: boolean;
  onKeepMismatch?(): void;
  onDiscardBundle?(): void;
  onRegenerateMismatch?(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const copyBundle = async () => {
    if (!props.bundle) return;
    const text = bundleCopyText(props.bundle, props.excludedSectionIds);
    await navigator.clipboard.writeText(text);
    props.onCopied(true);
    document.querySelector<HTMLElement>(".chat-workspace-canvas")?.focus();
  };

  const openPreset = (presetId: string) => {
    const preset = presetById(presetId);
    if (!preset) return;
    props.onOpenDrawer({
      presetId: preset.id,
      presetLabel: preset.label,
      instruction: preset.instruction,
      presetSourceIds: preset.sources.map((source) => source.id),
    });
  };

  const mismatch = props.bundle
    && props.sessionId
    && props.bundle.sessionId !== props.sessionId
    && !props.mismatchKept;

  const drawer = props.drawer?.open && props.sessionId ? (
    <ContextDrawer
      client={props.client}
      projectId={props.projectId}
      sessionId={props.sessionId}
      presetId={props.drawer.presetId}
      presetLabel={props.drawer.presetLabel}
      instruction={props.drawer.instruction}
      presetSourceIds={props.drawer.presetSourceIds}
      changedFiles={props.changedFiles}
      warnTokenThreshold={props.warnTokenThreshold}
      onBundle={(bundle) => { props.onBundle(bundle); props.onCloseDrawer(); }}
      onClose={props.onCloseDrawer}
    />
  ) : null;

  const overflowEntries: MenuEntry[] = [
    { id: "review", label: "Review changes", onSelect: () => openPreset("review") },
    { id: "debug", label: "Debug failure", onSelect: () => openPreset("debug") },
    { id: "plan", label: "Plan implementation", onSelect: () => openPreset("plan") },
    { id: "paste", label: "Paste result to Polyth", onSelect: () => props.onPasteResult() },
    ...(props.bundle ? [{
      id: "discard",
      label: "Discard context",
      onSelect: () => props.onDiscardBundle?.(),
    }] : []),
  ];

  if (!props.sessionId) {
    return (
      <>
        <div className="chat-workspace-dock">
          <span className="chat-workspace-dock-summary">Open a session to build Polyth context</span>
        </div>
        {drawer}
      </>
    );
  }

  if (!props.bundle) {
    return (
      <>
        <div className="chat-workspace-dock">
          <span className="chat-workspace-dock-summary">No context prepared</span>
          <Button size="sm" onClick={() => openPreset("review")}>Prepare context</Button>
          <Menu label="More" open={menuOpen} onOpenChange={setMenuOpen} entries={overflowEntries} align="end">
            {(trigger) => <button {...trigger} type="button" className="chat-workspace-dock-more" aria-label="More">···</button>}
          </Menu>
        </div>
        {drawer}
      </>
    );
  }

  if (mismatch) {
    return (
      <>
        <div className="chat-workspace-dock">
          <span className="chat-workspace-dock-summary">⚠ Context belongs to another session</span>
          <Button size="sm" onClick={() => props.onRegenerateMismatch?.()}>Resolve…</Button>
        </div>
        {drawer}
      </>
    );
  }

  if (props.stale?.stale) {
    const preset = presetById(props.bundle.presetId);
    return (
      <>
        <div className="chat-workspace-dock">
          <span className="chat-workspace-dock-summary">⚠ Context may be stale</span>
          <Button size="sm" onClick={() => props.onBuild(
            props.bundle!.presetId,
            preset?.label ?? props.bundle!.label,
            preset?.instruction ?? props.bundle!.instruction,
            preset?.sources.map((source) => source.id) ?? [],
          )}
          >
            Regenerate
          </Button>
        </div>
        {drawer}
      </>
    );
  }

  if (props.copied) {
    return (
      <>
        <div className="chat-workspace-dock">
          <span className="chat-workspace-dock-summary">✓ Context copied</span>
          <Button size="sm" onClick={props.onPasteResult}>Paste result…</Button>
        </div>
        {drawer}
      </>
    );
  }

  const preset = presetById(props.bundle.presetId);
  const bundleLabel = preset?.label ?? props.bundle.label;
  const omission = omissionSummary(props.bundle);

  return (
    <>
      <div className="chat-workspace-dock">
        <button
          type="button"
          className="chat-workspace-dock-summary"
          onClick={() => props.onOpenDrawer({
            presetId: props.bundle!.presetId,
            presetLabel: bundleLabel,
            instruction: props.bundle!.instruction,
            presetSourceIds: preset?.sources.map((source) => source.id) ?? [],
          })}
        >
          {bundleLabel} · {formatTokenEstimate(props.bundle.tokens)}
          {omission ? ` · ${omission}` : ` · ${props.bundle.sections.length} sources`}
        </button>
        <Button size="sm" onClick={() => void copyBundle()}>Copy & focus</Button>
        <Menu label="More" open={menuOpen} onOpenChange={setMenuOpen} entries={overflowEntries} align="end">
          {(trigger) => <button {...trigger} type="button" className="chat-workspace-dock-more" aria-label="More">···</button>}
        </Menu>
      </div>
      {drawer}
    </>
  );
}
