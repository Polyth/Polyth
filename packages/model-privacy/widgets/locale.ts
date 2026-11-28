import { useSyncExternalStore } from "react";

/** The host applies the resolved locale to `<html lang>` on every switch, so
 *  watching that attribute keeps the copy live without reaching into the
 *  shell's i18n store. */
export function documentLocale(): string {
  return typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
}

export function subscribeDocumentLocale(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return () => observer.disconnect();
}

export function useDocumentLocale(): string {
  return useSyncExternalStore(subscribeDocumentLocale, documentLocale, () => "en");
}
