/** Experimental packaging helpers for upstream iroh-relay 1.1.0.
 *  This is not a production TLS/443 product and does not reconnect devices. */

export const IROH_RELAY_VERSION = "1.1.0";
export const EXPERIMENTAL_RELAY_BIND = "127.0.0.1:3340";

export interface RelayConfig {
  httpBind: string;
}

export function defaultRelayConfig(): RelayConfig {
  return { httpBind: EXPERIMENTAL_RELAY_BIND };
}

export function validateRelayConfig(config: RelayConfig): string[] {
  const errors: string[] = [];
  const parsed = config.httpBind.split(":");
  if (parsed.length < 2 || !parsed[0] || !parsed[1]) errors.push("httpBind");
  return errors;
}
