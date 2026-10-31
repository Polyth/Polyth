import { defineWebPackage } from "@polyth/web-sdk";
import { IDE_PROFILE } from "../src/index.ts";
import { ideModeText } from "../src/i18n/index.ts";

export default defineWebPackage((host) => () => {
  const off = [host.workbench.profiles.register({
    ...IDE_PROFILE,
    description: ideModeText(host, "idemode.profile.description"),
  })];
  return () => off.toReversed().forEach((dispose) => dispose());
});
