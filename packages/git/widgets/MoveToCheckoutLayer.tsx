// Session-menu entry "Move to checkout…" and the app-layer that renders its
// dialog (the menu closes at once, so the dialog cannot live inside it).
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type Worktree } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Icon, BranchIcon } from "../../../apps/web/src/components/ui/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import MoveToCheckoutDialog, { moveTargets } from "./MoveToCheckoutDialog.tsx";

interface Request { sessionId: string; projectId: string; targets: Array<{ key: string; label: string }> }
let current: Request | null = null;
const listeners = new Set<() => void>();
const set = (next: Request | null) => { current = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function MoveToCheckoutLayer({ host }: { host: WebPackageHost }) {
  const request = useSyncExternalStore(subscribe, () => current, () => null);
  if (!request) return null;
  return <MoveToCheckoutDialog key={request.sessionId} {...request} host={host} onClose={() => set(null)} />;
}

export function MoveToCheckoutMenuAction({ sessionId, closeMenu }: { sessionId: string; closeMenu?: () => void }) {
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const projectId = session?.projectId;
  const isolated = session?.isolation?.kind === "git-worktree" || session?.isolationSummary === "git-worktree";
  const worktreePath = session?.worktreePath;
  const [trees, setTrees] = useState<Worktree[]>([]);
  useEffect(() => {
    if (!projectId || isolated) return;
    let live = true;
    api.listWorktrees(projectId).then((list) => { if (live) setTrees(list); }).catch(() => { if (live) setTrees([]); });
    return () => { live = false; };
  }, [projectId, isolated]);
  if (!projectId || isolated || trees.filter((tree) => !tree.isMain).length < 1) return null;
  const targets = moveTargets(trees, worktreePath);
  if (!targets.length) return null;
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { closeMenu?.(); set({ sessionId, projectId, targets }); }}>
      <Icon icon={BranchIcon} size="sm" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{tr("gitmove.menuItem")}</span></span>
    </button>
  );
}
