// Package renderers for fenced Markdown blocks (`host.markdown.registerFence`).
// Host-owned registry: built-in fences stay with the host, one owner per
// language, and every consumer re-renders when a package enables/disables.
// createElement-based so DOM-free node tests can import it.
import { Component, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { MarkdownFenceAction, MarkdownFenceRegistration, MarkdownFenceRendererProps, Unregister } from "@polyth/web-sdk";

/** Fences the host renders itself; a package cannot take them over. */
export const BUILT_IN_FENCES: ReadonlySet<string> = new Set(["mermaid", "json"]);
const LANGUAGE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

interface Entry {
  owner: string;
  component: ComponentType<MarkdownFenceRendererProps>;
}

const renderers = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

export function registerMarkdownFence(registration: MarkdownFenceRegistration): Unregister {
  const owner = registration.ownerPackageId ?? "host";
  const languages = [...new Set(registration.languages.map((lang) => lang.trim().toLowerCase()))];
  if (languages.length === 0) throw invalid("a fence renderer needs at least one language");
  for (const lang of languages) {
    if (!LANGUAGE_RE.test(lang)) throw invalid(`invalid fence language "${lang}"`);
    if (BUILT_IN_FENCES.has(lang)) throw invalid(`fence language "${lang}" is rendered by the host`);
    const current = renderers.get(lang);
    if (current && current.owner !== owner) throw invalid(`fence language "${lang}" is owned by ${current.owner}`);
  }
  const entry: Entry = { owner, component: registration.component };
  for (const lang of languages) renderers.set(lang, entry);
  emit();
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    let changed = false;
    for (const lang of languages) {
      if (renderers.get(lang) === entry) {
        renderers.delete(lang);
        changed = true;
      }
    }
    if (changed) emit();
  };
}

export function markdownFenceRenderer(lang: string): ComponentType<MarkdownFenceRendererProps> | undefined {
  return renderers.get(lang.trim().toLowerCase())?.component;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The current renderer for `lang`, re-evaluated when registrations change. */
export function useMarkdownFenceRenderer(lang: string): ComponentType<MarkdownFenceRendererProps> | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  return markdownFenceRenderer(lang);
}

// ---- actions on blocks (`host.markdown.registerFenceAction`) ----------------------
// One package adds a button to the blocks another renders. The host keeps the
// list and nothing else: the renderer draws the buttons and runs one from the
// person's click.

const ACTION_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const NO_ACTIONS: readonly MarkdownFenceAction[] = Object.freeze([]);
const actions = new Map<string, { action: MarkdownFenceAction; languages: readonly string[] }>();
const actionListeners = new Set<() => void>();
// Per language, rebuilt after a change: a stable array is a valid
// useSyncExternalStore snapshot.
let actionLists = new Map<string, readonly MarkdownFenceAction[]>();

const emitActions = () => {
  actionLists = new Map();
  for (const listener of [...actionListeners]) listener();
};

export function registerMarkdownFenceAction(action: MarkdownFenceAction): Unregister {
  if (!ACTION_ID_RE.test(action.id)) throw invalid(`invalid fence action id "${action.id}"`);
  if (actions.has(action.id)) throw invalid(`fence action "${action.id}" is already registered`);
  const languages = [...new Set(action.languages.map((lang) => lang.trim().toLowerCase()))];
  if (languages.length === 0) throw invalid("a fence action needs at least one language");
  for (const lang of languages) if (!LANGUAGE_RE.test(lang)) throw invalid(`invalid fence language "${lang}"`);
  const entry = { action, languages };
  actions.set(action.id, entry);
  emitActions();
  return () => {
    if (actions.get(action.id) !== entry) return;
    actions.delete(action.id);
    emitActions();
  };
}

export function markdownFenceActions(lang: string): readonly MarkdownFenceAction[] {
  const key = lang.trim().toLowerCase();
  const cached = actionLists.get(key);
  if (cached) return cached;
  const list = [...actions.values()]
    .filter((entry) => entry.languages.includes(key))
    .map((entry) => entry.action)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const next = list.length === 0 ? NO_ACTIONS : Object.freeze(list);
  actionLists.set(key, next);
  return next;
}

export function subscribeMarkdownFenceActions(listener: () => void): Unregister {
  actionListeners.add(listener);
  return () => { actionListeners.delete(listener); };
}

/** A renderer failure shows the host's own code block instead of breaking
 *  the message; the canonical text is never lost. */
export class FenceErrorBoundary extends Component<{ fallback: ReactNode; resetKey: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("[polyth] fence renderer failed", error);
  }

  componentDidUpdate(previous: { resetKey: string }): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : (this.props.children ?? null);
  }
}

export function renderFence(
  component: ComponentType<MarkdownFenceRendererProps>,
  props: MarkdownFenceRendererProps,
): ReactNode {
  return createElement(
    FenceErrorBoundary,
    { fallback: props.source, resetKey: props.text },
    createElement(component, props),
  );
}
