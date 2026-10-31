import type { AvailableProviderDescriptor, ModelDescriptor } from "@polyth/contracts";
import type { JudgmentConfig, JudgmentEngineMetadata, JudgmentTarget } from "./types.ts";
import type { JudgmentUseDescriptor } from "./uses.ts";
export type * from "./uses.ts";

export type JudgmentProviderStatus = "available" | "unavailable" | "authentication-required" | "unsupported";
export interface JudgmentProviderOption {
  provider: AvailableProviderDescriptor;
  status: JudgmentProviderStatus;
  models: ModelDescriptor[];
  /** One sentence: who answers and who bills. */
  description?: string;
  /** `none`: the provider takes no credential. Omitted means a credential is required. */
  credential?: "required" | "none";
  /** Endpoint origin the provider's credential and evidence are sent to. */
  endpoint?: string;
  /** Automatic may resolve to this provider once it is available. */
  automatic?: boolean;
  /** The provider can refresh its model list from the account. */
  discovery?: boolean;
  /** Runs on the Polyth server itself: evidence never leaves it. */
  local?: boolean;
  /** Answered by a model of the person's own connected harnesses, billed to that account. */
  harness?: boolean;
}
export interface JudgmentEngineSettings {
  /** Legacy single-credential field: the engine's primary provider handle. */
  secretHandle?: string;
  /** Credential Vault handle per provider ID. */
  credentials?: Record<string, string>;
  handles: Array<{ handle: string; label: string }>;
}
/** Outcome of one user-requested end-to-end check of the effective target. Never carries evidence. */
export interface JudgmentCheckResult {
  ok: boolean;
  reason?: string;
  engineId?: string;
  providerId?: string;
  modelId?: string;
  durationMs: number;
  checkedAt: number;
}
export interface JudgmentSettingsSnapshot {
  revision: number;
  global: JudgmentConfig;
  project?: Partial<JudgmentConfig>;
  engines: JudgmentEngineMetadata[];
  engineId?: string;
  defaultTarget?: JudgmentTarget;
  /** Default model per provider of the selected engine. */
  defaultModels?: Record<string, string>;
  providers: JudgmentProviderOption[];
  engineSettings?: JudgmentEngineSettings;
  /** Features currently registered to ask Judgment, sorted for display. */
  uses?: JudgmentUseDescriptor[];
}
