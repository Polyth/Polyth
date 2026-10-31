import { spawn } from "node:child_process";
import { platform } from "node:os";

/** Open a URL with the desktop's default handler; resolves false if none. */
export function openExternal(url: string): Promise<boolean> {
  const os = platform();
  if (os !== "win32" && os !== "darwin" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Promise.resolve(false);
  const [command, args] = os === "darwin" ? ["open", [url]]
    : os === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
      : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Text from positionals, or standard input when the text is `-` / absent
 *  and stdin is piped. */
export async function textArg(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") return (await readStdin()).trimEnd();
  if (parts.length) return parts.join(" ");
  if (!process.stdin.isTTY) return (await readStdin()).trimEnd();
  return "";
}
