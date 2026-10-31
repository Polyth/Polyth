// What every surface that shows action icons shares: pressing an action in a
// project, the run sheet it opens, and the editor. A surface renders the
// returned `overlays` once. Toolbar surfaces (`resultCard`) float a press's
// result in a card, like a rail launcher, instead of opening the sheet.
import { useRef, useState, type ReactNode } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { CustomActionDto, CustomActionInput } from "../src/actionModel.ts";
import ActionEditor from "./ActionEditor.tsx";
import { actionHost } from "./host.ts";
import RunSheet from "./RunSheet.tsx";
import { getSnapshot, markSeen, showCard, startAction } from "./store.ts";
import { tileView } from "./tileState.ts";

export interface ActionSurface {
  /** Run the action here, or show its run if it is busy or just failed. */
  press(action: CustomActionDto, anchor: HTMLElement | null): void;
  openRun(runId: string, anchor: HTMLElement | null): void;
  edit(action: CustomActionDto): void;
  create(seed?: Partial<CustomActionInput> | null): void;
  overlays: ReactNode;
}

export function useActionSurface(context: { projectId: string | null; sessionId: string | null; resultCard?: boolean }): ActionSurface {
  const [sheetRunId, setSheetRunId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ action: CustomActionDto | null; seed: Partial<CustomActionInput> | null } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [anchored, setAnchored] = useState(false);

  const openRun = (runId: string, anchor: HTMLElement | null) => {
    anchorRef.current = anchor;
    setAnchored(!!anchor);
    setSheetRunId(runId);
    markSeen(runId);
  };

  const run = (action: CustomActionDto) => {
    const { projectId, sessionId } = context;
    if (!projectId) {
      actionHost()?.errors.show?.(tr("customaction.chooseProjectFirst"));
      return;
    }
    void startAction(action, { projectId, sessionId }, { card: !!context.resultCard }).catch((cause) => {
      const host = actionHost();
      const text = host ? host.errors.friendly(tr("customaction.error.start", { name: action.name }), cause) : String(cause);
      host?.errors.show?.(text);
    });
  };

  const press = (action: CustomActionDto, anchor: HTMLElement | null) => {
    if (!context.projectId) {
      run(action);
      return;
    }
    const view = tileView(getSnapshot(), action.id, context.projectId, Date.now());
    if (view.run && (view.state === "running" || view.state === "chat" || (view.state === "failed" && !view.launch))) {
      if (context.resultCard) showCard(view.run.id);
      else openRun(view.run.id, anchor);
      return;
    }
    if (view.state === "starting") return;
    run(action);
  };

  const overlays = (
    <>
      <RunSheet
        runId={sheetRunId}
        {...(anchored ? { anchorRef } : {})}
        onClose={() => setSheetRunId(null)}
        onEdit={(action) => setEditor({ action, seed: null })}
        onRunAgain={(action) => {
          setSheetRunId(null);
          run(action);
        }}
      />
      {editor && (
        <ActionEditor
          open
          action={editor.action}
          seed={editor.seed}
          projectId={context.projectId}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );

  return {
    press,
    openRun,
    edit: (action) => setEditor({ action, seed: null }),
    create: (seed) => setEditor({ action: null, seed: seed ?? null }),
    overlays,
  };
}
