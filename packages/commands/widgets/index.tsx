import { defineWebPackage } from "@polyth/web-sdk";
import CommandsPage from "./CommandsPage.tsx";
export default defineWebPackage((host) => () => host.settings.registerPage({ id: "commands", packageId: "commands", label: "Commands", group: "Engineering", icon: "/", order: 30, component: CommandsPage }));
