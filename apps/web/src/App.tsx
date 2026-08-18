import { useState } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";

export default function App() {
  const [railOpen, setRailOpen] = useState(true);
  return (
    <div className="app">
      <Sidebar />
      <Main />
      <ContextRail open={railOpen} onToggle={() => setRailOpen((v) => !v)} />
    </div>
  );
}