// The app's window sends a shell token in its user agent. Polyth's account
// device list is built from the sign-in request's User-Agent, and an Electron
// window otherwise reports a plain Chrome UA: "Chrome on macOS" for our own
// desktop app, indistinguishable from a browser tab. The token names the shell
// and its version; the web bundle parses it in `clientUserAgent.ts`.
//
// The mobile app does the same through Capacitor's `appendUserAgent`
// (`apps/mobile/capacitor.config.ts`), which has no access to the bundle
// version at runtime, so it sends a bare token without a version.

/** Appended as `<name>/<version>`; a workstation build names its own edition. */
export const DESKTOP_UA_TOKEN = "PolythDesktop";

export function desktopUserAgent(base: string, opts: { version: string; workstation?: boolean }): string {
  const name = opts.workstation ? `${DESKTOP_UA_TOKEN}-Workstation` : DESKTOP_UA_TOKEN;
  const version = opts.version.replace(/[^\w.+-]/g, "");
  const token = version ? `${name}/${version}` : name;
  // A window recreated or a reloaded page must not stack tokens, and a token
  // from another build shape is replaced rather than kept beside this one.
  const previous = new RegExp(`\\s*${DESKTOP_UA_TOKEN}(?:-Workstation)?(?:/[\\w.+-]+)?(?=$|\\s)`, "g");
  const trimmed = base.replace(previous, "").trim();
  return trimmed ? `${trimmed} ${token}` : token;
}
