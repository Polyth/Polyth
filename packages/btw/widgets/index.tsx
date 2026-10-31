import "./styles.css";
import { sessionAccessAtLeast } from "@polyth/contracts";
import { createApiTransport, defineWebPackage, type ComposerContributionContext, type WebPackageHost } from "@polyth/web-sdk";
import { btwPath, type BtwResponse } from "../src/shared.ts";
import { btwStrings } from "../src/strings.ts";
import { BTW_MODE_ID, BtwCardSlot } from "./BtwCard.tsx";
import { BtwIcon } from "./icons.tsx";
import { createBtwStore, type BtwStore } from "./store.ts";

const transport = createApiTransport({ readRetry: false });

/** A side question needs an agent chat the person can work in. */
export function btwAvailable(host: Pick<WebPackageHost, "sessions">, context: Pick<ComposerContributionContext, "sessionId">): boolean {
  if (!context.sessionId) return false;
  const session = host.sessions.get(context.sessionId);
  if (!session || session.purpose === "conversation") return false;
  return !session.sharing || sessionAccessAtLeast(session.sharing.access, "collaborate");
}

export function createBtwPackage(host: WebPackageHost, store: BtwStore) {
  const strings = () => btwStrings(host.ui.locale.get());
  const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 480px)").matches;
  const off: Array<() => void> = [];
  const composer = host.composer;
  if (composer?.registerMode) {
    off.push(composer.registerMode({
      id: BTW_MODE_ID,
      label: () => strings().title,
      trigger: "/btw",
      placeholder: () => phone() ? strings().placeholderShort : strings().placeholder,
      submitLabel: () => strings().submit,
      icon: () => <BtwIcon size={14} />,
      isAvailable: (context) => btwAvailable(host, context),
      submit: (context, text) => {
        if (!context.sessionId) throw new Error(strings().failed);
        store.ask(context.sessionId, text);
      },
    }));
    off.push(composer.registerAddMenuItem({
      id: "btw.ask",
      label: () => strings().addMenuLabel,
      description: () => strings().addMenuDescription,
      icon: () => <BtwIcon size={16} />,
      order: 40,
      isAvailable: (context) => btwAvailable(host, context)
        && composer.activeMode?.(context.sessionId) !== BTW_MODE_ID,
      activate: (context) => context.setMode?.(BTW_MODE_ID),
    }));
  }
  off.push(host.slots.register({
    slot: "session.composer.before",
    id: "btw.card",
    // Last in the area: the card sits closest to the composer it answers.
    order: 1000,
    meta: { title: strings().title },
    render: (context) => {
      const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
      return sessionId
        ? <BtwCardSlot key={sessionId} host={host} store={store} sessionId={sessionId} strings={strings()} />
        : null;
    },
  }));
  return () => { for (const dispose of off.reverse()) dispose(); };
}

export default defineWebPackage((host) => () => {
  // One store per activation: disabling the package drops every thread and
  // any answer still on its way.
  const store = createBtwStore({
    ask: (sessionId, request, signal) => transport.post<BtwResponse>(btwPath(sessionId), request, { signal }),
    describeError: (error) => error instanceof Error && error.message ? error.message : String(error),
  });
  const dispose = createBtwPackage(host, store);
  return () => {
    dispose();
    store.dispose();
  };
});
