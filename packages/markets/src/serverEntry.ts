import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { registerDefaultMarketProviders } from "./defaultProviders.ts";
import { createMarketsService, type MarketsService } from "./service.ts";

export const marketsServiceKey = serverServiceKey<MarketsService>("markets");

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const markets = createMarketsService();
  registerDefaultMarketProviders(markets);
  host.services.provide(marketsServiceKey, markets);
  return {};
}
