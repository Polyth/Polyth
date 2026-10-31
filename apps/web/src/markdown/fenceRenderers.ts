// Package renderers for fenced Markdown blocks (`host.markdown.registerFence`).
// Host-owned registry: built-in fences stay with the host, one owner per
// language, and every consumer re-renders when a package enables/disables.
// createElement-based so DOM-free node tests can import it.
import { Component, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { MarkdownFenceRegistration, MarkdownFenceRendererProps, Unregister } from "@polyth/web-sdk";

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
