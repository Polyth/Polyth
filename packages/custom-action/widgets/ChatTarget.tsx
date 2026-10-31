// Which agent a `chat` action hands its result to: the composer's own harness
// tabs and model picker, so the choice reads exactly like starting a chat.
import { createElement, useMemo } from "react";
import type { HarnessSelection } from "@polyth/contracts";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { ActionModelRef } from "../src/actionModel.ts";
import { actionHost } from "./host.ts";

export default function ChatTarget({
  projectId,
  harnessId,
  model,
  onChange,
}: {
  /** Project whose runtime catalog previews the choice. */
  projectId: string | null;
  harnessId: string | undefined;
  model: ActionModelRef | undefined;
  onChange: (next: { harnessId: string | undefined; model: ActionModelRef | undefined }) => void;
}) {
  const projects = useStore((state) => state.projectRegistry.projects);
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const project = projects.find((item) => item.id === projectId);
  const spaceId = project?.spaceId;
  const catalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(spaceId ? { spaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(harnessId ? { harnessId } : {}),
  });
  const catalogHarnessId = harnessId ?? catalog.harnessId;
  const models = useMemo(
    () => catalogHarnessId
      ? catalog.models.filter((candidate) => !candidate.harnessId || candidate.harnessId === catalogHarnessId)
      : catalog.models,
    [catalog.models, catalogHarnessId],
  );
  const selection: HarnessSelection = harnessId ? { mode: "pinned", harnessId } : { mode: "auto" };
  const host = actionHost();
  const header = host
    ? createElement(host.ui.Slot, {
      slot: "modelPicker.header",
      context: {
        ...(spaceId ? { spaceId } : {}),
        ...(projectId ? { projectId } : {}),
        harnessSelection: selection,
        ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
        pendingHarnessSelection: selection,
        onSelectHarness: (next: HarnessSelection) => onChange({
          harnessId: next.mode === "pinned" ? next.harnessId : undefined,
          // A model belongs to its harness; a new harness starts on its default.
          model: next.mode === "pinned" && next.harnessId === harnessId ? model : undefined,
        }),
      },
    })
    : undefined;

  return (
    <div className="ca-chat-target">
      <ModelPicker
        models={models}
        {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
        {...(model ? { value: { ...model, ...(harnessId ? { harnessId } : {}) } } : {})}
        catalogLoading={catalog.discovery.state === "pending"}
        emptyLabel={tr("customaction.editor.defaultModel")}
        {...(header ? { header } : {})}
        onPick={(picked) => {
          if (!picked) {
            onChange({ harnessId, model: undefined });
            return;
          }
          onChange({
            harnessId: picked.harnessId ?? harnessId,
            model: {
              providerID: picked.providerID,
              modelID: picked.modelID,
              ...(picked.variant ? { variant: picked.variant } : {}),
            },
          });
        }}
      />
    </div>
  );
}
