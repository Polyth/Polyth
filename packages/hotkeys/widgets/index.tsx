import { defineWebPackage } from "@polyth/web-sdk";
import ShortcutsPage from "./ShortcutsPage.tsx";
export default defineWebPackage((host) => () => host.settings.registerPage({ id: "shortcuts", packageId: "hotkeys", label: "Shortcuts", group: "Customize", icon: "⌨", order: 40, component: ShortcutsPage }));
