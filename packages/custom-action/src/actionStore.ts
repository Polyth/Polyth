// Space-private persistence for custom actions: one JSON document per Space
// under that Space's package directory. Writes are serialized per file and
// land atomically (temp file + rename), so a crash leaves the previous list.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  ACTION_LIMITS,
  CUSTOM_ACTION_PACKAGE_ID,
  readStoredAction,
  type CustomActionDto,
  type CustomActionInput,
} from "./actionModel.ts";

const FILE = "actions.json";
const VERSION = 1;

export interface ActionStore {
  list(space: SpaceContext): Promise<CustomActionDto[]>;
  get(space: SpaceContext, id: string): Promise<CustomActionDto | undefined>;
  create(space: SpaceContext, input: CustomActionInput): Promise<CustomActionDto>;
  update(space: SpaceContext, id: string, input: CustomActionInput): Promise<CustomActionDto>;
  remove(space: SpaceContext, id: string): Promise<void>;
  /** Apply a complete id order. Unknown ids are refused; missing ids keep
   *  their relative order after the listed ones. */
  reorder(space: SpaceContext, ids: readonly string[]): Promise<CustomActionDto[]>;
}

export interface ActionStoreDeps {
  storage(space: SpaceContext): SpaceStorage;
  now?: () => number;
  id?: () => string;
  log?: (message: string) => void;
}

const notFound = () => Object.assign(new Error("This action no longer exists."), { code: "not-found" });

export function createActionStore(deps: ActionStoreDeps): ActionStore {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? randomUUID;
  const queues = new Map<string, Promise<unknown>>();

  const fileFor = (space: SpaceContext): string => join(deps.storage(space).packageDir(CUSTOM_ACTION_PACKAGE_ID), FILE);

  /** Serialize every read-modify-write of one file. */
  const exclusive = <T>(file: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(file) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    queues.set(file, tail);
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    return run;
  };

  const read = async (file: string): Promise<CustomActionDto[]> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Object.assign(new Error("Custom actions could not be read."), { code: "storage-unavailable", cause: error });
    }
    try {
      const parsed = JSON.parse(text) as { actions?: unknown };
      const rows = Array.isArray(parsed?.actions) ? parsed.actions : [];
      const seen = new Set<string>();
      return rows.flatMap((row) => {
        const action = readStoredAction(row);
        if (!action || seen.has(action.id)) return [];
        seen.add(action.id);
        return [action];
      });
    } catch (error) {
      // Keep the unreadable document for recovery instead of overwriting it.
      const aside = `${file}.unreadable-${now()}`;
      await rename(file, aside).catch(() => undefined);
      deps.log?.(`[custom-action] moved an unreadable actions file aside to ${aside}: ${String(error)}`);
      return [];
    }
  };

  const write = async (file: string, actions: readonly CustomActionDto[]): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${newId()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: VERSION, actions }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  };

  const list = (space: SpaceContext): Promise<CustomActionDto[]> => {
    const file = fileFor(space);
    return exclusive(file, () => read(file));
  };

  return {
    list,

    async get(space, id) {
      return (await list(space)).find((action) => action.id === id);
    },

    async create(space, input) {
      const file = fileFor(space);
      return exclusive(file, async () => {
        const actions = await read(file);
        if (actions.length >= ACTION_LIMITS.actions) {
          throw Object.assign(new Error(`You can keep up to ${ACTION_LIMITS.actions} custom actions.`), { code: "conflict" });
        }
        const at = now();
        const action: CustomActionDto = { id: newId(), ...input, createdAt: at, updatedAt: at };
        await write(file, [...actions, action]);
        return action;
      });
    },

    async update(space, id, input) {
      const file = fileFor(space);
      return exclusive(file, async () => {
        const actions = await read(file);
        const index = actions.findIndex((action) => action.id === id);
        if (index < 0) throw notFound();
        const current = actions[index]!;
        const next: CustomActionDto = {
          id: current.id,
          ...input,
          // A mode change keeps the chat hand-off settings for a later switch back.
          ...(!input.chat && current.chat ? { chat: current.chat } : {}),
          createdAt: current.createdAt,
          updatedAt: Math.max(now(), current.updatedAt + 1),
        };
        const copy = [...actions];
        copy[index] = next;
        await write(file, copy);
        return next;
      });
    },

    async remove(space, id) {
      const file = fileFor(space);
      await exclusive(file, async () => {
        const actions = await read(file);
        if (!actions.some((action) => action.id === id)) throw notFound();
        await write(file, actions.filter((action) => action.id !== id));
      });
    },

    async reorder(space, ids) {
      const file = fileFor(space);
      return exclusive(file, async () => {
        const actions = await read(file);
        const byId = new Map(actions.map((action) => [action.id, action]));
        const listed = new Set<string>();
        for (const id of ids) {
          if (!byId.has(id)) throw notFound();
          listed.add(id);
        }
        const next = [
          ...ids.flatMap((id, index) => ids.indexOf(id) === index ? [byId.get(id)!] : []),
          ...actions.filter((action) => !listed.has(action.id)),
        ];
        await write(file, next);
        return next;
      });
    },
  };
}
