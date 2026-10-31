// Host-owned connection feedback: the catch-up pill and the transient error
// notification. They share one subscription so a reconnect re-renders only
// this leaf, never the shell while history streams in, and so the error can be
// held back while the system is still healing a lost connection on its own.
import { useEffect, useRef } from "react";
import { claimUiErrorLifetime, clearUiError, useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";
import { Icon } from "./ui/index.ts";
import {
  BlockedIcon,
  ErrorIcon,
  LockIcon,
  OfflineIcon,
  ServerErrorIcon,
  StorageIcon,
  type LucideIcon,
} from "./ui/icons.ts";
import { presentUiError, type UiErrorCategory } from "../errorPresentation.ts";
import { isHoldableNetworkError, useSyncCatchUp, type CatchUpView } from "../syncCatchUp.ts";
import { dismissNotification, notify } from "../notify/store.ts";
import SyncCatchUpIndicator from "./SyncCatchUpIndicator.tsx";

// One contextual glyph per failure family keeps the notice legible at a glance
// without changing where the error came from or how long it stays.
const ERROR_CATEGORY_ICON: Record<UiErrorCategory, LucideIcon> = {
  network: OfflineIcon,
  auth: LockIcon,
  storage: StorageIcon,
  server: ServerErrorIcon,
  blocked: BlockedIcon,
  error: ErrorIcon,
};

/** The store's one transient error, as a notification of the shared stack. */
export const UI_ERROR_NOTIFICATION_ID = "host.ui-error";

/** Projects the store's transient error (`setUiError`) into the notification
 *  stack. Renders nothing itself. */
export function ErrorBanner({ catchUp }: { catchUp: CatchUpView }) {
  const message = useStore((s) => s.uiError);
  const action = useStore((s) => s.uiErrorAction);
  const kind = useStore((s) => s.uiErrorKind);
  // The same text raised again is a new occurrence: re-notifying restarts the
  // card's lifetime instead of leaving the old countdown to run out.
  const occurrence = useStore((s) => s.uiErrorSeq);
  // While mounted, the notification's pausable countdown is the error's only
  // lifetime — the store's fallback timer never closes a card being read.
  useEffect(() => claimUiErrorLifetime(), []);
  // A connection-loss error raised while the system is healing itself is held
  // out of sight; once the server confirms the screen current, the reads that
  // failed have already re-run (CONNECTION_RESTORED_EVENT), so it is dropped.
  // Only errors that were held are dropped — one already shown stays put.
  const held = useRef<string | null>(null);
  const hold = message !== null && catchUp.holdNetworkErrors && isHoldableNetworkError(message);
  if (hold) held.current = message;
  else if (message !== held.current && !catchUp.holdNetworkErrors) held.current = null;
  useEffect(() => {
    if (catchUp.fresh && message !== null && message === held.current) {
      held.current = null;
      clearUiError();
    }
  }, [catchUp.fresh, message]);
  const shown = message !== null && !hold && !(catchUp.fresh && message === held.current);

  useEffect(() => {
    if (!shown || message === null) {
      dismissNotification(UI_ERROR_NOTIFICATION_ID);
      return;
    }
    const view = presentUiError(message);
    const CategoryIcon = ERROR_CATEGORY_ICON[view.category];
    const failure = kind === "error";
    notify({
      id: UI_ERROR_NOTIFICATION_ID,
      kind,
      title: view.title || view.description || message,
      ...(view.title && view.description ? { body: view.description } : {}),
      // A calm word (nothing to compact, a chat that left) keeps its kind's glyph.
      ...(failure ? { icon: <Icon icon={CategoryIcon} size="md" /> } : {}),
      ...(action ? { actions: [{ label: action.label, run: () => { void action.run(); } }] } : {}),
      ...(failure ? { dismissLabel: tr("app.dismissError") } : {}),
      data: { category: view.category },
      // Closed by the person or run out: the error is over. A programmatic
      // dismissal is this effect following the store, which already moved on.
      onDismiss: (reason) => { if (reason !== "programmatic") clearUiError(); },
    });
  }, [shown, message, action, kind, occurrence]);
  useEffect(() => () => { dismissNotification(UI_ERROR_NOTIFICATION_ID); }, []);
  return null;
}

export default function ConnectionFeedback() {
  const catchUp = useSyncCatchUp();
  return (
    <>
      <SyncCatchUpIndicator indicator={catchUp.indicator} />
      <ErrorBanner catchUp={catchUp} />
    </>
  );
}
