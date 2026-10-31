import UiIcon from "../ui/Icon.tsx";
import Spinner from "../ui/Spinner.tsx";
import {
  ChatIcon,
  ErrorIcon,
  HelpIcon,
  RefreshIcon,
  ShieldIcon,
  SuccessIcon,
  TimerIcon,
  WarningIcon,
} from "../ui/icons.ts";
import type { SessionRowStatus } from "../../sessionStatus.ts";

export type MobileStatusKind = SessionRowStatus["kind"] | "waiting" | "complete";

/** Shared semantic status marks for session surfaces and the phone navigator. */
export function MobileStatusIcon({ kind }: { kind: MobileStatusKind }) {
  switch (kind) {
    case "working":
      return <Spinner size="sm" className="mobile-nav-state-icon" />;
    case "needs-reply":
    case "waiting":
    case "unknown":
      return <UiIcon icon={HelpIcon} size="sm" className="mobile-nav-state-icon" />;
    case "needs-approval":
      return <UiIcon icon={ShieldIcon} size="sm" className="mobile-nav-state-icon" />;
    case "unread":
    case "complete":
      return <UiIcon icon={SuccessIcon} size="sm" className="mobile-nav-state-icon" />;
    case "failed":
      return <UiIcon icon={ErrorIcon} size="sm" className="mobile-nav-state-icon" />;
    case "rate-limited":
      return <UiIcon icon={TimerIcon} size="sm" className="mobile-nav-state-icon" />;
    case "epoch-pending":
      return <UiIcon icon={WarningIcon} size="sm" className="mobile-nav-state-icon" />;
    case "reconciling":
    case "resume-ready":
      return <UiIcon icon={RefreshIcon} size="sm" className="mobile-nav-state-icon" />;
    case "regular":
      return <UiIcon icon={ChatIcon} size="sm" className="mobile-nav-state-icon" />;
  }
}
