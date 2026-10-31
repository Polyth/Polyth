import { createHash } from "node:crypto";
import { readFile, opendir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import type {
  EditorCompletionItem,
  EditorCompletionKind,
  EditorCompletions,
  EditorDefinition,
  EditorDiagnostic,
  EditorDiagnosticSeverity,
  EditorHover,
  EditorLanguageCapability,
  EditorLanguageResponse,
  EditorLocation,
  EditorPosition,
  EditorRange,
  EditorReference,
  EditorRenamePreview,
  EditorRenameTarget,
} from "./languageTypes.ts";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MAX_ON_DEMAND_FILES = 100;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORIES = 2_000;
const MAX_SCAN_MS = 1_500;
const LIB_ROOT = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));

export interface LanguageWorkspaceScope {
  spaceId: string;
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  root: string;
}

export interface EditorDocumentOverlay {
  content: string;
  revision?: string;
}

interface SourceFile {
  absolute: string;
  relative: string;
  text: string;
  revision: string;
  mtimeMs?: number;
  size?: number;
  onDemand?: boolean;
  accessedAt?: number;
}

interface LanguageHost extends ts.LanguageServiceHost {
  files: Map<string, SourceFile>;
  root: string;
  compilerOptions: ts.CompilerOptions;
  refresh(force?: boolean): Promise<void>;
}

function cleanPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function inside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function sourceRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const contentRevision = sourceRevision;

async function readWorkspaceFiles(root: string): Promise<Map<string, SourceFile>> {
  const canonicalRoot = await realpath(root);
  const files = new Map<string, SourceFile>();
  let totalBytes = 0;
  let directories = 0;
  const deadline = Date.now() + MAX_SCAN_MS;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 32 || files.size >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES || directories >= MAX_DIRECTORIES || Date.now() >= deadline) return;
    directories += 1;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (files.size >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES || directories >= MAX_DIRECTORIES || Date.now() >= deadline) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
      const candidate = join(directory, entry.name);
      // Symlinks are excluded rather than followed. The resolved workspace is
      // already the authority boundary; following a link would create a
      // second, implicit root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const resolved = await realpath(candidate);
      if (!inside(canonicalRoot, resolved)) continue;
      const info = await stat(resolved);
      if (info.size > MAX_SOURCE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) continue;
      const text = await readFile(resolved, "utf8");
      totalBytes += Buffer.byteLength(text);
      const rel = cleanPath(relative(canonicalRoot, resolved));
      files.set(resolved, {
        absolute: resolved,
        relative: rel,
        text,
        revision: sourceRevision(text),
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
    }
  };
  await visit(canonicalRoot);
  return files;
}

async function projectCompilerOptions(root: string): Promise<ts.CompilerOptions> {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowNonTsExtensions: false,
    noEmit: true,
    skipLibCheck: true,
  };
  try {
    const configPath = join(root, "tsconfig.json");
    if ((await stat(configPath)).size > MAX_SOURCE_BYTES || await realpath(configPath) !== configPath) return defaults;
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { compilerOptions?: unknown };
    if (!raw.compilerOptions || typeof raw.compilerOptions !== "object" || Array.isArray(raw.compilerOptions)) return defaults;
    const converted = ts.convertCompilerOptionsFromJson(raw.compilerOptions, root);
    if (converted.errors.length) return defaults;
    const options = { ...defaults, ...converted.options };
    if (options.baseUrl && !inside(root, options.baseUrl)) delete options.baseUrl;
    if (options.paths) {
      const safePaths: ts.MapLike<string[]> = {};
      for (const [alias, targets] of Object.entries(options.paths)) {
        const safeTargets = targets.filter((target) => inside(root, resolve(options.baseUrl ?? root, target)));
        if (safeTargets.length) safePaths[alias] = safeTargets;
      }
      options.paths = safePaths;
    }
    return options;
  } catch {
    return defaults;
  }
}

function makeHost(root: string, files: Map<string, SourceFile>, compilerOptions: ts.CompilerOptions): LanguageHost {
  const canonicalRoot = resolve(root);
  const versions = new Map<string, string>();
  let lastFullScanAt = Date.now();
  const SCAN_TTL_MS = 2_000;
  const host: LanguageHost = {
    files,
    root: canonicalRoot,
    compilerOptions,
    getCompilationSettings: () => host.compilerOptions,
    getScriptFileNames: () => [...host.files.keys()],
    getScriptVersion: (fileName) => {
      if (host.files.has(fileName)) return host.files.get(fileName)!.revision;
      return versions.get(fileName) ?? "0";
    },
    getScriptSnapshot: (fileName) => {
      const source = host.files.get(fileName);
      if (source) return ts.ScriptSnapshot.fromString(source.text);
      // TypeScript asks for its bundled declaration libraries by absolute
      // path. This is the only filesystem outside the repository root that is
      // allowed to enter the language service.
      if (fileName.startsWith(`${LIB_ROOT}${sep}`) && fileName.endsWith(".d.ts")) {
        try {
          return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "");
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    getCurrentDirectory: () => canonicalRoot,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => host.files.has(fileName)
      || (fileName.startsWith(`${LIB_ROOT}${sep}`) && ts.sys.fileExists(fileName)),
    readFile: (fileName) => host.files.get(fileName)?.text
      ?? (fileName.startsWith(`${LIB_ROOT}${sep}`) ? ts.sys.readFile(fileName) : undefined),
    readDirectory: (directory, extensions) => {
      if (!inside(canonicalRoot, directory)) return [];
      return [...host.files.keys()].filter((fileName) => {
        if (!inside(directory, fileName)) return false;
        return !extensions || extensions.some((extension) => fileName.endsWith(extension));
      });
    },
    refresh: async (force = false) => {
      const now = Date.now();
      if (force || now - lastFullScanAt >= SCAN_TTL_MS) {
        const next = await readWorkspaceFiles(canonicalRoot);
        const existingOnDemand = [...host.files.values()].filter((f) => f.onDemand);
        host.files.clear();
        versions.clear();
        for (const [fileName, file] of next) host.files.set(fileName, file);
        for (const [fileName, file] of next) versions.set(fileName, file.revision);
        for (const od of existingOnDemand) {
          if (!host.files.has(od.absolute)) {
            host.files.set(od.absolute, od);
            versions.set(od.absolute, od.revision);
          }
        }
        lastFullScanAt = Date.now();
        return;
      }
      const checks = [...host.files.values()].map(async (source) => {
        try {
          const info = await stat(source.absolute);
          if (source.mtimeMs === info.mtimeMs && source.size === info.size) {
            return;
          }
          const resolved = await realpath(source.absolute);
          if (!inside(canonicalRoot, resolved) || info.size > MAX_SOURCE_BYTES) {
            host.files.delete(source.absolute);
            versions.delete(source.absolute);
            return;
          }
          const text = await readFile(resolved, "utf8");
          const revision = sourceRevision(text);
          host.files.set(source.absolute, {
            absolute: resolved,
            relative: source.relative,
            text,
            revision,
            mtimeMs: info.mtimeMs,
            size: info.size,
          });
          versions.set(source.absolute, revision);
        } catch {
          host.files.delete(source.absolute);
          versions.delete(source.absolute);
        }
      });
      await Promise.all(checks);
    },
  };
  for (const [fileName, source] of files) versions.set(fileName, source.revision);
  return host;
}

function positionToOffset(text: string, position: EditorPosition): number {
  const lines = text.split("\n");
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let offset = 0;
  for (let index = 0; index < line; index++) offset += lines[index]!.length + 1;
  return offset + Math.max(0, Math.min(position.character, lines[line]!.length));
}

function offsetPosition(text: string, offset: number): EditorPosition {
  const safe = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safe);
  const line = before.split("\n").length - 1;
  return { line, character: safe - (before.lastIndexOf("\n") + 1) };
}

function rangeFromTs(fileName: string, text: string, start: number, length: number): EditorRange {
  return { start: offsetPosition(text, start), end: offsetPosition(text, start + length) };
}

function sourceFor(host: LanguageHost, fileName: string): SourceFile | undefined {
  const direct = host.files.get(fileName);
  if (direct) return direct;
  const canonical = resolve(fileName);
  return [...host.files.values()].find((source) => source.absolute === canonical);
}

function location(
  scope: LanguageWorkspaceScope,
  host: LanguageHost,
  fileName: string,
  start: number,
  length: number,
): EditorLocation | null {
  const source = sourceFor(host, fileName);
  if (!source) return null;
  return {
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    repositoryId: scope.repositoryId,
    path: source.relative,
    range: rangeFromTs(fileName, source.text, start, length),
  };
}

export function capabilityFor(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function mapScriptElementKind(kind: ts.ScriptElementKind | string): EditorCompletionKind {
  switch (kind) {
    case ts.ScriptElementKind.keyword:
      return "keyword";
    case ts.ScriptElementKind.constElement:
      return "constant";
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
    case ts.ScriptElementKind.letElement:
    case ts.ScriptElementKind.parameterElement:
    case ts.ScriptElementKind.variableUsingElement:
    case ts.ScriptElementKind.variableAwaitUsingElement:
      return "variable";
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return "function";
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.constructSignatureElement:
    case ts.ScriptElementKind.callSignatureElement:
    case ts.ScriptElementKind.indexSignatureElement:
      return "method";
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
    case ts.ScriptElementKind.memberAccessorVariableElement:
      return "property";
    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.localClassElement:
      return "class";
    case ts.ScriptElementKind.interfaceElement:
      return "interface";
    case ts.ScriptElementKind.typeElement:
    case ts.ScriptElementKind.primitiveType:
      return "type";
    case ts.ScriptElementKind.enumElement:
    case ts.ScriptElementKind.enumMemberElement:
      return "enum";
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
    case ts.ScriptElementKind.alias:
      return "module";
    default:
      return "text";
  }
}

const DECLARATION_ARTIFACT_CODES = new Set<number>([
  2304, // Cannot find name '...'
  2305, // Module '...' has no exported member '...'
  2306, // File '...' is not a module
  2307, // Cannot find module '...' or its corresponding type declarations
  2353, // Object literal may only specify known properties...
  2362, // The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type
  2363, // The right-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type
  2580, // Cannot find name '...'. Do you need to install type definitions for node?
  2583, // Cannot find name '...'. Do you need to change your target library?
  2584, // Cannot find name '...'. Do you need to change your target library?
  2688, // Cannot find type definition file for '...'
  2792, // Cannot find module '...'
  2875, // Type '...' is not generic
  5097, // An import path can only end with a '.tsx' extension when 'allowImportingTsExtensions' is enabled
  7016, // Could not find a declaration file for module '...'
]);

function isDeclarationArtifact(d: ts.Diagnostic): boolean {
  if (DECLARATION_ARTIFACT_CODES.has(d.code)) return true;
  if (d.code === 2339) {
    const text = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    if (text.includes("does not exist on type 'unknown'")) return true;
  }
  return false;
}

export class EditorLanguageWorkspace {
  readonly scope: LanguageWorkspaceScope;
  private readonly host: LanguageHost;
  private readonly service: ts.LanguageService;
  private operation: Promise<unknown> = Promise.resolve();
  private activeOperations = 0;
  private lastUsedAt = Date.now();
  private disposed = false;

  private constructor(scope: LanguageWorkspaceScope, host: LanguageHost) {
    this.scope = scope;
    this.host = host;
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  static async open(scope: LanguageWorkspaceScope): Promise<EditorLanguageWorkspace> {
    const root = await realpath(scope.root);
    const files = await readWorkspaceFiles(root);
    return new EditorLanguageWorkspace({ ...scope, root }, makeHost(root, files, await projectCompilerOptions(root)));
  }

  async refresh(force = false): Promise<void> {
    await this.enqueue(async () => this.host.refresh(force));
  }

  isBusy(): boolean { return this.activeOperations > 0; }
  lastUsed(): number { return this.lastUsedAt; }

  private enqueue<T>(run: () => Promise<T> | T): Promise<T> {
    const task = this.operation.then(async () => {
      if (this.disposed) throw new Error("language workspace is disposed");
      this.activeOperations += 1;
      this.lastUsedAt = Date.now();
      try { return await run(); } finally { this.activeOperations -= 1; this.lastUsedAt = Date.now(); }
    });
    this.operation = task.catch(() => undefined);
    return task;
  }

  source(path: string): SourceFile | undefined {
    const candidate = resolve(this.scope.root, path);
    if (!inside(this.scope.root, candidate)) return undefined;
    return sourceFor(this.host, candidate);
  }

  async ensureSource(path: string): Promise<SourceFile | undefined> {
    const candidate = resolve(this.scope.root, path);
    if (!inside(this.scope.root, candidate)) return undefined;
    const existing = sourceFor(this.host, candidate);
    if (existing) {
      if (existing.onDemand) existing.accessedAt = Date.now();
      return existing;
    }
    if (!capabilityFor(path)) return undefined;
    try {
      const resolved = await realpath(candidate);
      if (!inside(this.scope.root, resolved)) return undefined;
      const info = await stat(resolved);
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined;
      const text = await readFile(resolved, "utf8");
      const fileSize = Buffer.byteLength(text);
      if (fileSize > MAX_SOURCE_BYTES) return undefined;

      // Bound on-demand files: at most MAX_ON_DEMAND_FILES and respect MAX_TOTAL_BYTES.
      // Evict oldest on-demand entries, never scanned ones.
      let totalBytes = 0;
      const onDemandEntries: SourceFile[] = [];
      for (const file of this.host.files.values()) {
        totalBytes += Buffer.byteLength(file.text);
        if (file.onDemand) onDemandEntries.push(file);
      }
      onDemandEntries.sort((a, b) => (a.accessedAt ?? 0) - (b.accessedAt ?? 0));

      while (
        onDemandEntries.length > 0 &&
        (onDemandEntries.length >= MAX_ON_DEMAND_FILES || totalBytes + fileSize > MAX_TOTAL_BYTES)
      ) {
        const evicted = onDemandEntries.shift()!;
        this.host.files.delete(evicted.absolute);
        totalBytes -= Buffer.byteLength(evicted.text);
      }

      if (totalBytes + fileSize > MAX_TOTAL_BYTES) {
        return undefined;
      }

      const rel = cleanPath(relative(this.scope.root, resolved));
      const file: SourceFile = {
        absolute: resolved,
        relative: rel,
        text,
        revision: sourceRevision(text),
        mtimeMs: info.mtimeMs,
        size: info.size,
        onDemand: true,
        accessedAt: Date.now(),
      };
      this.host.files.set(resolved, file);
      return file;
    } catch {
      return undefined;
    }
  }

  private withOverlay<T>(path: string, overlay: EditorDocumentOverlay | undefined, run: () => T): T {
    if (!overlay) return run();
    if (Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return run();
    const source = this.source(path);
    if (!source) return run();
    const revision = overlay.revision ?? sourceRevision(overlay.content);
    this.host.files.set(source.absolute, { ...source, text: overlay.content, revision });
    try {
      return run();
    } finally {
      this.host.files.set(source.absolute, source);
    }
  }

  async definitions(path: string, position: EditorPosition, overlay?: EditorDocumentOverlay): Promise<EditorLanguageResponse> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return unavailable("definition", "language");
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.definitionsSync(path, position)));
  }

  private definitionsSync(path: string, position: EditorPosition): EditorLanguageResponse {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return unavailable("definition", "language");
    const offset = positionToOffset(source.text, position);
    const result = this.service.getDefinitionAndBoundSpan(source.absolute, offset);
    const definitions: EditorDefinition[] = [];
    for (const item of result?.definitions ?? []) {
      const target = location(this.scope, this.host, item.fileName, item.textSpan.start, item.textSpan.length);
      if (target) definitions.push({ ...target, name: item.name, kind: item.kind });
    }
    return { capability: "definition", definitions, unavailable: definitions.length ? undefined : "symbol" };
  }

  async references(path: string, position: EditorPosition, overlay?: EditorDocumentOverlay): Promise<EditorLanguageResponse> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return unavailable("references", "language");
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.referencesSync(path, position)));
  }

  private referencesSync(path: string, position: EditorPosition): EditorLanguageResponse {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return unavailable("references", "language");
    const offset = positionToOffset(source.text, position);
    const references: EditorReference[] = [];
    for (const item of this.service.getReferencesAtPosition(source.absolute, offset) ?? []) {
      const target = location(this.scope, this.host, item.fileName, item.textSpan.start, item.textSpan.length);
      if (target) references.push({ ...target, isDefinition: item.isWriteAccess });
    }
    return { capability: "references", references, unavailable: references.length ? undefined : "symbol" };
  }

  async rename(path: string, position: EditorPosition, newName?: string, overlay?: EditorDocumentOverlay): Promise<EditorLanguageResponse> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return unavailable("rename", "language");
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.renameSync(path, position, newName)));
  }

  private renameSync(path: string, position: EditorPosition, newName?: string): EditorLanguageResponse {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return unavailable("rename", "language");
    const offset = positionToOffset(source.text, position);
    const info = this.service.getRenameInfo(source.absolute, offset, { allowRenameOfImportPath: false });
    if (!info.canRename || !info.displayName) return unavailable("rename", "symbol");
    const replacement = newName ?? info.displayName;
    const targets: EditorRenameTarget[] = [];
    for (const item of this.service.findRenameLocations(source.absolute, offset, false, false) ?? []) {
      const target = location(this.scope, this.host, item.fileName, item.textSpan.start, item.textSpan.length);
      const targetSource = sourceFor(this.host, item.fileName);
      if (target && targetSource) targets.push({ ...target, expectedRevision: targetSource.revision });
    }
    const rename: EditorRenamePreview = { oldName: info.displayName, newName: replacement, targets };
    return { capability: "rename", rename, unavailable: targets.length ? undefined : "symbol" };
  }

  async completion(path: string, position: EditorPosition, overlay?: EditorDocumentOverlay): Promise<EditorCompletions | null> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return null;
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.completionSync(path, position)));
  }

  private completionSync(path: string, position: EditorPosition): EditorCompletions | null {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return null;
    const offset = positionToOffset(source.text, position);
    const info = this.service.getCompletionsAtPosition(
      source.absolute,
      offset,
      { includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false },
    );
    if (!info || !info.entries || info.entries.length === 0) return null;

    let startOffset = offset;
    if (info.optionalReplacementSpan) {
      startOffset = info.optionalReplacementSpan.start;
    } else {
      while (startOffset > 0 && /[A-Za-z0-9_$]/.test(source.text[startOffset - 1]!)) {
        startOffset -= 1;
      }
    }
    const from = offsetPosition(source.text, startOffset);

    const items: EditorCompletionItem[] = [];
    for (const entry of info.entries) {
      const item: EditorCompletionItem = {
        label: entry.name,
        kind: mapScriptElementKind(entry.kind),
      };
      const detail = entry.labelDetails?.detail ?? entry.labelDetails?.description;
      if (detail) {
        item.detail = detail;
      }
      if (entry.sortText) {
        item.sortText = entry.sortText;
      }
      if (entry.insertText && entry.insertText !== entry.name) {
        item.insertText = entry.insertText;
      }
      items.push(item);
    }

    items.sort((a, b) => {
      const sa = a.sortText ?? a.label;
      const sb = b.sortText ?? b.label;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    const incomplete = items.length > 200;
    const capped = incomplete ? items.slice(0, 200) : items;
    return {
      from,
      items: capped,
      ...(incomplete ? { incomplete: true } : {}),
    };
  }

  async hover(path: string, position: EditorPosition, overlay?: EditorDocumentOverlay): Promise<EditorHover | null> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return null;
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.hoverSync(path, position)));
  }

  private hoverSync(path: string, position: EditorPosition): EditorHover | null {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return null;
    const offset = positionToOffset(source.text, position);
    const info = this.service.getQuickInfoAtPosition(source.absolute, offset);
    if (!info) return null;

    const display = ts.displayPartsToString(info.displayParts);
    const docText = ts.displayPartsToString(info.documentation).trim();
    const tagLines: string[] = [];
    for (const tag of info.tags ?? []) {
      const tagText = ts.displayPartsToString(tag.text).trim();
      tagLines.push(tagText ? `@${tag.name} ${tagText}` : `@${tag.name}`);
    }

    let documentation: string | undefined;
    if (docText && tagLines.length > 0) {
      documentation = `${docText}\n\n${tagLines.join("\n")}`;
    } else if (docText) {
      documentation = docText;
    } else if (tagLines.length > 0) {
      documentation = tagLines.join("\n");
    }

    const range = rangeFromTs(source.absolute, source.text, info.textSpan.start, info.textSpan.length);
    return {
      range,
      display,
      ...(documentation ? { documentation } : {}),
    };
  }

  async diagnostics(path: string, overlay?: EditorDocumentOverlay): Promise<EditorDiagnostic[]> {
    if (overlay && Buffer.byteLength(overlay.content) > MAX_SOURCE_BYTES) return [];
    await this.ensureSource(path);
    return this.enqueue(() => this.withOverlay(path, overlay, () => this.diagnosticsSync(path)));
  }

  private diagnosticsSync(path: string): EditorDiagnostic[] {
    const source = this.source(path);
    if (!source || !capabilityFor(path)) return [];
    const syntactic = this.service.getSyntacticDiagnostics(source.absolute);
    const semantic = this.service.getSemanticDiagnostics(source.absolute);
    const diagnostics: EditorDiagnostic[] = [];

    // Syntactic diagnostics are always honest for that one file.
    for (const d of syntactic) {
      if (d.start === undefined || d.length === undefined) continue;
      diagnostics.push({
        range: rangeFromTs(source.absolute, source.text, d.start, d.length),
        severity: "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        code: d.code,
      });
      if (diagnostics.length >= 500) break;
    }

    if (diagnostics.length >= 500) return diagnostics;

    // Filter semantic diagnostics: exclude missing declaration and module resolution artifacts.
    for (const d of semantic) {
      if (d.start === undefined || d.length === undefined) continue;
      if (isDeclarationArtifact(d)) continue;
      const severity: EditorDiagnosticSeverity =
        d.category === ts.DiagnosticCategory.Error
          ? "error"
          : d.category === ts.DiagnosticCategory.Warning
            ? "warning"
            : "info";
      diagnostics.push({
        range: rangeFromTs(source.absolute, source.text, d.start, d.length),
        severity,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        code: d.code,
      });
      if (diagnostics.length >= 500) break;
    }
    return diagnostics;
  }

  dispose(): void {
    this.disposed = true;
    this.service.dispose();
  }
}

export function unavailable(capability: EditorLanguageCapability, reason: "language" | "symbol"): EditorLanguageResponse {
  return { capability, unavailable: reason, message: reason === "language"
    ? "Language navigation is available for JavaScript and TypeScript files."
    : "No symbol was found at this position." };
}

export function validateRelativeSource(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) return null;
  const candidate = resolve(root, path);
  return inside(root, candidate) ? candidate : null;
}

export { MAX_FILES, MAX_SOURCE_BYTES, MAX_TOTAL_BYTES, MAX_DIRECTORIES, MAX_SCAN_MS };
