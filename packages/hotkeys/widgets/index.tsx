import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { formatCombo, HOTKEY_ACTIONS } from "@polyth/hotkeys";
import ShortcutsPage from "./ShortcutsPage.tsx";
import { getKeymap } from "./hotkeys.ts";

export { getKeymap, resetKeymap, setBinding, useKeymap } from "./hotkeys.ts";

const isMac = typeof navigator !== "undefined"
  && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "shortcuts",
      packageId: "hotkeys",
      label: "Shortcuts",
      group: "Customize",
      icon: "keyboard",
      order: 40,
      component: ShortcutsPage,
    }),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "hotkeys.palette-commands",
      render: () => null,
      meta: {
        commands: HOTKEY_ACTIONS.map(({ id, label }) => ({
          id: `shortcut.${id}`,
          label: `Change shortcut: ${label}`,
          group: "Shortcuts",
          keywords: ["keybinding", "hotkey", "shortcut"],
          icon: "key",
          hint: () => formatCombo(getKeymap()[id], isMac),
          run: () => host.navigation.openSettingsPage("shortcuts"),
        })),
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
