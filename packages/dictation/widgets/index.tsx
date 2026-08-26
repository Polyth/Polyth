import { defineWebPackage } from "@polyth/web-sdk";
import VoicePage from "./VoicePage.tsx";
import { installVoice } from "./voice.tsx";
export default defineWebPackage((host) => () => { const off = [host.settings.registerPage({ id: "voice", packageId: "dictation", label: "Voice", group: "Workspace", icon: "🎤", order: 30, component: VoicePage }), installVoice(), host.capabilities.register({ id: "voice", label: "Voice input", technicalLabel: "Dictation", plainDescription: "Talk instead of typing.", keywords: ["voice", "dictation", "microphone", "speech"], standardTier: "more", standardRank: 19, open: () => host.navigation.openSettingsPage("voice"), available: () => true })]; return () => off.toReversed().forEach((dispose) => dispose()); });
