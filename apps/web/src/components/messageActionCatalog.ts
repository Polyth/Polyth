// One name, glyph and description per quick action. The message footers and
// the Settings editor read the same entries, so a button looks and reads the
// same in the conversation, in its "More" menu and where it is configured.
import { tr } from "../i18n/index.ts";
import type { MessageActionId, MessageActionRole } from "../messageActionLayout.ts";
import {
  CopyIcon,
  ForkIcon,
  ImageIcon,
  InfoIcon,
  NewChatIcon,
  PinIcon,
  RefreshIcon,
  UndoIcon,
  type LucideIcon,
} from "./ui/index.ts";

export const MESSAGE_ACTION_ICONS: Readonly<Record<MessageActionId, LucideIcon>> = {
  copy: CopyIcon,
  revert: UndoIcon,
  fork: ForkIcon,
  regenerate: RefreshIcon,
  pin: PinIcon,
  info: InfoIcon,
  session: NewChatIcon,
  image: ImageIcon,
};

/** Short visible name (menus, Settings). */
export function messageActionName(id: MessageActionId): string {
  switch (id) {
    case "copy": return tr("messageActions.action.copy");
    case "revert": return tr("messageActions.action.revert");
    case "fork": return tr("messageActions.action.fork");
    case "regenerate": return tr("messageActions.action.regenerate");
    case "pin": return tr("messageActions.action.pin");
    case "info": return tr("messageActions.action.info");
    case "session": return tr("messageActions.action.session");
    case "image": return tr("messageActions.action.image");
  }
}

/** One-sentence effect, worded for the role it acts on. */
export function messageActionDescription(role: MessageActionRole, id: MessageActionId): string {
  switch (id) {
    case "copy": return tr("messageActions.desc.copy");
    case "revert": return tr("messageActions.desc.revert");
    case "fork": return tr("messageActions.desc.fork");
    case "regenerate": return tr("messageActions.desc.regenerate");
    case "pin": return role === "user" ? tr("messageActions.desc.pinUser") : tr("messageActions.desc.pin");
    case "info": return tr("messageActions.desc.info");
    case "session": return role === "user" ? tr("messageActions.desc.sessionUser") : tr("messageActions.desc.sessionAssistant");
    case "image": return tr("messageActions.desc.image");
  }
}
