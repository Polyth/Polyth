// `read_file` — the paging tool for oversized tool output.
//
// It reads only `polyth://cache/<id>` URIs minted by the oversized-output paging
// cache, sliced by 1-based inclusive `start_line`/`end_line`, so a model that was
// handed a preview of a 50k-line log can read the exact region it needs. It never
// touches the filesystem: every harness already has its own permission-governed
// file reader, and `FileService.read` resolves absolute paths anywhere on the
// host, which a model-callable tool must not expose.
//
// The cache is resolved lazily from the service registry: this package must not
// hold a cross-package service reference from registration.
import type {
  AgentCapabilityContribution,
  JsonObject,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  OUTPUT_CACHE_SCHEME,
  parseOutputCacheUri,
  READ_FILE_TOOL_NAME,
  type SessionOutputCache,
} from "@polyth/session/output-cache";

export const FILES_PACKAGE_ID = "files";
export const READ_FILE_CAPABILITY_ID = `${FILES_PACKAGE_ID}.read_file`;
/** Lines returned per read when the caller does not bound the range itself. */
export const READ_FILE_DEFAULT_LINES = 500;
export const READ_FILE_MAX_LINES = 5_000;
/** A single huge line must not smuggle the whole payload back past the pager. */
export const READ_FILE_MAX_CHARS = 64_000;

export interface ReadFileAgentRuntime {
  /** Absent before the composition root publishes the cache; the virtual
   *  scheme then reports an honest miss. */
  outputCache?: () => SessionOutputCache | undefined;
}

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      description: `A ${OUTPUT_CACHE_SCHEME}<id> URI from a truncated tool result.`,
    },
    start_line: {
      type: "integer",
      minimum: 1,
      description: "First line to return (1-based, inclusive). Defaults to the first line.",
    },
    end_line: {
      type: "integer",
      minimum: 1,
      description: `Last line to return (1-based, inclusive). Defaults to start_line + ${READ_FILE_DEFAULT_LINES - 1}; at most ${READ_FILE_MAX_LINES} lines per read.`,
    },
  },
};

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const lineOf = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalid(`${name} must be a positive integer`);
  }
  return parsed;
};

export function createReadFileAgentTool(runtime: ReadFileAgentRuntime): AgentCapabilityContribution {
  return {
    descriptor: {
      id: READ_FILE_CAPABILITY_ID,
      kind: "tool",
      owner: FILES_PACKAGE_ID,
      scope: "project",
      revision: "2",
      name: READ_FILE_TOOL_NAME,
      description:
        `Page through a truncated tool result cached at a ${OUTPUT_CACHE_SCHEME} URI. `
        + "Accepts 1-based start_line/end_line so a large log can be read in the region that matters.",
      inputSchema,
      trust: "workspace",
      mutating: false,
    },
    async execute(input: JsonObject, context: ToolExecutionContext) {
      const uri = String(input.path ?? "").trim();
      if (!uri) throw invalid("path is required");
      if (!isOutputCachePath(uri)) {
        throw invalid(`read_file only reads ${OUTPUT_CACHE_SCHEME} URIs; use your own file tools for workspace files`);
      }
      const startLine = lineOf(input.start_line, "start_line") ?? 1;
      const requestedEnd = lineOf(input.end_line, "end_line");
      if (requestedEnd !== undefined && requestedEnd < startLine) {
        throw invalid("end_line must be greater than or equal to start_line");
      }
      const endLine = Math.min(
        requestedEnd ?? startLine + READ_FILE_DEFAULT_LINES - 1,
        startLine + READ_FILE_MAX_LINES - 1,
      );
      // A URI is only resolvable by the session that was told about it, and only
      // until its TTL expires. Report one honest miss for every case.
      const slice = runtime.outputCache?.()?.read(context.sessionId, uri, { startLine, endLine });
      if (!slice) {
        throw Object.assign(
          new Error(`No cached output for ${uri} in this session. It may have expired or belong to another session.`),
          { code: "not-found" },
        );
      }
      let body = slice.lines.join("\n");
      const clipped = body.length > READ_FILE_MAX_CHARS;
      if (clipped) body = body.slice(0, READ_FILE_MAX_CHARS);
      const more = slice.endLine < slice.totalLines
        ? ` Use ${READ_FILE_TOOL_NAME} with start_line ${slice.endLine + 1} for more.`
        : "";
      const clipNote = clipped
        ? ` Output clipped at ${READ_FILE_MAX_CHARS} characters; request a narrower line range.`
        : "";
      return {
        output: `${uri} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}\n${more}${clipNote}\n\n${body}`,
        metadata: {
          source: "output-cache",
          uri: slice.uri,
          startLine: slice.startLine,
          endLine: slice.endLine,
          totalLines: slice.totalLines,
          totalChars: slice.totalChars,
          ...(clipped ? { clipped: true } : {}),
          ...(startLine > slice.totalLines ? { empty: true } : {}),
        },
      };
    },
  };
}

export const isOutputCachePath = (path: string): boolean => parseOutputCacheUri(path) !== undefined;
