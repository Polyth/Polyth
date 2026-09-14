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
 * returning an absolute host path to the prompt. The provider-bound instruction
 * tells Command Code to resolve it against its own current workspace before it
 * calls read_file, whose native contract expects an absolute in-workspace path.
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
  return projectRelative.replace(/\\/g, "/");
}

const absoluteReadInstruction = (path: string): string =>
  `Resolve project-relative path ${JSON.stringify(path)} against the current workspace root, then pass the resulting absolute in-workspace path to native read_file`;

const attachmentInstruction = (attachment: AttachmentRef, path: string): string => {
  const read = absoluteReadInstruction(path);
  if (attachment.kind === "range" && attachment.range) {
    const from = Math.max(1, Math.trunc(attachment.range[0]));
    const to = Math.max(from, Math.trunc(attachment.range[1]));
    const limit = to - from + 1;
    return `- ${read} with offset=${from} and limit=${limit}.`;
  }
  if (attachment.mime === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
    return `- ${read}; use Command Code's document extraction and preserve the extracted document structure.`;
  }
  return `- ${read} when needed.`;
};

export type PreparedCommandCodeTurn =
  | { ok: true; request: CanonicalTurnRequest }
  | { ok: false; code: "unsupported" | "invalid-attachment"; message: string };

/**
 * Translate Polyth project-file references into a provider-only read_file
 * workflow. This is emulated attachment delivery: Command Code's file tool is
 * native, but Polyth projects the reference as instructions rather than passing
 * a native attachment object. The visible canonical user message stays clean.
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
      // References are now represented by provider-only read_file instructions.
      // Do not let the inner runtime reject or double-deliver them.
      attachments: [],
    },
  };
}

export const commandCodeInputCapabilities = (base: RuntimeCapabilities): RuntimeCapabilities => ({
  ...base,
  attachments: {
    modalities: {
      ...base.attachments?.modalities,
      // Command Code's read_file implementation is native, but the attachment
      // itself is projected into prompt instructions by this adapter.
      file: "emulated",
      pdf: "emulated",
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
