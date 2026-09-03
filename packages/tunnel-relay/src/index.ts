/** Upstream Iroh relay operations helpers. This package does not see Polyth routes, grants, or pairing secrets. */

export const IROH_RELAY_VERSION = "1.1.0";
export const RELAY_LISTEN_PORT = 443;
export const RELAY_HEALTH_PATH = "/health";

export interface RelayConfig {
  domain: string;
  listenPort: number;
  tlsCertPath: string;
  tlsKeyPath: string;
  maxConnections: number;
}

export function defaultRelayConfig(domain: string): RelayConfig {
  return {
    domain,
    listenPort: RELAY_LISTEN_PORT,
    tlsCertPath: "/etc/polyth-link-relay/tls.crt",
    tlsKeyPath: "/etc/polyth-link-relay/tls.key",
    maxConnections: 10_000,
  };
}

export function validateRelayConfig(config: RelayConfig): string[] {
  const errors: string[] = [];
  if (!config.domain.includes(".")) errors.push("domain");
  if (config.listenPort !== 443 && config.listenPort !== 8443) errors.push("listenPort");
  if (!config.tlsCertPath || !config.tlsKeyPath) errors.push("tls");
  return errors;
}
