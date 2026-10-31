/** Browser-safe Reflect DTOs and constants shared by the server routes and
 * the memory settings UI. No runtime imports. */
import type { MemoryCategory } from "@polyth/knowledge/memory-contracts";
import type { ReflectSignal } from "./reflect.ts";

export type { ReflectSignal };
export const REFLECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type ReflectInstructionFile = typeof REFLECT_INSTRUCTION_FILES[number];
export const REFLECT_INSTRUCTION_HEADING = "## Learned rules";
export const REFLECT_INSTRUCTION_CONFIRMATION = "append-project-instruction";

export type ReflectDurabilityArea = "code" | "style" | "process" | "communication" | "other";

export interface ReflectProposalJudgmentDto {
  durability: number;
  area: ReflectDurabilityArea;
  evaluatedAt?: number;
}

export interface ReflectProposalDto {
  id: string;
  projectId: string;
  sessionId: string;
  sessionTitle?: string;
  eventSeq: number;
  eventId?: string;
  signal: ReflectSignal;
  rule: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt?: number;
  memoryId?: string;
  instruction?: { file: ReflectInstructionFile; at: number };
  durability?: number;
  area?: ReflectDurabilityArea;
  judgment?: ReflectProposalJudgmentDto;
}

export interface ReflectViewDto {
  projectId: string;
  enabled: boolean;
  pending: ReflectProposalDto[];
  recent: ReflectProposalDto[];
  pendingTotal: number;
  instructionFiles: Array<{ file: ReflectInstructionFile; exists: boolean }>;
  /** False for remote projects or a missing root: approval may still save a
   * memory, but no instruction file can be written. */
  instructionWritable: boolean;
  /** True when project memory is off: scanning is refused (409 memory-off)
   *  and new corrections are not detected. Optional for older servers. */
  memoryOff?: boolean;
  /** Proposals with durability below hideBelow threshold, kept for manual review. */
  hidden?: ReflectProposalDto[];
  hiddenTotal?: number;
}

export interface ReflectApproveInput {
  rule?: string;
  title?: string;
  category?: MemoryCategory;
  instructionFile?: string;
  confirmation?: string;
}

export interface ReflectApproveResult {
  proposal: ReflectProposalDto;
  memoryId?: string;
  instruction?:
    | { status: "appended"; file: ReflectInstructionFile }
    | { status: "duplicate"; file: ReflectInstructionFile }
    | { status: "failed"; file: string; code: string };
}

/** Error code of a scan refused because project memory is off (HTTP 409).
 *  The panel matches it to explain how to turn memory on. */
export const REFLECT_MEMORY_OFF = "memory-off";
