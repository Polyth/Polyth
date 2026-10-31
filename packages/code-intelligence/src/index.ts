// Code intelligence: a browser-safe provider that turns the editor's
// `editor.intelligence` slot into TypeScript/JavaScript language smarts. The
// editor package owns CodeMirror and the route; this module owns only the
// request mapping and the failure policy.
//
// The route is the editor package's scoped `POST /api/editor/language`. This
// module is deliberately pure: it takes a `fetch` implementation so it can be
// tested without a DOM, and it never throws into the editor — an unavailable
// service, a non-2xx response or a malformed body degrades to "nothing to
// show".
import type {
  EditorCompletions,
  EditorDiagnostic,
  EditorHover,
  EditorPosition,
} from "@polyth/editor";

/** Language labels exactly as packages/editor/widgets/languages.ts declares
 *  them; the editor matches providers on the label of the open buffer. */
export const CODE_INTELLIGENCE_LANGUAGES = Object.freeze([
  "JavaScript",
  "JavaScript (JSX)",
  "TypeScript",
  "TypeScript (TSX)",
]);

export const CODE_INTELLIGENCE_ROUTE = "/api/editor/language";

export type CodeIntelligenceCapability = "completion" | "hover" | "diagnostics";

export interface CodeIntelligenceRef {
  scheme: string;
  locator: string;
  projectId: string;
  sessionId: string | null;
  repositoryId?: string;
}

/** Structural twin of the editor's `EditorIntelligenceRequest`; a provider
 *  object built here satisfies `EditorIntelligenceProvider` without importing
 *  the editor's browser modules. */
export interface CodeIntelligenceRequest {
  ref: CodeIntelligenceRef;
  path: string;
  language: string;
  content: string;
  contentRevision?: string;
  position: EditorPosition;
}

export interface CodeIntelligenceProvider {
  id: string;
  languages: readonly string[];
  completions(request: CodeIntelligenceRequest, signal?: AbortSignal): Promise<EditorCompletions | null>;
  hover(request: CodeIntelligenceRequest, signal?: AbortSignal): Promise<EditorHover | null>;
  diagnostics(request: CodeIntelligenceRequest, signal?: AbortSignal): Promise<EditorDiagnostic[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const CODE_INTELLIGENCE_PROVIDER_ID = "code-intelligence.typescript";

interface LanguageResponse {
  completions?: EditorCompletions | null;
  hover?: EditorHover | null;
  diagnostics?: EditorDiagnostic[];
  unavailable?: string;
}

function bodyFor(capability: CodeIntelligenceCapability, request: CodeIntelligenceRequest): string {
  const body: Record<string, unknown> = {
    capability,
    projectId: request.ref.projectId,
    sessionId: request.ref.sessionId,
    repositoryId: request.ref.repositoryId ?? "primary",
    path: request.path,
    position: request.position,
    content: request.content,
  };
  if (request.contentRevision !== undefined) body.contentRevision = request.contentRevision;
  return JSON.stringify(body);
}

/** One request. `null` means "the service could not answer": an aborted
 *  request, a non-2xx status, `unavailable`, or an unreadable body. */
async function ask(
  fetchImpl: FetchLike,
  capability: CodeIntelligenceCapability,
  request: CodeIntelligenceRequest,
  signal?: AbortSignal,
): Promise<LanguageResponse | null> {
  if (signal?.aborted) return null;
  try {
    const response = await fetchImpl(CODE_INTELLIGENCE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyFor(capability, request),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const payload = await response.json() as LanguageResponse | null;
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.unavailable === "string") return null;
    return payload;
  } catch {
    // Abort, network failure and malformed JSON all degrade the same way.
    return null;
  }
}

/** TypeScript/JavaScript completions, hover details and problems from the
 *  editor's language route. Every capability resolves to an empty result
 *  instead of rejecting, so a broken service never breaks the editor. */
export function createTypeScriptIntelligence(fetchImpl: FetchLike = fetch): CodeIntelligenceProvider {
  return {
    id: CODE_INTELLIGENCE_PROVIDER_ID,
    languages: CODE_INTELLIGENCE_LANGUAGES,
    async completions(request, signal) {
      const payload = await ask(fetchImpl, "completion", request, signal);
      const completions = payload?.completions;
      if (!completions || !Array.isArray(completions.items) || completions.items.length === 0) return null;
      return completions;
    },
    async hover(request, signal) {
      const payload = await ask(fetchImpl, "hover", request, signal);
      const hover = payload?.hover;
      if (!hover || typeof hover.display !== "string") return null;
      return hover;
    },
    async diagnostics(request, signal) {
      const payload = await ask(fetchImpl, "diagnostics", request, signal);
      const diagnostics = payload?.diagnostics;
      return Array.isArray(diagnostics) ? diagnostics : [];
    },
  };
}
