import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentRuntime,
  AttachmentRef,
  CanonicalTurnRequest,
  RuntimeCapabilities,
} from "@polyth/contracts";

const MAX_ATTACHMENT_PATH_BYTES = 8 * 1024;

const invalidPath = (path: string): boolean =>
  !path
  || Buffer.byteLength(path, "utf8") > MAX_ATTACHMENT_PATH_BYTES
  || /[\u0000\r\n]/.test(path);

/**
 * Resolve a client-neutral project-relative attachment path without ever
 * returning an absolute host path to the prompt. Command Code applies its own
 * workspace guard again when `read_file` follows the reference.
 */
export function commandCodeProjectPath(cwd: string, attachment: AttachmentRef): string | undefined {
  const raw = attachment.path?.trim();
  if (!raw || invalidPath(raw) || isAbsolute(raw)) return undefined;
  const root = resolve(cwd);
  const absolute = resolve(root, raw);
  const projectRelative = relative(root, absolute);
  if (!projectRelative || projectRelative === ".") return undefined;
  if (isAbsolute(projectRelative) || projectRelative === ".." || projectRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return undefined;
  }
  if (invalidPath(projectRelative)) return undefined;
  // Command Code prompt/file tools accept forward-slash project paths on all
  // supported platforms; never expose a host absolute path.
  return projectRelative.replace(/\\/g, "/");
}

const attachmentInstruction = (attachment: AttachmentRef, path: string): string => {
  if (attachment.kind === "range" && attachment.range) {
    const from = Math.max(1, Math.trunc(attachment.range[0]));
    const to = Math.max(from, Math.trunc(attachment.range[1]));
    return `- Use the native read_file tool on project file ${JSON.stringify(path)}, focusing on lines ${from}-${to}.`;
  }
  if (attachment.mime === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
    return `- Use the native read_file tool on project document ${JSON.stringify(path)}; preserve its extracted document structure.`;
  }
  return `- Use the native read_file tool on project file ${JSON.stringify(path)} when needed.`;
};

export type PreparedCommandCodeTurn =
  | { ok: true; request: CanonicalTurnRequest }
  | { ok: false; code: "unsupported" | "invalid-attachment"; message: string };

/**
 * Translate Polyth project-file references into Command Code's documented
 * native file-tool workflow. The visible canonical user message stays clean:
 * these instructions exist only in the provider-bound request.
 */
export function prepareCommandCodeTurnInput(
  cwd: string,
  request: CanonicalTurnRequest,
): PreparedCommandCodeTurn {
  // Command Code custom agents are delegated subagents. It has no supported
  // primary-agent selector, so silently ignoring a selected agent would be a
  // false capability claim.
  if (request.agent) {
    return {
      ok: false,
      code: "unsupported",
      message: "Command Code custom agents are delegated native subagents and cannot be selected as the primary turn agent",
    };
  }

  if (!request.attachments?.length) return { ok: true, request };

  const instructions: string[] = [];
  for (const attachment of request.attachments) {
    const kind = attachment.kind ?? "file";
    const supported = kind === "file" || kind === "range"
      || attachment.mime === "application/pdf";
    if (!supported) {
      return {
        ok: false,
        code: "unsupported",
        message: `${attachment.name} is not a project file/document attachment Command Code can receive through this integration yet`,
      };
    }
    const path = commandCodeProjectPath(cwd, attachment);
    if (!path) {
      return {
        ok: false,
        code: "invalid-attachment",
        message: `${attachment.name} must resolve to a project-relative path before Command Code can read it`,
      };
    }
    instructions.push(attachmentInstruction(attachment, path));
  }

  const providerText = [
    request.text,
    "",
    "Polyth project attachments (provider-only instructions; do not treat these as quoted user content):",
    ...instructions,
  ].join("\n");
  return {
    ok: true,
    request: {
      ...request,
      text: providerText,
      // References are now represented in Command Code's native read_file
      // workflow. Do not let the inner runtime reject or double-deliver them.
      attachments: [],
    },
  };
}

export const commandCodeInputCapabilities = (base: RuntimeCapabilities): RuntimeCapabilities => ({
  ...base,
  attachments: {
    modalities: {
      ...base.attachments?.modalities,
      // A project-relative ref is handed to Command Code's own read_file tool;
      // it performs the actual text/PDF/document decoding and workspace guard.
      file: "native",
      pdf: "native",
    },
  },
});

/** Apply input translation without changing the execution/recovery runtime. */
export function decorateCommandCodeTurnInput(runtime: AgentRuntime, cwd: string): AgentRuntime {
  const capabilities = runtime.capabilities.bind(runtime);
  const startTurnOperation = runtime.startTurnOperation?.bind(runtime);
  runtime.capabilities = async () => commandCodeInputCapabilities(await capabilities());
  if (startTurnOperation) {
    runtime.startTurnOperation = async (request, operationId) => {
      const prepared = prepareCommandCodeTurnInput(cwd, request);
      if (!prepared.ok) {
        return { kind: "rejected", code: prepared.code, message: prepared.message };
      }
      return startTurnOperation(prepared.request, operationId);
    };
  }
  return runtime;
}
