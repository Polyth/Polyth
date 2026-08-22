import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { init } from "./init.ts";
import { exposeSlots } from "./slots.ts";
import { exposeSurfaces } from "./surfaces.ts";
import { exposeCapabilities } from "./capabilities.ts";
import { installShell } from "./shell.ts";
import { exposeWorkspaceSurfaces } from "./workspace/surfaceRegistry.ts";
import { applySettingsToDom } from "./settings.ts";
import { getState } from "./store.ts";
import { installBuiltinMiniWidgets } from "./widgets/builtinMiniWidgets.tsx";
import { exposeWidgets } from "./widgets/catalog.ts";
import { bootPackages } from "./packages/registry.ts";
import App from "./App.tsx";
import LockScreen from "./components/LockScreen.tsx";
import "./styles.css";

applySettingsToDom(getState().settings);
exposeSlots();
exposeSurfaces();
exposeCapabilities();
exposeWorkspaceSurfaces();
exposeWidgets();
installBuiltinMiniWidgets();
// Palette commands + keyboard shortcuts: one install, synced with the
// capability registry from then on (UX-PERSONAS: search sees every tool).
installShell();

// F16: init() loads REST data and opens /ws — it must not run until the
// server says this device is authorized (or that no password is set).
let booted = false;
const bootOnce = (): void => {
  if (booted) return;
  booted = true;
  void bootPackages().catch(() => undefined);
  init();
};

function Root() {
  const [phase, setPhase] = useState<"checking" | "locked" | "ready">("checking");

  useEffect(() => {
    let cancelled = false;
    void api.authStatus()
      .then((s) => { if (!cancelled) setPhase(s.required && !s.authorized ? "locked" : "ready"); })
      // Status unreachable → proceed; init()'s own error banner reports it.
      .catch(() => { if (!cancelled) setPhase("ready"); });
    // Mid-session 401 (session revoked / password newly set) re-locks the UI.
    const onAuthRequired = () => setPhase("locked");
    window.addEventListener("polyth:auth-required", onAuthRequired);
    return () => {
      cancelled = true;
      window.removeEventListener("polyth:auth-required", onAuthRequired);
    };
  }, []);

  useEffect(() => { if (phase === "ready") bootOnce(); }, [phase]);

  if (phase === "checking") return null;
  if (phase === "locked") {
    // After a mid-session revoke the store/WS state is stale — reload for a
    // clean slate; on the initial lock just proceed into the normal boot.
    return <LockScreen onUnlocked={() => { if (booted) location.reload(); else setPhase("ready"); }} />;
  }
  return <App />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
