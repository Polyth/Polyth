import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button, ChevronDownIcon, ChevronUpIcon, CloseIcon, DeleteIcon, IconButton, LayersIcon, PlusIcon, Select, Spinner, Textarea, TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { DisclosureRow, ItemList, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  BUILTIN_ROLE_BRIEFS, POLICY_LIMITS, isBuiltinRole, isCustomRole, modelKey,
  type ModelOption, type ResolvedChoice, type ResolvedRole, type RoutingPolicy, type RoutingRole,
} from "../src/contracts.ts";
import {
  charCount, cloneRole, customRoleId, limitText, moveItem, removeItem, statusText, statusTone, type Translate,
} from "./helpers.ts";
import ModelPicker from "./ModelPicker.tsx";
import { harnessLabel, QuotaMeter } from "./Meter.tsx";
import { roleName } from "./NowTab.tsx";

const translate: Translate = (key, values) => tr(key as never, values);
const AT_ONCE = ["", "1", "2", "3", "4", "5", "6"];

const choiceKey = (c: { harnessId: string; providerID: string; modelID: string }) => modelKey(c);

function ChainRow({ role, index, choice, resolved, picked, ceiling, now, onMove, onRemove, onLimit }: {
  role: RoutingRole;
  index: number;
  choice: RoutingRole["models"][number];
  resolved: ResolvedChoice | undefined;
  picked: boolean;
  ceiling: number;
  now: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  onLimit: (value: number | undefined) => void;
}) {
  const name = resolved?.name ?? choice.modelID;
  const last = role.models.length - 1;
  const noLimit = tr("orchestration.roles.noLimit");
  return (
    <li className="orch-chain-row" data-picked={picked ? "true" : undefined} data-row={`${role.id}:${index}`}>
      <span className="orch-chain-n" title={index === 0 ? tr("orchestration.roles.usedFirst") : undefined} aria-label={tr("orchestration.roles.position", { n: index + 1 })}>{index + 1}</span>
      <span className="orch-chain-name">
        <strong>{name}</strong>
        <span className="orch-muted">
          {[harnessLabel(choice.harnessId), choice.providerID, resolved?.runs].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="orch-chain-status">
        {picked
          ? <span className="orch-chip orch-chip--accent">{tr("orchestration.status.usedNow")}</span>
          : resolved && <span className={`orch-chip orch-chip--${statusTone(resolved.status)}`}>{statusText(resolved, ceiling, now, translate)}</span>}
        {resolved && <QuotaMeter used={resolved.quotaUsed} window={resolved.quotaWindow} ceiling={ceiling} blocked={resolved.status === "blocked"} now={now} />}
      </span>
      <span className="orch-chain-controls">
        <span className="orch-at-once">
          <span className="orch-muted">{tr("orchestration.roles.atOnce")}</span>
          <Select
            label={tr("orchestration.roles.atOnceFor", { name })}
            value={choice.maxConcurrent === undefined ? "" : String(choice.maxConcurrent)}
            options={AT_ONCE.map((v) => ({ value: v, label: v === "" ? noLimit : v }))}
            onChange={(value) => onLimit(value === "" ? undefined : Number(value))}
            searchable={false}
          />
        </span>
        <IconButton icon={ChevronUpIcon} label={tr("orchestration.roles.moveUp", { name })} size="sm" disabled={index === 0}
          data-move={`${role.id}:${index}`} onClick={() => onMove(index - 1)} />
        <IconButton icon={ChevronDownIcon} label={tr("orchestration.roles.moveDown", { name })} size="sm" disabled={index === last}
          onClick={() => onMove(index + 1)} />
        <IconButton icon={CloseIcon} label={tr("orchestration.roles.remove", { name })} size="sm" onClick={onRemove} />
      </span>
    </li>
  );
}

export default function RolesTab({ draft, setDraft, resolvedRoles, pending, ceiling, now, openRequest, onFill, filling, filled, fillError, onSwitchMode }: {
  draft: RoutingPolicy;
  setDraft: (next: RoutingPolicy) => void;
  resolvedRoles: readonly ResolvedRole[];
  pending: boolean;
  ceiling: number;
  now: number;
  openRequest: { id: string; n: number } | null;
  onFill: () => void;
  filling: boolean;
  filled: boolean;
  fillError: string | null;
  onSwitchMode: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusRef = useRef<{ kind: "move"; id: string; index: number } | { kind: "name"; id: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const resolvedById = useMemo(() => new Map(resolvedRoles.map((role) => [role.id, role])), [resolvedRoles]);

  useEffect(() => {
    if (!openRequest) return;
    setOpen((current) => new Set(current).add(openRequest.id));
    requestAnimationFrame(() => rootRef.current?.querySelector(`[data-disclosure-row="${CSS.escape(`orchestration.role.${openRequest.id}`)}"]`)?.scrollIntoView?.({ block: "nearest" }));
  }, [openRequest]);

  useEffect(() => {
    const target = focusRef.current;
    if (!target) return;
    focusRef.current = null;
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (target.kind === "move") {
        const el = root.querySelector<HTMLElement>(`[data-move="${CSS.escape(`${target.id}:${target.index}`)}"]:not(:disabled)`)
          ?? root.querySelector<HTMLElement>(`[data-row="${CSS.escape(`${target.id}:${target.index}`)}"] button:not(:disabled)`);
        el?.focus();
      } else {
        root.querySelector<HTMLElement>(`[data-name="${CSS.escape(target.id)}"]`)?.focus();
      }
    });
  });

  const update = (id: string, change: (role: RoutingRole) => RoutingRole) =>
    setDraft({ ...draft, roles: draft.roles.map((role) => role.id === id ? change(role) : role) });
  const toggleOpen = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const customRoles = draft.roles.filter((role) => isCustomRole(role.id));
  const addRole = () => {
    if (customRoles.length >= POLICY_LIMITS.customRoles) return;
    const id = customRoleId(tr("orchestration.roles.customDefault"), draft.roles.map((role) => role.id));
    setDraft({ ...draft, roles: [...draft.roles, { id, label: tr("orchestration.roles.customDefault"), when: "", enabled: true, models: [] }] });
    setOpen((current) => new Set(current).add(id));
    focusRef.current = { kind: "name", id };
  };
  const pickerRole = pickerFor ? draft.roles.find((role) => role.id === pickerFor) : undefined;
  const pickerDisabled = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of pickerRole?.models ?? []) map.set(choiceKey(m), tr("orchestration.picker.inChain"));
    for (const key of draft.excluded) if (!map.has(key)) map.set(key, tr("orchestration.picker.onNever"));
    return map;
  }, [pickerRole, draft.excluded]);
  const addModel = (model: ModelOption) => {
    if (!pickerRole || pickerRole.models.length >= POLICY_LIMITS.modelsPerRole) return;
    const id = pickerRole.id;
    const index = pickerRole.models.length;
    update(id, (role) => ({ ...role, models: [...role.models, { harnessId: model.harnessId, providerID: model.providerID, modelID: model.modelID }] }));
    focusRef.current = { kind: "move", id, index };
    setPickerFor(null);
  };

  return (
    <div className="orch-roles" ref={rootRef}>
      {draft.mode === "auto" && (
        <p className="orch-inline-note">
          {tr("orchestration.roles.inactive")}{" "}
          <button type="button" className="orch-link" onClick={onSwitchMode}>{tr("orchestration.roles.switch")}</button>
        </p>
      )}
      <div className="orch-toolbar">
        <Button iconStart={LayersIcon} onClick={onFill} busy={filling}>{tr("orchestration.roles.fill")}</Button>
        {pending && <span className="orch-pending"><Spinner label={tr("orchestration.roles.pending")} /></span>}
      </div>
      {filled && <p className="orch-hint" role="status">{tr("orchestration.roles.filled")}</p>}
      {fillError && <p className="orch-hint orch-hint--danger" role="alert">{fillError}</p>}
      <ItemList>
        {draft.roles.map((role) => {
          const resolved = resolvedById.get(role.id);
          const byKey = new Map((resolved?.choices ?? []).map((c) => [c.key, c]));
          const pick = resolved?.pick !== undefined ? resolved.choices[resolved.pick] : undefined;
          const summary = !role.enabled
            ? <span className="orch-muted">{tr("orchestration.roles.off")}</span>
            : role.models.length === 0
              ? <span className="orch-muted">{tr("orchestration.roles.notSet")}</span>
              : pick
                ? <span>{pick.name}</span>
                : resolved ? <span className="orch-danger-text">{tr("orchestration.status.none")}</span> : null;
          const custom = isCustomRole(role.id);
          const label = custom ? (role.label || tr("orchestration.roles.customDefault")) : roleName(role);
          return (
            <DisclosureRow
              key={role.id}
              rowId={`orchestration.role.${role.id}`}
              open={open.has(role.id)}
              onToggle={() => toggleOpen(role.id)}
              label={(
                <span className="orch-role-label">
                  <strong>{label}</strong>
                  <span className="orch-muted orch-role-desc">{custom ? role.when ?? "" : tr(`orchestration.role.${role.id}.desc` as never)}</span>
                  <span className="orch-role-pick">{role.enabled && pick ? "→ " : ""}{summary}</span>
                </span>
              )}
              value={<span className="orch-sum">{summary}</span>}
            >
              <div className="orch-role-body" data-role={role.id}>
                <div className="orch-role-use">
                  <Toggle on={role.enabled} onChange={(on) => update(role.id, (r) => ({ ...r, enabled: on }))} label={tr("orchestration.roles.use", { role: label })} />
                  <span>{tr("orchestration.roles.use", { role: label })}</span>
                </div>
                {custom ? (
                  <div className="orch-role-fields">
                    <label className="orch-field">
                      <span>{tr("orchestration.roles.name")}</span>
                      <TextInput
                        data-name={role.id}
                        value={role.label ?? ""}
                        maxLength={POLICY_LIMITS.labelChars}
                        placeholder={tr("orchestration.roles.namePlaceholder")}
                        onChange={(e) => update(role.id, (r) => ({ ...r, label: limitText(e.target.value, POLICY_LIMITS.labelChars) }))}
                      />
                    </label>
                    <label className="orch-field">
                      <span>{tr("orchestration.roles.when")}</span>
                      <Textarea
                        value={role.when ?? ""}
                        maxLength={POLICY_LIMITS.whenChars}
                        minRows={2}
                        placeholder={tr("orchestration.roles.whenPlaceholder")}
                        onChange={(e) => update(role.id, (r) => ({ ...r, when: limitText(e.target.value.replace(/\s*\n+\s*/g, " "), POLICY_LIMITS.whenChars) }))}
                      />
                      <span className="orch-muted orch-field-foot">
                        <span>{tr("orchestration.roles.whenHint")}</span>
                        <span>{tr("orchestration.roles.counter", { used: charCount(role.when ?? ""), max: POLICY_LIMITS.whenChars })}</span>
                      </span>
                    </label>
                  </div>
                ) : isBuiltinRole(role.id) && (
                  <p className="orch-muted orch-brief">{tr("orchestration.roles.agentsRead", { brief: BUILTIN_ROLE_BRIEFS[role.id] })}</p>
                )}
                {role.models.length === 0
                  ? <p className="orch-muted">{tr("orchestration.roles.empty")}</p>
                  : (
                    <ol className="orch-chain">
                      {role.models.map((choice, index) => (
                        <ChainRow
                          key={choiceKey(choice)}
                          role={role}
                          index={index}
                          choice={choice}
                          resolved={byKey.get(choiceKey(choice))}
                          picked={!!pick && pick.key === choiceKey(choice)}
                          ceiling={ceiling}
                          now={now}
                          onMove={(to) => {
                            update(role.id, (r) => ({ ...r, models: moveItem(r.models, index, to) }));
                            focusRef.current = { kind: "move", id: role.id, index: to };
                            setAnnounce(tr("orchestration.roles.moved", { name: byKey.get(choiceKey(choice))?.name ?? choice.modelID, n: to + 1 }));
                          }}
                          onRemove={() => update(role.id, (r) => ({ ...r, models: removeItem(r.models, index) }))}
                          onLimit={(value) => update(role.id, (r) => ({
                            ...r,
                            models: r.models.map((m, i) => {
                              if (i !== index) return m;
                              const { maxConcurrent: _drop, ...rest } = m;
                              return value === undefined ? rest : { ...rest, maxConcurrent: value };
                            }),
                          }))}
                        />
                      ))}
                    </ol>
                  )}
                <div className="orch-role-actions">
                  <Button
                    iconStart={PlusIcon}
                    onClick={() => setPickerFor(role.id)}
                    disabled={role.models.length >= POLICY_LIMITS.modelsPerRole}
                  >{tr("orchestration.roles.addModel")}</Button>
                  {role.models.length >= POLICY_LIMITS.modelsPerRole && (
                    <span className="orch-muted">{tr("orchestration.roles.limitModels", { count: POLICY_LIMITS.modelsPerRole })}</span>
                  )}
                  {custom && (
                    <Button variant="danger" iconStart={DeleteIcon} className="orch-delete-role"
                      onClick={() => setDraft({ ...draft, roles: draft.roles.filter((r) => r.id !== role.id) })}>
                      {tr("orchestration.roles.deleteRole")}
                    </Button>
                  )}
                </div>
              </div>
            </DisclosureRow>
          );
        })}
      </ItemList>
      <div className="orch-role-actions">
        <Button iconStart={PlusIcon} onClick={addRole} disabled={customRoles.length >= POLICY_LIMITS.customRoles}>
          {tr("orchestration.roles.addRole")}
        </Button>
      </div>
      <p className="sr-only" aria-live="polite" role="status">{announce}</p>
      {pickerRole && (
        <ModelPicker
          title={tr("orchestration.picker.titleRole", { role: isCustomRole(pickerRole.id) ? pickerRole.label || tr("orchestration.roles.customDefault") : roleName(pickerRole) })}
          disabledReasons={pickerDisabled}
          onPick={addModel}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

export { cloneRole };
