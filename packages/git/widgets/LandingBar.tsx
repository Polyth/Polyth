import { useCallback, useEffect, useRef, useState } from "react";
import type { IsolationStatusDto, IsolationTargetDto, IsolationTargetPushDto, SessionIsolation } from "@polyth/contracts";
import { isManagedIsolationBranch, isolationBlocksUserMutation, isolationNeedsRecovery } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  BranchIcon,
  Button,
  CheckIcon,
  ChevronDownIcon,
  CombineIcon,
  Icon,
  Menu,
  WarningIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { createBranchDiffClient } from "./branchDiffClient.ts";
import { reportGitError } from "./gitRefusal.ts";
import { setGitPrefs, useGitPrefs } from "./gitPrefs.ts";
import { createIsolationClient } from "./isolationClient.ts";

const isolationClient = createIsolationClient();
const branchDiffClient = createBranchDiffClient();

type Tone = "ok" | "neutral" | "warn" | "danger";
type Check = { tone: Tone; text: string };

/** What the check line knows beyond the status: read only for the recorded
 *  target, so a proposed one never borrows another branch's answer. */
type Preview = { key: string; conflicts: number | null; ahead: number | null };

const conflictText = (branch: string, count: number): string =>
  count === 1 ? tr("landing.oneConflictFile", { branch }) : tr("landing.conflictFiles", { branch, count });

const sameTarget = (a: { branch: string; path: string }, b: { branch: string; path: string }) =>
  a.branch === b.branch && a.path === b.path;

/**
 * "Where to integrate": the landing of an isolated chat's work, under the
 * Changes tab. It names the target branch (a chip that chooses another
 * checked-out branch through `isolation.retarget`), says in one line what
 * integrating there would meet, and offers one primary action whose label is
 * exactly what happens — integrate, and push the target when the person keeps
 * Push on. The chat's isolation card stays the compact form of the same
 * state; both read the server's status, so a choice made here shows there.
 */
export default function LandingBar({ host, projectId, sessionId, repositoryId, uncommitted, onReviewConflicts }: {
  host?: WebPackageHost;
  projectId: string;
  sessionId: string;
  repositoryId?: string;
  /** Files the working tree changes now: integrating commits them first. */
  uncommitted: number;
  /** Open the Conflicts review; absent while it is already open. */
  onReviewConflicts?: () => void;
}) {
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const isolation: SessionIsolation | null = session?.isolation?.kind === "git-worktree" ? session.isolation : null;
  const working = session ? isolationBlocksUserMutation(session.status) : false;
  const prefs = useGitPrefs(projectId);
  const push = prefs.pushAfterIntegrate;
  const [held, setHeld] = useState<{ sessionId: string; value: IsolationStatusDto } | null>(null);
  const status = held?.sessionId === sessionId ? held.value : null;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"merge" | "retarget" | null>(null);
  const [choosing, setChoosing] = useState(false);
  const request = useRef(0);

  const identity = isolation
    ? `${sessionId}\u0000${isolation.state}\u0000${isolation.targetBranch}\u0000${isolation.originPath ?? ""}\u0000${working ? "working" : "resting"}`
    : null;
  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!identity) { setHeld(null); return; }
    try {
      const next = await api.isolationStatus(sessionId);
      if (id === request.current) setHeld({ sessionId, value: next });
    } catch {
      // The card reports a failed read; this bar keeps what it showed.
    }
    // While the agent works the answer is fixed; turn churn must not re-ask.
  }, [identity, sessionId, working ? "working" : session?.updatedAt, uncommitted]);
  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const live = status?.isolation?.kind === "git-worktree" ? status.isolation : isolation;
  const suggestion = status?.suggestion ?? null;
  const targets: readonly IsolationTargetDto[] = status?.targets ?? [];
  const recorded = live ? { branch: live.targetBranch, path: live.originPath ?? live.targetPath } : null;
  const unavailable = suggestion?.reason === "destination-unavailable";
  // A switched origin checkout is a way forward: its new branch takes the
  // work. Only when nothing can take it by default does the bar ask.
  const originSwitched = unavailable ? targets.find((target) => target.origin && !target.current) : undefined;
  const proposed = originSwitched ?? (unavailable ? null : recorded);
  const stranded = unavailable && !originSwitched;
  const conflict = live?.state === "conflict" && suggestion?.eligible !== true;
  const ready = status?.actions?.canMerge === true || originSwitched !== undefined;
  const delegatedPending = (status?.delegated?.length ?? 0) > 0;

  // Conflicts and commit count are read for the recorded target only, and
  // again whenever the work or the target changes.
  const previewKey = ready && !originSwitched && suggestion && live
    ? `${sessionId}\u0000${live.targetBranch}\u0000${suggestion.revision}\u0000${uncommitted}`
    : null;
  useEffect(() => {
    if (!previewKey) return;
    let active = true;
    setPreview((current) => current?.key === previewKey ? current : { key: previewKey, conflicts: null, ahead: null });
    void isolationClient.conflicts(sessionId)
      .then((value) => { if (active) setPreview((current) => current?.key === previewKey ? { ...current, conflicts: value.files.length } : current); })
      .catch(() => { /* the line just omits it */ });
    void branchDiffClient.list({ projectId, sessionId, ...(repositoryId ? { repositoryId } : {}) })
      .then((value) => { if (active) setPreview((current) => current?.key === previewKey ? { ...current, ahead: value.ahead } : current); })
      .catch(() => { /* the line just omits it */ });
    return () => { active = false; };
  }, [previewKey, projectId, repositoryId, sessionId]);

  if (!session || !isolation || !live || !recorded || !status || isolationNeedsRecovery(live.state)) return null;
  // A delegated isolation lands in its parent's checkout; its card owns that.
  if (isManagedIsolationBranch(live.targetBranch)) return null;
  if (suggestion?.hasChanges !== true && !conflict) return null;

  const shown = proposed ?? recorded;
  const shownBranch = shown.branch;
  const canChoose = status.actions?.canChooseTarget === true && !working && busy === null;
  const known = preview?.key === previewKey ? preview : null;

  const check = ((): Check => {
    if (working) return { tone: "neutral", text: tr("landing.waitWorking") };
    if (suggestion?.reason === "runtime-recovering") return { tone: "neutral", text: tr("isolation.runtimeRecovering") };
    if (delegatedPending) return { tone: "warn", text: tr("isolation.delegatedPending") };
    if (conflict) {
      const count = live.conflict?.files.length ?? 0;
      return { tone: "danger", text: count ? conflictText(shownBranch, count) : tr("isolation.conflictDetail", { branch: shownBranch }) };
    }
    if (suggestion?.reason === "target-overlap") return { tone: "warn", text: tr("landing.targetOverlap", { branch: shownBranch }) };
    if (originSwitched) {
      return { tone: "neutral", text: tr("isolation.originSwitchedDetail", { path: originSwitched.path, current: originSwitched.branch, branch: recorded.branch }) };
    }
    if (unavailable) return { tone: "warn", text: tr("landing.chooseTarget", { branch: recorded.branch }) };
    const parts: string[] = [];
    let tone: Tone = "ok";
    if (known?.conflicts === 0) parts.push(tr("landing.noConflicts"));
    else if (known?.conflicts) { parts.push(conflictText(shownBranch, known.conflicts)); tone = "warn"; }
    else tone = "neutral";
    if (suggestion?.targetDirty) { parts.push(tr("landing.targetDirty", { branch: shownBranch })); if (tone === "ok") tone = "neutral"; }
    else parts.push(tr("landing.targetClean", { branch: shownBranch }));
    if (known?.ahead) parts.push(known.ahead === 1 ? tr("landing.oneCommit") : tr("landing.commits", { count: known.ahead }));
    if (uncommitted > 0) parts.push(uncommitted === 1 ? tr("landing.oneUncommitted") : tr("landing.uncommitted", { count: uncommitted }));
    return { tone, text: parts.join(" · ") };
  })();

  const retarget = (target: IsolationTargetDto) => {
    if (sameTarget(target, recorded)) return;
    setBusy("retarget");
    void api.isolationRetarget(sessionId, { branch: target.branch, path: target.path })
      .then((next) => { upsertSession(next); })
      .catch((cause) => { reportGitError(tr("landing.chooseBranch"), cause); })
      .finally(() => { setBusy(null); void refresh(); });
  };

  const reportPush = (branch: string, pushed: IsolationTargetPushDto) => {
    const notifications = host?.notifications;
    if (pushed.ok) {
      notifications?.show({ kind: "success", title: tr("landing.integratedAndPushed", { branch, remote: pushed.remote }) });
      return;
    }
    const retry = () => api.gitPush(projectId, pushed.remote, sessionId).then(
      () => { notifications?.show({ kind: "success", title: tr("landing.pushed", { branch, remote: pushed.remote }) }); },
      (cause: unknown) => { reportGitError(tr("landing.pushNow"), cause); },
    );
    if (notifications) {
      notifications.show({
        kind: "warning",
        title: tr("landing.integratedNotPushed", { branch }),
        body: pushed.message,
        duration: "sticky",
        actions: [{ label: tr("landing.pushNow"), primary: true, run: retry }],
      });
    } else {
      setUiError(`${tr("landing.integratedNotPushed", { branch })} ${pushed.message}`, { label: tr("landing.pushNow"), run: () => { void retry(); } });
    }
  };

  const integrate = () => {
    const branch = shownBranch;
    setBusy("merge");
    void api.isolationMerge(sessionId, {
      ...(originSwitched ? { target: { branch: originSwitched.branch, path: originSwitched.path } } : {}),
      ...(push ? { push: true } : {}),
    })
      .then((result) => {
        upsertSession(result.session);
        if (result.pushed) reportPush(branch, result.pushed);
      })
      .catch((cause) => { reportGitError(tr("landing.integrate"), cause); })
      .finally(() => { setBusy(null); void refresh(); });
  };

  // Where the work can go, then whether the target is pushed afterwards:
  // one destination choice, a sheet on phones.
  const rows = targets.length ? targets : [{ branch: recorded.branch, path: recorded.path, origin: true, current: true }];
  const entries: MenuEntry[] = [
    ...rows.map((target): MenuEntry => ({
      id: `target:${target.path}`,
      label: target.branch,
      detail: target.origin ? tr("landing.originCheckout", { path: target.path }) : target.path,
      kind: "radio",
      checked: sameTarget(target, shown),
      disabled: !canChoose && !sameTarget(target, shown),
      onSelect: () => retarget(target),
    })),
    "separator",
    {
      id: "push",
      label: tr("landing.pushAfter"),
      detail: tr("landing.pushHint", { branch: shownBranch }),
      kind: "switch",
      checked: push,
      disabled: busy === "merge",
      onSelect: () => setGitPrefs({ pushAfterIntegrate: !push }, projectId),
    },
  ];
  const chip = (
    <span className="git-landing-target-name mono" title={shownBranch}>{shownBranch}</span>
  );

  return (
    <section className="git-landing" aria-label={tr("landing.title")} data-tone={check.tone}>
      <div className="git-landing-route">
        <span className="git-landing-label">{tr("landing.integrateInto")}</span>
        <Menu
          label={tr("landing.chooseBranch")}
          title={tr("landing.title")}
          phonePresentation="sheet"
          entries={entries}
          open={choosing}
          onOpenChange={setChoosing}
        >
          {(trigger) => (
            <Button
              {...trigger}
              size="sm"
              variant="quiet"
              className="git-landing-target"
              iconStart={BranchIcon}
              iconEnd={ChevronDownIcon}
              busy={busy === "retarget"}
              disabled={busy === "merge"}
            >
              {chip}
            </Button>
          )}
        </Menu>
      </div>
      <p className="git-landing-check" data-tone={check.tone} role="status">
        {check.tone === "ok" && <Icon icon={CheckIcon} size="sm" />}
        {(check.tone === "warn" || check.tone === "danger") && <Icon icon={WarningIcon} size="sm" />}
        <span>{check.text}</span>
      </p>
      {(!conflict || onReviewConflicts) && <div className="git-landing-action">
        {conflict ? (
          <Button size="md" variant="primary" block iconStart={WarningIcon} onClick={onReviewConflicts}>
            {tr("landing.reviewConflicts")}
          </Button>
        ) : stranded ? (
          // Nothing takes the work by default: choosing where is the way on.
          <Button size="md" variant="primary" block iconStart={BranchIcon} disabled={!canChoose} onClick={() => setChoosing(true)}>
            {tr("landing.chooseBranchAction")}
          </Button>
        ) : (
          <Button
            size="md"
            variant="primary"
            block
            className="git-landing-primary"
            iconStart={CombineIcon}
            busy={busy === "merge"}
            disabled={!ready || working || busy !== null || delegatedPending || suggestion?.reason === "target-overlap"}
            onClick={integrate}
          >
            {push ? tr("landing.integrateAndPush", { branch: shownBranch }) : tr("isolation.integrateInto", { branch: shownBranch })}
          </Button>
        )}
      </div>}
    </section>
  );
}
