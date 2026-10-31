// Former top-bar controls hosted by a side column in the full-height window
// layouts (shellLayout.ts). The groups are the bar's own components — the top
// rail's tools, the header actions rail and the account menu — rendered once,
// wherever the layout puts them, so their order, drag targets and
// customisation stay the same in every layout.
import { useOpenPage, useStore, workspaceProjectId } from "../store.ts";
import { useProfileAccount } from "../profileAccount.ts";
import { shellColumnGroups, useShellLayout, type ShellColumn } from "../shellLayout.ts";
import { useWorkspaceMode } from "../widgets/workspaceMode.ts";
import { CapabilityNav, HeaderActionsRail, UserMenu, type ShellGroupOrientation } from "./Header.tsx";

/** Whether `column` hosts any former top-bar group in the current layout. */
export function useShellColumnHosts(column: ShellColumn): { tools: boolean; actions: boolean; account: boolean; any: boolean } {
  const groups = shellColumnGroups(useShellLayout(), column);
  return { ...groups, any: groups.tools || groups.actions || groups.account };
}

/** One docked group. `orientation` follows the host: down a rail, along a
 *  row in the navigator's tree header and footer. */
export function ShellDock({ column, group, orientation = "vertical" }: {
  column: ShellColumn;
  group: "tools" | "actions";
  orientation?: ShellGroupOrientation;
}) {
  const hosts = useShellColumnHosts(column);
  const workspaceMode = useWorkspaceMode();
  const pageOpen = useOpenPage() !== null;
  const projectId = useStore((s) => workspaceProjectId(s));
  const sessionId = useStore((s) => (pageOpen ? null : s.activeSessionId));
  if (!hosts[group]) return null;
  return (
    <div className={`shell-dock shell-dock--${group}`} data-shell-column={column} data-orientation={orientation}>
      {group === "tools"
        ? <CapabilityNav orientation={orientation} />
        : <HeaderActionsRail projectId={projectId} sessionId={sessionId} workspaceMode={workspaceMode} orientation={orientation} />}
    </div>
  );
}

/** The account menu at the foot of a column: the navigator's, or the
 *  launcher strip's when the header actions are docked there. */
export function ShellColumnAccount({ column = "start" }: { column?: ShellColumn } = {}) {
  return useShellLayout().account === column ? <ColumnAccountMenu /> : null;
}

function ColumnAccountMenu() {
  const projectId = useStore((s) => workspaceProjectId(s));
  const account = useProfileAccount(projectId ?? null);
  const editing = useWorkspaceMode() === "edit";
  return <UserMenu account={account} editing={editing} className="shell-column-account" />;
}

/** The tree navigator has no icon rail: docked tools head it, docked actions
 *  and the account close it, each as one row. */
export function ShellColumnHead() {
  const shell = useShellLayout();
  const tools = shell.tools === "start";
  if (!tools) return null;
  return (
    <div className="shell-column-head">
      <ShellDock column="start" group="tools" orientation="horizontal" />
    </div>
  );
}

export function ShellColumnFoot() {
  const shell = useShellLayout();
  const actions = shell.actions === "start";
  if (shell.account !== "start" && !actions) return null;
  return (
    <div className="shell-column-foot">
      {actions && <ShellDock column="start" group="actions" orientation="horizontal" />}
      <ShellColumnAccount />
    </div>
  );
}
