import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistFreshnessSeq, latestCompletedExchange } from "@polyth/session/next-action";
import { createApiTransport, type ComposerDraftContext, type ComposerSuggestionOffer, type WebPackageHost } from "@polyth/web-sdk";
import { assistSettings, loadAssistSettings, subscribeAssistSettings } from "./assistSettings.ts";
import {
  beginNextPrompt, endNextPrompt, markNextPromptAsked, nextPromptAsked, nextPromptFor, nextPromptsVersion, pendingNextPrompt,
  rememberNextPrompt, shouldSuggestNextPrompt, subscribeNextPrompts,
} from "./nextPrompt.ts";

const api = createApiTransport();
/** Settle time after a reply before asking on our own. */
const SUGGEST_DELAY_MS = 400;
/** A harness that suggests prompts itself (Claude Code) gets this long to do so first. */
const HARNESS_GRACE_MS = 8_000;
/** The longest a preferred request keeps a harness hint off the chip. */
export const HOLD_MAX_MS = 10_000;

/** Ask the small model for the next message of an idle chat at `atSeq`. The
 * answer lands in the shared next-prompt store, where every open composer for
 * the session picks it up; the promise resolves to it ("" when the model has
 * no grounded next step) or null when the conversation moved meanwhile. */
export function requestNextPrompt(
  host: WebPackageHost, sessionId: string, atSeq: number, explicit: boolean,
): Promise<string | null> {
  markNextPromptAsked(sessionId, atSeq);
  beginNextPrompt(sessionId, atSeq, explicit);
  return api.post<{ suggestion: string; atSeq: number }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/assist/suggestion`,
    explicit ? { draft: "", regenerate: true } : { draft: "" },
  )
    .then((result) => {
      // The client may still be catching up to the server's view; only a
      // conversation that has already moved past the answer makes it stale.
      if (result.atSeq < assistFreshnessSeq(host.sessions.events(sessionId))) return null;
      rememberNextPrompt(sessionId, result.atSeq, result.suggestion, { explicit });
      return result.suggestion.trim();
    })
    .finally(() => endNextPrompt(sessionId, atSeq));
}

/** Session Assist's next-prompt source for one agent composer. It renders
 * nothing: the host mounts it through the `composer.suggestion` slot for as
 * long as the composer shows a session — independent of the rail button — and
 * it offers through the host's one suggestion chip, so a Session Assist
 * suggestion looks and works exactly like the harness's own. */
export default function NextPromptSource({ host, draft }: { host: WebPackageHost; draft: ComposerDraftContext }) {
  const sessionId = draft.sessionId;
  const conversation = () => sessionId
    ? `${assistFreshnessSeq(host.sessions.events(sessionId))}:${host.sessions.get(sessionId)?.status ?? ""}`
    : "0:";
  const conversationKey = useSyncExternalStore(host.sessions.subscribe, conversation, conversation);
  const separator = conversationKey.indexOf(":");
  const seq = Number(conversationKey.slice(0, separator));
  const status = conversationKey.slice(separator + 1) || undefined;
  useSyncExternalStore(subscribeNextPrompts, nextPromptsVersion, nextPromptsVersion);
  const settings = useSyncExternalStore(subscribeAssistSettings, assistSettings, assistSettings);
  // A failed load (a restart, a dropped link) is asked again on the next
  // conversation movement rather than leaving suggestions off for the page.
  useEffect(() => {
    if (!settings) void loadAssistSettings().catch(() => {});
  }, [settings, sessionId, seq]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The idle recap's own suggestion, while its conversation has not moved.
  const recapSuggestion = () => {
    const assist = sessionId ? host.sessions.get(sessionId)?.assist : undefined;
    return assist?.suggestion && assist.atSeq >= assistFreshnessSeq(host.sessions.events(sessionId!))
      ? assist.suggestion
      : "";
  };
  const recapped = useSyncExternalStore(host.sessions.subscribe, recapSuggestion, recapSuggestion);

  const assistFirst = settings?.suggestionPriority === "assist";
  const answer = sessionId ? nextPromptFor(sessionId, seq) : null;
  const text = answer?.text || recapped;
  // An answer the person asked for wins like the priority setting does.
  const preferred = assistFirst || answer?.explicit === true;
  // While a preferred request runs with nothing to show yet, hold the chip
  // so a harness hint does not flash up and get replaced; never for long.
  const flight = sessionId && !text ? pendingNextPrompt(sessionId, seq) : null;
  const holdKey = flight && (assistFirst || flight.explicit) ? `${sessionId}:${seq}:${flight.since}` : "";
  const [expiredHold, setExpiredHold] = useState("");
  useEffect(() => {
    if (!holdKey) return;
    const since = Number(holdKey.slice(holdKey.lastIndexOf(":") + 1));
    const timer = setTimeout(() => setExpiredHold(holdKey), Math.max(0, since + HOLD_MAX_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [holdKey]);
  const holding = !!holdKey && holdKey !== expiredHold;

  // The offer for this exact conversation state; any movement, a session
  // switch or unmount (package disable) withdraws it.
  const offer = draft.offerSuggestion;
  const offerRef = useRef(offer);
  offerRef.current = offer;
  useEffect(() => {
    if (!offer) return;
    const next: ComposerSuggestionOffer | null = !sessionId ? null
      : text ? { sessionId, text, ...(preferred ? { preferred: true } : {}) }
        : holding ? { sessionId, text: "", preferred: true }
          : null;
    offer(next);
  }, [offer, sessionId, text, preferred, holding]);
  useEffect(() => () => { offerRef.current?.(null); }, []);

  const hasCompletedExchange = () => !!sessionId && latestCompletedExchange(host.sessions.events(sessionId)) !== null;
  const autoSuggest = shouldSuggestNextPrompt({
    enabled: settings?.suggestNextPrompt === true && !!offer,
    sessionId, seq, status, busy: draft.busy, draft: draft.text,
    // A harness hint saves the request only while the harness comes first.
    offered: (assistFirst ? "" : draft.harnessSuggestion) || recapped,
    hasCompletedExchange,
  });
  const graceMs = !assistFirst && draft.harnessSuggests ? HARNESS_GRACE_MS : SUGGEST_DELAY_MS;
  useEffect(() => {
    if (!autoSuggest || !sessionId) return;
    const timer = setTimeout(() => {
      // Automatic requests stay silent: no progress, no failure notice.
      // Another composer on the same chat (a split pane) may have asked first.
      if (alive.current && !draft.read().text.trim() && !nextPromptAsked(sessionId, seq)) void requestNextPrompt(host, sessionId, seq, false).catch(() => {});
    }, graceMs);
    return () => clearTimeout(timer);
  }, [autoSuggest, sessionId, seq, graceMs]);

  return null;
}
