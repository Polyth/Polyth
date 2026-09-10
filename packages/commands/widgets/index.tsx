import { defineWebPackage } from "@polyth/web-sdk";
import CommandsPage from "./CommandsPage.tsx";
import SkillsPage from "./SkillsPage.tsx";
export default defineWebPackage((host) => () => {
  const commands = host.settings.registerPage({ id: "commands", packageId: "commands", label: "Commands", group: "Engineering", icon: "command", order: 30, component: CommandsPage });
  const skills = host.settings.registerPage({ id: "skills", packageId: "commands", label: "Skills", group: "Engineering", icon: "assist", order: 31, component: SkillsPage });
  return () => { skills(); commands(); };
});
