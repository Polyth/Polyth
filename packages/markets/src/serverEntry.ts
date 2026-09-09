import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createMarketsService, type MarketsService } from "./service.ts";

export const marketsServiceKey = serverServiceKey<MarketsService>("markets");

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  host.services.provide(marketsServiceKey, createMarketsService());
  return {};
}
