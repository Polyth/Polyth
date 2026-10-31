// The window shows the local server at http://127.0.0.1:<port>, so the port is
// part of the renderer's origin. Chromium keeps localStorage, IndexedDB and
// site permissions per origin, which made a fresh port on every launch start
// the shell with empty origin storage each time: the navigator forgot its sort,
// the manual project order, the open projects and the shown-session counts.
// The app keeps the port it used last time and takes a new one only when
// another process holds it.
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

export function parseSavedServerPort(value: unknown): number | null {
  const port = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).port
    : undefined;
  return typeof port === "number" && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

export function readSavedServerPort(path: string): number | null {
  try {
    return parseSavedServerPort(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function saveServerPort(path: string, port: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Listen on `port` (0: any free one), then release it for the server. */
function claimLoopbackPort(port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port"));
        return;
      }
      const claimed = address.port;
      server.close((error) => error ? reject(error) : resolvePort(claimed));
    });
  });
}

/** The saved port while it is free, otherwise a fresh one from the system. */
export async function reserveServerPort(preferred: number | null): Promise<number> {
  if (preferred !== null) {
    try {
      return await claimLoopbackPort(preferred);
    } catch {
      // Taken by another process: this launch gets a new origin.
    }
  }
  return claimLoopbackPort(0);
}
