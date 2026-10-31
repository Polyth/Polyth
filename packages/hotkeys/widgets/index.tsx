import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { formatCombo, HOTKEY_ACTIONS } from "@polyth/hotkeys";
import ShortcutsPage from "./ShortcutsPage.tsx";
import { getKeymap, replaceKeymap, subscribeKeymap } from "./hotkeys.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export { getKeymap, replaceKeymap, resetKeymap, setBinding, subscribeKeymap, useKeymap } from "./hotkeys.ts";

const isMac = typeof navigator !== "undefined"
  && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");

export default defineWebPackage((host) => () => {
  const off = [
    host.preferences.register("package.hotkeys", {
      read: getKeymap,
      write: replaceKeymap,
      subscribe: subscribeKeymap,
    }),
    host.settings.registerPage({
      id: "shortcuts",
      packageId: "hotkeys",
      label: tr("settings.shortcutspage.shortcuts"),
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
        commands: HOTKEY_ACTIONS.map(({ id }) => ({
          id: `shortcut.${id}`,
          label: tr("settings.shortcutspage.changeShortcut", { action: tr(`settings.shortcutspage.action.${id}`) }),
          group: tr("settings.shortcutspage.shortcuts"),
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
