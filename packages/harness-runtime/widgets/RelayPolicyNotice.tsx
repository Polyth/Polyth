import type { HarnessRelayVendorPolicy } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Notice } from "../../../apps/web/src/components/ui/index.ts";

/** What `relay.policy` of a harness family means for the person: the text
 *  comes from the policy, the vendor's name from the family. */
export function RelayPolicyNotice({ host, policy, name }: { host: WebPackageHost; policy: HarnessRelayVendorPolicy; name: string }) {
  const t = (key: string) => host.ui.locale.translate(`harnessruntime.relay.policy.${policy}.${key}`, { name });
  return <Notice tone={policy === "tolerated" ? "info" : "warning"} data-testid="relay-policy-notice" data-policy={policy} heading={t("title")}>{t("body")}</Notice>;
}
