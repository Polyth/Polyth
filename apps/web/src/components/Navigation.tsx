import Sidebar from "./Sidebar.tsx";
import MobileNavigator from "./mobile/MobileNavigator.tsx";
import { useShellMode } from "../responsiveShell.ts";

export default function Navigation() {
  const mode = useShellMode();
  return mode === "phone" ? <MobileNavigator /> : <Sidebar />;
}
