import type { AgentCapabilityContribution, AgentCapabilityContributionRegistry, Disposable, JsonObject } from "@polyth/contracts";
import { serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { WAIT_CONDITIONS_SERVICE_ID, WAIT_TOOL_NAME, type WaitConditionRegistry } from "./index.ts";
import { createWaitManager, type WaitManager, type WaitManagerOptions } from "./manager.ts";

export const WAIT_TOOL_ID = "wait.polyth-wait";
export const WAIT_SKILL_ID = "wait.skill.polyth-wait";
export const WAIT_INSTRUCTION_ID = "wait.policy.polyth-wait";

export const waitInstruction = {
  descriptor: {
    id: WAIT_INSTRUCTION_ID,
    kind: "instruction" as const,
    owner: "wait",
    scope: "deployment" as const,
    revision: "1",
    title: "Waiting for background work",
    text: "If you end your turn while something you started keeps running (a backgrounded command, a build, a CI run) and you intend to continue when it finishes, register polyth_wait before ending the turn. Never end a turn promising to wait or to check back without it: nothing else will wake you.",
  },
} satisfies AgentCapabilityContribution;

export const waitSkill = {
  descriptor: {
    id: WAIT_SKILL_ID,
    kind: "skill" as const,
    owner: "wait",
    scope: "deployment" as const,
    revision: "1",
    name: "polyth-wait",
    title: "Wait for background work",
    description: "End your turn while a command, build or CI run keeps going; Polyth wakes this chat when it finishes.",
    instructions: `Use \`polyth_wait\` for anything that keeps running after your turn ends and that you want to continue from.

1. Start the work in the background so it survives your turn, and keep its exit code in a file:
   \`mkdir -p .polyth-wait && nohup sh -c '<cmd> > .polyth-wait/build.log 2>&1; echo $? > .polyth-wait/build.exit' >/dev/null 2>&1 &\`
   (\`.polyth-wait/\` is scratch: never commit it. Remove a stale \`build.exit\` before reusing the name.)
   Then call \`polyth_wait {file: ".polyth-wait/build.exit", note: "..."}\`. Waiting on the exit file is better than waiting on a pid because it carries the status; a pid wait only learns that the process is gone.
2. For a GitHub Actions run use \`polyth_wait {github_run: {id}}\`; get the id with \`gh run list --branch <b> --limit 1 --json databaseId\`. For pull requests, \`watch_pull_request\` covers failing checks and reviews.
3. \`seconds\` is a plain timer. Every wait ends by itself after \`timeoutMinutes\` (default 120), so nothing waits forever.
4. Always set \`note\` to what you plan to do on wake. Do not sleep-poll. Then end your turn.
5. \`polyth_wait {action: "list"}\` shows this chat's waits; \`{action: "cancel", id}\` cancels one you no longer need.`,
  },
} satisfies AgentCapabilityContribution;

const waitTool = (manager: WaitManager): AgentCapabilityContribution => ({
  descriptor: {
    id: WAIT_TOOL_ID,
    kind: "tool",
    owner: "wait",
    scope: "deployment",
    revision: "1",
    name: WAIT_TOOL_NAME,
    description: "Ask Polyth to wake this chat when something you started finishes, then end your turn. Give exactly one of: `pid` (a local process), `file` (wakes when the path exists), `github_run` (a GitHub Actions run) or `seconds` (a timer). The wait is durable, bounded by `timeoutMinutes` (default 120) and never silent. `action` is `start` (default), `list` or `cancel` (with `id`).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["start", "list", "cancel"] },
        pid: { type: "integer", minimum: 2, description: "A local process you started; wakes when it is gone." },
        file: { type: "string", description: "Wakes when this path exists. Relative paths resolve against the working directory." },
        github_run: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "integer", minimum: 1 }, repo: { type: "string", description: "owner/name; omit for this checkout's repository." } },
          required: ["id"],
        },
        seconds: { type: "integer", minimum: 1, maximum: 86400 },
        timeoutMinutes: { type: "integer", minimum: 1, maximum: 1440, description: "Give up after this long (default 120)." },
        note: { type: "string", maxLength: 500, description: "What you plan to do on wake; echoed in the wake." },
        id: { type: "string", description: "The wait to cancel." },
      },
    },
    // The closest class this codebase has to "local": it reads local process
    // and workspace state; there is no `trust: "local"`.
    trust: "workspace",
    // Starts a durable wait that can later wake this chat.
    mutating: true,
  },
  async execute(input: JsonObject, context) {
    return { output: await manager.runTool(input, context) };
  },
});

/** Replaceable parts of the package, for tests; the host only ever passes `host`. */
export type WaitPackageSeams = Pick<WaitManagerOptions, "now" | "tickMs" | "platform">;

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return createWaitPackage(host);
}

export function createWaitPackage(host: ServerPackageHost, seams: WaitPackageSeams = {}): ServerPackage {
  // One manager for the package's life: providers registered by other packages
  // survive a disable/enable of this one; its records and timers do not.
  const manager = createWaitManager({ host, ...seams });
  let registrations: Disposable[] = [];
  // Published at load time, like the GitHub service, so a provider package can
  // find it in its own enable hook whatever the enable order.
  host.services.provide<WaitConditionRegistry>(serverServiceKey(WAIT_CONDITIONS_SERVICE_ID), { register: (provider) => manager.register(provider) });
  return {
    async onEnable() {
      const capabilities = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      registrations = capabilities
        ? [capabilities.register("wait", waitInstruction), capabilities.register("wait", waitSkill), capabilities.register("wait", waitTool(manager))]
        : [];
      await manager.resume();
    },
    async onDisable() {
      manager.dispose();
      for (const registration of registrations.toReversed()) await registration.dispose();
      registrations = [];
    },
  };
}
