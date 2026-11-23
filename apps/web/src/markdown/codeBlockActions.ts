// Package actions in a code fence's header (`session.code.actions`, described
// by `meta.codeAction`). The host owns the header and mounts each contribution
// with the block's context; a streaming block gets none, so an action never
// reads half a command.
import { createElement, type ReactNode } from "react";
import type { CodeBlockActionSlotContext, CodeBlockActionSlotMeta } from "@polyth/web-sdk";
import { listSlots, type SlotItem } from "../slots.ts";
import { SlotBoundary, useSlotVersion } from "../components/slots/SlotHost.ts";

export const CODE_ACTIONS_SLOT = "session.code.actions";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function codeActionApplies(item: SlotItem, lang: string): boolean {
  const meta = isRecord(item.meta?.codeAction) ? item.meta.codeAction as CodeBlockActionSlotMeta : null;
  if (!meta?.languages) return true;
  return meta.languages.includes(lang);
}

/** Pure element list for DOM-free tests; empty while the block streams. */
export function codeBlockActionChildren(context: CodeBlockActionSlotContext): ReactNode[] {
  if (context.streaming || !context.lang) return [];
  const bag = { ...context } as unknown as Record<string, unknown>;
  return listSlots(CODE_ACTIONS_SLOT)
    .filter((item) => codeActionApplies(item, context.lang))
    .map((item) => createElement(SlotBoundary, { key: item.id, slot: CODE_ACTIONS_SLOT, item, context: bag }));
}

export function CodeBlockActions(context: CodeBlockActionSlotContext): ReactNode {
  useSlotVersion();
  const children = codeBlockActionChildren(context);
  return children.length > 0 ? createElement("span", { className: "md-code-block-package-actions" }, ...children) : null;
}
