import type { SpaceContext } from "@polyth/contracts";
import { serverServiceKey } from "@polyth/plugins";
import type { JudgmentBudgetPool } from "./budget.ts";
import type { JudgmentEngineAdapter, JudgmentEngineMetadata, JudgmentObservation, JudgmentRuntime } from "./types.ts";
import type { JudgmentEngineSettings, JudgmentProviderOption } from "./settings.ts";
import type { JudgmentUseDescriptor, JudgmentUseState } from "./uses.ts";
export type * from "./uses.ts";

export interface JudgmentServerContext { space: SpaceContext; projectId: string }
export interface JudgmentEngineContribution {
  metadata: JudgmentEngineMetadata;
  create(context: JudgmentServerContext): JudgmentEngineAdapter;
  catalog(context: JudgmentServerContext): JudgmentProviderOption[];
  /** Refreshes the account model list of `providerId`, or of the engine's primary provider. */
  refresh?(context: JudgmentServerContext, signal: AbortSignal, providerId?: string): Promise<void>;
  settings?(context: JudgmentServerContext): JudgmentEngineSettings;
  /** Connects or clears (`secretHandle` omitted) the credential of `providerId`, or of the primary provider. */
  configure?(context: JudgmentServerContext, settings: { providerId?: string; secretHandle?: string }): Promise<void>;
}
export interface JudgmentService {
  registerEngine(contribution: JudgmentEngineContribution): () => void;
  /** Caller owns disposal. Runtime lifetime is a run, not the server's lifetime. */
  /** Registers a feature that asks Judgment; Settings → Judgment renders its switch and parameters. Call from an enable hook; dispose on disable. */
  registerUse(descriptor: JudgmentUseDescriptor): () => void;
  /** The use's resolved switch and parameters for this Space/project. Read before every evaluation: settings change at any time. */
  resolveUse(context: JudgmentServerContext, useId: string): Promise<JudgmentUseState>;
  createRun(context: JudgmentServerContext, options?: { budget?: JudgmentBudgetPool; observe?: (observation: JudgmentObservation) => void }): Promise<JudgmentRuntime>;
}
export const JUDGMENT_SERVICE = serverServiceKey<JudgmentService>("judgment.service");
