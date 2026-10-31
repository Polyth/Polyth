import { useSyncExternalStore } from "react";

/** The host applies the resolved locale to `<html lang>` on every switch
 *  (apps/web/src/i18n/index.ts), so watching that attribute keeps the chip's
 *  copy live without reaching into the shell's i18n store. */
export function useDocumentLocale(): string {
  return useSyncExternalStore(
    (listener) => {
      if (typeof document === "undefined") return () => {};
      const observer = new MutationObserver(listener);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      return () => observer.disconnect();
    },
    () => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en"),
    () => "en",
  );
}
