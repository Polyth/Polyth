// The kind glyph every notification surface shares: the transient stack's
// cards and the notification centre's rows. One kind → one icon and one tone
// (`--notify-tone`, see notify.css), so a failed run reads the same in the
// corner toast and in the inbox.
import type { ReactNode } from "react";
import Icon from "../components/ui/Icon.tsx";
import Spinner from "../components/ui/Spinner.tsx";
import {
  AssistIcon,
  ChatIcon,
  DownloadIcon,
  ErrorIcon,
  InfoIcon,
  LightbulbIcon,
  MentionIcon,
  LoaderIcon,
  SuccessIcon,
  WarningIcon,
  type LucideIcon,
} from "../components/ui/icons.ts";
import type { NotificationKind } from "./store.ts";
import "./notify.css";

export const NOTIFICATION_KIND_ICON: Readonly<Record<NotificationKind, LucideIcon>> = {
  error: ErrorIcon,
  warning: WarningIcon,
  success: SuccessIcon,
  info: InfoIcon,
  progress: LoaderIcon,
  update: DownloadIcon,
  news: AssistIcon,
  hint: LightbulbIcon,
  mention: MentionIcon,
  message: ChatIcon,
};

/** Tinted round glyph for a kind. `busy` draws activity instead of the icon
 *  (an indeterminate progress); `children` replaces the icon (a package mark). */
export default function NotificationGlyph({
  kind,
  busy = false,
  children,
  className,
}: {
  kind: NotificationKind;
  busy?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={className ? `notify-glyph ${className}` : "notify-glyph"} data-kind={kind} aria-hidden="true">
      {children ?? (busy ? <Spinner size="md" /> : <Icon icon={NOTIFICATION_KIND_ICON[kind]} size="md" />)}
    </span>
  );
}
