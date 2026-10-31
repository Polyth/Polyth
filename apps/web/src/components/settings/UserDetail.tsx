import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GUARDRAIL_DEFAULT_GRANTS,
  GUARDRAIL_GRANTABLE,
  isSpaceRole,
  type AccountGuardrailsDto,
  type AccountLimitsDto,
  type AccountPermission,
  type AccountPermissionsDto,
  type GuardrailApprovals,
  type HarnessModelRef,
  type ModelDescriptor,
  type Project,
  type SpaceRole,
} from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import ModelPicker from "@polyth/models/model-picker";
import {
  accountGuardrails,
  accountLimits,
  accountPermissions,
  disableAccount,
  renameAccount,
  resetAccountPassword,
  setAccountGuardrails,
  setAccountLimits,
  setAccountPermissions,
  setAccountStatus,
  type AccountChoice,
} from "../../accounts.ts";
import { grantSpaceMember, revokeSpaceMember, type CurrentSpaceAccess } from "../../spaceAccess.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Notice,
  Select,
  TextInput,
} from "../ui/index.ts";
import { isImeComposing } from "../input/editorCore.ts";
import { BackIcon, CopyIcon, HideIcon, RefreshIcon, ShowIcon } from "../ui/icons.ts";
import {
  CheckGroup,
  EmptyState,
  ErrorState,
  FormField,
  NumberField,
  ReadonlyRow,
  Row,
  SaveBar,
  Section,
  Seg,
  Toggle,
  type SaveStatusState,
} from "./parts.tsx";
import {
  addModel,
  buildGuardrails,
  draftChanged,
  draftFrom,
  extraGrantChoices,
  grantLabel,
  isRiskyGrant,
  makeDefaultModel,
  removeModel,
  sameModel,
  toggleExtra,
  type GuardrailDraft,
} from "./accountGuardrailsModel.ts";
import {
  accountErrorText,
  buildLimits,
  DEFAULT_CHATS_PER_DAY,
  DEFAULT_MESSAGES_PER_DAY,
  generatePassphrase,
  initials,
  limitsChanged,
  limitsDraftFrom,
  limitsProblem,
  makeFirst,
  MIN_PASSWORD_LENGTH,
  roleText,
  toggleId,
  usageLine,
  type LimitsDraft,
} from "./usersModel.ts";
import { isReauthCancelled, type WithReauth } from "./ownerReauth.tsx";
import { getLocale, tr } from "../../i18n/index.ts";

type AccessChoice = SpaceRole | "none";

const EXTRA_CHOICES = extraGrantChoices(GUARDRAIL_GRANTABLE, GUARDRAIL_DEFAULT_GRANTS);
const SAFE_EXTRAS = EXTRA_CHOICES.filter((capability) => !isRiskyGrant(capability));
const RISKY_EXTRAS = EXTRA_CHOICES.filter(isRiskyGrant);

interface HarnessChoice { id: string; name: string }

interface Props {
  account: AccountChoice;
  /** Display name already resolved by the list. */
  name: string;
  spaceAccess: CurrentSpaceAccess | null;
  withReauth: WithReauth;
  onBack: () => void;
  /** Re-read accounts and memberships after a change. */
  onChanged: () => Promise<void>;
  /** The account is gone from management (disabled); return to the list. */
  onRemoved: (message: string) => void;
  /** A result from the list (e.g. "created") to show until the next action. */
  welcome?: string | undefined;
}

export default function UserDetail({ account, name, spaceAccess, withReauth, onBack, onChanged, onRemoved, welcome }: Props) {
  const [loadError, setLoadError] = useState<unknown>(null);
  const [limitsDto, setLimitsDto] = useState<AccountLimitsDto | null>(null);
  const [guardDto, setGuardDto] = useState<AccountGuardrailsDto | null>(null);
  const [permissionsDto, setPermissionsDto] = useState<AccountPermissionsDto | null>(null);
  const [limitsInitial, setLimitsInitial] = useState<LimitsDraft | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<LimitsDraft | null>(null);
  const [guardInitial, setGuardInitial] = useState<GuardrailDraft | null>(null);
  const [guardDraft, setGuardDraft] = useState<GuardrailDraft | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessChoice[] | null>(null);
  const [catalog, setCatalog] = useState<ModelDescriptor[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(
    welcome ? { tone: "success", text: welcome } : null,
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatusState>("idle");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [nameDraft, setNameDraft] = useState(name);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => { setNameDraft(name); }, [name]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [limits, guard, permissions] = await Promise.all([
        accountLimits(account.id),
        accountGuardrails(account.id),
        // Best-effort: without it only the assistant permission switches are hidden.
        accountPermissions(account.id).catch(() => null),
      ]);
      setLimitsDto(limits);
      setGuardDto(guard);
      setPermissionsDto(permissions);
      const nextLimits = limitsDraftFrom(limits.limits);
      setLimitsInitial(nextLimits);
      setLimitsDraft(nextLimits);
      const nextGuard = draftFrom(guard.guardrails, GUARDRAIL_GRANTABLE, GUARDRAIL_DEFAULT_GRANTS);
      setGuardInitial(nextGuard);
      setGuardDraft(nextGuard);
    } catch (cause) {
      setLoadError(cause);
    }
  }, [account.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let live = true;
    // Choices are best-effort: a failed list keeps the saved ids editable.
    void api.listProjects().then((list) => { if (live) setProjects(list); }, () => { if (live) setProjects([]); });
    void api.harnessSnapshots().then(
      (list) => { if (live) setHarnesses(list.map((snapshot) => ({ id: snapshot.identity.id, name: snapshot.identity.name }))); },
      () => { if (live) setHarnesses([]); },
    );
    void fetch("/api/models?all=1").then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as unknown;
      if (live) setCatalog(Array.isArray(body) ? body as ModelDescriptor[] : []);
    }).catch(() => { if (live) setCatalog([]); });
    return () => { live = false; };
  }, []);

  const membership = spaceAccess?.members.find((member) => member.userId === account.id);
  const isDisabled = account.status === "disabled" || account.status === "offboarding";
  const isSuspended = account.status === "suspended";
  const canEditMembership = !!spaceAccess?.canManageMembers && !isDisabled
    && (spaceAccess.role === "owner" || membership?.role !== "owner");
  const accessValue: AccessChoice = membership?.role ?? "none";

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await withReauth(action);
      setNotice({ tone: "success", text: success });
      await onChanged();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setNotice({ tone: "error", text: accountErrorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  const changeAccess = async (next: AccessChoice) => {
    if (!spaceAccess || next === accessValue) return;
    const current = membership?.role;
    if (next === "none") {
      const ok = await confirmAlert(
        tr("settings.users.removeAccessBody", { name, space: spaceAccess.name }),
        { title: tr("settings.users.removeAccessTitle", { name, space: spaceAccess.name }), confirmLabel: tr("settings.users.removeAccess") },
      );
      if (!ok) return;
    } else if (next === "owner" || current === "owner") {
      const ok = await confirmAlert(
        tr("settings.users.changeRoleBody", {
          name,
          from: current ? roleText(current).label : tr("settings.users.noAccess"),
          to: roleText(next).label,
          space: spaceAccess.name,
        }),
        { title: tr("settings.users.changeOwnershipTitle"), confirmLabel: tr("settings.users.changeAccess") },
      );
      if (!ok) return;
    }
    await run(
      () => next === "none"
        ? revokeSpaceMember(spaceAccess.id, account.id)
        : grantSpaceMember(spaceAccess.id, account.id, next).then(() => undefined),
      next === "none"
        ? tr("settings.users.accessRemoved", { name, space: spaceAccess.name })
        : tr("settings.users.roleChanged", { name, role: roleText(next).label, space: spaceAccess.name }),
    );
  };

  const changeSignIn = async (allowed: boolean) => {
    if (!allowed) {
      const ok = await confirmAlert(
        tr("settings.users.pauseBody", { name }),
        { title: tr("settings.users.pauseTitle", { name }), confirmLabel: tr("settings.users.pauseAccount") },
      );
      if (!ok) return;
    }
    await run(
      () => setAccountStatus(account, allowed ? "active" : "suspended"),
      allowed ? tr("settings.users.signInResumed", { name }) : tr("settings.users.signInPaused", { name }),
    );
  };

  const canManageHarnesses = !!permissionsDto?.permissions.includes("harnesses.manage");
  const canAddOwnHarnesses = !!permissionsDto?.permissions.includes("harnesses.personal");
  const changePermission = async (permission: AccountPermission, allowed: boolean, success: string) => {
    if (!permissionsDto) return;
    const next = allowed
      ? [...new Set([...permissionsDto.permissions, permission])]
      : permissionsDto.permissions.filter((entry) => entry !== permission);
    await run(async () => {
      setPermissionsDto(await setAccountPermissions(account.id, next, permissionsDto.revision));
    }, success);
  };
  const changeHarnessManagement = (allowed: boolean) => changePermission("harnesses.manage", allowed, allowed
    ? tr("settings.users.harnessManageOn", { name })
    : tr("settings.users.harnessManageOff", { name }));
  const changeOwnHarnessAccounts = (allowed: boolean) => changePermission("harnesses.personal", allowed, allowed
    ? tr("settings.users.ownHarnessOn", { name })
    : tr("settings.users.ownHarnessOff", { name }));

  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === name) return;
    await run(() => renameAccount(account, next), tr("settings.users.renamed", { name: next }));
  };

  const disable = async () => {
    const ok = await confirmAlert(
      tr("settings.users.disableBody", { name }),
      { title: tr("settings.users.disableTitle", { name }), confirmLabel: tr("settings.users.disableAccount") },
    );
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      await withReauth(() => disableAccount(account));
      onRemoved(tr("settings.users.disabledDone", { name }));
    } catch (cause) {
      if (!isReauthCancelled(cause)) setNotice({ tone: "error", text: accountErrorText(cause) });
      setBusy(false);
    }
  };

  // ------------------------------------------------------------- restrictions

  const dirtyLimits = !!limitsDraft && !!limitsInitial && limitsChanged(limitsDraft, limitsInitial);
  const dirtyGuard = !!guardDraft && !!guardInitial && draftChanged(guardDraft, guardInitial);
  const dirty = dirtyLimits || dirtyGuard;
  const problem = limitsDraft ? limitsProblem(limitsDraft) : null;

  const saveRestrictions = async () => {
    if (!limitsDraft || !guardDraft || !limitsDto || !guardDto || !dirty) return;
    if (problem) { setSaveStatus("error"); setSaveError(problem); return; }
    setBusy(true);
    setSaveStatus("saving");
    setSaveError(undefined);
    setNotice(null);
    try {
      // Each write is its own revisioned request; a later failure keeps the
      // earlier one saved and only the rest stays dirty.
      if (dirtyLimits) {
        const saved = await withReauth(() => setAccountLimits(account.id, buildLimits(limitsDraft), limitsDto.revision));
        setLimitsDto(saved);
        const next = limitsDraftFrom(saved.limits);
        setLimitsInitial(next);
        setLimitsDraft(next);
      }
      if (dirtyGuard) {
        const saved = await withReauth(() => setAccountGuardrails(
          account.id, buildGuardrails(guardDraft, GUARDRAIL_DEFAULT_GRANTS), guardDto.revision,
        ));
        setGuardDto(saved);
        const next = draftFrom(saved.guardrails, GUARDRAIL_GRANTABLE, GUARDRAIL_DEFAULT_GRANTS);
        setGuardInitial(next);
        setGuardDraft(next);
      }
      setSaveStatus("saved");
      await onChanged();
    } catch (cause) {
      if (isReauthCancelled(cause)) setSaveStatus("idle");
      else { setSaveStatus("error"); setSaveError(accountErrorText(cause)); }
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    setLimitsDraft(limitsInitial);
    setGuardDraft(guardInitial);
    setSaveStatus("idle");
    setSaveError(undefined);
  };

  const updateLimits = (patch: Partial<LimitsDraft>) => {
    if (!limitsDraft) return;
    setLimitsDraft({ ...limitsDraft, ...patch });
    setSaveStatus("idle");
  };
  const updateGuard = (patch: Partial<GuardrailDraft>) => {
    if (!guardDraft) return;
    setGuardDraft({ ...guardDraft, ...patch });
    setSaveStatus("idle");
  };

  // Saved ids that are not projects of this Space (another Space, or removed).
  const otherProjectIds = useMemo(() => {
    if (!limitsDraft || !projects) return [];
    return limitsDraft.projects.filter((id) => !projects.some((project) => project.id === id));
  }, [limitsDraft, projects]);

  const harnessChoices = useMemo<HarnessChoice[]>(() => {
    const known = harnesses ?? [];
    const saved = (limitsDraft?.harnesses ?? []).filter((id) => !known.some((harness) => harness.id === id));
    return [...known, ...saved.map((id) => ({ id, name: id }))];
  }, [harnesses, limitsDraft]);

  const modelName = (ref: HarnessModelRef): string => {
    const found = catalog?.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID
      && (!model.harnessId || model.harnessId === ref.harnessId));
    return found ? `${found.name}${found.providerName ? ` · ${found.providerName}` : ""}` : `${ref.providerID} / ${ref.modelID}`;
  };
  const pickableModels = useMemo(() => {
    if (!catalog) return [];
    const allowedHarness = (id: string): boolean =>
      limitsDraft?.harnessScope !== "selected" || limitsDraft.harnesses.includes(id);
    return catalog.filter((model) => model.harnessId && allowedHarness(model.harnessId));
  }, [catalog, limitsDraft]);

  if (loadError) {
    return (
      <div className="user-detail">
        <DetailHeader name={name} account={account} accessValue={accessValue} onBack={onBack} />
        <ErrorState title={tr("settings.users.loadFailed")} error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  const approvalsHint: Record<GuardrailApprovals, string> = {
    none: tr("settings.users.approvalsNoneHint"),
    once: tr("settings.users.approvalsOnceHint", { name }),
  };

  return (
    <div className="user-detail">
      <DetailHeader
        name={name}
        account={account}
        accessValue={accessValue}
        onBack={onBack}
        {...(limitsDto?.limits ? { limited: true } : {})}
        {...(guardDto?.guardrails ? { guarded: true } : {})}
      />

      {notice && (
        <Notice tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</Notice>
      )}

      <Section title={tr("settings.users.profile")}>
        {account.managed ? (
          <ReadonlyRow label={tr("settings.users.name")} value={name} hint={tr("settings.users.nameManagedHint")} />
        ) : (
          <Row label={tr("settings.users.name")} hint={tr("settings.users.nameHint")}>
            <span className="user-detail-inline">
              <TextInput
                uiSize="sm"
                value={nameDraft}
                aria-label={tr("settings.users.name")}
                disabled={busy || isDisabled}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter") void rename(); }}
              />
              {nameDraft.trim() !== name && nameDraft.trim() && (
                <Button size="sm" variant="quiet" disabled={busy} onClick={() => void rename()}>{tr("common.rename")}</Button>
              )}
            </span>
          </Row>
        )}
        {account.login && <ReadonlyRow label={tr("settings.users.login")} value={`@${account.login}`} mono />}
        {isDisabled ? (
          <ReadonlyRow label={tr("settings.users.signIn")} value={<Badge tone="danger">{tr("settings.users.disabled")}</Badge>} hint={tr("settings.users.signInDisabledHint")} />
        ) : !account.managed ? (
          <Row
            label={tr("settings.users.canSignIn")}
            hint={isSuspended
              ? tr("settings.users.signInPausedHint")
              : tr("settings.users.signInHint")}
          >
            <Toggle on={!isSuspended} disabled={busy} label={tr("settings.users.canSignIn")} onChange={(on) => void changeSignIn(on)} />
          </Row>
        ) : null}
      </Section>

      <Section
        title={spaceAccess ? tr("settings.users.accessTo", { space: spaceAccess.name }) : tr("settings.users.spaceAccess")}
        hint={spaceAccess ? tr("settings.users.spaceAccessHint") : tr("settings.users.spaceUnavailable")}
      >
        {spaceAccess && (
          <Row
            label={tr("settings.users.role")}
            hint={accessValue === "none" ? tr("settings.users.noAccessDetail") : roleText(accessValue).detail}
          >
            {canEditMembership ? (
              <Select
                label={tr("settings.users.roleFor", { name })}
                ariaLabel={tr("settings.users.roleFor", { name })}
                value={accessValue}
                disabled={busy}
                options={[
                  { value: "none", label: tr("settings.users.noAccess"), detail: tr("settings.users.noAccessDetail") },
                  ...(["viewer", "member", "admin", "owner"] as const)
                    .filter((role) => role !== "owner" || spaceAccess.role === "owner")
                    .map((role) => ({ value: role, ...roleText(role) })),
                ]}
                onChange={(value) => { if (value === "none" || isSpaceRole(value)) void changeAccess(value); }}
              />
            ) : (
              <Badge tone={accessValue === "none" ? "neutral" : "info"}>
                {accessValue === "none" ? tr("settings.users.noAccess") : roleText(accessValue).label}
              </Badge>
            )}
          </Row>
        )}
        {guardDto?.guardrails && (accessValue === "admin" || accessValue === "owner") && (
          <p className="user-detail-note">{tr("settings.users.protectedAdminNote")}</p>
        )}
      </Section>

      {!limitsDraft || !guardDraft ? (
        <EmptyState compact busy title={tr("settings.users.loadingLimits")} />
      ) : (
        <>
          <Section
            title={tr("settings.users.projects")}
            hint={tr("settings.users.projectsHint")}
          >
            <Row label={tr("settings.users.canUse")}>
              <Seg
                label={tr("settings.users.projectsScopeLabel")}
                value={limitsDraft.projectScope}
                disabled={busy}
                options={[["all", tr("settings.users.allProjects")], ["selected", tr("settings.users.onlySelected")]]}
                onChange={(projectScope) => updateLimits({ projectScope })}
              />
            </Row>
            {limitsDraft.projectScope === "selected" && (
              projects === null ? (
                <EmptyState compact busy title={tr("settings.users.loadingProjects")} />
              ) : projects.length === 0 && otherProjectIds.length === 0 ? (
                <EmptyState compact icon="folder" title={tr("settings.users.noProjects")} body={tr("settings.users.noProjectsBody")} />
              ) : (
                <div className="user-detail-choices">
                  <CheckGroup
                    label={tr("settings.users.allowedProjects")}
                    columns={2}
                    disabled={busy}
                    value={limitsDraft.projects.filter((id) => projects.some((project) => project.id === id))}
                    options={projects.map((project) => ({ id: project.id, label: project.name, description: project.path }))}
                    onChange={(next) => updateLimits({ projects: [...next, ...otherProjectIds] })}
                  />
                  {otherProjectIds.length > 0 && (
                    <p className="user-detail-note">
                      {tr(
                        new Intl.PluralRules(getLocale()).select(otherProjectIds.length) === "one"
                          ? "settings.users.otherSpaceProjectsOne"
                          : "settings.users.otherSpaceProjectsOther",
                        { count: otherProjectIds.length },
                      )}{" "}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateLimits({ projects: limitsDraft.projects.filter((id) => !otherProjectIds.includes(id)) })}>
                        {tr("common.remove")}
                      </Button>
                    </p>
                  )}
                  <p className="user-detail-note">{tr("settings.users.projectsLockedNote")}</p>
                </div>
              )
            )}
          </Section>

          <Section title={tr("settings.users.assistants")} hint={tr("settings.users.assistantsHint")}>
            {permissionsDto && (
              <Row
                label={tr("settings.users.canManageAssistants")}
                hint={guardDto?.guardrails
                  ? tr("settings.users.notInProtectedMode")
                  : tr("settings.users.canManageAssistantsHint")}
              >
                <Toggle
                  on={canManageHarnesses && !guardDto?.guardrails}
                  disabled={busy || isDisabled || !!guardDto?.guardrails}
                  label={tr("settings.users.canManageAssistants")}
                  onChange={(on) => void changeHarnessManagement(on)}
                />
              </Row>
            )}
            {permissionsDto && (
              <Row
                label={tr("settings.users.canAddOwnHarness")}
                hint={guardDto?.guardrails
                  ? tr("settings.users.notInProtectedMode")
                  : canManageHarnesses
                    ? tr("settings.users.includedWithManage")
                    : tr("settings.users.canAddOwnHarnessHint")}
              >
                <Toggle
                  on={(canAddOwnHarnesses || canManageHarnesses) && !guardDto?.guardrails}
                  disabled={busy || isDisabled || !!guardDto?.guardrails || canManageHarnesses}
                  label={tr("settings.users.canAddOwnHarness")}
                  onChange={(on) => void changeOwnHarnessAccounts(on)}
                />
              </Row>
            )}
            <Row label={tr("settings.users.canUse")}>
              <Seg
                label={tr("settings.users.assistantsScopeLabel")}
                value={limitsDraft.harnessScope}
                disabled={busy}
                options={[["all", tr("settings.users.allAssistants")], ["selected", tr("settings.users.onlySelected")]]}
                onChange={(harnessScope) => updateLimits({ harnessScope })}
              />
            </Row>
            {limitsDraft.harnessScope === "selected" && (
              harnesses === null ? (
                <EmptyState compact busy title={tr("settings.users.loadingAssistants")} />
              ) : harnessChoices.length === 0 ? (
                <EmptyState compact icon="terminal" title={tr("settings.users.noAssistants")} body={tr("settings.users.noAssistantsBody")} />
              ) : (
                <div className="user-detail-choices">
                  <ul className="user-choice-list" aria-label={tr("settings.users.allowedAssistants")}>
                    {harnessChoices.map((harness) => {
                      const index = limitsDraft.harnesses.indexOf(harness.id);
                      return (
                        <li key={harness.id} className="user-choice">
                          <Checkbox
                            checked={index >= 0}
                            disabled={busy}
                            label={harness.name}
                            onChange={(on) => updateLimits({ harnesses: toggleId(limitsDraft.harnesses, harness.id, on) })}
                          />
                          {index === 0 && <Badge tone="accent">{tr("settings.users.default")}</Badge>}
                          {index > 0 && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateLimits({ harnesses: makeFirst(limitsDraft.harnesses, harness.id) })}>
                              {tr("settings.users.makeDefault")}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="user-detail-note">{tr("settings.users.assistantsDefaultNote")}</p>
                </div>
              )
            )}
          </Section>

          <Section title={tr("settings.users.dailyLimits")} hint={tr("settings.users.dailyLimitsHint")}>
            <LimitRow
              label={tr("settings.users.messagesPerDay")}
              toggleLabel={tr("settings.users.limitMessages")}
              hint={limitsDto ? usageLine(limitsDto.usage, limitsDto.limits?.messagesPerDay ?? null, "message", "messages") : undefined}
              value={limitsDraft.messagesPerDay}
              fallback={DEFAULT_MESSAGES_PER_DAY}
              disabled={busy}
              onChange={(messagesPerDay) => updateLimits({ messagesPerDay })}
            />
            <LimitRow
              label={tr("settings.users.chatsPerDay")}
              toggleLabel={tr("settings.users.limitChats")}
              hint={limitsDto ? usageLine(limitsDto.usage, limitsDto.limits?.chatsPerDay ?? null, "chat", "chats") : undefined}
              value={limitsDraft.chatsPerDay}
              fallback={DEFAULT_CHATS_PER_DAY}
              disabled={busy}
              onChange={(chatsPerDay) => updateLimits({ chatsPerDay })}
            />
            {limitsDto && !limitsDto.limits && (
              <p className="user-detail-note">{tr("settings.users.usageCountedNote")}</p>
            )}
          </Section>

          <Section title={tr("settings.users.protectedMode")} hint={tr("settings.users.protectedModeHint")}>
            <Row label={tr("settings.users.protectedMode")} hint={guardDraft.enabled ? tr("settings.users.protectedOn") : tr("settings.users.protectedOff")}>
              <Toggle on={guardDraft.enabled} disabled={busy} label={tr("settings.users.protectedMode")} onChange={(enabled) => updateGuard({ enabled })} />
            </Row>
            {guardDraft.enabled && (
              <>
                <Row label={tr("settings.users.agentActions")} hint={approvalsHint[guardDraft.approvals]}>
                  <Seg
                    label={tr("settings.users.whoApproves")}
                    value={guardDraft.approvals}
                    disabled={busy}
                    options={[["none", tr("settings.users.approvalsNone")], ["once", tr("settings.users.approvalsOnce")]]}
                    onChange={(approvals) => updateGuard({ approvals })}
                  />
                </Row>
                <Row
                  label={tr("settings.users.models")}
                  layout="stacked"
                  hint={guardDraft.models.length === 0
                    ? tr("settings.users.modelsNoneHint")
                    : tr("settings.users.modelsHint")}
                >
                  <div className="user-detail-choices">
                    {guardDraft.models.length > 0 && (
                      <ol className="user-choice-list">
                        {guardDraft.models.map((model, index) => (
                          <li key={`${model.harnessId}/${model.providerID}/${model.modelID}`} className="user-choice">
                            <span className="user-choice-name">{modelName(model)}</span>
                            {index === 0 && <Badge tone="accent">{tr("settings.users.default")}</Badge>}
                            {limitsDraft.harnessScope === "selected" && !limitsDraft.harnesses.includes(model.harnessId) && (
                              <Badge tone="warning">{tr("settings.users.assistantNotAllowed")}</Badge>
                            )}
                            {index > 0 && (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateGuard({ models: makeDefaultModel(guardDraft.models, model) })}>{tr("settings.users.makeDefault")}</Button>
                            )}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => updateGuard({ models: removeModel(guardDraft.models, model) })}>{tr("common.remove")}</Button>
                          </li>
                        ))}
                      </ol>
                    )}
                    {catalog !== null && catalog.length === 0 ? (
                      <Notice tone="warning">{tr("settings.users.modelsLoadFailed")}</Notice>
                    ) : (
                      <fieldset className="user-model-picker" disabled={busy} aria-label={tr("settings.users.allowedModels")}>
                        <ModelPicker
                          models={pickableModels}
                          selection={guardDraft.models}
                          emptyLabel={tr("settings.users.addModel")}
                          catalogLoading={catalog === null}
                          onPick={() => updateGuard({ models: [] })}
                          onToggle={(picked) => {
                            if (!picked.harnessId) return;
                            const ref: HarnessModelRef = { harnessId: picked.harnessId, providerID: picked.providerID, modelID: picked.modelID };
                            updateGuard({
                              models: guardDraft.models.some((entry) => sameModel(entry, ref))
                                ? removeModel(guardDraft.models, ref)
                                : addModel(guardDraft.models, ref),
                            });
                          }}
                        />
                      </fieldset>
                    )}
                  </div>
                </Row>
                <Row
                  label={tr("settings.users.alsoAllowed")}
                  layout="stacked"
                  hint={tr("settings.users.alsoAllowedHint")}
                >
                  <div className="user-detail-choices">
                    <CheckGroup
                      label={tr("settings.users.extraPermissions")}
                      columns={2}
                      disabled={busy}
                      value={guardDraft.extra.filter((capability) => SAFE_EXTRAS.includes(capability))}
                      options={SAFE_EXTRAS.map((capability) => {
                        const text = grantLabel(capability);
                        return { id: capability, label: text.label, ...(text.detail ? { description: text.detail } : {}) };
                      })}
                      onChange={(next) => updateGuard({ extra: [...next, ...guardDraft.extra.filter(isRiskyGrant)] })}
                    />
                    {RISKY_EXTRAS.length > 0 && (
                      <details className="guardrails-advanced" open={guardDraft.extra.some(isRiskyGrant) || undefined}>
                        <summary>{tr("settings.users.advancedPermissions")}</summary>
                        {RISKY_EXTRAS.map((capability) => {
                          const text = grantLabel(capability);
                          return (
                            <Checkbox
                              key={capability}
                              checked={guardDraft.extra.includes(capability)}
                              disabled={busy}
                              label={<>{text.label} <Badge tone="warning">{tr("settings.users.risky")}</Badge></>}
                              {...(text.detail ? { description: text.detail } : {})}
                              onChange={(on) => updateGuard({ extra: toggleExtra(guardDraft.extra, capability, on) })}
                            />
                          );
                        })}
                      </details>
                    )}
                  </div>
                </Row>
              </>
            )}
          </Section>

          <div className="user-detail-savebar">
            {problem && dirty && <Notice tone="warning">{problem}</Notice>}
            <SaveBar
              dirty={dirty}
              saving={saveStatus === "saving"}
              status={saveStatus}
              {...(saveError ? { error: saveError } : {})}
              saveLabel={tr("settings.pages.saveChanges")}
              onSave={() => void saveRestrictions()}
              onDiscard={discard}
            />
          </div>
        </>
      )}

      {!account.managed && !isDisabled && account.login && (
        <Section title={tr("settings.users.password")}>
          <Row label={tr("settings.users.setNewPassword")} hint={tr("settings.users.setNewPasswordHint", { name })}>
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => setPasswordOpen(true)}>{tr("settings.users.setPasswordEllipsis")}</Button>
          </Row>
        </Section>
      )}

      {!account.managed && !isDisabled && (
        <Section title={tr("settings.users.disableAccount")} tone="danger">
          <Row label={tr("settings.users.disablePermanently")} hint={tr("settings.users.disablePermanentlyHint")}>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void disable()}>{tr("settings.users.disableAccount")}</Button>
          </Row>
        </Section>
      )}

      {passwordOpen && (
        <PasswordDialog
          name={name}
          onClose={() => setPasswordOpen(false)}
          onSave={async (password) => {
            await withReauth(() => resetAccountPassword(account.id, password));
            setPasswordOpen(false);
            setNotice({ tone: "success", text: tr("settings.users.passwordChanged", { name }) });
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function DetailHeader({ name, account, accessValue, onBack, limited = false, guarded = false }: {
  name: string;
  account: AccountChoice;
  accessValue: AccessChoice;
  onBack: () => void;
  limited?: boolean;
  guarded?: boolean;
}) {
  return (
    <div className="user-detail-head">
      <Button size="sm" variant="ghost" iconStart={BackIcon} className="user-detail-back" onClick={onBack}>{tr("settings.users.allUsers")}</Button>
      <div className="user-detail-identity">
        <div className="user-avatar is-large" aria-hidden="true">{initials(name)}</div>
        <div className="user-row-copy">
          <div className="user-row-name">
            <strong>{name}</strong>
            {account.status === "suspended" && <Badge tone="warning">{tr("settings.users.paused")}</Badge>}
            {(account.status === "disabled" || account.status === "offboarding") && <Badge tone="danger">{tr("settings.users.disabled")}</Badge>}
          </div>
          <span className="user-row-meta">
            {account.login ? `@${account.login}` : tr("settings.users.noPasswordSignIn")}
            {" · "}
            {accessValue === "none" ? tr("settings.users.noAccessToSpace") : roleText(accessValue).label}
          </span>
          {(limited || guarded) && (
            <span className="user-row-badges">
              {limited && <Badge tone="info">{tr("settings.users.limited")}</Badge>}
              {guarded && <Badge tone="info">{tr("settings.users.protected")}</Badge>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** One optional daily cap: off = unlimited; on = a whole number. */
function LimitRow({ label, toggleLabel, hint, value, fallback, disabled, onChange }: {
  label: string;
  /** Accessible name of the on/off switch ("Limit messages per day"). */
  toggleLabel: string;
  hint?: string | undefined;
  value: number | null;
  fallback: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <Row label={label} {...(hint ? { hint } : {})}>
      <span className="user-detail-inline">
        {value !== null && (
          <NumberField label={label} value={value} min={0} max={100_000} width="md" disabled={disabled} onCommit={onChange} />
        )}
        <Toggle on={value !== null} disabled={disabled} label={toggleLabel} onChange={(on) => onChange(on ? fallback : null)} />
      </span>
    </Row>
  );
}

/** Owner sets a new password for someone else, with a generator for an
 *  easy-to-type passphrase. */
export function PasswordDialog({ name, onClose, onSave, title, intro }: {
  name: string;
  onClose: () => void;
  onSave: (password: string) => Promise<void>;
  title?: string;
  intro?: string;
}) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const valid = [...password].length >= MIN_PASSWORD_LENGTH;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(password);
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title ?? tr("settings.users.newPasswordFor", { name })}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>{tr("settings.users.setPassword")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p className="users-dialog-intro">{intro ?? tr("settings.users.newPasswordIntro", { name })}</p>
        <PassphraseField
          value={password}
          visible={visible}
          copied={copied}
          disabled={busy}
          onChange={(next) => { setPassword(next); setCopied(false); }}
          onToggleVisible={() => setVisible(!visible)}
          onGenerate={() => { setPassword(generatePassphrase()); setVisible(true); setCopied(false); }}
          onCopied={() => setCopied(true)}
        />
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}

/** Passphrase input with show/hide, generate and copy. Shared by Add user. */
export function PassphraseField({ value, visible, copied, disabled, label = tr("settings.users.password"), onChange, onToggleVisible, onGenerate, onCopied }: {
  value: string;
  visible: boolean;
  copied: boolean;
  disabled: boolean;
  label?: string;
  onChange: (value: string) => void;
  onToggleVisible: () => void;
  onGenerate: () => void;
  onCopied: () => void;
}) {
  const tooShort = value.length > 0 && [...value].length < MIN_PASSWORD_LENGTH;
  return (
    <FormField
      label={label}
      hint={copied ? tr("settings.users.passwordCopied") : tr("settings.users.passwordHint", { count: MIN_PASSWORD_LENGTH })}
      {...(tooShort ? { error: tr("settings.users.passwordTooShort", { count: MIN_PASSWORD_LENGTH }) } : {})}
    >
      {(field) => (
        <span className="users-passphrase">
          <TextInput
            {...field}
            type={visible ? "text" : "password"}
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled}
            invalid={tooShort}
            onChange={(event) => onChange(event.target.value)}
          />
          <IconButton icon={visible ? HideIcon : ShowIcon} label={visible ? tr("setup.account.hidePassword") : tr("setup.account.showPassword")} disabled={disabled} onClick={onToggleVisible} />
          <IconButton
            icon={CopyIcon}
            label={tr("settings.users.copyPassword")}
            disabled={disabled || !value}
            onClick={() => { void navigator.clipboard?.writeText(value).then(onCopied, () => undefined); }}
          />
          <Button size="sm" variant="quiet" iconStart={RefreshIcon} disabled={disabled} onClick={onGenerate}>{tr("settings.users.generate")}</Button>
        </span>
      )}
    </FormField>
  );
}
