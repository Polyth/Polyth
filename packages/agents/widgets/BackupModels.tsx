import { useMemo } from "react";
import type { HarnessSelection } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ArrowDownIcon, ArrowUpIcon, Button, CloseIcon, IconButton, PlusIcon } from "../../../apps/web/src/components/ui/index.ts";
import { MAX_BACKUP_MODELS, moveBackup, newBackup, type AgentDraftState, type BackupModelDraft, type ExecutionModel } from "./agentModel.ts";

/** One backup: the same harness + model picker as the main route. */
function BackupRow({
  row,
  index,
  count,
  projectId,
  spaceId,
  host,
  onChange,
  onMove,
  onRemove,
}: {
  row: BackupModelDraft;
  index: number;
  count: number;
  projectId: string;
  spaceId?: string;
  host?: WebPackageHost;
  onChange: (row: BackupModelDraft) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const harnessId = row.harness.mode === "pinned" ? row.harness.harnessId : undefined;
  const catalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(spaceId ? { spaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(harnessId ? { harnessId } : {}),
  });
  const catalogHarnessId = harnessId ?? catalog.harnessId ?? row.model?.harnessId;
  const models = useMemo(
    () => catalogHarnessId
      ? catalog.models.filter((candidate) => !candidate.harnessId || candidate.harnessId === catalogHarnessId)
      : catalog.models,
    [catalog.models, catalogHarnessId],
  );
  // A backup is always pinned: the route must not change under it later.
  const pick = (ref?: ExecutionModel) => {
    if (!ref) return;
    const pinned = ref.harnessId ?? catalogHarnessId;
    onChange({
      ...row,
      model: { ...ref, ...(pinned ? { harnessId: pinned } : {}) },
      ...(pinned ? { harness: { mode: "pinned", harnessId: pinned } } : {}),
    });
  };
  const label = tr("agents.backupValue", { count: index + 1 });
  return (
    <li className="agent-backup" data-incomplete={!row.model || undefined}>
      <span className="agent-backup-rank" aria-hidden="true">{index + 1}</span>
      <div className="agent-model agent-backup-picker" role="group" aria-label={label}>
        <ModelPicker
          models={models}
          {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
          {...(row.model ? { value: row.model } : {})}
          emptyLabel={tr("agents.chooseBackupModel")}
          catalogLoading={catalog.discovery.state === "pending"}
          header={host ? (
            <host.ui.Slot
              slot="modelPicker.header"
              context={{
                ...(spaceId ? { spaceId } : {}),
                ...(projectId ? { projectId } : {}),
                harnessSelection: row.harness,
                ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
                pendingHarnessSelection: row.harness,
                // Another harness means another catalog: the old model goes.
                onSelectHarness: (selection: HarnessSelection) => onChange({ key: row.key, harness: selection }),
              }}
            />
          ) : undefined}
          onPick={pick}
        />
      </div>
      <span className="agent-backup-actions">
        <IconButton icon={ArrowUpIcon} size="sm" label={tr("agents.moveUpValue", { name: label })} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon={ArrowDownIcon} size="sm" label={tr("agents.moveDownValue", { name: label })} disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton icon={CloseIcon} size="sm" label={tr("agents.removeValue", { name: label })} onClick={onRemove} />
      </span>
    </li>
  );
}

/** Ordered backup models: tried top to bottom when the main route fails. */
export default function BackupModels({
  draft,
  spaceId,
  host,
  onChange,
}: {
  draft: AgentDraftState;
  spaceId?: string;
  host?: WebPackageHost;
  onChange: (backups: AgentDraftState["backups"]) => void;
}) {
  const backups = draft.backups;
  return (
    <div className="agent-field agent-backups">
      <span className="agent-field-label">{tr("agents.backupModels")}</span>
      {backups.length > 0 && (
        <ol className="agent-backup-list">
          {backups.map((row, index) => (
            <BackupRow
              key={row.key}
              row={row}
              index={index}
              count={backups.length}
              projectId={draft.projectId}
              {...(spaceId ? { spaceId } : {})}
              {...(host ? { host } : {})}
              onChange={(next) => onChange(backups.map((item) => item.key === row.key ? next : item))}
              onMove={(delta) => onChange(moveBackup(backups, index, delta))}
              onRemove={() => onChange(backups.filter((item) => item.key !== row.key))}
            />
          ))}
        </ol>
      )}
      {backups.length < MAX_BACKUP_MODELS && (
        <span>
          <Button size="sm" variant="ghost" iconStart={PlusIcon} onClick={() => onChange([...backups, newBackup(draft)])}>
            {tr("agents.addBackupModel")}
          </Button>
        </span>
      )}
      <span className="agent-field-hint">{tr("agents.backupModelsHint")}</span>
    </div>
  );
}
