/**
 * P13-G1 first Polyth life. Spawned by phase13.ts. Creates a session against
 * the recording proxy, prints the binding, waits until the parent has armed
 * the swallow fault (barrier file), then dispatches the marker prompt. The
 * parent SIGKILLs this exact process after the upstream prompt response has
 * committed but before it is relayed, so this process dies mid-await without
 * ever settling the turn-submit operation.
 *
 * argv: <scratchFilePath> <proxyUrl> <marker>
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixedBorrowedLease, sleep, startPolyth, type Scratch } from "./phase13lib.ts";

const scratch = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Scratch;
const proxyUrl = process.argv[3]!;
const marker = process.argv[4]!;

const main = async (): Promise<void> => {
  const lease = fixedBorrowedLease(proxyUrl, scratch.project, "phase13:g1");
  const polyth = await startPolyth(scratch, lease, { logName: "polyth-life1.ndjson" });
  const created = await polyth.create("P13-G1 crash duplicate");
  console.log(JSON.stringify({ kind: "created", sessionId: created.id, backendId: created.backendId }));
  const barrier = join(scratch.root, "armed");
  while (!existsSync(barrier)) await sleep(25);
  try {
    await polyth.sessions.send(created.id, {
      text: `Reply exactly ${marker} and nothing else.`,
      model: { providerID: "opencode", modelID: "big-pickle" },
    });
    console.log(JSON.stringify({ kind: "send-settled" }));
  } catch (error) {
    console.log(JSON.stringify({ kind: "send-error", error: String(error) }));
  }
  // Stay alive; the parent owns termination.
  await new Promise(() => {});
};

main().catch((error) => {
  console.log(JSON.stringify({ kind: "fatal", error: String(error) }));
  process.exit(1);
});
