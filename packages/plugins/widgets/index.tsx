import { defineWebPackage } from "@polyth/web-sdk";
import PluginsPage from "./PluginsPage.tsx";
import "./styles.css";
export default defineWebPackage((host) => () => { const off = [host.settings.registerPage({ id: "plugins", packageId: "plugins", label: "Packages & Plugins", group: "Customize", icon: "🧩", order: 20, component: PluginsPage }), host.capabilities.register({ id: "diagnostics", label: "Extension diagnostics", technicalLabel: "Plugins", plainDescription: "Inspect installed packages and logs.", keywords: ["plugin", "package", "extension", "install", "logs"], standardTier: "technical", standardRank: 34, open: () => host.navigation.openSettingsPage("plugins"), available: () => true })]; return () => off.toReversed().forEach((dispose) => dispose()); });
