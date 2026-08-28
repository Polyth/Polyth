import {
  registerCommand,
  type CommandPaletteSlotMeta,
  type PaletteCommandDescriptor,
} from "./commands.ts";
import { listSlots, subscribeSlots, type SlotItem } from "./slots.ts";

const MAX_COMMANDS_PER_ITEM = 64;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 160;
const MAX_GROUP_LENGTH = 80;
const MAX_ICON_LENGTH = 64;
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_LENGTH = 80;
const COMMAND_ID = /^[a-z0-9][a-z0-9._:-]*$/i;

const objectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Validate executable plugin input before it reaches the command registry.
 * Invalid descriptors fail closed; valid siblings remain usable. */
export function isPaletteCommandDescriptor(
  value: unknown,
): value is PaletteCommandDescriptor {
  if (!objectRecord(value)) return false;
  if (
    !boundedString(value.id, MAX_ID_LENGTH)
    || !COMMAND_ID.test(value.id)
    || !boundedString(value.label, MAX_LABEL_LENGTH)
    || typeof value.run !== "function"
  ) return false;
  if (
    value.group !== undefined
    && !boundedString(value.group, MAX_GROUP_LENGTH)
  ) return false;
  if (
    value.icon !== undefined
    && !boundedString(value.icon, MAX_ICON_LENGTH)
  ) return false;
  if (
    value.hint !== undefined
    && typeof value.hint !== "string"
    && typeof value.hint !== "function"
  ) return false;
  if (typeof value.hint === "string" && value.hint.length > MAX_LABEL_LENGTH) {
    return false;
  }
  if (value.when !== undefined && typeof value.when !== "function") return false;
  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords) || value.keywords.length > MAX_KEYWORDS) {
      return false;
    }
    if (!value.keywords.every((word) =>
      boundedString(word, MAX_KEYWORD_LENGTH))) return false;
  }
  return true;
}

export function commandDescriptorsFromMeta(
  meta: unknown,
): PaletteCommandDescriptor[] {
  if (!objectRecord(meta) || !Array.isArray(meta.commands)) return [];
  return meta.commands
    .slice(0, MAX_COMMANDS_PER_ITEM)
    .filter(isPaletteCommandDescriptor);
}

function registerDescriptor(descriptor: PaletteCommandDescriptor): () => void {
  const when = descriptor.when;
  return registerCommand({
    ...descriptor,
    ...(when
      ? {
          when: () => {
            try {
              return Boolean(when());
            } catch {
              return false;
            }
          },
        }
      : {}),
  });
}

function registerItem(item: SlotItem): () => void {
  const disposers = commandDescriptorsFromMeta(
    item.meta as CommandPaletteSlotMeta | undefined,
  ).map(registerDescriptor);
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
}

/** Keep package/plugin command descriptors in lockstep with their slot items.
 * Rebuilding on each slot mutation also restores deterministic precedence when
 * two independently loaded plugins accidentally publish the same command id. */
export function installCommandSlotBridge(): () => void {
  let itemDisposers = new Map<string, () => void>();
  const sync = () => {
    for (const dispose of [...itemDisposers.values()].toReversed()) dispose();
    itemDisposers = new Map(
      listSlots("commandPalette.commands")
        .map((item) => [item.id, registerItem(item)] as const),
    );
  };
  sync();
  const unsubscribe = subscribeSlots(sync);
  return () => {
    unsubscribe();
    for (const dispose of [...itemDisposers.values()].toReversed()) dispose();
    itemDisposers.clear();
  };
}
