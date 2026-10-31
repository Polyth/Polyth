import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { glanceStrings } from "../src/strings.ts";
import { Clock, DEFAULT_PLACES, WorldClock } from "./clocks.tsx";
import { UNIT_CHOICES, Weather } from "./weather.tsx";

const SLOTS = ["session.empty.widgets", "workspace.main", "workspace.right"] as const;

export default defineWebPackage((host) => () => {
  const locale = () => host.ui.locale.get();
  const strings = glanceStrings(locale());
  const shared = {
    kind: "widget",
    defaultSlot: "session.empty.widgets",
    supportedSlots: SLOTS,
    category: strings.name,
    defaultVisible: false,
    audience: "simple",
    scope: "global",
    duplicatable: true,
    resizable: true,
    minSize: { w: 2, h: 2 },
    maxSize: { w: 12, h: 8 },
  } as const;
  const off = [
    host.widgets.registerPlugin({
      id: "glance",
      name: strings.name,
      widgets: [
        {
          ...shared,
          id: "glance.clock",
          title: strings.clockTitle,
          description: strings.clockDescription,
          defaultSize: { w: 3, h: 2 },
          panelSizes: ["compact", "standard"],
          panelDefaultSize: "compact",
          settingsSchema: {
            type: "object",
            properties: {
              place: { type: "string", title: strings.place, description: strings.placeHint, default: "" },
              date: { type: "boolean", title: strings.date, default: true },
              seconds: { type: "boolean", title: strings.seconds, default: false },
            },
          },
          render: (context) => createElement(Clock, { context, strings, locale: locale() }),
        },
        {
          ...shared,
          id: "glance.world",
          title: strings.worldTitle,
          description: strings.worldDescription,
          defaultSize: { w: 4, h: 3 },
          panelSizes: ["standard", "wide"],
          panelDefaultSize: "standard",
          settingsSchema: {
            type: "object",
            properties: {
              places: { type: "string", title: strings.places, description: strings.placesHint, default: DEFAULT_PLACES },
            },
          },
          render: (context) => createElement(WorldClock, { context, strings, locale: locale() }),
        },
        {
          ...shared,
          id: "glance.weather",
          title: strings.weatherTitle,
          description: strings.weatherDescription,
          defaultSize: { w: 4, h: 2 },
          panelSizes: ["compact", "standard", "wide"],
          panelDefaultSize: "standard",
          settingsSchema: {
            type: "object",
            properties: {
              place: { type: "string", title: strings.place, description: strings.weatherPlaceHint, default: "" },
              units: { type: "string", title: strings.units, enum: [...UNIT_CHOICES], default: UNIT_CHOICES[0] },
            },
          },
          render: (context) => createElement(Weather, { context, strings, locale: locale() }),
        },
      ],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
