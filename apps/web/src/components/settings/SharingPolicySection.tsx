// The current Space's sharing policy (Spaces §14.3). Space admins edit it;
// everyone else sees the rules that apply to them. Each value autosaves on
// change, guarded by the policy revision: if another admin saved first, the
// latest values are shown instead of overwriting theirs.
import { useCallback, useEffect, useState } from "react";
import { SESSION_ACCESS_LEVELS, type SessionAccessLevel, type SpaceSharingPolicy, type SpaceSharingPolicyDto } from "@polyth/contracts";
import { httpStatusOf } from "@polyth/session/web-api";
import { tr } from "../../i18n/index.ts";
import { accessLabel, loadSharingPolicy, saveSharingPolicy } from "../../sessionSharing.ts";
import { Select } from "../ui/index.ts";
import {
  EmptyState, ErrorState, ReadonlyRow, Row, SaveStatus, Section, Seg, Toggle,
  settingsErrorText, type SaveStatusState,
} from "./parts.tsx";

const audienceLabel = (value: SpaceSharingPolicy["defaultVisibility"]): string =>
  value === "space" ? tr("sharing.policySpace") : tr("sharing.policyPrivate");
const yesNo = (value: boolean): string => value ? tr("sharing.allowed") : tr("sharing.notAllowed");

export default function SharingPolicySection() {
  const [policy, setPolicy] = useState<SpaceSharingPolicyDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [status, setStatus] = useState<SaveStatusState>("idle");
  const [saveError, setSaveError] = useState<string | undefined>();

  const load = useCallback(() => loadSharingPolicy().then(
    (next) => { setPolicy(next); setLoadError(null); },
    (error: unknown) => setLoadError(error),
  ), []);
  useEffect(() => { void load(); }, [load]);

  // No sharing route: a legacy install without canonical identity.
  if (!policy && httpStatusOf(loadError) === 404) return null;

  const title = tr("sharing.policyTitle");
  const hint = policy && !policy.canEdit ? tr("sharing.policyReadOnly") : tr("sharing.policyHint");
  const action = policy?.canEdit ? <SaveStatus state={status} {...(saveError ? { error: saveError } : {})} /> : undefined;

  if (!policy) {
    return (
      <Section title={title} hint={tr("sharing.policyHint")} itemId="users.sharing">
        {loadError
          ? <ErrorState compact title={tr("sharing.policyUnavailable")} error={loadError} onRetry={() => void load()} />
          : <EmptyState compact busy title={tr("common.loading")} />}
      </Section>
    );
  }

  const update = async (patch: Partial<SpaceSharingPolicy>) => {
    const before = policy;
    setPolicy({ ...policy, ...patch });
    setStatus("saving");
    setSaveError(undefined);
    try {
      setPolicy(await saveSharingPolicy({ ...patch, expectedRevision: before.revision }));
      setStatus("saved");
    } catch (error) {
      setPolicy(before);
      setStatus("error");
      if (httpStatusOf(error) === 409) {
        setSaveError(tr("sharing.policyChanged"));
        void load();
      } else {
        setSaveError(settingsErrorText(error).message);
      }
    }
  };

  if (!policy.canEdit) {
    return (
      <Section title={title} hint={hint} itemId="users.sharing">
        <ReadonlyRow label={tr("sharing.policyDefault")} value={audienceLabel(policy.defaultVisibility)} />
        <ReadonlyRow label={tr("sharing.policyAllowSpace")} value={yesNo(policy.allowSpaceVisibility)} />
        <ReadonlyRow label={tr("sharing.policyMembersShare")} value={yesNo(policy.membersMayShare)} />
        {policy.membersMayShare && (
          <ReadonlyRow label={tr("sharing.policyMaxAccess")} value={accessLabel(policy.maxMemberAccess)} />
        )}
      </Section>
    );
  }

  return (
    <Section title={title} hint={hint} action={action} itemId="users.sharing">
      <Row label={tr("sharing.policyDefault")} hint={tr("sharing.policyDefaultHint")}>
        <Seg
          label={tr("sharing.policyDefault")}
          value={policy.defaultVisibility}
          options={[
            ["private", tr("sharing.policyPrivate")],
            // The server refuses a Space-wide default while Space sharing is off.
            ...(policy.allowSpaceVisibility ? [["space", tr("sharing.policySpace")] as ["space", string]] : []),
          ]}
          onChange={(value) => void update({ defaultVisibility: value })}
        />
      </Row>
      <Row label={tr("sharing.policyAllowSpace")} hint={tr("sharing.policyAllowSpaceHint")}>
        <Toggle
          label={tr("sharing.policyAllowSpace")}
          on={policy.allowSpaceVisibility}
          onChange={(on) => void update(on
            ? { allowSpaceVisibility: true }
            : { allowSpaceVisibility: false, ...(policy.defaultVisibility === "space" ? { defaultVisibility: "private" as const } : {}) })}
        />
      </Row>
      <Row label={tr("sharing.policyMembersShare")} hint={tr("sharing.policyMembersShareHint")}>
        <Toggle
          label={tr("sharing.policyMembersShare")}
          on={policy.membersMayShare}
          onChange={(on) => void update({ membersMayShare: on })}
        />
      </Row>
      <Row label={tr("sharing.policyMaxAccess")} hint={tr("sharing.policyMaxAccessHint")} disabled={!policy.membersMayShare}>
        <Select
          label={tr("sharing.policyMaxAccess")}
          value={policy.maxMemberAccess}
          disabled={!policy.membersMayShare}
          options={SESSION_ACCESS_LEVELS.map((level) => ({ value: level, label: accessLabel(level) }))}
          onChange={(value) => void update({ maxMemberAccess: value as SessionAccessLevel })}
        />
      </Row>
    </Section>
  );
}
