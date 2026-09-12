import { posix } from "node:path";
import type { ProjectService, RemoteHost } from "@polyth/contracts";
import type { FileService } from "./index.ts";

export const WORKSPACE_INSTRUCTIONS_FILE = "AGENTS.md";
export const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

export interface WorkspaceInstructionSourceService {
  /** Read the policy from the active execution root. Missing is a normal no-op. */
  read(root: string, projectId: string): Promise<string | null>;
}

const sourceError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const missingLocalFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const decodePolicy = (bytes: Uint8Array): string => {
  if (bytes.byteLength > WORKSPACE_INSTRUCTIONS_MAX_BYTES) {
    throw sourceError(
      "payload-too-large",
      `${WORKSPACE_INSTRUCTIONS_FILE} exceeds ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} bytes`,
    );
  }
  if (bytes.includes(0)) {
    throw sourceError(
      "invalid-input",
      `${WORKSPACE_INSTRUCTIONS_FILE} must be a UTF-8 text file`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw sourceError(
      "invalid-input",
      `${WORKSPACE_INSTRUCTIONS_FILE} must be a UTF-8 text file`,
    );
  }
};

const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const readRemotePolicy = async (host: RemoteHost, root: string): Promise<string | null> => {
  const normalizedRoot = posix.normalize(root);
  if (!normalizedRoot || normalizedRoot === "." || normalizedRoot === "/") {
    throw sourceError("invalid-path", "Refusing to read workspace instructions from a broad remote root");
  }
  const missingMarker = "POLYTH_AGENTS_MISSING";
  const command = [
    `ROOT=${shq(normalizedRoot)}`,
    'ROOT_REAL=$(realpath -- "$ROOT") || exit 41',
    `CANDIDATE="$ROOT_REAL/${WORKSPACE_INSTRUCTIONS_FILE}"`,
    `if [ ! -e "$CANDIDATE" ]; then printf '${missingMarker}\\n'; exit 0; fi`,
    'TARGET=$(realpath -- "$CANDIDATE") || exit 42',
    'case "$TARGET" in "$ROOT_REAL"/*) ;; *) exit 43 ;; esac',
    '[ -f "$TARGET" ] || exit 44',
    'SIZE=$(stat -c \'%s\' -- "$TARGET" 2>/dev/null || stat -f \'%z\' -- "$TARGET") || exit 45',
    'case "$SIZE" in \'\'|*[!0-9]*) exit 45 ;; esac',
    `if [ "$SIZE" -gt ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} ]; then exit 46; fi`,
    'printf \'POLYTH_AGENTS_SIZE=%s\\n\' "$SIZE"',
    'base64 < "$TARGET"',
  ].join("\n");
  const result = await host.exec(command, {
    timeoutMs: 30_000,
    maxOutputBytes: Math.ceil(WORKSPACE_INSTRUCTIONS_MAX_BYTES * 4 / 3) + 1024,
  });
  if (result.code === 46) {
    throw sourceError(
      "payload-too-large",
      `${WORKSPACE_INSTRUCTIONS_FILE} exceeds ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} bytes`,
    );
  }
  if (result.code === 43) {
    throw sourceError("invalid-path", `${WORKSPACE_INSTRUCTIONS_FILE} escapes the workspace root`);
  }
  if (result.code === 44) {
    throw sourceError("invalid-input", `${WORKSPACE_INSTRUCTIONS_FILE} is not a regular file`);
  }
  if (result.code !== 0) {
    throw sourceError("unavailable", `Could not read ${WORKSPACE_INSTRUCTIONS_FILE}`);
  }
  if (result.stdout.trim() === missingMarker) return null;
  const newline = result.stdout.indexOf("\n");
  const sizeMatch = result.stdout.slice(0, newline).match(/^POLYTH_AGENTS_SIZE=(\d+)$/);
  if (newline < 0 || !sizeMatch) {
    throw sourceError("unavailable", `Could not verify ${WORKSPACE_INSTRUCTIONS_FILE}`);
  }
  const expected = Number(sizeMatch[1]);
  const encoded = result.stdout.slice(newline + 1).replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== expected) {
    throw sourceError("unavailable", `${WORKSPACE_INSTRUCTIONS_FILE} changed while it was read`);
  }
  return decodePolicy(bytes);
};

export function createWorkspaceInstructionSource(options: {
  projects: Pick<ProjectService, "get">;
  localFiles: FileService;
  remoteHost?: (connectionId: string) => RemoteHost | undefined;
}): WorkspaceInstructionSourceService {
  return {
    async read(root, projectId) {
      const project = await options.projects.get(projectId);
      if (!project) throw sourceError("not-found", "Project not found");
      if (project.remote?.kind === "ssh") {
        const host = options.remoteHost?.(project.remote.connectionId);
        if (!host) {
          throw sourceError("unavailable", "Remote workspace is unavailable");
        }
        const text = await readRemotePolicy(host, root);
        return text?.trim() ? text : null;
      }
      try {
        const stat = await options.localFiles.stat(root, WORKSPACE_INSTRUCTIONS_FILE);
        if (stat.kind !== "file") {
          throw sourceError(
            "invalid-input",
            `${WORKSPACE_INSTRUCTIONS_FILE} is not a regular file`,
          );
        }
        if (stat.size > WORKSPACE_INSTRUCTIONS_MAX_BYTES) {
          throw sourceError(
            "payload-too-large",
            `${WORKSPACE_INSTRUCTIONS_FILE} exceeds ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} bytes`,
          );
        }
        const raw = await options.localFiles.readRaw(root, WORKSPACE_INSTRUCTIONS_FILE);
        const text = decodePolicy(raw.data);
        return text.trim() ? text : null;
      } catch (error) {
        if (missingLocalFile(error)) return null;
        throw error;
      }
    },
  };
}
