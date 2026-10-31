import { parseExtensionCommandId } from "@polyth/commands/catalog";

/** Host-only extension commands are intercepted before session/model admission.
 * The reserved id is the authority marker; no owner/transport DTO widening is
 * required. */
export function isHostOnlyExtensionCommand(
  command: { id: string } | undefined,
): boolean {
  return command ? parseExtensionCommandId(command.id) !== null : false;
}
