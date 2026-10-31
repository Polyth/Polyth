// The optional "Ask before running" step. Every press funnels through
// `startAction`, so rails, tiles, toolbars and Run again all ask the same way.
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { CustomActionDto } from "../src/actionModel.ts";

/** Lines of the command the default confirmation quotes. */
const COMMAND_LINES = 3;

/** What the confirmation says: the person's own message, or the command. */
export function confirmationText(action: Pick<CustomActionDto, "command" | "confirm">): string {
  const message = action.confirm?.message.trim();
  if (message) return message;
  const lines = action.command.split("\n");
  const shown = lines.slice(0, COMMAND_LINES).join("\n") + (lines.length > COMMAND_LINES ? "\n…" : "");
  return tr("customaction.confirm.body", { command: shown });
}

/** Resolves true when the action may run now: it does not ask, or the person agreed. */
export async function confirmRun(action: Pick<CustomActionDto, "name" | "command" | "confirm">): Promise<boolean> {
  if (!action.confirm) return true;
  return confirmAlert(confirmationText(action), {
    title: tr("customaction.confirm.title", { name: action.name }),
    confirmLabel: tr("customaction.menu.run"),
    destructive: false,
  });
}
