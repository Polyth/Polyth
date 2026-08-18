import { createRoot } from "react-dom/client";
import { init } from "./init.ts";
import { exposeSlots } from "./slots.ts";
import App from "./App.tsx";
import "./styles.css";

exposeSlots();
init();

createRoot(document.getElementById("root") as HTMLElement).render(<App />);