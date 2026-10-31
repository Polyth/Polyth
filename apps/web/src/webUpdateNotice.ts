// A newer web build, found while this page is healthy (buildFreshness.ts on
// resume), is offered as one `update` notification instead of a reload the
// person did not ask for. "Later" waits for the next build or the next load.
import { tr } from "./i18n/index.ts";
import { notify } from "./notify/store.ts";

export const WEB_UPDATE_NOTIFICATION_ID = "host.web-update";

export function offerWebUpdate(_serverBuildId: string, reload: () => void): void {
  notify({
    id: WEB_UPDATE_NOTIFICATION_ID,
    kind: "update",
    title: tr("app.webUpdate.title"),
    body: tr("app.webUpdate.body"),
    duration: "sticky",
    actions: [
      { label: tr("app.webUpdate.reload"), primary: true, run: reload },
      { label: tr("app.webUpdate.later"), run: () => {} },
    ],
  });
}
