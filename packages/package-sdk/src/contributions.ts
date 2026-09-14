import type { RemoteUiNode } from "./remoteUi.ts";

export type PackageJsonPrimitive = string | number | boolean | null;
export type PackageJsonValue = PackageJsonPrimitive | PackageJsonValue[] | { [key: string]: PackageJsonValue };
export type PackageJsonObject = { [key: string]: PackageJsonValue };

export interface ExternalResource {
  provider: string;
  resourceId: string;
  title: string;
  subtitle?: string;
  url?: string;
  summary?: string;
  text?: string;
  retrievedAt?: number;
  freshUntil?: number;
  metadata?: PackageJsonObject;
  provenance?: {
    source?: string;
    uri?: string;
    retrievedAt?: number;
  };
}

export interface StructuredContext {
  provider: string;
  sourceId: string;
  title: string;
  uri?: string;
  retrievedAt: number;
  freshUntil?: number;
  summary: string;
  content: string;
  metadata?: PackageJsonObject;
}

export type ContributionInvocationKind =
  | "composer-action"
  | "attachment-provider"
  | "message-action"
  | "session-action"
  | "command"
  | "tool-renderer"
  | "status-badge"
  | "settings-section"
  | "context-provider"
  | "widget"
  | "surface";

export interface ContributionInvocationBase {
  invocationId: string;
  lease: string;
  expiresAt: number;
  kind: ContributionInvocationKind;
  contributionId: string;
  spaceId: string;
  projectId?: string;
  sessionId?: string;
}

export interface MessageActionInvocation extends ContributionInvocationBase {
  kind: "message-action";
  message: {
    id: string;
    role: "user" | "assistant" | "tool";
    text?: string;
    toolName?: string;
  };
}

export interface SessionActionInvocation extends ContributionInvocationBase {
  kind: "session-action";
  session: {
    id: string;
    title: string;
    status?: string;
  };
}

export interface CommandInvocation extends ContributionInvocationBase {
  kind: "command";
  query: string;
  arguments: string;
}

export interface ToolRendererInvocation extends ContributionInvocationBase {
  kind: "tool-renderer";
  tool: {
    callId: string;
    name: string;
    input?: PackageJsonObject;
    output?: PackageJsonValue;
    error?: string;
  };
}

export interface ResourceInvocation extends ContributionInvocationBase {
  kind: "attachment-provider" | "context-provider";
  query?: string;
}

export interface UiContributionInvocation extends ContributionInvocationBase {
  kind: "composer-action" | "settings-section" | "status-badge" | "widget" | "surface";
  input?: PackageJsonObject;
}

export type ContributionInvocation =
  | MessageActionInvocation
  | SessionActionInvocation
  | CommandInvocation
  | ToolRendererInvocation
  | ResourceInvocation
  | UiContributionInvocation;

export interface ContributionResult {
  resources?: ExternalResource[];
  context?: StructuredContext[];
  ui?: RemoteUiNode;
  status?: {
    label: string;
    tone?: "neutral" | "info" | "success" | "warning" | "danger";
  };
  message?: string;
}

export interface ContributionCompletion {
  invocationId: string;
  lease: string;
  ok: boolean;
  result?: ContributionResult;
  error?: { message: string };
}
