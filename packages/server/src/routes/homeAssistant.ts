import type {
  HomeAssistantConfigInput,
  HomeAssistantEntityDto,
} from "@polyth/contracts";
import type { HomeAssistantService } from "@polyth/home-assistant";
import type { RouteHandler, RouteRequest } from "../http.ts";

const fail = (
  rc: RouteRequest,
  error: unknown,
  fallback = "Home Assistant request failed",
): true => {
  const code = (error as { code?: unknown }).code;
  const invalid = code === "invalid-input";
  rc.json(invalid ? 400 : 502, {
    error: invalid ? "invalid-input" : "upstream",
    message: error instanceof Error ? error.message : fallback,
  });
  return true;
};

const entityPayload = (body: Record<string, unknown>): string =>
  typeof body.entityId === "string" ? body.entityId : "";

export function homeAssistantRoutes(homeAssistant: HomeAssistantService): RouteHandler {
  return async (rc) => {
    const { path, method, json, url } = rc;

    if (path === "/api/home-assistant/config" && method === "GET") {
      json(200, homeAssistant.config());
      return true;
    }
    if (path === "/api/home-assistant/config" && method === "PUT") {
      try {
        const body = await rc.body();
        json(200, homeAssistant.configure(body as HomeAssistantConfigInput));
      } catch (error) {
        return fail(rc, error, "Home Assistant settings could not be saved");
      }
      return true;
    }
    if (path === "/api/home-assistant/status" && method === "GET") {
      json(200, await homeAssistant.status());
      return true;
    }
    if (path === "/api/home-assistant/entities" && method === "GET") {
      try {
        const requested = url.searchParams.getAll("entityId");
        const entities = await homeAssistant.states(requested.length > 0 ? requested : undefined);
        json(200, entities);
      } catch (error) {
        return fail(rc, error);
      }
      return true;
    }
    if (path === "/api/home-assistant/toggle" && method === "POST") {
      try {
        const body = await rc.body();
        const entity: HomeAssistantEntityDto = await homeAssistant.toggle(entityPayload(body));
        json(200, entity);
      } catch (error) {
        return fail(rc, error);
      }
      return true;
    }
    if (path === "/api/home-assistant/climate/temperature" && method === "POST") {
      try {
        const body = await rc.body();
        const entity = await homeAssistant.setTemperature(
          entityPayload(body),
          typeof body.temperature === "number" ? body.temperature : Number.NaN,
        );
        json(200, entity);
      } catch (error) {
        return fail(rc, error);
      }
      return true;
    }
    return false;
  };
}
