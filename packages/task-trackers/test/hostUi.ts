// `host.ui` for task-tracker UI tests: the shell's real host object, handed to
// the package the way the web host does. Importing the host module keeps the
// package itself free of shell imports while tests exercise the same parts the
// app installs (`components`, `iconSet`, `tabIds`, `confirm`).
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
const { setTaskTrackerHost } = await import("../widgets/store.ts");

/** The host's UI seams a package may use, without the app locale/theme so the
 *  installer keeps its unlocalized catalog path in these tests. */
export const hostUi = {
  icons: webPackageHost.ui.icons,
  components: webPackageHost.ui.components,
  iconSet: webPackageHost.ui.iconSet,
  tabIds: webPackageHost.ui.tabIds,
  confirm: webPackageHost.ui.confirm,
};

const none = () => () => {};

/** A minimal host for tests that mount package UI without the installer: no
 *  active project or session, no composer choice and no sessions. */
export function installTestHost(extra: Record<string, unknown> = {}): void {
  setTaskTrackerHost({
    ui: hostUi,
    store: { subscribe: none, getSnapshot: () => ({ activeProjectId: null, activeSessionId: null }) },
    executionDraft: { subscribe: none, get: () => undefined },
    sessions: { subscribe: none, get: () => undefined },
    errors: {
      friendly: (action: string, cause: unknown) =>
        cause instanceof Error && cause.message ? `${action}: ${cause.message}` : action,
    },
    ...extra,
  } as never);
}
