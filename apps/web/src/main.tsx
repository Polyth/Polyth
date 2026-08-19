import { createRoot } from "react-dom/client";
import { init } from "./init.ts";
import { exposeSlots } from "./slots.ts";
import { installShell } from "./shell.ts";
import { installVoice } from "./voice.tsx";
import { installNotify } from "./notify.ts";
import { applyUiSettings } from "./uiPrefs.ts";
import App from "./App.tsx";
import "./styles.css";

exposeSlots();
installShell();
installVoice();
installNotify();
applyUiSettings();
init();

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
