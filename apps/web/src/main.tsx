import { createRoot } from "react-dom/client";
import { init } from "./init.ts";
import { exposeSlots } from "./slots.ts";
import { applySettingsToDom } from "./settings.ts";
import { getState } from "./store.ts";
import App from "./App.tsx";
import "./styles.css";

applySettingsToDom(getState().settings);
exposeSlots();
init();

createRoot(document.getElementById("root") as HTMLElement).render(<App />);