// Move a chat to another checkout (main or a linked worktree) of its project.
// Mounted by the host through the `session.checkout.move` slot while a drop is
// pending, and by the session menu's "Move to checkout…" (target Select first).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorCodeOf, type Worktree } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import type {
  SessionCheckoutBranchChoice, SessionCheckoutPreview, SessionCheckoutTarget,
} from "../src/sessionCheckoutMove.ts";
import { Button, Checkbox, Dialog, Notice, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { upsertSession } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { gitSessionCheckout, gitSessionCheckoutPreview } from "./checkoutMoveClient.ts";
import { branchRefusalMessage, branchRefusalOf } from "./gitRefusal.ts";

type BranchMode = "keep" | "switch" | "other" | "create";

const targetKey = (target: SessionCheckoutTarget): string => "main" in target ? "main" : target.worktreePath;
const fromKey = (key: string): SessionCheckoutTarget => key === "main" ? { main: true } : { worktreePath: key };
const leaf = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** Targets a chat can move to: the main checkout plus every linked worktree except the current one. */
export function moveTargets(worktrees: readonly Worktree[], currentPath: string | undefined): Array<{ key: string; label: string }> {
  const main = worktrees.find((tree) => tree.isMain);
  const here = currentPath || main?.path;
  return worktrees
    .filter((tree) => tree.path !== here)
    .map((tree) => ({ key: tree.isMain ? "main" : tree.path, label: tree.isMain ? tr("gitmove.mainCheckout") : leaf(tree.path) }));
}

export interface MoveToCheckoutDialogProps {
  sessionId: string;
  projectId: string;
  /** Fixed target (a drop). Absent: the person picks it in the first field. */
  target?: SessionCheckoutTarget;
  /** Worktrees offered when no fixed target is given. */
  targets?: ReadonlyArray<{ key: string; label: string }>;
  onClose: () => void;
  host?: Pick<WebPackageHost, "notifications"> | undefined;
}

export default function MoveToCheckoutDialog({ sessionId, projectId: _projectId, target: fixed, targets = [], onClose, host }: MoveToCheckoutDialogProps) {
  const [chosen, setChosen] = useState<string>(fixed ? targetKey(fixed) : targets[0]?.key ?? "");
  const [preview, setPreview] = useState<SessionCheckoutPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<BranchMode>("keep");
  const [otherBranch, setOtherBranch] = useState("");
  const [newName, setNewName] = useState("");
  const [remove, setRemove] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setPreview(null);
    setLoadError(null);
    gitSessionCheckoutPreview({ sessionId, target: fromKey(chosen) })
      .then((next) => { if (live) setPreview(next); })
      .catch((cause: unknown) => { if (live) setLoadError(friendlyError(tr("gitmove.confirm"), cause)); });
    return () => { live = false; };
  }, [sessionId, chosen, reload]);

  const targetName = preview?.to.label ?? targets.find((entry) => entry.key === chosen)?.label ?? "";
  const to = preview?.to;
  const dirtyTarget = (to?.dirtyCount ?? 0) > 0;
  const sourceBranch = preview?.from.branch ?? null;
  const lastChat = Boolean(preview?.lastSessionInSource && !preview.from.isMain);
  const dirtySource = (preview?.sourceDirtyCount ?? 0) > 0;
  const removing = lastChat && !dirtySource && remove;
  const sourceInUse = Boolean(preview?.branches.some((entry) => entry.name === sourceBranch && entry.inUseBy));
  const switchAllowed = !dirtyTarget && sourceBranch !== null && (!sourceInUse || (lastChat && removing));
  // A row that became unavailable (dirty target, Remove unchecked) falls back to Keep.
  const effective: BranchMode = !dirtyTarget && (mode !== "switch" || switchAllowed) ? mode : "keep";
  const ownedMerged = Boolean(preview?.sourceBranchOwned && preview.sourceBranchMerged);

  const branchChoice = (): SessionCheckoutBranchChoice | null => {
    if (effective === "keep") return { kind: "keep" };
    if (effective === "switch" && sourceBranch) return { kind: "switch", name: sourceBranch };
    if (effective === "other") return otherBranch && !preview?.branches.some((entry) => entry.name === otherBranch && entry.inUseBy) ? { kind: "switch", name: otherBranch } : null;
    const name = newName.trim();
    if (!name) return null;
    return { kind: "create", name, ...(to?.branch ? { from: to.branch } : {}) };
  };
  const choice = preview ? branchChoice() : null;

  const notify = useCallback((kind: "success" | "warning", title: string) => { host?.notifications?.show({ kind, title }); }, [host]);

  const submit = async () => {
    if (!preview || !choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await gitSessionCheckout({
        sessionId,
        target: fromKey(chosen),
        expectedWorkspaceRevision: preview.expectedWorkspaceRevision,
        branch: choice,
        ...(removing ? { removeSource: { deleteBranch: ownedMerged && deleteBranch } } : {}),
      });
      upsertSession(result.session);
      if (result.branchError) notify("warning", tr("gitmove.movedButBranch", { reason: result.branchError.message }));
      else if (result.removeError) notify("warning", tr("gitmove.movedButRemove", { reason: result.removeError.message }));
      else {
        const branch = choice.kind === "keep" ? to?.branch : choice.name;
        notify("success", branch ? tr("gitmove.movedTo", { target: targetName, branch }) : tr("gitmove.movedNoBranch", { target: targetName }));
      }
      onClose();
    } catch (cause) {
      if (errorCodeOf(cause) === "conflict") {
        setReload((n) => n + 1);
        setError(tr("gitmove.conflict"));
      } else {
        const refusal = branchRefusalOf(cause);
        setError(refusal ? branchRefusalMessage(refusal) : friendlyError(tr("gitmove.confirm"), cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const blocked = preview?.blocked;
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>{tr("gitmove.cancel")}</Button>
      <span className="git-move-spacer" />
      {!blocked && (
        <Button variant={removing ? "danger" : "primary"} busy={busy} disabled={!preview || !choice || busy} onClick={() => void submit()}>
          {removing ? tr("gitmove.confirmRemove") : tr("gitmove.confirm")}
        </Button>
      )}
    </>
  );
  const keepLabel = to?.branch ? tr("gitmove.keep", { branch: to.branch }) : tr("gitmove.keepDetached");
  const dirtyCopy = tr("gitmove.dirtyTarget", { target: targetName, count: to?.dirtyCount ?? 0 });

  const row = (value: BranchMode, label: string, opts: { disabled?: boolean; hint?: string; children?: React.ReactNode }) => (
    <label className={`git-move-radio${opts.disabled ? " is-disabled" : ""}`} data-checked={effective === value}>
      <input type="radio" name="git-move-branch" value={value} checked={effective === value} disabled={opts.disabled}
        onChange={() => setMode(value)} />
      <span className="git-move-radio-copy">
        <span className="git-move-radio-label">{label}</span>
        {opts.hint && <span className="git-move-radio-hint">{opts.hint}</span>}
        {effective === value && opts.children}
      </span>
    </label>
  );

  return (
    <Dialog title={tr("gitmove.title", { target: targetName || "…" })} onClose={onClose} footer={footer} className="git-move-dialog">
      <div className="git-move-body">
        {!fixed && (
          <Select label={tr("gitmove.targetLabel")} value={chosen} options={targets.map((entry) => ({ value: entry.key, label: entry.label }))}
            onChange={(value) => { setChosen(value); setMode("keep"); setError(null); }} />
        )}
        {loadError && <div role="alert" className="git-move-error">{loadError}</div>}
        {!preview && !loadError && <p className="git-move-meta">{tr("gitmove.loading")}</p>}
        {preview && (
          <>
            <p className="git-move-route">{tr("gitmove.fromTo", {
              from: `${preview.from.label}${preview.from.branch ? ` · ${preview.from.branch}` : ""}`,
              to: `${preview.to.label}${preview.to.branch ? ` · ${preview.to.branch}` : ""}`,
            })}</p>
            {blocked ? (
              <Notice tone="warning">{blocked.message}</Notice>
            ) : (
              <>
                <p className="git-move-meta">{tr("gitmove.body", { target: targetName })}</p>
                {preview.restartsAgent && <p className="git-move-meta">{tr("gitmove.restart")}</p>}
                <div className="git-move-group" role="radiogroup" aria-label={tr("gitmove.branchGroup", { target: targetName })}>
                  <div className="git-move-group-title">{tr("gitmove.branchGroup", { target: targetName })}</div>
                  {row("keep", keepLabel, {})}
                  {sourceBranch && row("switch", tr("gitmove.switch", { branch: sourceBranch }), {
                    disabled: !switchAllowed,
                    ...(dirtyTarget ? { hint: dirtyCopy } : sourceInUse && !switchAllowed ? { hint: tr("gitmove.inUse", { worktree: preview.from.label }) } : {}),
                  })}
                  {row("other", tr("gitmove.other"), {
                    disabled: dirtyTarget,
                    ...(dirtyTarget ? { hint: dirtyCopy } : {}),
                    children: (
                      <Select label={tr("gitmove.otherLabel")} value={otherBranch} placeholder={tr("gitmove.otherPlaceholder")} searchable
                        options={preview.branches.map((entry) => ({
                          value: entry.name, label: entry.name,
                          ...(entry.inUseBy ? { detail: tr("gitmove.inUse", { worktree: entry.inUseBy }) } : {}),
                        }))}
                        onChange={setOtherBranch} />
                    ),
                  })}
                  {row("create", tr("gitmove.newFrom", { base: to?.branch ?? "HEAD" }), {
                    disabled: dirtyTarget,
                    ...(dirtyTarget ? { hint: dirtyCopy } : {}),
                    children: <TextInput aria-label={tr("gitmove.newLabel")} value={newName} onChange={(event) => setNewName(event.target.value)} />,
                  })}
                </div>
                {lastChat && (
                  <Notice tone={dirtySource ? "warning" : "info"}>
                    <div className="git-move-last">
                      <span>{tr("gitmove.lastChat", { worktree: preview.from.label })}</span>
                      {dirtySource && <span>{tr("gitmove.dirtySource", { count: preview.sourceDirtyCount })}</span>}
                      <Checkbox checked={removing} disabled={dirtySource} onChange={setRemove} label={tr("gitmove.remove")} />
                      {ownedMerged && removing && (
                        <Checkbox checked={deleteBranch} onChange={setDeleteBranch}
                          label={tr("gitmove.deleteBranch", { branch: preview.from.branch ?? "" })} />
                      )}
                    </div>
                  </Notice>
                )}
              </>
            )}
          </>
        )}
        {error && <div role="alert" className="git-move-error">{error}</div>}
      </div>
    </Dialog>
  );
}
