// Relay's web side: it joins the Accounts section of Settings → Harnesses
// through harness-runtime's Relay seam and brings its own card and row parts.
import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { registerRelayKit } from "@polyth/harness-runtime/relay-ui";
import { RelayBadge, RelayCard, RelayReading, useRelay } from "./RelayGroup.tsx";

export default defineWebPackage(() => () => registerRelayKit({ useRelay, RelayCard, RelayBadge, RelayReading }));
