import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { MICROPHONE_CLAIM_EVENT, claimMicrophone } from "@polyth/dictation";
import {
  SPEECH_CLAIM_EVENT,
  createSpeechOutput,
  primeSpeechOutput,
  type SpeechOutputSettings,
} from "@polyth/dictation/voice-runtime";
import { api } from "@polyth/session/web-api";
import { tapFeedback } from "../../../apps/web/src/haptics.ts";
import { resolveCommandPhrases } from "../src/commands.ts";
import { narrationLocale, narrationPhrases } from "../src/narrationPhrases.ts";
import { bargeInEnabled } from "../src/prefs.ts";
import { voiceModeStrings } from "../src/strings.ts";
import { createVoiceModeController } from "./controller.ts";
import { loadNarrationStatus, requestNarration } from "./narrateClient.ts";
import { playEarcon } from "./earcons.ts";
import { startListener } from "./listener.ts";
import { startMicMonitor } from "./micMonitor.ts";
import { getVoiceModePrefs, replaceVoiceModePrefs, subscribeVoiceModePrefs } from "./prefsStore.ts";
import { readVoicePrefs, resolveRecognitionRoutes } from "./route.ts";
import { sendQueuedNow, stopTurn } from "./sessionActions.ts";
import { createTabClaim } from "./tabClaim.ts";
import VoiceModeSettings from "./VoiceModeSettings.tsx";
import { VoiceModeButton, VoiceModeHost } from "./VoiceModeLayer.tsx";

/** Read-aloud voice settings (Settings → Voice), read per spoken chunk so a
 *  change applies from the next sentence. */
const outputSettings = (): SpeechOutputSettings => {
  const prefs = readVoicePrefs();
  return {
    engine: prefs.ttsEngine,
    ...(prefs.localVoice ? { localVoice: prefs.localVoice } : {}),
    ...(prefs.localSpeaker !== undefined ? { localSpeaker: prefs.localSpeaker } : {}),
    lang: prefs.lang,
    ...(prefs.voice ? { voice: prefs.voice } : {}),
    rate: prefs.rate,
    pitch: prefs.pitch,
    volume: prefs.volume,
  };
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
};

/** The voice's language; "auto" is the browser's. */
const spokenLang = (): string => {
  const lang = readVoicePrefs().lang;
  return !lang || lang === "auto" ? (typeof navigator !== "undefined" ? navigator.language : "en") : lang;
};

export default defineWebPackage((host) => () => {
  const strings = () => voiceModeStrings(host.ui.locale.get());
  const bargeIn = () => bargeInEnabled(getVoiceModePrefs(), typeof navigator !== "undefined" ? navigator : undefined);
  // English plus the UI and recognition languages, unless the user set phrases.
  const commandPhrases = () => resolveCommandPhrases(getVoiceModePrefs().commandPhrases, [host.ui.locale.get(), readVoicePrefs().lang]);
  const tabClaim = createTabClaim();
  const controller = createVoiceModeController({
    host,
    owner: "voice-mode",
    strings,
    prefs: getVoiceModePrefs,
    // Narration is said in the voice's language and shown in the UI's.
    spokenPhrases: () => narrationPhrases(narrationLocale(spokenLang(), host.ui.locale.get())),
    shownPhrases: () => narrationPhrases(host.ui.locale.get()),
    spokenLang,
    narrate: requestNarration,
    commandPhrases,
    outputSettings,
    resolveRoutes: resolveRecognitionRoutes,
    startListener,
    createOutput: createSpeechOutput,
    primeOutput: primeSpeechOutput,
    startMicMonitor,
    bargeIn,
    earcon: (kind) => {
      if (getVoiceModePrefs().sounds) playEarcon(kind);
    },
    claimMicrophone,
    claimSpeaker: (owner) => window.dispatchEvent(new CustomEvent(SPEECH_CLAIM_EVENT, { detail: { owner } })),
    onMicrophoneClaimed: (listener) => {
      const claimed = (event: Event) => listener((event as CustomEvent<{ owner?: string }>).detail?.owner ?? "");
      window.addEventListener(MICROPHONE_CLAIM_EVENT, claimed);
      return () => window.removeEventListener(MICROPHONE_CLAIM_EVENT, claimed);
    },
    stopTurn: (sessionId) => stopTurn(api, sessionId),
    sendQueuedNow: (sessionId) => sendQueuedNow(api, sessionId),
    claimTab: () => tabClaim.claim(),
    onTabClaimed: (listener) => tabClaim.onClaimed(() => {
      if (controller.getSnapshot().phase !== "off") host.errors.show?.(strings().otherTab);
      listener();
    }),
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => {};
      const changed = () => listener(document.visibilityState === "visible");
      document.addEventListener("visibilitychange", changed);
      window.addEventListener("pageshow", changed);
      return () => {
        document.removeEventListener("visibilitychange", changed);
        window.removeEventListener("pageshow", changed);
      };
    },
    // Keep a phone screen awake for a hands-free conversation.
    wakeLock: async () => {
      const lock = await (navigator as WakeLockNavigator).wakeLock?.request("screen");
      return lock ? () => { void lock.release().catch(() => {}); } : null;
    },
    haptic: tapFeedback,
    now: () => Date.now(),
  });
  const activeSessionId = () => host.store.getSnapshot().activeSessionId;
  const sessionTitle = (sessionId: string | null) => {
    const id = sessionId ?? activeSessionId();
    return id ? host.sessions.get(id)?.title ?? "" : "";
  };
  const hintCommands = () => getVoiceModePrefs().commands ? commandPhrases() : null;

  const off = [
    // Account settings, so Replies (switched in the voice window) and the
    // rest follow the user to every device and the next conversation.
    host.preferences.register("package.voice-mode", {
      read: getVoiceModePrefs,
      write: replaceVoiceModePrefs,
      subscribe: subscribeVoiceModePrefs,
    }),
    // A Replies change — here, from another tab or another device — applies
    // to the running conversation at once.
    subscribeVoiceModePrefs(() => controller.applyFeedback()),
    host.settings.registerPage({
      id: "voice-mode",
      label: strings().title,
      group: "Workspace",
      icon: "voice-mode",
      order: 31,
      component: () => (
        <VoiceModeSettings strings={strings()} openVoiceSettings={() => host.navigation.openSettingsPage("voice")}
          openSmallModelSettings={() => host.navigation.openSettingsPage("sessions", { itemId: "sessions.small-model" })}
          loadNarrationStatus={loadNarrationStatus} commandPhrases={commandPhrases} />
      ),
    }),
    // Directly above the composer: the compact dock sits where the user's
    // words land, and the full-screen layer portals out from here.
    host.slots.register({
      slot: "session.composer.before",
      id: "voice-mode.layer",
      order: -5,
      meta: { title: strings().title },
      render: () => (
        <VoiceModeHost controller={controller} strings={strings()} sessionTitle={sessionTitle} activeSessionId={activeSessionId}
          bargeIn={bargeIn} commands={hintCommands} priority={1} />
      ),
    }),
    // Screens without the area above (New chat) still have a composer; the
    // layer must never be live without anything on screen.
    host.slots.register({
      slot: "composer.pending",
      id: "voice-mode.layer-fallback",
      order: -5,
      meta: { title: strings().title },
      render: () => (
        <VoiceModeHost controller={controller} strings={strings()} sessionTitle={sessionTitle} activeSessionId={activeSessionId}
          bargeIn={bargeIn} commands={hintCommands} />
      ),
    }),
    host.widgets.registerPlugin({
      id: "voice-mode",
      name: strings().title,
      widgets: [{
        id: "voice-mode.start",
        title: strings().title,
        description: strings().widgetDescription,
        kind: "mini-widget",
        defaultSlot: "composer.trailing",
        // Acts on the agent's turn: hidden where the composer writes only to people.
        agentOnly: true,
        supportedSlots: ["composer.trailing", "composer.leading", "session.header.actions", "app.header.actions"],
        category: "Workspace",
        defaultVisible: true,
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        order: 6,
        render: () => <VoiceModeButton controller={controller} strings={strings()} />,
      }],
    }),
    // One capability: rail/Tools launcher, the palette command
    // (`capability.voice-mode`) and the Voice mode shortcut all toggle it.
    host.capabilities.register({
      id: "voice-mode",
      label: strings().title,
      technicalLabel: "Voice mode",
      plainDescription: strings().description,
      keywords: ["voice", "voice mode", "talk", "speak", "conversation", "hands-free", "audio"],
      standardTier: "more",
      standardRank: 18,
      launcherWidget: false,
      open: () => controller.toggle(),
      available: () => true,
    }),
    () => controller.dispose(),
    () => tabClaim.dispose(),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
