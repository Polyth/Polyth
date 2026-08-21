// UX-PANE-MODEL: visibility signal for kept-alive pane bodies. The pane host
// provides `false` while a surface (or tab) is mounted but hidden so bodies
// pause their UI-only polling — canonical subscriptions (PTY sockets, browser
// session frames, shared git status) stay attached. Default is true so the
// same components behave normally outside a pane host.
import { createContext, useContext } from "react";

export const PaneVisibilityContext = createContext<boolean>(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibilityContext);
}
