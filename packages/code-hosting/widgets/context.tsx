import { hostingMessage } from "./messages.ts";
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { HostingRepository } from "@polyth/code-hosting";
import { createCodeHostingClient, type CodeHostingClient, type CodeHostingProvider } from "./client.ts";
export { createCodeHostingClient, supportedMergeStrategies, supportedReviewEvents, type CodeHostingClient, type CodeHostingPresentation, type CodeHostingProvider } from "./client.ts";

export type CodeHostingTab = "issues" | "changes";


export interface CodeHostingContextValue {
  host: WebPackageHost;
  provider: CodeHostingProvider;
  client: CodeHostingClient;
}

const CodeHostingContext = createContext<CodeHostingContextValue | null>(null);

export function CodeHostingProviderContext({ host, provider, children }: {
  host: WebPackageHost;
  provider: CodeHostingProvider;
  children: ReactNode;
}) {
  const client = useMemo(() => createCodeHostingClient(provider), [provider.id, provider.apiBase]);
  // Providers are plain objects that wrappers commonly rebuild on every render.
  // Views list `t` in their loading effects, so it must keep its identity across
  // those re-renders; otherwise every host re-render cancels and restarts the
  // in-flight load and the list never leaves its loading state.
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const t = useCallback((key: string, values?: Record<string, string | number>) => hostingMessage(host.ui.locale.get(), key, values) ?? providerRef.current.t(key, values), [host, provider.id]);
  const presentation = useMemo(() => ({ ...provider, t }), [provider, t]);
  return <CodeHostingContext.Provider value={{ host, provider: presentation, client }}>{children}</CodeHostingContext.Provider>;
}

export function useCodeHosting(): CodeHostingContextValue {
  const context = useContext(CodeHostingContext);
  if (!context) throw new Error("Code-hosting views require CodeHostingProviderContext");
  return context;
}

export function useCodeHostingStore() {
  const { host } = useCodeHosting();
  return useSyncExternalStore(host.store.subscribe, host.store.getSnapshot, host.store.getSnapshot);
}

export type { HostingRepository };
