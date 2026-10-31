// The active package host. Set by the installer and cleared on disable, so
// widgets, the window and the editor reach host seams (navigation,
// conversation, notices, the model-picker slot) without prop drilling.
import type { WebPackageHost } from "@polyth/web-sdk";

let current: WebPackageHost | null = null;

export function setActionHost(host: WebPackageHost | null): void {
  current = host;
}

export function actionHost(): WebPackageHost | null {
  return current;
}
